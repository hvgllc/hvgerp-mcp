/**
 * Proxy từ Events RPC sang API ERP, dùng bearer token của CHÍNH request đang xử lý.
 *
 * MCP không lưu gì ở đây: không secret, không token, không callback, không subscription. Trạng
 * thái bền nằm ở ERP. Mỗi lệnh gọi đi qua `getFrappeClient()` bên trong `runWithCaller` do adapter
 * dựng, nên header là `HVGKeycloak <token của người gọi>` và ERP tự xác minh lại danh tính.
 *
 * Hợp đồng với ERP: mọi method trả HTTP 200 với `message` là `{ok:true,result}` hoặc
 * `{ok:false,error:{code,message,data}}`. Lỗi xác thực là ngoại lệ: ERP raise PermissionError
 * (HTTP 401/403) và ở đây nó trở thành `EventsAuthError` để adapter trả HTTP 401 cho client.
 *
 * @module lib/erpnext/src/events/erp-store
 */

import { currentCaller } from "../api/caller-context.ts";
import {
  FrappeAPIError,
  type FrappeClient,
  getFrappeClient,
} from "../api/frappe-client.ts";
import {
  EventsErrorCode,
  EventsProtocolError,
  mapErpError,
  type SubscribeRequest,
  type SubscribeResult,
  toSubscribeResult,
  type UnsubscribeRequest,
} from "./protocol.ts";

export const ERP_EVENTS_METHODS = {
  subscribe: "hvg_workspace.mcp_events.api.subscribe",
  unsubscribe: "hvg_workspace.mcp_events.api.unsubscribe",
  meetingGet: "hvg_workspace.mcp_events.api.meeting_get",
} as const;

/** ERP từ chối bearer của request (HTTP 401/403). Adapter đổi thành HTTP 401 cho client. */
export class EventsAuthError extends Error {
  constructor() {
    super("ERP rejected the caller token");
    this.name = "EventsAuthError";
  }
}

export interface EventsStore {
  subscribe(request: SubscribeRequest): Promise<SubscribeResult>;
  unsubscribe(request: UnsubscribeRequest): Promise<Record<string, never>>;
}

export type ErpEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; error: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bóc phong bì `{ok,result|error}`. Hình dạng lạ là lỗi backend, không phải lỗi người dùng. */
export function unwrapErpEnvelope(message: unknown): ErpEnvelope {
  if (!isRecord(message) || typeof message.ok !== "boolean") {
    throw new EventsProtocolError(EventsErrorCode.InternalError);
  }
  if (message.ok) return { ok: true, result: message.result };
  return { ok: false, error: message.error };
}

/**
 * Đổi lỗi truyền tải của Frappe thành lỗi của giao thức Events. Không phản chiếu body của ERP.
 * 401/403 là lỗi xác thực; 429 là giới hạn tốc độ; phần còn lại là backend không dùng được.
 */
export function classifyTransportError(error: unknown): Error {
  if (error instanceof FrappeAPIError) {
    if (error.status === 401 || error.status === 403) {
      return new EventsAuthError();
    }
    if (error.status === 429) {
      return new EventsProtocolError(EventsErrorCode.QuotaExceeded);
    }
    return new EventsProtocolError(EventsErrorCode.InternalError);
  }
  if (
    error instanceof EventsProtocolError || error instanceof EventsAuthError
  ) {
    return error;
  }
  return new EventsProtocolError(EventsErrorCode.InternalError);
}

export interface ErpEventsStoreOptions {
  /** Lấy client; mặc định là client của người gọi hiện tại. Test tiêm client giả ở đây. */
  getClient?: () => FrappeClient;
}

async function callErp(
  getClient: () => FrappeClient,
  method: string,
  args: Record<string, unknown>,
  httpMethod: "GET" | "POST",
): Promise<unknown> {
  // Cổng an toàn cuối: lệnh gọi này luôn phải chạy thay mặt một người cụ thể, không bao giờ dưới
  // tài khoản dịch vụ dùng chung. Adapter đã đảm bảo điều này, kiểm lại ở đây để một đường gọi
  // sai trong tương lai thất bại lớn tiếng thay vì lặng lẽ đổi danh tính.
  if (!currentCaller()) {
    throw new EventsProtocolError(EventsErrorCode.Forbidden);
  }
  let message: unknown;
  try {
    message = await getClient().callMethod(method, args, { httpMethod });
  } catch (error) {
    throw classifyTransportError(error);
  }
  const envelope = unwrapErpEnvelope(message);
  if (!envelope.ok) throw mapErpError(envelope.error);
  return envelope.result;
}

export function createErpEventsStore(
  options: ErpEventsStoreOptions = {},
): EventsStore {
  const getClient = options.getClient ?? getFrappeClient;
  return {
    async subscribe(request) {
      const args: Record<string, unknown> = {
        name: request.name,
        arguments: request.arguments,
        delivery_url: request.deliveryUrl,
        delivery_secret: request.deliverySecret,
      };
      // Vắng mặt và `null` khác nhau: vắng là "dùng mặc định", null là "xin không hết hạn".
      if (request.ttlMs !== undefined) args.ttl_ms = request.ttlMs;
      if (request.cursor !== undefined) args.cursor = request.cursor;
      const result = await callErp(
        getClient,
        ERP_EVENTS_METHODS.subscribe,
        args,
        "POST",
      );
      return toSubscribeResult(result);
    },

    async unsubscribe(request) {
      await callErp(getClient, ERP_EVENTS_METHODS.unsubscribe, {
        name: request.name,
        arguments: request.arguments,
        delivery_url: request.deliveryUrl,
      }, "POST");
      // Kết quả nghiệp vụ của hủy luôn là {} (idempotent), bất kể ERP trả gì trong `result`.
      return {};
    },
  };
}

/** Tham số của `meeting_get`. Chỉ mang định danh và cửa sổ thời gian, không bao giờ có user. */
export interface MeetingGetArgs {
  event_id: string;
  occurrence_start?: string;
  window_start?: string;
  window_end?: string;
}

/**
 * Đọc lại trạng thái lịch họp từ ERP bằng GET, luôn tươi: `callMethod` không có cache và client
 * truyền vào do người gọi cấp (đã gắn bearer của chính request). Không yêu cầu `currentCaller()`
 * vì tool đi qua middleware danh tính của McpApp; lỗi nghiệp vụ được đổi thành `Error` với thông
 * điệp CỐ ĐỊNH, không phản chiếu nội dung từ ERP.
 */
export async function fetchMeeting(
  client: FrappeClient,
  args: MeetingGetArgs,
): Promise<Record<string, unknown>> {
  let message: unknown;
  try {
    message = await client.callMethod(ERP_EVENTS_METHODS.meetingGet, {
      ...args,
    }, {
      httpMethod: "GET",
    });
  } catch (error) {
    const mapped = classifyTransportError(error);
    if (mapped instanceof EventsAuthError) {
      throw new Error("Not authorized to read this meeting");
    }
    throw new Error(
      mapped instanceof EventsProtocolError
        ? mapped.toJsonRpcError().message
        : "Events backend error",
    );
  }
  let envelope: ErpEnvelope;
  try {
    envelope = unwrapErpEnvelope(message);
  } catch (error) {
    throw new Error(
      error instanceof EventsProtocolError
        ? error.toJsonRpcError().message
        : "Events backend error",
    );
  }
  if (!envelope.ok) {
    throw new Error(mapErpError(envelope.error).toJsonRpcError().message);
  }
  if (
    !isRecord(envelope.result) || typeof envelope.result.event_id !== "string"
  ) {
    throw new Error("Events backend error");
  }
  return envelope.result;
}
