/**
 * Giao thức MCP Events cho lịch họp: catalog schema, kiểm tra tham số, lỗi JSON-RPC và ánh xạ kết
 * quả từ ERP.
 *
 * Module này KHÔNG chạm mạng, KHÔNG biết SDK và KHÔNG lưu gì: nó chỉ biến một request đã xác thực
 * thành dữ liệu sạch (hoặc một `EventsProtocolError`) và ngược lại biến kết quả của ERP thành kết
 * quả trên dây. Không có API giả của SDK nào ở đây (SDK 0.25 không có `registerEvent`).
 *
 * Quy tắc xuyên suốt: thông báo lỗi là chuỗi CỐ ĐỊNH theo mã. Không bao giờ phản chiếu body hay
 * thông điệp thô của ERP, và không bao giờ chứa URL callback, secret hay giá trị người gọi gửi,
 * để người gọi không dùng phản hồi lỗi làm oracle.
 *
 * @module lib/erpnext/src/events/protocol
 */

import contract from "./contract/meeting-events.v1.json" with { type: "json" };
import { validateJsonSchema } from "./json-schema.ts";

// ── Hằng số giao thức ────────────────────────────────────────────────────────

export const EVENTS_METHODS = [
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
] as const;
export type EventsMethod = (typeof EVENTS_METHODS)[number];

export function isEventsMethod(value: unknown): value is EventsMethod {
  return typeof value === "string" &&
    (EVENTS_METHODS as readonly string[]).includes(value);
}

/** Mã lỗi Events (theo draft của MCP Events) cộng hai mã JSON-RPC lõi mà module này dùng. */
export const EventsErrorCode = {
  HeaderMismatch: -32020,
  InvalidParams: -32602,
  InternalError: -32603,
  EventNotFound: -32011,
  Forbidden: -32012,
  QuotaExceeded: -32013,
  UnsupportedDelivery: -32014,
  CallbackFailed: -32015,
} as const;
export type EventsErrorCodeValue =
  (typeof EventsErrorCode)[keyof typeof EventsErrorCode];

/** Thông điệp cố định theo mã. Không bao giờ ghép giá trị của người gọi vào đây. */
const ERROR_MESSAGES: Record<EventsErrorCodeValue, string> = {
  [EventsErrorCode.HeaderMismatch]: "Header mismatch",
  [EventsErrorCode.InvalidParams]: "Invalid params",
  [EventsErrorCode.InternalError]: "Events backend error",
  [EventsErrorCode.EventNotFound]: "Unknown event name",
  [EventsErrorCode.Forbidden]: "Not allowed to use this event",
  [EventsErrorCode.QuotaExceeded]: "Subscription limit reached",
  [EventsErrorCode.UnsupportedDelivery]: "Unsupported delivery",
  [EventsErrorCode.CallbackFailed]: "Callback verification failed",
};

const ERROR_HTTP_STATUS: Record<EventsErrorCodeValue, number> = {
  [EventsErrorCode.HeaderMismatch]: 400,
  [EventsErrorCode.InvalidParams]: 400,
  [EventsErrorCode.InternalError]: 502,
  [EventsErrorCode.EventNotFound]: 404,
  [EventsErrorCode.Forbidden]: 403,
  [EventsErrorCode.QuotaExceeded]: 429,
  [EventsErrorCode.UnsupportedDelivery]: 400,
  [EventsErrorCode.CallbackFailed]: 502,
};

/** Lý do callback hỏng mà ERP được phép báo ra ngoài (danh sách đóng, không phải chuỗi tự do). */
export const CALLBACK_FAILURE_REASONS = [
  "connection_refused",
  "timeout",
  "tls_error",
  "http_4xx",
  "http_5xx",
  "challenge_failed",
] as const;

export class EventsProtocolError extends Error {
  readonly code: EventsErrorCodeValue;
  readonly httpStatus: number;
  readonly data?: Record<string, unknown>;

  constructor(code: EventsErrorCodeValue, data?: Record<string, unknown>) {
    super(ERROR_MESSAGES[code]);
    this.name = "EventsProtocolError";
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    if (data && Object.keys(data).length > 0) this.data = data;
  }

  toJsonRpcError(): { code: number; message: string; data?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.data ? { data: this.data } : {}),
    };
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export type JsonSchemaObject = Record<string, unknown>;

export interface EventDescriptor {
  name: string;
  description: string;
  delivery: ["webhook"];
  inputSchema: JsonSchemaObject;
  payloadSchema: JsonSchemaObject;
}

export const MEETING_EVENT_NAMES: readonly string[] = contract.events.map((
  event,
) => event.name);

/** Schema payload chung. Cả ba descriptor trỏ tới đúng đối tượng này. */
export const PAYLOAD_SCHEMA: JsonSchemaObject = contract.payloadSchema;
export const EVENT_INPUT_SCHEMA: JsonSchemaObject = contract.inputSchema;

/** `change` mà payload của mỗi event phải mang, ví dụ `meeting.created` -> `created`. */
export const CHANGE_BY_EVENT: Readonly<Record<string, string>> =
  contract.changeByEvent;

const CATALOG: readonly EventDescriptor[] = contract.events.map((event) => ({
  name: event.name,
  description: event.description,
  delivery: ["webhook"],
  inputSchema: EVENT_INPUT_SCHEMA,
  payloadSchema: PAYLOAD_SCHEMA,
}));

export function eventCatalog(): readonly EventDescriptor[] {
  return CATALOG;
}

/**
 * Kiểm một payload (`data`) của event `name` theo hợp đồng chung, gồm cả ràng buộc `change` khớp
 * tên event. Trả về danh sách lỗi, rỗng nghĩa là hợp lệ. Dùng cho contract test và fixture; MCP
 * không tự phát payload nên không gọi hàm này ở đường chạy thật.
 */
export function validateEventPayload(name: string, data: unknown): string[] {
  const expectedChange = CHANGE_BY_EVENT[name];
  if (expectedChange === undefined) return ["name: unknown event"];
  const errors = validateJsonSchema(PAYLOAD_SCHEMA, data);
  if (
    typeof data === "object" && data !== null &&
    (data as Record<string, unknown>).change !== expectedChange
  ) {
    errors.push("/change: does not match event name");
  }
  return errors;
}

// ── events/list ──────────────────────────────────────────────────────────────

export function handleEventsList(params: Record<string, unknown>) {
  const cursor = params.cursor;
  // Catalog nhỏ và luôn nằm gọn trong một trang, nên server không bao giờ phát cursor. Một cursor
  // do người gọi tự đưa lên chỉ có thể là rác.
  if (cursor !== undefined && cursor !== null) {
    throw new EventsProtocolError(EventsErrorCode.InvalidParams, {
      field: "cursor",
    });
  }
  return { events: CATALOG.map((descriptor) => ({ ...descriptor })) };
}

// ── Kiểm tra tham số subscribe và unsubscribe ───────────────────────────────

export interface SubscribeRequest {
  name: string;
  arguments: Record<string, unknown>;
  deliveryUrl: string;
  deliverySecret: string;
  /** `undefined` là không gửi (ERP dùng mặc định), `null` là yêu cầu không hết hạn. */
  ttlMs?: number | null;
  cursor?: string | null;
  /** Cursor cũ hơn mức này (mili giây) bị ERP báo cắt; chỉ thu hẹp, không nới cửa sổ replay của server. */
  maxAgeMs?: number;
}

export interface UnsubscribeRequest {
  name: string;
  arguments: Record<string, unknown>;
  deliveryUrl: string;
}

const MAX_URL_LENGTH = 2048;
const MAX_CURSOR_LENGTH = 1024;
const SECRET_PREFIX = "whsec_";
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string): EventsProtocolError {
  return new EventsProtocolError(EventsErrorCode.InvalidParams, { field });
}

/** `whsec_` cộng base64 chuẩn giải mã ra 24 đến 64 byte (Standard Webhooks). */
export function isValidSigningSecret(secret: unknown): boolean {
  if (typeof secret !== "string" || !secret.startsWith(SECRET_PREFIX)) {
    return false;
  }
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const bytes = (encoded.length / 4) * 3 - padding;
  return bytes >= SECRET_MIN_BYTES && bytes <= SECRET_MAX_BYTES;
}

function parseCallbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid("delivery.url");
  }
  if (value.length > MAX_URL_LENGTH) throw invalid("delivery.url");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid("delivery.url");
  }
  // Chỉ kiểm hình dạng. Việc chặn SSRF (phân giải DNS, IP không công khai, redirect) là của ERP
  // vì chính ERP mới là bên gửi callback.
  if (parsed.protocol !== "https:") throw invalid("delivery.url");
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalid("delivery.url");
  }
  if (parsed.hostname === "") throw invalid("delivery.url");
  return value;
}

function parseEventName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalid("name");
  if (!MEETING_EVENT_NAMES.includes(value)) {
    throw new EventsProtocolError(EventsErrorCode.EventNotFound);
  }
  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  const candidate = value === undefined ? {} : value;
  if (!isRecord(candidate)) throw invalid("arguments");
  if (validateJsonSchema(EVENT_INPUT_SCHEMA, candidate).length > 0) {
    throw invalid("arguments");
  }
  return candidate;
}

/** Chấp nhận `mode: "webhook"` và đúng tập khoá cho phép, mọi thứ khác là -32014. */
function parseDelivery(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) throw invalid("delivery");
  if (value.mode !== "webhook") {
    throw new EventsProtocolError(EventsErrorCode.UnsupportedDelivery, {
      supportedModes: ["webhook"],
    });
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new EventsProtocolError(EventsErrorCode.UnsupportedDelivery, {
        supportedModes: ["webhook"],
      });
    }
  }
  return value;
}

const SUBSCRIBE_KEYS = [
  "name",
  "arguments",
  "delivery",
  "ttlMs",
  "cursor",
  "maxAgeMs",
  "_meta",
] as const;
const UNSUBSCRIBE_KEYS = ["name", "arguments", "delivery", "_meta"] as const;

/**
 * Từ chối khoá cấp cao lạ: một lỗi gõ như `argumnts` sẽ bị coi là thiếu `arguments` và thành đăng ký
 * không lọc (hoặc hủy nhầm đối tượng khác) thay vì lỗi -32602.
 */
function rejectUnknownKeys(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(params)) {
    // Tên khoá lạ là dữ liệu do client gửi: chỉ phản chiếu khi nó trông như một tên trường an toàn, nếu không
    // (URL callback, secret hay ký tự điều khiển lọt vào tên khoá) thì chỉ báo chung là `params`.
    if (!allowed.includes(key)) {
      throw invalid(SAFE_FIELD_PATTERN.test(key) ? `params.${key}` : "params");
    }
  }
}

export function parseSubscribeParams(params: unknown): SubscribeRequest {
  if (!isRecord(params)) throw invalid("params");
  rejectUnknownKeys(params, SUBSCRIBE_KEYS);
  const name = parseEventName(params.name);
  const delivery = parseDelivery(params.delivery, ["mode", "url", "secret"]);
  const deliveryUrl = parseCallbackUrl(delivery.url);
  if (!isValidSigningSecret(delivery.secret)) throw invalid("delivery.secret");
  const args = parseArguments(params.arguments);

  const request: SubscribeRequest = {
    name,
    arguments: args,
    deliveryUrl,
    deliverySecret: delivery.secret as string,
  };

  if (params.ttlMs !== undefined) {
    const ttl = params.ttlMs;
    // TTL chỉ là gợi ý: server nâng giá trị quá ngắn lên mức tối thiểu của nó, nên 0 hợp lệ và không bị từ chối.
    if (ttl !== null && !(Number.isSafeInteger(ttl) && (ttl as number) >= 0)) {
      throw invalid("ttlMs");
    }
    request.ttlMs = ttl as number | null;
  }
  if (params.maxAgeMs !== undefined) {
    const maxAge = params.maxAgeMs;
    if (!(Number.isSafeInteger(maxAge) && (maxAge as number) > 0)) {
      throw invalid("maxAgeMs");
    }
    request.maxAgeMs = maxAge as number;
  }
  if (params.cursor !== undefined) {
    const cursor = params.cursor;
    if (
      cursor !== null &&
      !isReplayableCursor(cursor)
    ) {
      throw invalid("cursor");
    }
    request.cursor = cursor as string | null;
  }
  return request;
}

export function parseUnsubscribeParams(params: unknown): UnsubscribeRequest {
  if (!isRecord(params)) throw invalid("params");
  rejectUnknownKeys(params, UNSUBSCRIBE_KEYS);
  const name = parseEventName(params.name);
  // `secret` được chấp nhận nhưng bị bỏ qua: hủy không cần secret và secret không được đi tiếp.
  // Hủy chỉ cần `url`: `mode` có thể vắng (client tuân thủ không bắt buộc gửi), nhưng nếu có thì
  // vẫn phải là `webhook` để không nhận nhầm một kiểu giao khác.
  const rawDelivery =
    isRecord(params.delivery) && params.delivery.mode === undefined
      ? { ...params.delivery, mode: "webhook" }
      : params.delivery;
  const delivery = parseDelivery(rawDelivery, ["mode", "url", "secret"]);
  return {
    name,
    arguments: parseArguments(params.arguments),
    deliveryUrl: parseCallbackUrl(delivery.url),
  };
}

// ── Kết quả và lỗi từ ERP ───────────────────────────────────────────────────

export interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: string | null;
  truncated: boolean;
}

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Chuỗi khớp hình dạng ISO UTC và là một thời điểm có thật (không có tháng 99 hay ngày 31/02). */
export function isRealUtcInstant(value: string): boolean {
  if (!ISO_UTC_PATTERN.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, 19)
    .split(/[-T:]/).map(Number);
  const moment = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day &&
    moment.getUTCHours() === hour && moment.getUTCMinutes() === minute &&
    moment.getUTCSeconds() === second;
}

/**
 * So hai thời điểm ISO UTC đã qua `isRealUtcInstant`: âm nếu `a` đứng trước `b`, 0 nếu bằng nhau, dương nếu sau.
 * Phần thập phân được so đủ mọi chữ số (`Date.parse` cắt ở mili giây nên `.9999` và `.9990` sẽ bị coi là bằng nhau).
 */
export function compareUtcInstants(a: string, b: string): number {
  const secondsA = Date.parse(`${a.slice(0, 19)}Z`);
  const secondsB = Date.parse(`${b.slice(0, 19)}Z`);
  if (secondsA !== secondsB) return secondsA < secondsB ? -1 : 1;
  return compareFractions(a.slice(20, -1), b.slice(20, -1));
}

/** So hai phần thập phân của giây (chỉ các chữ số) như số thực: `5` bằng `50`, `9999` lớn hơn `999`. */
export function compareFractions(a: string, b: string): number {
  const width = Math.max(a.length, b.length);
  const left = a.padEnd(width, "0");
  const right = b.padEnd(width, "0");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày lịch có thật theo dạng `YYYY-MM-DD` (loại `2030-02-30`). */
export function isRealDate(value: unknown): boolean {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const moment = new Date(Date.UTC(year, month - 1, day));
  return moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day;
}

/**
 * Cursor mà client có thể gửi lại ở lần refresh sau: chuỗi không rỗng, không dài quá giới hạn. Dùng chung
 * cho cursor client gửi lên và cursor ERP trả về, để server không bao giờ phát cursor chính nó từ chối.
 */
export function isReplayableCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH;
}

function malformedBackend(): EventsProtocolError {
  return new EventsProtocolError(EventsErrorCode.InternalError);
}

/** Đổi kết quả subscribe của ERP (snake_case) sang kết quả trên dây (camelCase) và kiểm hình dạng. */
export function toSubscribeResult(raw: unknown): SubscribeResult {
  if (!isRecord(raw)) throw malformedBackend();
  const { id, refresh_before, truncated } = raw;
  // Hợp đồng Events: cursor trong phản hồi là tuỳ chọn và nullable, vắng mặt được hiểu như `null`.
  const cursor = raw.cursor === undefined ? null : raw.cursor;
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw malformedBackend();
  }
  if (
    typeof refresh_before !== "string" || !isRealUtcInstant(refresh_before)
  ) {
    throw malformedBackend();
  }
  if (cursor !== null && !isReplayableCursor(cursor)) throw malformedBackend();
  if (typeof truncated !== "boolean") throw malformedBackend();
  return {
    id,
    refreshBefore: refresh_before,
    cursor: cursor as string | null,
    truncated,
  };
}

const SAFE_FIELD_PATTERN = /^[a-zA-Z0-9_.]{1,40}$/;

/**
 * Dữ liệu hạn mức theo hợp đồng Events: `limit` là tên hạn mức, `max` là trần (tuỳ chọn). Chỉ hai trường
 * vô hướng đó đi qua; tên hạn mức phải khớp mẫu an toàn và `max` phải là số hữu hạn.
 */
function pickLimit(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof data.limit !== "string" || !SAFE_FIELD_PATTERN.test(data.limit)) {
    return undefined;
  }
  const safe: Record<string, unknown> = { limit: data.limit };
  if (typeof data.max === "number" && Number.isFinite(data.max)) {
    safe.max = data.max;
  }
  return safe;
}

/**
 * Đổi `error` của ERP thành lỗi giao thức. Chỉ mã nằm trong danh sách đóng được giữ nguyên; mọi
 * mã khác thành -32603. Thông điệp của ERP bị bỏ, `data` chỉ đi qua một danh sách cho phép hẹp.
 */
export function mapErpError(raw: unknown): EventsProtocolError {
  if (!isRecord(raw) || typeof raw.code !== "number") return malformedBackend();
  const data = isRecord(raw.data) ? raw.data : {};
  switch (raw.code) {
    case EventsErrorCode.InvalidParams: {
      const field = typeof data.field === "string" &&
          SAFE_FIELD_PATTERN.test(data.field)
        ? data.field
        : undefined;
      return new EventsProtocolError(
        EventsErrorCode.InvalidParams,
        field ? { field } : undefined,
      );
    }
    case EventsErrorCode.EventNotFound:
    case EventsErrorCode.Forbidden:
      return new EventsProtocolError(raw.code);
    case EventsErrorCode.QuotaExceeded: {
      return new EventsProtocolError(
        EventsErrorCode.QuotaExceeded,
        pickLimit(data),
      );
    }
    case EventsErrorCode.UnsupportedDelivery:
      return new EventsProtocolError(EventsErrorCode.UnsupportedDelivery, {
        supportedModes: ["webhook"],
      });
    case EventsErrorCode.CallbackFailed: {
      const reason = (CALLBACK_FAILURE_REASONS as readonly unknown[]).includes(
          data.reason,
        )
        ? data.reason
        : undefined;
      return new EventsProtocolError(
        EventsErrorCode.CallbackFailed,
        reason ? { reason } : undefined,
      );
    }
    default:
      return malformedBackend();
  }
}
