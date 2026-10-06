/**
 * Proxy từ Events RPC sang API ERP, dùng bearer token của CHÍNH request đang xử lý.
 *
 * MCP không lưu gì ở đây: không secret, không token, không callback, không subscription. Trạng
 * thái bền nằm ở ERP. Mỗi lệnh gọi đi qua `getFrappeClient()` bên trong `runWithCaller` do adapter
 * dựng, nên header là `HVGKeycloak <token của người gọi>` và ERP tự xác minh lại danh tính.
 *
 * Hợp đồng với ERP: mọi method trả HTTP 200 với `message` là `{ok:true,result}` hoặc
 * `{ok:false,error:{code,message,data}}`. Lỗi xác thực là ngoại lệ: ERP raise PermissionError
 * (HTTP 401 khi token bị từ chối, 403 khi người gọi không đủ quyền). 401 trở thành `EventsAuthError` để
 * adapter trả HTTP 401 cho client; 403 trở thành lỗi giao thức Forbidden (-32012), vì token vẫn hợp lệ.
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
  compareUtcInstants,
  EventsErrorCode,
  EventsProtocolError,
  isRealDate,
  isRealUtcInstant,
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

/** ERP từ chối bearer của request (HTTP 401). Adapter đổi thành HTTP 401 cho client. */
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
  // Phong bì mâu thuẫn hoặc thiếu nhánh (`{ok:true}`, `{ok:true,error}`, `{ok:false,result}`) là lỗi
  // backend: nếu không, unsubscribe (vốn bỏ qua `result`) sẽ báo hủy thành công dù ERP trả sai.
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (message.ok) {
    if (!hasResult || hasError) {
      throw new EventsProtocolError(EventsErrorCode.InternalError);
    }
    return { ok: true, result: message.result };
  }
  if (!hasError || hasResult) {
    throw new EventsProtocolError(EventsErrorCode.InternalError);
  }
  return { ok: false, error: message.error };
}

/**
 * Đổi lỗi truyền tải của Frappe thành lỗi của giao thức Events. Không phản chiếu body của ERP.
 * 401 là lỗi xác thực; 403 là người gọi không đủ quyền (token vẫn đúng); phần còn lại (kể cả 429 giới
 * hạn tốc độ) là backend không dùng được.
 */
export function classifyTransportError(error: unknown): Error {
  if (error instanceof FrappeAPIError) {
    if (error.status === 401) return new EventsAuthError();
    if (error.status === 403) {
      return new EventsProtocolError(EventsErrorCode.Forbidden);
    }
    // 429 ở tầng truyền tải là Frappe giới hạn tốc độ request, không phải hạn mức subscription (hạn mức
    // đi qua phong bì lỗi HTTP 200). Báo -32013 sẽ khiến client dừng hẳn thay vì thử lại, nên đây là
    // lỗi backend trung tính.
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
      if (request.maxAgeMs !== undefined) args.max_age_ms = request.maxAgeMs;
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
    // 429 của lần đọc lại cuộc họp là giới hạn tốc độ của ERP, không phải hạn mức subscription.
    if (error instanceof FrappeAPIError && error.status === 429) {
      throw new Error("ERP is rate limiting requests, try again later");
    }
    const mapped = classifyTransportError(error);
    // Tool đọc cuộc họp không có HTTP 401 để trả: cả token bị từ chối lẫn thiếu quyền đều là một câu.
    if (
      mapped instanceof EventsAuthError ||
      (mapped instanceof EventsProtocolError &&
        mapped.code === EventsErrorCode.Forbidden)
    ) {
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
  // Kết quả phải là của đúng cuộc họp được hỏi: một bản ghi hợp lệ nhưng của Event khác sẽ khiến người gọi cập nhật nhầm.
  if (
    !isRecord(envelope.result) || envelope.result.event_id !== args.event_id
  ) {
    throw new Error("Events backend error");
  }
  return pickMeetingFields(envelope.result, args);
}

/** Tập đóng các giá trị `status` của Event native (Select `Open/Completed/Closed/Cancelled`); giá trị khác là ERP lệch hợp đồng. */
const MEETING_STATUSES: ReadonlySet<string> = new Set([
  "Open",
  "Completed",
  "Closed",
  "Cancelled",
]);

const MEETING_KEYS = [
  "event_id",
  "revision",
  "deleted",
  "status",
  "all_day",
  "time_zone",
  "starts_at",
  "ends_at",
  "start_date",
  "end_date_exclusive",
  "has_more",
] as const;
const TOMBSTONE_KEYS = ["event_id", "revision", "deleted"] as const;
const RECURRENCE_KEYS = ["frequency", "until", "weekdays"] as const;
/** Tập đóng ERP phát ra: chuỗi ngoài tập là dữ liệu hỏng hoặc lệch phiên bản, không được lọt ra ngoài. */
const RECURRENCE_FREQUENCIES: ReadonlySet<string> = new Set([
  "Daily",
  "Weekly",
  "Monthly",
  "Yearly",
]);
const WEEKDAY_NAMES: ReadonlySet<string> = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const OCCURRENCE_KEYS = [
  "series_id",
  "occurrence_start",
  "occurrence_end",
  "zone",
  "schedule_revision",
] as const;

function pickKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) picked[key] = source[key];
  }
  return picked;
}

const BACKEND_ERROR = "Events backend error";

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Kiểm đủ hình dạng của từng giá trị trước khi chép sang phản hồi. Lọc theo tên khóa là chưa đủ:
 * một khóa được phép vẫn có thể mang object lồng nhau hoặc kiểu sai, và từ đó dữ liệu tùy ý đi tiếp
 * tới người gọi. Mọi lệch hình dạng là lỗi backend cố định, không bao giờ được sửa lặng lẽ.
 */
function assertShape(ok: boolean): void {
  if (!ok) throw new Error(BACKEND_ERROR);
}

/**
 * Kết thúc phải sau bắt đầu. Ngày chỉ có dạng `YYYY-MM-DD` nên so chuỗi cũng là so thời gian; thời điểm UTC
 * được so đủ mọi chữ số thập phân của giây. `exclusive` là mốc kết thúc loại trừ của cuộc họp cả ngày, nơi bằng nhau nghĩa là
 * khoảng rỗng. Cuộc họp có giờ cho phép độ dài 0.
 */
function endFollowsStart(start: string, end: string, allDay: boolean): boolean {
  if (allDay) return end > start;
  return compareUtcInstants(end, start) >= 0;
}

/** Giá trị là chuỗi hợp lệ theo `check` hoặc `null`; mọi thứ khác là lỗi backend. */
function isNullableOf(
  value: unknown,
  check: (text: string) => boolean,
): boolean {
  return value === null || (typeof value === "string" && check(value));
}

/** Ngày lịch liền trước của `YYYY-MM-DD` (đầu vào đã qua `isRealDate`). */
function previousDate(date: string): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() - 1);
  return moment.toISOString().slice(0, 10);
}

/**
 * `firstDate` là ngày sớm nhất mà lần diễn ra đầu tiên có thể rơi vào theo lịch của cuộc họp. `until` là ngày theo múi giờ
 * của cuộc họp nên không được đứng trước ngày đó, nếu không chuỗi đã kết thúc trước khi bắt đầu.
 */
function validateRecurrence(
  recurrence: Record<string, unknown>,
  firstDate: string,
): Record<string, unknown> {
  const picked = pickKeys(recurrence, RECURRENCE_KEYS);
  assertShape(
    typeof picked.frequency === "string" &&
      RECURRENCE_FREQUENCIES.has(picked.frequency),
  );
  assertShape(
    !Object.hasOwn(picked, "until") || isNullableOf(picked.until, isRealDate),
  );
  assertShape(typeof picked.until !== "string" || picked.until >= firstDate);
  assertShape(
    !Object.hasOwn(picked, "weekdays") ||
      (Array.isArray(picked.weekdays) &&
        picked.weekdays.every((day) =>
          typeof day === "string" && WEEKDAY_NAMES.has(day)
        ) &&
        new Set(picked.weekdays).size === picked.weekdays.length),
  );
  return picked;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAIVE_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}[\d:.]*$/;
const OFFSET_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[\d:.]*(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/;

/** Ngày lịch (`YYYY-MM-DD`) của một thời điểm theo múi giờ `zone`; `null` khi thời điểm hay múi giờ không hợp lệ. */
function localDay(instantMs: number, zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instantMs));
  } catch {
    return null;
  }
}

/**
 * Ngày lịch mà ERP dùng để thu hẹp cửa sổ khi người gọi gửi `occurrence_start`: ngày thuần giữ nguyên, mốc có offset đổi sang
 * múi giờ của cuộc họp, mốc không offset đã là giờ của site. `null` khi chuỗi có dạng mà ERP chấp nhận nhưng ta không
 * đọc được: lúc đó không có gì để đối chiếu và ERP vẫn là bên kiểm tham số.
 */
function requestedDay(requested: string, zone: string): string | null {
  const text = requested.trim();
  if (DATE_ONLY.test(text)) return text;
  const naive = NAIVE_DATE_TIME.exec(text);
  if (naive) return naive[1];
  if (!OFFSET_DATE_TIME.test(text)) return null;
  return localDay(Date.parse(text.replace(" ", "T")), zone);
}

/**
 * Mỗi lần diễn ra trả về phải chạm ngày được hỏi: ERP trả cả lần bắt đầu ngày trước nhưng còn kéo dài sang ngày đó. Một lần
 * rơi hẳn ngày khác là phản hồi lệch phiên bản, và người gọi sẽ nhầm nó với lần diễn ra đã hỏi.
 */
function assertTouchesDay(
  occurrence: Record<string, unknown>,
  allDay: boolean,
  requested: string,
): void {
  const zone = occurrence.zone as string;
  const day = requestedDay(requested, zone);
  if (day === null) return;
  const start = occurrence.occurrence_start as string;
  const end = occurrence.occurrence_end as string;
  if (allDay) {
    assertShape(start <= day && end > day);
    return;
  }
  const startDay = localDay(Date.parse(start), zone);
  const endDay = localDay(Date.parse(end), zone);
  assertShape(
    startDay !== null && endDay !== null && startDay <= day && endDay >= day,
  );
}

function validateOccurrence(
  item: Record<string, unknown>,
  allDay: boolean,
  eventId: string,
  requestedStart?: string,
): Record<string, unknown> {
  const picked = pickKeys(item, OCCURRENCE_KEYS);
  assertShape(typeof picked.zone === "string" && picked.zone !== "");
  // Mỗi lần diễn ra phải thuộc đúng chuỗi của cuộc họp được hỏi, nếu không người gọi nhận lịch của Event khác.
  assertShape(picked.series_id === eventId);
  // Cuộc họp cả ngày phát ngày (`YYYY-MM-DD`), cuộc họp có giờ phát thời điểm UTC (`...Z`).
  for (const key of ["occurrence_start", "occurrence_end"]) {
    const value = picked[key];
    assertShape(
      typeof value === "string" &&
        (allDay ? isRealDate(value) : isRealUtcInstant(value)),
    );
  }
  assertShape(
    endFollowsStart(
      picked.occurrence_start as string,
      picked.occurrence_end as string,
      allDay,
    ),
  );
  assertShape(isRevision(picked.schedule_revision));
  if (requestedStart !== undefined) {
    assertTouchesDay(picked, allDay, requestedStart);
  }
  return picked;
}

/**
 * Chỉ giữ các trường đã công bố của tool. Nếu ERP trả thêm trường vì lệch phiên bản hoặc cấu hình
 * sai (tiêu đề, mô tả, email người tham dự...), chúng không bao giờ đi tiếp tới người gọi.
 */
function pickMeetingFields(
  result: Record<string, unknown>,
  args: MeetingGetArgs,
): Record<string, unknown> {
  // Cuộc họp đã xóa chỉ trả đúng ba trường của tombstone, kể cả khi ERP (lệch phiên bản) còn kèm lịch cũ.
  if (result.deleted === true) {
    const tombstone = pickKeys(result, TOMBSTONE_KEYS);
    assertShape(isRevision(tombstone.revision));
    return tombstone;
  }
  const picked = pickKeys(result, MEETING_KEYS);
  assertShape(isRevision(picked.revision));
  assertShape(!Object.hasOwn(picked, "deleted") || picked.deleted === false);
  assertShape(
    typeof picked.status === "string" && MEETING_STATUSES.has(picked.status),
  );
  assertShape(typeof picked.all_day === "boolean");
  assertShape(typeof picked.time_zone === "string" && picked.time_zone !== "");
  assertShape(typeof picked.has_more === "boolean");
  for (const key of ["starts_at", "ends_at"]) {
    assertShape(
      !Object.hasOwn(picked, key) ||
        isNullableOf(picked[key], isRealUtcInstant),
    );
  }
  for (const key of ["start_date", "end_date_exclusive"]) {
    assertShape(
      !Object.hasOwn(picked, key) || isNullableOf(picked[key], isRealDate),
    );
  }
  // Trường lịch bắt buộc theo `all_day` (đúng như catalog): cả ngày cần ngày bắt đầu và ngày kết thúc loại trừ,
  // giờ cụ thể cần `starts_at`. Trường của nhánh kia không được có, nếu không người gọi nhận lịch tự mâu thuẫn.
  const [required, forbidden] = picked.all_day
    ? [["start_date", "end_date_exclusive"], ["starts_at", "ends_at"]]
    : [["starts_at"], ["start_date", "end_date_exclusive"]];
  for (const key of required) {
    assertShape(typeof picked[key] === "string" && picked[key] !== "");
  }
  for (const key of forbidden) assertShape(picked[key] == null);
  // Mỗi mốc kết thúc có mặt phải đứng sau mốc bắt đầu tương ứng, nếu không lịch là bất khả thi.
  const [startKey, endKey] = picked.all_day
    ? ["start_date", "end_date_exclusive"]
    : ["starts_at", "ends_at"];
  if (typeof picked[endKey] === "string") {
    assertShape(
      endFollowsStart(
        picked[startKey] as string,
        picked[endKey] as string,
        picked.all_day as boolean,
      ),
    );
  }
  if (isRecord(result.recurrence)) {
    // Cuộc họp có giờ: ngày UTC có thể lệch tới một ngày so với ngày theo múi giờ của cuộc họp, nên chừa biên một ngày.
    const firstDate = picked.all_day
      ? picked.start_date as string
      : previousDate((picked.starts_at as string).slice(0, 10));
    picked.recurrence = validateRecurrence(result.recurrence, firstDate);
  } else {
    // Cuộc họp còn sống luôn mang `recurrence`: đối tượng hợp lệ hoặc đúng `null` (không lặp). Thiếu trường hay giá trị hỏng
    // mà bị coi là "không lặp" sẽ làm người gọi bỏ lỡ các lần sau, nên cả hai đều là lỗi backend.
    assertShape(result.recurrence === null);
    picked.recurrence = null;
  }
  // Người gọi hỏi một cửa sổ thì ERP phải trả mảng `occurrences` (rỗng cũng được): thiếu nó là phản hồi lệch phiên bản, và
  // bỏ qua kiểm tra sẽ biến nó thành một kết quả cửa sổ "hợp lệ" mà không có dữ liệu.
  const windowed = args.occurrence_start !== undefined ||
    args.window_start !== undefined || args.window_end !== undefined;
  if (windowed) assertShape(Array.isArray(result.occurrences));
  if (Object.hasOwn(result, "occurrences")) {
    // Một phần tử hỏng không được lặng lẽ bị bỏ: người gọi sẽ tưởng lịch đã đủ và bỏ lỡ cuộc họp.
    const items = result.occurrences;
    if (!Array.isArray(items) || !items.every(isRecord)) {
      throw new Error(BACKEND_ERROR);
    }
    picked.occurrences = items.map((item) =>
      validateOccurrence(
        item,
        picked.all_day as boolean,
        result.event_id as string,
        args.occurrence_start,
      )
    );
  }
  return picked;
}
