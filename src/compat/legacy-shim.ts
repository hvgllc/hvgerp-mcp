/**
 * Shim tương thích cho client MCP đời cũ đứng trước server chỉ nói 2026-07-28.
 *
 * Bối cảnh đo được trên dây: Claude Cowork mở phiên bằng `initialize` với
 * `protocolVersion: "2025-11-25"` và KHÔNG gửi header `MCP-Protocol-Version`,
 * nên server trả 400 kèm `-32020`; Cowork hiểu đó là "không phải endpoint
 * Streamable HTTP đời mới" rồi tụt xuống transport HTTP+SSE cũ bằng
 * `GET /mcp`, và nhận tiếp 405. Claude chat thì gửi đúng bộ header
 * 2026-07-28 nên chạy bình thường.
 *
 * Shim này dịch đúng hai chiều đó và không đụng gì tới luồng đã chạy được:
 * request nào đã mang `MCP-Protocol-Version: 2026-07-28` được chuyển tiếp
 * nguyên trạng, không parse, không sửa.
 *
 * Ba khác biệt phải bắc cầu, theo đúng thứ tự mà server kiểm tra:
 *
 * 1. Header. Mọi POST có `id` phải mang `MCP-Protocol-Version` khớp với
 *    `params._meta["io.modelcontextprotocol/protocolVersion"]`, `Mcp-Method`
 *    khớp `method`, và `Mcp-Name` khớp trường định danh với những method có
 *    một (`tools/call`, `resources/read`, ...). Notification (không `id`)
 *    được miễn.
 * 2. Body. `params._meta` phải mang protocolVersion và `clientCapabilities`
 *    dạng object; thiếu là `-32602`.
 * 3. Verb và mã trạng thái. `GET /mcp` (stream SSE cũ) và `DELETE /mcp`
 *    (đóng phiên) không còn tồn tại nên server trả 405; method không còn
 *    tồn tại (`ping`, `logging/setLevel`) trả HTTP 404 chứ không phải 200.
 *    Client cũ đọc cả hai như "endpoint chết".
 */

/** Revision duy nhất mà server chấp nhận. */
export const SPEC_2026_07_28 = "2026-07-28";

/** Revision giả định cho client cũ khi không tự khai báo. */
export const LEGACY_FALLBACK_VERSION = "2025-11-25";

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** Trường trong `params` mà `Mcp-Name` phải soi gương, theo method. */
const NAME_SOURCE: Readonly<Record<string, "name" | "uri" | "taskId">> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
};

/**
 * Method đã bị gỡ khỏi 2026-07-28 nhưng client cũ vẫn gọi, và shim tự trả lời.
 *
 * Chuyển tiếp lên server chỉ nhận về HTTP 404 kèm `-32601`. Với `ping` đó là
 * hỏng thật: client cũ dùng ping làm keepalive và đọc 404 như mất endpoint,
 * nên nó phải được trả lời tại chỗ bằng result rỗng đúng như spec cũ.
 */
const LOCALLY_ANSWERED = new Set(["ping", "logging/setLevel"]);

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/** RFC 9110 field-value: quyết định giá trị nào được gửi thô. */
const HEADER_SAFE_VALUE = /^(?:[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?)?$/;

/**
 * Header hop-by-hop và header do tầng vận chuyển tự tính, không được chuyển tiếp.
 *
 * `content-length` nằm trong danh sách vì shim viết lại thân request, còn
 * `accept-encoding` bị cắt để upstream trả thân chưa nén: shim phải đọc và sửa
 * JSON, và một thân đã nén sẽ phải giải nén thủ công không vì lợi ích gì.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/** Header MCP mà shim tự dựng lại, nên bản của client bị bỏ đi. */
const SHIM_OWNED_HEADERS = new Set([
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
]);

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

/** Danh tính client điền vào `_meta` khi bản thân request không mang theo. */
export interface ClientIdentity {
  name: string;
  version: string;
}

export interface ShimOptions {
  /** Gốc URL của server thật, ví dụ `http://hvgerp-mcp-origin:7654`. */
  upstream: string;
  /** Nhịp heartbeat cho stream SSE giả, tính bằng mili giây. */
  heartbeatMs?: number;
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bọc giá trị header theo sentinel base64 khi nó không phải ASCII an toàn.
 *
 * Sao đúng thuật toán của server: nó từ chối một giá trị ngoài tập an toàn mà
 * gửi thô, và cũng từ chối một giá trị thô trông y hệt sentinel.
 */
export function encodeHeaderValue(value: string): string {
  const looksLikeSentinel = value.startsWith(SENTINEL_PREFIX) &&
    value.endsWith(SENTINEL_SUFFIX);
  if (HEADER_SAFE_VALUE.test(value) && !looksLikeSentinel) return value;

  const utf8 = new TextEncoder().encode(value);
  let latin1 = "";
  for (const byte of utf8) latin1 += String.fromCharCode(byte);
  return `${SENTINEL_PREFIX}${btoa(latin1)}${SENTINEL_SUFFIX}`;
}

/**
 * Request đã nói đúng revision hiện hành hay chưa.
 *
 * Đây là công tắc duy nhất quyết định shim có đụng vào request hay không, nên
 * nó cố tình hẹp: chỉ header khớp tuyệt đối mới được đi thẳng.
 */
export function isModernRequest(headers: Headers): boolean {
  return headers.get("MCP-Protocol-Version") === SPEC_2026_07_28;
}

/** Revision mà client cũ tự nhận, để trả lại đúng thứ nó chờ đợi. */
export function readClientProtocolVersion(
  headers: Headers,
  message: JsonRpcMessage | JsonRpcMessage[] | undefined,
): string {
  const fromHeader = headers.get("MCP-Protocol-Version");
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return fromHeader;
  }
  const first = Array.isArray(message) ? message[0] : message;
  const params = first?.params;
  if (isRecord(params) && typeof params["protocolVersion"] === "string") {
    return params["protocolVersion"];
  }
  return LEGACY_FALLBACK_VERSION;
}

/** Suy ra danh tính client từ header Anthropic gửi kèm, để log server có nghĩa. */
export function readClientIdentity(
  headers: Headers,
  clientVersion: string,
): ClientIdentity {
  const vendor = headers.get("X-Anthropic-Client") ??
    headers.get("User-Agent") ?? "legacy-mcp-client";
  return { name: `${vendor} (via compat shim)`, version: clientVersion };
}

export interface OutboundMessage {
  message: JsonRpcMessage;
  headers: Record<string, string>;
}

/**
 * Nâng một message đời cũ lên đúng hình dạng 2026-07-28.
 *
 * Chỉ thêm, không xoá: `_meta` sẵn có của client được giữ nguyên trừ khoá
 * protocolVersion, vì đó là thứ duy nhất bắt buộc phải khớp header.
 */
export function rewriteOutbound(
  message: JsonRpcMessage,
  identity: ClientIdentity,
): OutboundMessage {
  const method = typeof message.method === "string" ? message.method : "";
  const params = isRecord(message.params) ? { ...message.params } : {};
  const meta = isRecord(params["_meta"]) ? { ...params["_meta"] } : {};

  meta[META_PROTOCOL_VERSION] = SPEC_2026_07_28;
  if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
    meta[META_CLIENT_CAPABILITIES] = isRecord(params["capabilities"])
      ? params["capabilities"]
      : {};
  }
  if (!isRecord(meta[META_CLIENT_INFO])) {
    meta[META_CLIENT_INFO] = isRecord(params["clientInfo"])
      ? params["clientInfo"]
      : identity;
  }
  params["_meta"] = meta;

  // `initialize` mang protocolVersion ở cả hai chỗ trong bản cũ. Server đọc
  // `_meta`, nhưng để lại "2025-11-25" trong params là bỏ lại một mâu thuẫn
  // ngay trong cùng một thân request.
  if (method === "initialize") {
    params["protocolVersion"] = SPEC_2026_07_28;
  }

  const headers: Record<string, string> = {
    "MCP-Protocol-Version": SPEC_2026_07_28,
    "Mcp-Method": method,
  };

  const nameField = NAME_SOURCE[method];
  if (nameField !== undefined) {
    const value = params[nameField];
    // Giá trị không phải chuỗi là request hỏng của client. Bỏ qua header ở đây
    // để server trả về đúng lỗi của nó thay vì shim bịa ra một lỗi khác.
    if (typeof value === "string") {
      headers["Mcp-Name"] = encodeHeaderValue(value);
    }
  }

  return { message: { ...message, params }, headers };
}

/**
 * Hạ một result 2026-07-28 về hình dạng mà client cũ chờ đợi.
 *
 * `resultType` là trường của phong bì mới, không tồn tại ở 2025-11-25;
 * `protocolVersion` trong result của `initialize` phải là bản mà client đã
 * đề nghị, nếu không client coi như thương lượng thất bại.
 */
export function rewriteInbound(
  payload: unknown,
  clientVersion: string,
): unknown {
  if (Array.isArray(payload)) {
    return payload.map((entry) => rewriteInbound(entry, clientVersion));
  }
  if (!isRecord(payload) || !isRecord(payload["result"])) return payload;

  const result = { ...payload["result"] };
  delete result["resultType"];
  if (typeof result["protocolVersion"] === "string") {
    result["protocolVersion"] = clientVersion;
  }
  return { ...payload, result };
}

function filterHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [key, value] of source) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || SHIM_OWNED_HEADERS.has(lower)) continue;
    out.set(key, value);
  }
  return out;
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code, message },
  };
}

interface ForwardOutcome {
  /**
   * Thân JSON-RPC đã dịch, hoặc `undefined` khi upstream không trả JSON
   * (202 không thân, stream SSE, trang lỗi của tầng dưới).
   */
  payload?: unknown;
  status: number;
  /** Response gốc, còn nguyên thân chưa đọc khi `payload` là `undefined`. */
  response: Response;
}

async function forwardOne(
  message: JsonRpcMessage,
  req: Request,
  target: URL,
  identity: ClientIdentity,
  clientVersion: string,
): Promise<ForwardOutcome> {
  const { message: outbound, headers: mcpHeaders } = rewriteOutbound(
    message,
    identity,
  );
  const headers = filterHeaders(req.headers);
  for (const [key, value] of Object.entries(mcpHeaders)) {
    headers.set(key, value);
  }
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");

  const res = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify(outbound),
  });

  const contentType = res.headers.get("Content-Type") ?? "";
  if (res.status === 202 || !contentType.includes("application/json")) {
    return { status: res.status, response: res };
  }

  const payload = rewriteInbound(await res.json(), clientVersion);

  // Spec 2026-07-28 bắt method lạ trả HTTP 404 để client phân biệt endpoint
  // MCP đời mới với server HTTP+SSE cũ. Ở transport cũ, mọi lỗi JSON-RPC đi
  // kèm HTTP 200; 404 làm client vứt cả endpoint thay vì báo lỗi một lời gọi.
  const status = res.status === 404 ? 200 : res.status;
  return { payload, status, response: res };
}

/** Stream SSE rỗng thay cho 405, đúng vai `GET /mcp` của transport cũ. */
function openLegacyStream(heartbeatMs: number): Response {
  let timer: number | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Client cũ chờ stream mở và im lặng: server-initiated message ở
      // revision mới đi qua `subscriptions/listen`, không qua đây. Heartbeat
      // chỉ để Cloudflare và các proxy trung gian không đóng kết nối rỗng.
      controller.enqueue(encoder.encode(": connected\n\n"));
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          if (timer !== undefined) clearInterval(timer);
        }
      }, heartbeatMs) as unknown as number;
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Tắt buffering của proxy ngược, nếu không stream sẽ nằm im trong bộ đệm.
      "X-Accel-Buffering": "no",
    },
  });
}

async function proxyPassThrough(req: Request, target: URL): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of req.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Bắt buộc khi thân là stream chưa đọc hết, nếu không fetch từ chối gửi.
    init.duplex = "half";
  }
  return await fetch(target, init);
}

/**
 * Điểm vào duy nhất của shim.
 *
 * Thứ tự nhánh là cố ý: luồng hiện đại được nhận ra trước hết và đi thẳng, nên
 * một lỗi trong phần dịch không thể làm hỏng đường đang chạy tốt.
 */
export async function handleShimRequest(
  req: Request,
  opts: ShimOptions,
): Promise<Response> {
  const url = new URL(req.url);
  const target = new URL(url.pathname + url.search, opts.upstream);
  const isMcpPath = url.pathname === "/mcp" || url.pathname === "/";

  if (!isMcpPath) return await proxyPassThrough(req, target);

  if (req.method === "GET") {
    const accept = req.headers.get("Accept") ?? "";
    // Client hiện đại không mở stream ở đây, nên chỉ nhận SSE mới đổi hành vi;
    // còn lại vẫn để server trả 405 của chính nó.
    if (accept.includes("text/event-stream")) {
      return openLegacyStream(opts.heartbeatMs ?? 15_000);
    }
    return await proxyPassThrough(req, target);
  }

  // Transport cũ đóng phiên bằng DELETE. Server stateless không có phiên để
  // đóng, nên câu trả lời đúng là "đã xong", không phải "verb không hợp lệ".
  if (req.method === "DELETE") return new Response(null, { status: 204 });

  if (req.method !== "POST" || isModernRequest(req.headers)) {
    return await proxyPassThrough(req, target);
  }

  const raw = await req.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error"), {
      status: 400,
    });
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const clientVersion = readClientProtocolVersion(
    req.headers,
    parsed as JsonRpcMessage | JsonRpcMessage[],
  );
  const identity = readClientIdentity(req.headers, clientVersion);

  const replies: unknown[] = [];
  let status = 200;
  let upstreamHeaders: Headers | undefined;

  for (const entry of messages) {
    if (!isRecord(entry) || typeof entry["method"] !== "string") {
      replies.push(jsonRpcError(
        isRecord(entry) ? entry["id"] : null,
        -32600,
        "Invalid Request: missing 'method' field",
      ));
      continue;
    }

    const message = entry as JsonRpcMessage;
    const id = message.id;

    if (id !== undefined && LOCALLY_ANSWERED.has(message.method as string)) {
      replies.push({ jsonrpc: "2.0", id, result: {} });
      continue;
    }

    const outcome = await forwardOne(
      message,
      req,
      target,
      identity,
      clientVersion,
    );
    upstreamHeaders = outcome.response.headers;

    // Không có JSON để dịch thì không có gì để shim làm: trả nguyên response
    // của upstream, thân còn nguyên chưa đọc. Đây là đường của 401 kèm
    // `WWW-Authenticate` (thứ khởi động lại luồng OAuth), của 5xx, và của mọi
    // thân không phải JSON.
    if (outcome.payload === undefined && outcome.status !== 202) {
      return outcome.response;
    }
    if (outcome.status >= 400) status = outcome.status;
    if (outcome.payload !== undefined) replies.push(outcome.payload);
  }

  if (replies.length === 0) return new Response(null, { status: 202 });

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("MCP-Protocol-Version", clientVersion);
  const wwwAuthenticate = upstreamHeaders?.get("WWW-Authenticate");
  if (wwwAuthenticate !== null && wwwAuthenticate !== undefined) {
    headers.set("WWW-Authenticate", wwwAuthenticate);
  }

  const body = Array.isArray(parsed) ? replies : replies[0];
  return new Response(JSON.stringify(body), { status, headers });
}
