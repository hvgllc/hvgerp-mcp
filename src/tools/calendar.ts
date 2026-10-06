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

/** Chuỗi khớp hình dạng ISO và mọi thành phần là giá trị có thật (không có ngày 30/02 hay giờ 25). */
function isRealTemporal(value: string): boolean {
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!parts) return false;
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts.slice(1)
    .map((part) => (part === undefined ? 0 : Number(part)));
  if (hour > 23 || minute > 59 || second > 59) return false;
  const moment = new Date(Date.UTC(year, month - 1, day));
  return moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day;
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
      "Freshly read one calendar meeting from ERPNext (schedule, recurrence and occurrences in a " +
      "window). Use it after a meeting event to fetch the current state. Returns no title, " +
      "description, participants or links. A deleted meeting returns only event_id, revision and " +
      "deleted=true. Always reads live data; results are never cached.",
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
      // Chỉ nhận đúng các khoá đã khai báo: `user_id` hay bất kỳ khoá lạ nào bị từ chối thay vì
      // được lặng lẽ chuyển tiếp, vì danh tính luôn lấy từ bearer của request.
      for (const key of Object.keys(input)) {
        if (!ALLOWED_KEYS.has(key)) throw new Error(`Unknown argument: ${key}`);
      }
      const eventId = input.event_id;
      if (
        typeof eventId !== "string" || eventId.length === 0 ||
        eventId.length > 140
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
      return await fetchMeeting(ctx.client, args);
    },
  },
];
