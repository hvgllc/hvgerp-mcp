/**
 * Tool đọc lại lịch họp theo hợp đồng MCP Events (`meeting-events.v1`).
 *
 * Sự kiện Events chỉ mang con trỏ nhỏ (không tiêu đề, người tham dự hay link). Bên nhận gọi tool
 * này để đọc lại trạng thái ĐÚNG LÚC, dưới quyền của chính người gọi. Mỗi lần gọi là một GET tới
 * ERP, không cache, nên kết quả luôn là bản mới nhất. Tool chỉ được nạp khi bật cờ Events.
 *
 * @module lib/erpnext/tools/calendar
 */

import { fetchMeeting, type MeetingGetArgs } from "../events/erp-store.ts";
import { codePointLength } from "../events/json-schema.ts";
import { compareFractions } from "../events/protocol.ts";
import type { ErpNextTool } from "./types.ts";

/** Tên các tool chỉ tồn tại khi bật cờ Events. `ErpNextToolsClient` dùng để lọc ra. */
export const EVENTS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "erpnext_meeting_get",
]);

const TEMPORAL_FIELDS = [
  "occurrence_start",
  "window_start",
  "window_end",
] as const;
const ALLOWED_KEYS = new Set<string>(["event_id", ...TEMPORAL_FIELDS]);
const TEMPORAL_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const TEMPORAL_MAX_LENGTH = 64;

/** Chuỗi khớp hình dạng ISO và mọi thành phần là giá trị có thật (không có ngày 30/02, giờ 25 hay lệch +99:99). */
function isRealTemporal(value: string): boolean {
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/,
  );
  if (!parts) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (hour > 23 || minute > 59 || second > 59) return false;
  // Độ lệch múi giờ thật chỉ tới ±14:00; chặn ở 23:59 là đủ để loại giá trị vô nghĩa như +99:99.
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const moment = new Date(Date.UTC(year, month - 1, day));
  return moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day;
}

/** Một mốc thời gian: số mili giây UTC của giây nguyên cộng với phần thập phân của giây, giữ nguyên mọi chữ số. */
interface TemporalInstant {
  seconds: number;
  fraction: string;
  /** Chuỗi gốc có múi giờ (`Z` hoặc độ lệch). Ngày trơn và giờ trần là "không múi giờ". */
  zoned: boolean;
}

/**
 * Mốc thời gian của một chuỗi đã qua `isRealTemporal`. Chuỗi không có múi giờ được đặt tạm trên trục UTC
 * (chỉ để so với một mốc cũng không có múi giờ: ERP hiểu chúng theo múi giờ của site, nên so với mốc có múi giờ
 * là vô nghĩa, xem `canOrder`), và ngày trơn ở đầu mút `end` nghĩa là hết ngày đó, để `window_end: "2030-05-01"` không bị coi là
 * đứng trước `window_start: "2030-05-01T10:00"`. Phần thập phân không bị cắt ở mili giây: hai mốc chỉ khác
 * nhau ở chữ số thứ tư trở đi vẫn được sắp đúng thứ tự.
 */
function temporalInstant(value: string, endOfDay: boolean): TemporalInstant {
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):?(\d{2}))?)?$/,
  )!;
  const [year, month, day] = [
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
  ];
  if (parts[4] === undefined) {
    // Hết ngày là mọi thời điểm của ngày đó, kể cả `23:59:59.999...` với số chữ số tùy ý.
    return {
      seconds: Date.UTC(year, month - 1, day) + (endOfDay ? 86_399_000 : 0),
      fraction: endOfDay ? "9".repeat(TEMPORAL_MAX_LENGTH) : "",
      zoned: false,
    };
  }
  const local = Date.UTC(
    year,
    month - 1,
    day,
    Number(parts[4]),
    Number(parts[5]),
    Number(parts[6] ?? 0),
  );
  const fraction = parts[7] ?? "";
  if (parts[9] === undefined) {
    return { seconds: local, fraction, zoned: parts[8] !== undefined };
  }
  const offset = (Number(parts[10]) * 60 + Number(parts[11])) * 60_000;
  return {
    seconds: parts[9] === "+" ? local - offset : local + offset,
    fraction,
    zoned: true,
  };
}

/** Âm nếu `a` đứng trước `b`, 0 nếu bằng nhau, dương nếu đứng sau. */
/**
 * Chỉ hai mốc cùng loại (cùng có hoặc cùng không có múi giờ) mới sắp thứ tự được ở đây: mốc không múi giờ là giờ địa
 * phương của site mà MCP không biết, nên "2030-05-01T20:00" có thể đứng trước hay sau "2030-05-01T14:00Z" tùy múi giờ
 * của site. Cặp lẫn loại để ERP tự kiểm, không bị từ chối nhầm một cửa sổ hợp lệ.
 */
function canOrder(a: TemporalInstant, b: TemporalInstant): boolean {
  return a.zoned === b.zoned;
}

function compareInstants(a: TemporalInstant, b: TemporalInstant): number {
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  return compareFractions(a.fraction, b.fraction);
}

function readTemporal(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" || value.length > TEMPORAL_MAX_LENGTH ||
    !TEMPORAL_PATTERN.test(value) || !isRealTemporal(value)
  ) {
    throw new Error(`Invalid ${key}: expected an ISO date or date-time`);
  }
  return value;
}

export const calendarTools: ErpNextTool[] = [
  {
    name: "erpnext_meeting_get",
    description:
      "Freshly read one calendar meeting from ERPNext: schedule, recurrence and occurrences in a " +
      "window, plus the title and meeting link (meeting_url) when ERPNext provides them; either " +
      "may be null or absent. Use it after a meeting event to fetch the current state. Name the " +
      "meeting only from a non-null title and share a link only from a non-null meeting_url; " +
      "never invent either. Returns no description or participants. A deleted meeting returns " +
      "only event_id, revision and deleted=true. Always reads live data; results are never cached.",
    category: "operations",
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          minLength: 1,
          maxLength: 140,
          description: "Event name (id) as given by the meeting event.",
        },
        occurrence_start: {
          type: "string",
          maxLength: TEMPORAL_MAX_LENGTH,
          description:
            "Start of one occurrence of a recurring meeting (ISO date or date-time).",
        },
        window_start: {
          type: "string",
          maxLength: TEMPORAL_MAX_LENGTH,
          description:
            "Start of the window used to list occurrences (ISO date or date-time).",
        },
        window_end: {
          type: "string",
          maxLength: TEMPORAL_MAX_LENGTH,
          description:
            "End of the window used to list occurrences (ISO date or date-time).",
        },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async handler(input, ctx) {
      // Tool này đọc lịch THAY MẶT một người cụ thể: client dùng chung (service account hoặc khoá tĩnh của stdio) sẽ đọc
      // bằng quyền của tài khoản đó chứ không phải của người hỏi, nên bị từ chối thay vì lặng lẽ đọc rộng hơn.
      if (ctx.client.actsAs !== "caller") {
        throw new Error("Not authorized to read this meeting");
      }
      // Chỉ nhận đúng các khoá đã khai báo: `user_id` hay bất kỳ khoá lạ nào bị từ chối thay vì
      // được lặng lẽ chuyển tiếp, vì danh tính luôn lấy từ bearer của request.
      for (const key of Object.keys(input)) {
        // Thông điệp CỐ ĐỊNH: tên khoá do người gọi đặt, không được phản chiếu lại vào lỗi.
        if (!ALLOWED_KEYS.has(key)) {
          throw new Error(
            "Unknown argument: only event_id, occurrence_start, window_start and window_end are accepted",
          );
        }
      }
      const eventId = input.event_id;
      if (
        typeof eventId !== "string" || eventId.length === 0 ||
        codePointLength(eventId) > 140
      ) {
        throw new Error(
          "Invalid event_id: expected a non-empty string of at most 140 characters",
        );
      }
      const args: MeetingGetArgs = { event_id: eventId };
      for (const key of TEMPORAL_FIELDS) {
        const value = readTemporal(input, key);
        if (value !== undefined) args[key] = value;
      }
      // Có `occurrence_start` thì ERP bỏ qua cửa sổ (và `fetchMeeting` cũng vậy), nên cửa sổ cũ còn sót lại không được chặn lần đọc.
      if (
        args.occurrence_start === undefined &&
        args.window_start !== undefined && args.window_end !== undefined
      ) {
        const start = temporalInstant(args.window_start, false);
        const end = temporalInstant(args.window_end, true);
        if (canOrder(start, end) && compareInstants(start, end) > 0) {
          throw new Error(
            "Invalid window: window_start must not be after window_end",
          );
        }
      }
      return await fetchMeeting(ctx.client, args);
    },
  },
];
