/**
 * Adapter MCP Events bao quanh `getFetchHandler` của SDK.
 *
 * SDK 0.25 không có `registerEvent`/`registerMethod` và `buildServerCapabilities` là private, nên
 * Events được thêm ở tầng HTTP, KHÔNG gọi field private nào:
 *
 *  1. Mọi request MCP thường được chuyển nguyên trạng cho handler gốc.
 *  2. `server/discover` và `initialize`: handler gốc xử lý trước. Chỉ khi nó trả 200 VÀ request
 *     mang danh tính người dùng hợp lệ thì adapter mới thêm `capabilities.events`.
 *  3. `events/list|subscribe|unsubscribe`: request GỐC vẫn đi qua handler gốc để nó làm hết phần
 *     xác thực, kiểm header (`Mcp-Method`, `MCP-Protocol-Version`) và kiểm `_meta` (-32020, -32022,
 *     -32602, 401 kèm `WWW-Authenticate`, 429...). Handler gốc chỉ trả 404 kèm -32601 "Method not
 *     found: <method>" khi mọi cổng đó đã qua, và CHỈ khi thấy tín hiệu đó adapter mới nhận việc.
 *     Mọi phản hồi khác được trả nguyên. Nhờ vậy adapter không nhân bản logic xác thực, và nếu
 *     một bản SDK tương lai tự hỗ trợ `events/*` thì tín hiệu biến mất và adapter nhường đường.
 *
 * Danh tính: adapter xác minh lại bearer bằng `authProvider.verifyToken` (cùng provider đã nạp vào
 * `McpApp`) và dùng đúng `resolveCallerIdentity` mà middleware của tool dùng. Không có danh tính
 * người dùng (ví dụ bearer tĩnh dùng chung) thì bị từ chối bằng -32012.
 *
 * Adapter không lưu gì và không log token, secret, callback, tiêu đề hay email.
 *
 * @module lib/erpnext/src/events/adapter
 */

import {
  type AuthProvider,
  createUnauthorizedResponse,
  extractBearerToken,
  type FetchHandler,
} from "@casys/mcp-server";
import { runWithCaller } from "../api/caller-context.ts";
import { resolveCallerIdentity } from "../auth/caller-middleware.ts";
import { EventsAuthError, type EventsStore } from "./erp-store.ts";
import {
  EventsErrorCode,
  type EventsMethod,
  EventsProtocolError,
  handleEventsList,
  isEventsMethod,
  parseSubscribeParams,
  parseUnsubscribeParams,
} from "./protocol.ts";

const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION = "2026-07-28";
const MCP_PATHS = new Set(["/mcp", "/"]);
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface EventsAdapterOptions {
  /** Handler gốc từ `McpApp.getFetchHandler`. */
  base: FetchHandler;
  /** Đúng provider đã nạp vào `McpApp`, dùng để xác minh lại bearer. */
  authProvider: AuthProvider;
  /** Danh tính server, đóng dấu vào `_meta` của mọi kết quả Events giống như lõi. */
  serverInfo: { name: string; version: string };
  store: EventsStore;
  /** Trần dung lượng body adapter chịu đọc để xem method. Mặc định 1 MiB, bằng trần của SDK. */
  maxBodyBytes?: number;
  /** Số subscribe/unsubscribe được gọi ERP cùng lúc. Mặc định 10, bằng `maxConcurrent` của SDK. */
  maxConcurrent?: number;
  /** Số lệnh được xếp hàng chờ khi đã đủ `maxConcurrent`; quá số này trả 503. Mặc định 50. */
  maxQueued?: number;
  /**
   * Tổng byte adapter được giữ trong bộ nhớ cùng lúc để xem method trước khi vào SDK. Hết ngân
   * sách thì request đi thẳng vào SDK mà không xem. Mặc định 16 MiB.
   */
  maxPeekBytes?: number;
  /** Thời gian tối đa chờ body để xem method, quá hạn thì đi thẳng vào SDK. Mặc định 5000 ms. */
  peekTimeoutMs?: number;
  /** Chỉ nhận thông điệp không nhạy cảm (tên method, mã lỗi). */
  log?: (message: string) => void;
}

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_QUEUED = 50;
const DEFAULT_MAX_PEEK_BYTES = 16 * 1024 * 1024;
const DEFAULT_PEEK_TIMEOUT_MS = 5000;

/** Ngân sách byte dùng chung: `take` giữ chỗ trước khi đọc, `give` trả lại khi xong. */
function createByteBudget(total: number) {
  let used = 0;
  return {
    take(bytes: number): boolean {
      if (used + bytes > total) return false;
      used += bytes;
      return true;
    },
    give(bytes: number): void {
      used -= bytes;
    },
  };
}

/** Hàng đợi đã đầy: adapter từ chối việc mới thay vì gom thêm vào bộ nhớ. */
class EventsBusyError extends Error {}

/** Giới hạn số tác vụ chạy đồng thời, các tác vụ dư xếp hàng tới `maxQueued` rồi bị từ chối. */
function createLimiter(maxActive: number, maxQueued: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxActive) {
      if (waiting.length >= maxQueued) throw new EventsBusyError();
      // Slot được chuyển thẳng cho người đứng đầu hàng nên `active` không đổi.
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Methods mà `params.name` định danh một đối tượng nên HTTP binding bắt `Mcp-Name` khớp. */
const NAMED_METHODS = new Set<string>([
  "events/subscribe",
  "events/unsubscribe",
]);

interface PeekedRpc {
  method: string;
  id: unknown;
  params: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** Đọc tối đa `limit` byte của một luồng; trả `null` nếu vượt trần. */
async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return null;
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Không `await`: hủy một nhánh của `clone()` chỉ xong khi nhánh còn lại cũng được
        // tiêu thụ hoặc hủy, mà request gốc chưa tới tay handler gốc cho tới khi hàm này trả về.
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** Ngân sách đệm đã cạn: không thể xem method, nên không được phép chuyển tiếp như thể "không phải Events". */
const PEEK_BUSY = Symbol("peek-busy");

/** Xem method của một POST tới endpoint MCP mà không tiêu thụ body của request gốc. */
async function peekRpc(
  request: Request,
  maxBodyBytes: number,
  budget: ReturnType<typeof createByteBudget>,
  timeoutMs: number,
): Promise<PeekedRpc | typeof PEEK_BUSY | null> {
  if (request.method !== "POST" || request.body === null) return null;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (!MCP_PATHS.has(pathname)) return null;
  // Body khai báo quá trần thì không đệm: SDK sẽ tự từ chối. Không khai báo (chunked) thì giữ chỗ
  // theo trần, vì chưa biết sẽ đọc bao nhiêu.
  const declared = request.headers.get("content-length");
  let reserve = maxBodyBytes;
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return null;
    reserve = Number(declared);
    if (reserve > maxBodyBytes) return null;
  }
  // Cạn ngân sách thì từ chối có giới hạn. Chuyển thẳng cho SDK sẽ biến một request Events đã xác
  // thực thành -32601 chỉ vì kẻ khác đang giữ chỗ bằng các body chunked chưa xác thực.
  if (!budget.take(reserve)) return PEEK_BUSY;
  try {
    const bytes = await readLimited(
      request.clone().body!,
      maxBodyBytes,
      timeoutMs,
    );
    if (bytes === null) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed) || typeof parsed.method !== "string") return null;
    return { method: parsed.method, id: parsed.id, params: parsed.params };
  } catch {
    return null;
  } finally {
    budget.give(reserve);
  }
}

/** Header của handler gốc (CORS...) cộng header của phản hồi do adapter tự dựng. */
function mergeHeaders(baseHeaders: Headers, own: Headers): Headers {
  const merged = new Headers(baseHeaders);
  merged.delete("content-length");
  for (const [name, value] of own) merged.set(name, value);
  return merged;
}

async function isMethodNotFound(
  response: Response,
  method: string,
): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const body: unknown = await response.clone().json();
    if (!isRecord(body) || !isRecord(body.error)) return false;
    return body.error.code === -32601 &&
      body.error.message === `Method not found: ${method}`;
  } catch {
    return false;
  }
}

/** `Mcp-Name` phải có mặt và đúng bằng `params.name` (tên sự kiện luôn là ASCII). */
function nameHeaderMatches(request: Request, rpc: PeekedRpc): boolean {
  if (!isRecord(rpc.params) || typeof rpc.params.name !== "string") {
    // Thiếu tên thì parser tham số trả -32602 đúng hơn một lỗi header.
    return true;
  }
  if (!/^[\x20-\x7e]*$/.test(rpc.params.name)) return true;
  return request.headers.get("Mcp-Name") === rpc.params.name;
}

export function createEventsAdapter(
  options: EventsAdapterOptions,
): FetchHandler {
  const { base, authProvider, serverInfo, store } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.log ?? (() => {});
  const peekBudget = createByteBudget(
    options.maxPeekBytes ?? DEFAULT_MAX_PEEK_BYTES,
  );
  const peekTimeoutMs = options.peekTimeoutMs ?? DEFAULT_PEEK_TIMEOUT_MS;
  const limit = createLimiter(
    options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    options.maxQueued ?? DEFAULT_MAX_QUEUED,
  );

  async function verify(request: Request) {
    const token = extractBearerToken(request);
    if (!token) return null;
    try {
      return await authProvider.verifyToken(token);
    } catch {
      return null;
    }
  }

  function unauthorized(baseResponse: Response): Response {
    const metadata = authProvider.getResourceMetadata();
    const denied = createUnauthorizedResponse(
      metadata.resource_metadata_url,
      "invalid_token",
      "Invalid or expired token",
    );
    return new Response(denied.body, {
      status: denied.status,
      headers: mergeHeaders(baseResponse.headers, denied.headers),
    });
  }

  function jsonRpc(
    baseResponse: Response,
    payload: Record<string, unknown>,
    status: number,
  ): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", ...payload }), {
      status,
      headers: mergeHeaders(
        baseResponse.headers,
        new Headers({
          "Content-Type": "application/json",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
        }),
      ),
    });
  }

  function failure(
    baseResponse: Response,
    id: string | number,
    error: EventsProtocolError,
  ): Response {
    log(`events rpc refused code=${error.code}`);
    return jsonRpc(
      baseResponse,
      { id, error: error.toJsonRpcError() },
      error.httpStatus,
    );
  }

  /** Cùng phong bì mà `stampResult` của lõi đóng: `resultType` cộng serverInfo trong `_meta`. */
  function stamp(result: Record<string, unknown>): Record<string, unknown> {
    const existingMeta = isRecord(result._meta) ? result._meta : undefined;
    return {
      ...result,
      resultType: "complete",
      _meta: { ...existingMeta, [SERVER_INFO_KEY]: { ...serverInfo } },
    };
  }

  async function dispatch(
    method: EventsMethod,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    if (method === "events/list") {
      const listParams = params === undefined ? {} : params;
      if (!isRecord(listParams)) {
        throw new EventsProtocolError(EventsErrorCode.InvalidParams, {
          field: "params",
        });
      }
      return { ...handleEventsList(listParams) };
    }
    if (method === "events/subscribe") {
      return { ...await store.subscribe(parseSubscribeParams(params)) };
    }
    return { ...await store.unsubscribe(parseUnsubscribeParams(params)) };
  }

  async function handleEvents(
    request: Request,
    rpc: PeekedRpc & { method: EventsMethod; id: string | number },
  ): Promise<Response> {
    const baseResponse = await base(request);
    // Chỉ nhận việc khi handler gốc đã cho qua mọi cổng và chỉ còn thiếu method.
    if (!await isMethodNotFound(baseResponse, rpc.method)) return baseResponse;

    const authInfo = await verify(request);
    if (!authInfo) return unauthorized(baseResponse);

    const identity = resolveCallerIdentity(authInfo, request.headers);
    if (!identity) {
      return failure(
        baseResponse,
        rpc.id,
        new EventsProtocolError(EventsErrorCode.Forbidden),
      );
    }

    if (NAMED_METHODS.has(rpc.method) && !nameHeaderMatches(request, rpc)) {
      return failure(
        baseResponse,
        rpc.id,
        new EventsProtocolError(EventsErrorCode.HeaderMismatch),
      );
    }

    try {
      const run = () =>
        runWithCaller(identity, () => dispatch(rpc.method, rpc.params));
      // events/list chỉ đọc danh mục trong bộ nhớ; chỉ việc gọi ERP mới cần giới hạn.
      const result = rpc.method === "events/list"
        ? await run()
        : await limit(run);
      log(`events rpc ok method=${rpc.method}`);
      return jsonRpc(baseResponse, { id: rpc.id, result: stamp(result) }, 200);
    } catch (error) {
      if (error instanceof EventsAuthError) return unauthorized(baseResponse);
      if (error instanceof EventsBusyError) {
        log(`events rpc refused busy method=${rpc.method}`);
        return jsonRpc(baseResponse, {
          id: rpc.id,
          error: {
            code: EventsErrorCode.InternalError,
            message: "Server busy",
          },
        }, 503);
      }
      if (error instanceof EventsProtocolError) {
        return failure(baseResponse, rpc.id, error);
      }
      return failure(
        baseResponse,
        rpc.id,
        new EventsProtocolError(EventsErrorCode.InternalError),
      );
    }
  }

  /** Thêm `capabilities.events` vào kết quả discover/initialize đã thành công của handler gốc. */
  async function withEventsCapability(
    request: Request,
    response: Response,
  ): Promise<Response> {
    if (response.status !== 200) return response;
    const authInfo = await verify(request);
    if (!authInfo || !resolveCallerIdentity(authInfo, request.headers)) {
      return response;
    }
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (!isRecord(body) || !isRecord(body.result)) return response;
    const capabilities = body.result.capabilities;
    if (!isRecord(capabilities)) return response;
    const merged = {
      ...body,
      result: {
        ...body.result,
        capabilities: { ...capabilities, events: capabilities.events ?? {} },
      },
    };
    return new Response(JSON.stringify(merged), {
      status: response.status,
      headers: mergeHeaders(response.headers, new Headers()),
    });
  }

  return async (request) => {
    const rpc = await peekRpc(request, maxBodyBytes, peekBudget, peekTimeoutMs);
    if (rpc === PEEK_BUSY) {
      log("events rpc refused busy peek budget exhausted");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: EventsErrorCode.InternalError,
            message: "Server busy",
          },
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "1",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
          },
        },
      );
    }
    if (rpc === null) return await base(request);

    if (rpc.method === "server/discover" || rpc.method === "initialize") {
      return await withEventsCapability(request, await base(request));
    }
    if (isEventsMethod(rpc.method) && isRequestId(rpc.id)) {
      return await handleEvents(
        request,
        { ...rpc, method: rpc.method, id: rpc.id },
      );
    }
    return await base(request);
  };
}
