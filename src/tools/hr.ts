/**
 * ERPNext HR Tools
 *
 * MCP tools for human resources: employees, attendance, leave applications.
 *
 * @module lib/erpnext/tools/hr
 */

import type { FrappeFilter } from "../api/types.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";
import { listResult } from "./list-result.ts";
import { siteToday } from "./site-date.ts";
import { DOCLIST_META } from "./viewer-meta.ts";
import { resolveEmployee, resolveLink } from "../api/resolve.ts";

/** One leave type's line in what `get_leave_details` returns. */
interface LeaveAllocationEntry {
  total_leaves?: number;
  expired_leaves?: number;
  leaves_taken?: number;
  leaves_pending_approval?: number;
  remaining_leaves?: number;
}

/** Shape of `hrms...leave_application.get_leave_details`. */
interface LeaveDetails {
  leave_allocation?: Record<string, LeaveAllocationEntry>;
}

// ── Attendance day repair ───────────────────────────────────────────────────
//
// Hai tool sửa ngày công KHÔNG tự tính lại giờ công. Chúng gọi
// `hvg_workspace.api.hr_get_day_attendance` / `hr_save_day_attendance`, là hai hàm đã
// whitelist của app riêng mà site này chạy.
//
// Không port công thức sang TypeScript, dù `hrms` có sẵn: app ấy ghi đè `Shift Type` bằng
// `HVGShiftType.get_attendance`, trừ giờ nghỉ trưa không lương rồi mới xét ngưỡng
// vắng/nửa ngày. Tính lại ở phía MCP là ra một con số khác với con số mà chính site coi là
// đúng - đo trên production, một ngày cho 13.03h ở chỗ công thức HRMS gốc cho 14.53h.
// Một luật nghiệp vụ chỉ được có một nguồn.
//
// Cũng không gọi `ShiftType.process_auto_attendance`: nó chạy theo CẢ CA và kéo theo
// `mark_absent_for_dates_with_no_attendance` cho mọi nhân sự được phân ca, tức tác dụng
// phụ không chặn được cho một thao tác "sửa một ngày của một người".
//
// Hai hàm ấy không đi qua `erpnext_method_call` nên `ERPNEXT_METHOD_ALLOWLIST` không liên
// quan; allowlist đó chỉ gác đúng tool kia.

/** Độ dài tối thiểu của lý do sửa, khớp `hvg_workspace.install.ATTENDANCE_FIX_MIN_REASON`. */
const MIN_FIX_REASON = 10;

/** Câu nói rõ hai tool sửa ngày công phụ thuộc app riêng, để mô tả tool không hứa suông. */
const REQUIRES_HVG_WORKSPACE =
  "Requires the 'hvg_workspace' app on the site; without it the call fails and the " +
  "generic erpnext_doc_* tools are the only route.";

/** Một lượt bấm giờ như `_serialize_checkin` trả về. */
interface AttendancePunch {
  name: string;
  time: string;
  /** Máy chấm công không báo chiều thì để rỗng - đó là trạng thái thứ ba, không phải OUT. */
  log_type?: string;
  shift?: string | null;
  attendance?: string | null;
  skip_auto_attendance?: number;
}

/** Trạng thái một ngày công, chung cho cả đường đọc lẫn đường ghi. */
interface AttendanceDayState {
  employee?: Record<string, unknown>;
  date?: string;
  rows?: AttendancePunch[];
  worked_minutes?: number;
  shift?: Record<string, unknown> | null;
  attendance?: {
    name: string;
    status: string;
    working_hours: number;
    docstatus: number;
  } | null;
  /** Ngày đã có Attendance đã duyệt: lưu sẽ HUỶ bản ấy rồi dựng lại. */
  locked?: boolean;
  /** Không sửa được chút nào: bản nháp, hoặc bản sinh từ đơn còn hiệu lực. */
  blocked?: boolean;
  locked_reason?: string;
  /** Người đang gọi tự sửa công của chính mình - site chặn, phân tách nhiệm vụ. */
  is_self?: boolean;
  cancelled_attendance?: string[];
  changed_count?: number;
  recompute?: { attendance?: string | null; skipped?: string | null };
  no_change?: boolean;
}

/**
 * Câu duy nhất Frappe nói khi KHÔNG phân giải được đường dẫn hàm.
 *
 * Hẹp có chủ ý. Bắt theo "not found" hay "does not exist" chung thì mọi lỗi nghiệp vụ có
 * chứa mấy chữ ấy - một lượt bấm giờ vừa bị người khác xoá, chẳng hạn - đều bị dịch thành
 * "site này không có app", tức là báo sai nguyên nhân, và `FrappeAPIError` bị thay bằng
 * `Error` trần nên người gọi mất luôn `status` với `body` đã parse.
 */
const METHOD_LOOKUP_FAILURE = /Failed to get method|Method Not Found/i;

/** Gọi một hàm của `hvg_workspace`, dịch "app không có" thành câu người đọc hiểu được. */
async function callHvgWorkspace<T>(
  ctx: ErpNextToolContext,
  method: string,
  args: Record<string, unknown>,
  tool: string,
): Promise<T> {
  try {
    return await ctx.client.callMethod<T>(method, args);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Frappe trả cùng một lỗi cho "hàm không tồn tại" dù nguyên nhân là app chưa cài hay
    // tên gõ sai. Người đọc cần biết nhánh nào để còn hành động.
    if (METHOD_LOOKUP_FAILURE.test(text)) {
      throw new Error(
        `[${tool}] this site does not expose '${method}'. These attendance repair ` +
          "tools need the 'hvg_workspace' app installed. Original error: " +
          text,
        { cause: err },
      );
    }
    throw err;
  }
}

/** Đọc trạng thái một ngày. Không phán xét: `blocked` là dữ liệu, không phải lỗi. */
async function readAttendanceDay(
  ctx: ErpNextToolContext,
  employee: string,
  date: string,
  tool: string,
): Promise<AttendanceDayState> {
  return await callHvgWorkspace<AttendanceDayState>(
    ctx,
    "hvg_workspace.api.hr_get_day_attendance",
    { employee, date },
    tool,
  );
}

/** `log_type` phải là IN hoặc OUT; rỗng đi tới server sẽ bị từ chối bằng tiếng Việt. */
function assertLogType(value: unknown, tool: string): void {
  const text = String(value ?? "").toUpperCase();
  if (text !== "IN" && text !== "OUT") {
    throw new Error(
      `[${tool}] log_type must be 'IN' or 'OUT', got ${JSON.stringify(value)}.`,
    );
  }
}

/** Một hàng của trạng thái đích: `name` rỗng nghĩa là lượt bấm mới. */
interface TargetPunch {
  name: string;
  time: string;
  log_type?: string;
}

/**
 * Điền chiều cho những lượt bấm không khai chiều, theo thứ tự của NGÀY SAU KHI SỬA.
 *
 * `hr_save_day_attendance` đòi mọi hàng mang IN hoặc OUT, nhưng `log_type` là Select có
 * lựa chọn rỗng nên kho thật sự chứa chuỗi rỗng. Phải suy, và phải suy trên trạng thái
 * đích: một lượt `edit` dời giờ hay một lượt `add` chèn vào giữa đều đổi thứ tự trong
 * ngày, nên suy trên thứ tự CŨ là gán chiều không còn khớp trình tự thời gian, và ca này
 * xác định vào/ra bằng "alternating entries" nên giờ công ra sai theo.
 *
 * Quy tắc: đi theo thứ tự thời gian, một hàng trống lấy chiều ngược với hàng liền trước;
 * hàng trống đầu tiên là IN. Hàng đã khai chiều KHÔNG bị đụng tới - giá trị của nó là dữ
 * liệu, không phải chỗ trống để đoán - và chính nó làm mốc neo cho các hàng trống sau.
 */
function fillBlankLogTypes(
  target: readonly TargetPunch[],
): Array<{ name: string; time: string; log_type: string }> {
  const ordered = [...target].sort((a, b) => a.time.localeCompare(b.time));
  let previous: string | undefined;
  return ordered.map((row) => {
    const log_type = row.log_type
      ? row.log_type
      : previous === "IN"
      ? "OUT"
      : "IN";
    previous = log_type;
    return { name: row.name, time: row.time, log_type };
  });
}

export const hrTools: ErpNextTool[] = [
  // ── Employees ─────────────────────────────────────────────────────────────

  {
    name: "erpnext_employee_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description: "List Employees. Filterable by department, status. " +
      "Fields: name, employee_name, designation, department, company, status, date_of_joining.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        department: { type: "string", description: "Filter by department" },
        status: {
          type: "string",
          description: "Filter by status (Active, Inactive, Suspended, Left)",
          enum: ["Active", "Inactive", "Suspended", "Left"],
        },
        company: { type: "string", description: "Filter by company" },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.department) {
        filters.push(["department", "=", input.department as string]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.company) {
        filters.push(["company", "=", input.company as string]);
      }

      const docs = await ctx.client.list("Employee", {
        fields: [
          "name",
          "employee_name",
          "designation",
          "department",
          "company",
          "status",
          "date_of_joining",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Employee", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_employee_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Employee by name/ID (e.g. HR-EMP-00001). Returns all fields.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Employee name or ID (e.g. HR-EMP-00001) — a unique name resolves automatically",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_employee_get] 'name' is required");
      }
      // The description promises a name works, so resolve it. Strict mode even
      // on this read path: two employees sharing a display name should surface
      // both IDs rather than have one silently picked.
      const employeeId = await resolveLink(
        ctx.client,
        "Employee",
        input.name as string,
        "employee_name",
        { allowPartialMatch: false, inputPath: "name" },
      );
      const doc = await ctx.client.get("Employee", employeeId);
      return { data: doc };
    },
  },

  // ── Attendance ────────────────────────────────────────────────────────────

  {
    name: "erpnext_attendance_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Attendance records. Only submitted records are returned unless " +
      "include_cancelled is set, because Attendance is submittable and cancelled " +
      "records must not be counted towards attendance. " +
      "Filterable by employee, status, date range. " +
      "Fields: name, employee, employee_name, attendance_date, status, docstatus, " +
      "company, department, shift, late_entry, early_exit.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        employee: {
          type: "string",
          description:
            "Filter by employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        status: {
          type: "string",
          description:
            "Filter by status (Present, Absent, Half Day, On Leave, Work From Home)",
          enum: [
            "Present",
            "Absent",
            "Half Day",
            "On Leave",
            "Work From Home",
          ],
        },
        include_cancelled: {
          type: "boolean",
          description:
            "Include draft and cancelled records too. Default false: only submitted " +
            "(docstatus = 1) records count towards attendance.",
          default: false,
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD",
        },
        date_to: { type: "string", description: "End date filter YYYY-MM-DD" },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      // Attendance là doctype submittable, và bản ghi đã hủy vẫn nằm trong bảng. Không lọc
      // `docstatus` thì một câu hỏi về chuyên cần cộng luôn cả những ngày đã bị hủy bỏ, và
      // câu trả lời sai đó trông y hệt câu trả lời đúng.
      if (!input.include_cancelled) {
        filters.push(["docstatus", "=", 1]);
      }
      if (input.employee) {
        filters.push([
          "employee",
          "=",
          await resolveEmployee(ctx.client, input.employee as string, {
            inputPath: "employee",
          }),
        ]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.date_from) {
        filters.push(["attendance_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["attendance_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Attendance", {
        fields: [
          "name",
          "employee",
          "employee_name",
          "attendance_date",
          "status",
          // `docstatus` đi kèm để người đọc kết quả thấy được bản ghi nào đã hủy khi
          // `include_cancelled` được bật, thay vì phải đoán.
          "docstatus",
          "company",
          "department",
          "shift",
          "late_entry",
          "early_exit",
        ],
        filters,
        limit,
        order_by: "attendance_date desc",
      });

      return await listResult(ctx, "Attendance", docs, {
        filters,
        limit,
      });
    },
  },

  // ── Employee Checkins & day repair ────────────────────────────────────────

  {
    name: "erpnext_employee_checkin_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Employee Checkin punches for an employee over a date range. This is the " +
      "raw punch log behind Attendance, so it is where a broken day shows up: a day " +
      "with an odd number of punches never closed, and a punch whose 'attendance' is " +
      "empty was never counted. 'skip_auto_attendance' = 1 means auto attendance " +
      "already refused this punch, which is what happens when a checkin is added to a " +
      "day that already carries an Attendance record. " +
      "Fields: name, employee, employee_name, time, log_type, shift, attendance, " +
      "skip_auto_attendance. " +
      "Use erpnext_attendance_day_get for the authoritative per-day view, and " +
      "erpnext_attendance_day_fix to repair a day.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 50)",
        },
        employee: {
          type: "string",
          description:
            "Filter by employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        log_type: {
          type: "string",
          description:
            "Filter by direction. Devices that do not report a direction leave this " +
            "empty, so filtering on it can hide real punches.",
          enum: ["IN", "OUT"],
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD (time >=, from 00:00:00)",
        },
        date_to: {
          type: "string",
          description: "End date filter YYYY-MM-DD (time <=, up to 23:59:59)",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 50;
      const filters: FrappeFilter[] = [];
      if (input.employee) {
        filters.push([
          "employee",
          "=",
          await resolveEmployee(ctx.client, input.employee as string, {
            inputPath: "employee",
          }),
        ]);
      }
      if (input.log_type) {
        filters.push(["log_type", "=", input.log_type as string]);
      }
      // `time` là Datetime, không phải Date. So thẳng với `YYYY-MM-DD` thì cận trên rơi
      // vào `00:00:00` và mọi lượt bấm trong chính ngày cuối khoảng bị loại - đúng ngày
      // mà người hỏi quan tâm nhất.
      if (input.date_from) {
        filters.push(["time", ">=", `${input.date_from as string} 00:00:00`]);
      }
      if (input.date_to) {
        filters.push(["time", "<=", `${input.date_to as string} 23:59:59`]);
      }

      const docs = await ctx.client.list("Employee Checkin", {
        fields: [
          "name",
          "employee",
          "employee_name",
          "time",
          "log_type",
          "shift",
          "attendance",
          "skip_auto_attendance",
        ],
        filters,
        limit,
        order_by: "time asc",
      });

      return await listResult(ctx, "Employee Checkin", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_attendance_day_get",
    annotations: { readOnlyHint: true },
    description:
      "Read one employee's full attendance picture for ONE day: every punch, the shift " +
      "that governs it, the minutes worked as this site computes them, and the " +
      "Attendance record standing in the way of a repair. " +
      "Read this before calling erpnext_attendance_day_fix: 'locked' true means the day " +
      "already carries a submitted Attendance, so fixing it CANCELS that record and " +
      "rebuilds it, and the fix tool will refuse without confirm_cancel_attendance. " +
      "'blocked' true means the fix cannot proceed at all (a draft Attendance, or one " +
      "backed by a still-valid Attendance Request); 'locked_reason' says which. " +
      "'is_self' true means the API user may not edit this employee - the site enforces " +
      "segregation of duties. " +
      REQUIRES_HVG_WORKSPACE,
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            "Employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        date: { type: "string", description: "The day to read, YYYY-MM-DD" },
      },
      required: ["employee", "date"],
    },
    handler: async (input, ctx) => {
      if (!input.employee) {
        throw new Error("[erpnext_attendance_day_get] 'employee' is required");
      }
      if (!input.date) {
        throw new Error("[erpnext_attendance_day_get] 'date' is required");
      }
      const employee = await resolveEmployee(
        ctx.client,
        input.employee as string,
        { inputPath: "employee" },
      );
      const state = await readAttendanceDay(
        ctx,
        employee,
        input.date as string,
        "erpnext_attendance_day_get",
      );
      return { data: state };
    },
  },

  {
    name: "erpnext_attendance_day_fix",
    annotations: {
      readOnlyHint: false,
      // Huỷ một bản Attendance đã duyệt là thao tác không hoàn tác được bằng chính tool
      // này, nên hint phải nói thật kể cả khi phần lớn lượt gọi chỉ thêm một lượt bấm.
      destructiveHint: true,
      idempotentHint: false,
    },
    description:
      "Repair ONE employee's attendance for ONE day: add the missing punches, correct " +
      "the wrong ones, and rebuild that day's Attendance from the result. " +
      "This is the tool for the 'a day is missing its check-out' case. Adding an " +
      "Employee Checkin on its own does NOT fix such a day - HRMS refuses to build a " +
      "second Attendance for a day that already has one and silently marks the new " +
      "punch skipped - so the day is repaired by cancelling the stale Attendance and " +
      "recomputing, which is what this tool does in a single transaction. " +
      "Pass punches to create in 'add' and corrections in 'edit'; punches you do not " +
      "mention are left alone. Deleting a punch is not possible here by design. " +
      "'reason' is written to the audit trail and is required. " +
      "When the day already carries a submitted Attendance, the call is refused unless " +
      "confirm_cancel_attendance is true, because saving cancels that record. " +
      "Refuses outright for a future date, an unusable log_type, a draft Attendance on " +
      "the day, or an Attendance backed by a still-valid Attendance Request. " +
      REQUIRES_HVG_WORKSPACE,
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            "Employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        date: { type: "string", description: "The day to repair, YYYY-MM-DD" },
        reason: {
          type: "string",
          description:
            `Why the punches are being changed, at least ${MIN_FIX_REASON} characters. ` +
            "Stored on the audit trail; it is the only record of why the hours moved.",
        },
        add: {
          type: "array",
          description: "Punches to create on this day.",
          items: {
            type: "object",
            properties: {
              log_type: {
                type: "string",
                description: "Direction of the punch",
                enum: ["IN", "OUT"],
              },
              time: {
                type: "string",
                description:
                  "When the punch happened, 'YYYY-MM-DD HH:MM:SS'. Must fall inside " +
                  "the day's shift window - see 'shift.window_start' / " +
                  "'shift.window_end' from erpnext_attendance_day_get.",
              },
            },
            required: ["log_type", "time"],
          },
        },
        edit: {
          type: "array",
          description:
            "Corrections to punches that already exist. Identify each by its " +
            "Employee Checkin name from erpnext_attendance_day_get.",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "Employee Checkin ID, e.g. 'EMP-CKIN-08-2026-00123'",
              },
              log_type: {
                type: "string",
                description: "New direction; omit to keep the current one",
                enum: ["IN", "OUT"],
              },
              time: {
                type: "string",
                description:
                  "New timestamp 'YYYY-MM-DD HH:MM:SS'; omit to keep the current one",
              },
            },
            required: ["name"],
          },
        },
        confirm_cancel_attendance: {
          type: "boolean",
          description:
            "Acknowledge that the day's submitted Attendance will be cancelled and " +
            "rebuilt. Required only when erpnext_attendance_day_get reports " +
            "'locked': true.",
          default: false,
        },
      },
      required: ["employee", "date", "reason"],
    },
    handler: async (input, ctx) => {
      const TOOL = "erpnext_attendance_day_fix";
      if (!input.employee) throw new Error(`[${TOOL}] 'employee' is required`);
      if (!input.date) throw new Error(`[${TOOL}] 'date' is required`);

      // Lý do bị chặn ở đây chứ không chỉ ở server: server đo sau khi đã mở giao dịch và
      // đã tra nhân sự, còn đây là phép kiểm rẻ nhất trong chuỗi.
      const reason = String(input.reason ?? "").trim();
      if (reason.length < MIN_FIX_REASON) {
        throw new Error(
          `[${TOOL}] 'reason' must be at least ${MIN_FIX_REASON} characters. ` +
            "It is the only thing that explains the change to whoever reads the " +
            "audit trail later.",
        );
      }

      const adds = (input.add ?? []) as Array<Record<string, unknown>>;
      const edits = (input.edit ?? []) as Array<Record<string, unknown>>;
      if (adds.length === 0 && edits.length === 0) {
        throw new Error(
          `[${TOOL}] nothing to do: pass at least one punch in 'add' or 'edit'.`,
        );
      }
      for (const row of adds) {
        assertLogType(row.log_type, TOOL);
        if (!row.time) {
          throw new Error(`[${TOOL}] every entry in 'add' needs a 'time'.`);
        }
      }
      for (const row of edits) {
        if (!row.name) {
          throw new Error(
            `[${TOOL}] every entry in 'edit' needs the Employee Checkin 'name'.`,
          );
        }
        if (row.log_type !== undefined) assertLogType(row.log_type, TOOL);
      }

      const date = input.date as string;
      // Máy chấm công không chứa sự kiện chưa xảy ra. Đo bằng ngày của SITE, không phải
      // ngày UTC của tiến trình MCP: hai thứ đó lệch nhau đúng quanh nửa đêm, tức đúng lúc
      // một ca đêm đang được sửa.
      const today = await siteToday(ctx);
      if (date > today) {
        throw new Error(
          `[${TOOL}] '${date}' is in the future (site today is ${today}). ` +
            "Attendance can only be repaired for a day that has already happened.",
        );
      }

      const employee = await resolveLink(
        ctx.client,
        "Employee",
        input.employee as string,
        "employee_name",
        // Write path — see purchasing.ts: no fuzzy matching on writes.
        { allowPartialMatch: false, inputPath: "employee" },
      );

      const state = await readAttendanceDay(ctx, employee, date, TOOL);
      const current = (state.rows ?? []) as AttendancePunch[];

      // `blocked` được chặn ở ĐÂY chứ không ở hàm đọc: bản nháp hay bản sinh từ đơn còn
      // hiệu lực là thứ đường ghi không đi qua được, nhưng đường đọc phải trả về nguyên
      // trạng thái ấy thì người hỏi mới biết vì sao bế tắc.
      if (state.blocked) {
        throw new Error(
          `[${TOOL}] ${date} cannot be repaired as it stands. ` +
            (state.locked_reason ?? "The site reports the day as blocked.") +
            " Resolve that in ERPNext first.",
        );
      }

      // Cờ xác nhận chỉ tồn tại ở tầng này: `hr_save_day_attendance` huỷ bản đã duyệt VÔ
      // ĐIỀU KIỆN. Một tool mà model gọi được thì không được để việc huỷ công của một
      // người xảy ra như tác dụng phụ của "thêm một lượt bấm".
      if (state.locked && input.confirm_cancel_attendance !== true) {
        throw new Error(
          `[${TOOL}] ${date} already has an Attendance record` +
            (state.attendance?.name ? ` (${state.attendance.name})` : "") +
            ". Saving cancels it and rebuilds the day from the punches. " +
            "Pass confirm_cancel_attendance: true to proceed. " +
            (state.locked_reason ? `Site says: ${state.locked_reason}` : ""),
        );
      }

      const byName = new Map(current.map((row) => [row.name, row]));
      for (const row of edits) {
        if (!byName.has(row.name as string)) {
          throw new Error(
            `[${TOOL}] checkin '${row.name}' is not one of ${date}'s punches. ` +
              "Read them with erpnext_attendance_day_get first.",
          );
        }
      }

      // `rows` là TOÀN BỘ trạng thái đích của ngày, và một hàng có sẵn mà vắng mặt bị
      // server coi là nhầm lẫn chứ không phải yêu cầu xoá. Nên dựng từ trạng thái vừa đọc
      // chứ không từ payload: caller chỉ nói phần thay đổi.
      const edited = new Map(
        edits.map((row) => [row.name as string, row]),
      );
      const target: TargetPunch[] = current.map((row) => {
        const patch = edited.get(row.name);
        return {
          name: row.name,
          time: (patch?.time as string) ?? row.time,
          log_type: (patch?.log_type as string) ?? row.log_type,
        };
      });
      for (const row of adds) {
        target.push({
          name: "",
          time: row.time as string,
          log_type: row.log_type as string,
        });
      }
      // Điền chiều SAU khi đã gộp `edit` và `add`, vì chiều của một lượt bấm là vị trí của
      // nó trong ngày đã sửa chứ không phải trong ngày trước khi sửa.
      const rows = fillBlankLogTypes(target);

      // Ảnh chụp mà lượt gọi này ĐANG NHÌN THẤY, để server phát hiện có ai vừa sửa cùng
      // ngày ấy giữa lượt đọc và lượt ghi. Lấy từ chính `state` ở trên, nên nó mô tả đúng
      // thứ `rows` được dựng trên đó.
      const base: Record<string, { time: string; log_type: string }> = {};
      for (const row of current) {
        base[row.name] = { time: row.time, log_type: row.log_type ?? "" };
      }

      const saved = await callHvgWorkspace<AttendanceDayState>(
        ctx,
        "hvg_workspace.api.hr_save_day_attendance",
        { employee, date, reason, rows, base },
        TOOL,
      );

      // Ghi qua `callMethod` thì cache không tự dọn - `create`/`update`/`delete` mới tự
      // dọn. Một lượt gọi này đổi cả lượt bấm giờ lẫn ngày công, nên bỏ qua bước này là
      // lượt đọc ngay sau đó còn trả về đúng đống dữ liệu vừa được sửa.
      ctx.client.invalidate("Employee Checkin");
      for (const name of saved.cancelled_attendance ?? []) {
        ctx.client.invalidate("Attendance", name);
      }
      ctx.client.invalidate("Attendance", saved.attendance?.name);

      const cancelled = saved.cancelled_attendance ?? [];
      const parts = [
        `Attendance for ${employee} on ${date} rebuilt`,
        `${saved.changed_count ?? 0} punch(es) written`,
      ];
      if (cancelled.length > 0) {
        parts.push(`cancelled ${cancelled.join(", ")}`);
      }
      // Cửa xác nhận ở trên đo `state.locked` của lượt ĐỌC, còn server huỷ ở lượt GHI, nên
      // giữa hai lượt vẫn còn một khe: chạy chấm công tự động có thể dựng một bản Attendance
      // mới đúng vào khe ấy và bản ấy bị huỷ mà không ai xác nhận. Đóng khe cho kín phải sửa
      // `hr_save_day_attendance` để nhận cờ và kiểm trong cùng giao dịch; ở tầng này chỉ
      // phát hiện được. Đã phát hiện thì phải nói to, im lặng mới là hỏng.
      if (cancelled.length > 0 && input.confirm_cancel_attendance !== true) {
        parts.push(
          `WARNING: ${
            cancelled.join(", ")
          } was cancelled even though this call did ` +
            "not confirm a cancellation - the record appeared between the read and " +
            "the save. Check that the rebuilt day is what you expected",
        );
      }
      if (saved.attendance?.name) {
        parts.push(
          `now ${saved.attendance.name} ${saved.attendance.status} ` +
            `(${saved.attendance.working_hours ?? 0}h)`,
        );
      }
      // `skipped` nghĩa là lượt tính lại KHÔNG ra bản ghi nào. Server chỉ hoàn tác khi
      // ngày đó vừa mất một bản Attendance; ngày chưa từng có bản nào thì lượt lưu thành
      // công với một ngày vẫn chưa có công, và im lặng ở đây là báo sai.
      if (saved.recompute?.skipped) {
        parts.push(
          `WARNING: the day could not be recomputed (${saved.recompute.skipped}), ` +
            "so it still has no Attendance record",
        );
      }
      if (saved.no_change) {
        parts.push("no punch actually differed from what was already stored");
      }

      return { data: saved, message: `${parts.join("; ")}.` };
    },
  },

  // ── Leave Applications ────────────────────────────────────────────────────

  {
    name: "erpnext_leave_application_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Leave Applications. Filterable by employee, status, leave_type. " +
      "Fields: name, employee, employee_name, leave_type, from_date, to_date, status.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        employee: {
          type: "string",
          description:
            "Filter by employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        status: {
          type: "string",
          description: "Filter by status (Open, Approved, Rejected, Cancelled)",
          enum: ["Open", "Approved", "Rejected", "Cancelled"],
        },
        leave_type: {
          type: "string",
          description: "Filter by leave type (e.g. Sick Leave)",
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD",
        },
        date_to: { type: "string", description: "End date filter YYYY-MM-DD" },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.employee) {
        filters.push([
          "employee",
          "=",
          await resolveEmployee(ctx.client, input.employee as string, {
            inputPath: "employee",
          }),
        ]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.leave_type) {
        filters.push(["leave_type", "=", input.leave_type as string]);
      }
      if (input.date_from) {
        filters.push(["from_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["to_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Leave Application", {
        fields: [
          "name",
          "employee",
          "employee_name",
          "leave_type",
          "from_date",
          "to_date",
          "status",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Leave Application", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_leave_application_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Leave Application by name. Returns full document.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Leave Application name" },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_leave_application_get] 'name' is required");
      }
      const doc = await ctx.client.get(
        "Leave Application",
        input.name as string,
      );
      return { data: doc };
    },
  },

  {
    name: "erpnext_leave_application_create",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    description:
      "Create a new Leave Application. Requires employee, leave_type, from_date, to_date. " +
      "Dates in YYYY-MM-DD format.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            "Employee name or ID (e.g. HR-EMP-00001) — a unique name resolves automatically",
        },
        leave_type: {
          type: "string",
          description:
            "Leave type, exactly as it is named on this site. Leave types are configured " +
            "per site and a type with no allocation produces an application with no " +
            "entitlement behind it, so read the real names off Leave Type rather than " +
            "guessing from the ERPNext defaults.",
        },
        from_date: { type: "string", description: "Start date YYYY-MM-DD" },
        to_date: { type: "string", description: "End date YYYY-MM-DD" },
        description: {
          type: "string",
          description: "Reason for the leave (optional)",
        },
      },
      required: ["employee", "leave_type", "from_date", "to_date"],
    },
    handler: async (input, ctx) => {
      if (!input.employee) {
        throw new Error(
          "[erpnext_leave_application_create] 'employee' is required",
        );
      }
      if (!input.leave_type) {
        throw new Error(
          "[erpnext_leave_application_create] 'leave_type' is required",
        );
      }
      if (!input.from_date) {
        throw new Error(
          "[erpnext_leave_application_create] 'from_date' is required",
        );
      }
      if (!input.to_date) {
        throw new Error(
          "[erpnext_leave_application_create] 'to_date' is required",
        );
      }

      const data: Record<string, unknown> = {
        employee: await resolveLink(
          ctx.client,
          "Employee",
          input.employee as string,
          "employee_name",
          // Write path — see purchasing.ts: no fuzzy matching on writes.
          { allowPartialMatch: false, inputPath: "employee" },
        ),
        leave_type: input.leave_type as string,
        from_date: input.from_date as string,
        to_date: input.to_date as string,
      };
      // Leave Application không có ô `reason`. Frappe bỏ im lặng mọi khoá lạ khi chèn bản
      // ghi, nên lý do nghỉ người dùng nhập biến mất mà không có lỗi nào. Ô thật là
      // `description`.
      if (input.description) {
        data.description = input.description as string;
      }

      const doc = await ctx.client.create("Leave Application", data);
      return {
        data: doc,
        message: `Leave Application ${doc.name} created successfully`,
      };
    },
  },

  // ── Salary Slips ──────────────────────────────────────────────────────────

  {
    name: "erpnext_salary_slip_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Salary Slips. Filterable by employee, status, date range. " +
      "Fields: name, employee, employee_name, posting_date, start_date, end_date, gross_pay, net_pay, status.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        employee: {
          type: "string",
          description:
            "Filter by employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        status: {
          type: "string",
          description: "Filter by status (Draft, Submitted, Cancelled)",
          enum: ["Draft", "Submitted", "Cancelled"],
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD (posting_date >=)",
        },
        date_to: {
          type: "string",
          description: "End date filter YYYY-MM-DD (posting_date <=)",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.employee) {
        filters.push([
          "employee",
          "=",
          await resolveEmployee(ctx.client, input.employee as string, {
            inputPath: "employee",
          }),
        ]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.date_from) {
        filters.push(["posting_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["posting_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Salary Slip", {
        fields: [
          "name",
          "employee",
          "employee_name",
          "posting_date",
          "start_date",
          "end_date",
          "gross_pay",
          "net_pay",
          "status",
        ],
        filters,
        limit,
        order_by: "posting_date desc",
      });

      return await listResult(ctx, "Salary Slip", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_salary_slip_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Salary Slip by name/ID. Returns all fields including earnings and deductions.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Salary Slip ID (e.g. Salary Slip/HR-EMP-00001/00001)",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_salary_slip_get] 'name' is required");
      }
      const doc = await ctx.client.get("Salary Slip", input.name as string);
      return { data: doc };
    },
  },

  // ── Payroll Entries ───────────────────────────────────────────────────────

  {
    name: "erpnext_payroll_entry_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description: "List Payroll Entries. Filterable by company, status. " +
      "Fields: name, company, posting_date, payroll_frequency, status.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        company: { type: "string", description: "Filter by company" },
        status: {
          type: "string",
          description: "Filter by status (Draft, Submitted, Cancelled)",
          enum: ["Draft", "Submitted", "Cancelled"],
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD",
        },
        date_to: { type: "string", description: "End date filter YYYY-MM-DD" },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.company) {
        filters.push(["company", "=", input.company as string]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.date_from) {
        filters.push(["posting_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["posting_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Payroll Entry", {
        fields: [
          "name",
          "company",
          "posting_date",
          "payroll_frequency",
          "status",
        ],
        filters,
        limit,
        order_by: "posting_date desc",
      });

      return await listResult(ctx, "Payroll Entry", docs, {
        filters,
        limit,
      });
    },
  },

  // ── Expense Claims ────────────────────────────────────────────────────────

  {
    name: "erpnext_expense_claim_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Expense Claims. Filterable by employee, status, approval_status, workflow_state. " +
      "Fields: name, employee, employee_name, posting_date, total_claimed_amount, " +
      "total_sanctioned_amount, status, approval_status, workflow_state. " +
      "When the site drives Expense Claim through a Workflow, workflow_state is the stage " +
      "people actually work with; its values are site-defined, so read them off the " +
      "Workflow rather than assuming the ERPNext defaults.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        employee: {
          type: "string",
          description:
            "Filter by employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        status: {
          type: "string",
          description:
            "Filter by status (Draft, Paid, Unpaid, Rejected, Submitted, Cancelled)",
          enum: [
            "Draft",
            "Paid",
            "Unpaid",
            "Rejected",
            "Submitted",
            "Cancelled",
          ],
        },
        approval_status: {
          type: "string",
          description:
            "Filter by approval status (Draft, Approved, Rejected, Cancelled). " +
            "Claims awaiting approval sit in Draft, not in a 'Pending' state.",
          enum: ["Draft", "Approved", "Rejected", "Cancelled"],
        },
        workflow_state: {
          type: "string",
          description:
            "Filter by the site's Workflow state. Values are defined by the Workflow " +
            "attached to Expense Claim, so they are not fixed here.",
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD",
        },
        date_to: { type: "string", description: "End date filter YYYY-MM-DD" },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.employee) {
        filters.push([
          "employee",
          "=",
          await resolveEmployee(ctx.client, input.employee as string, {
            inputPath: "employee",
          }),
        ]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.approval_status) {
        filters.push(["approval_status", "=", input.approval_status as string]);
      }
      if (input.workflow_state) {
        filters.push(["workflow_state", "=", input.workflow_state as string]);
      }
      if (input.date_from) {
        filters.push(["posting_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["posting_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Expense Claim", {
        fields: [
          "name",
          "employee",
          "employee_name",
          "posting_date",
          "total_claimed_amount",
          "total_sanctioned_amount",
          "status",
          "approval_status",
          // Trạng thái mà tổ chức thật sự làm việc cùng nằm ở `workflow_state`, không phải ở
          // `status`. Không phơi ra thì người đọc kết quả không có cách nào biết hồ sơ đang
          // ở khâu nào.
          "workflow_state",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Expense Claim", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_expense_claim_create",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    description:
      "Create a new Expense Claim. Requires employee and expenses array. " +
      "Each expense item maps to the Expense Claim Detail child table.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            "Employee name or ID (e.g. HR-EMP-00001) — a unique name resolves automatically",
        },
        expenses: {
          type: "array",
          description: "List of expense line items",
          items: {
            type: "object",
            properties: {
              expense_type: {
                type: "string",
                description: "Expense type (e.g. Travel, Food)",
              },
              amount: { type: "number", description: "Claimed amount" },
              sanctioned_amount: {
                type: "number",
                description:
                  "Approved amount (optional). Defaults to 'amount'; the claim's total " +
                  "sanctioned amount is the sum of this column, so leaving it unset " +
                  "produces a claim whose approved total is zero.",
              },
              expense_date: {
                type: "string",
                description:
                  "Date the expense was incurred YYYY-MM-DD (optional)",
              },
              description: {
                type: "string",
                description: "Description of the expense (optional)",
              },
            },
            required: ["expense_type", "amount"],
          },
        },
        posting_date: {
          type: "string",
          description: "Posting date YYYY-MM-DD (optional, defaults to today)",
        },
      },
      required: ["employee", "expenses"],
    },
    handler: async (input, ctx) => {
      if (!input.employee) {
        throw new Error(
          "[erpnext_expense_claim_create] 'employee' is required",
        );
      }
      if (
        !input.expenses || !Array.isArray(input.expenses) ||
        (input.expenses as unknown[]).length === 0
      ) {
        throw new Error(
          "[erpnext_expense_claim_create] 'expenses' is required and must be a non-empty array",
        );
      }

      const expenses = input.expenses as Array<
        {
          expense_type: string;
          amount: number;
          sanctioned_amount?: number;
          description?: string;
          expense_date?: string;
        }
      >;

      const data: Record<string, unknown> = {
        employee: await resolveLink(
          ctx.client,
          "Employee",
          input.employee as string,
          "employee_name",
          // Write path — see purchasing.ts: no fuzzy matching on writes.
          { allowPartialMatch: false, inputPath: "employee" },
        ),
        expenses: expenses.map((e) => ({
          expense_type: e.expense_type,
          amount: e.amount,
          // `ExpenseClaim.calculate_total_amount` cộng đúng cột này, mà cột này không có
          // default và không fetch từ `amount`. Bỏ trống thì hồ sơ tạo ra có tổng duyệt bằng 0
          // trong khi vẫn hiện đủ số tiền đề nghị - một hồ sơ hỏng nhìn như hồ sơ bình thường.
          sanctioned_amount: e.sanctioned_amount ?? e.amount,
          description: e.description ?? "",
          ...(e.expense_date ? { expense_date: e.expense_date } : {}),
        })),
      };
      if (input.posting_date) {
        data.posting_date = input.posting_date as string;
      }

      const doc = await ctx.client.create("Expense Claim", data);
      return {
        data: doc,
        message: `Expense Claim ${doc.name} created successfully`,
      };
    },
  },

  // ── Leave Balance ─────────────────────────────────────────────────────────

  {
    name: "erpnext_leave_balance",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "Get an employee's leave balance as of a date: for every leave type, how many days " +
      "were allocated, how many were taken, how many sit in applications awaiting approval, " +
      "how many expired, and how many are still available. The numbers come from HR's own " +
      "leave ledger, so leave already taken is deducted: an allocation total on its own is " +
      "not a balance. The date actually used is echoed back as as_on_date.",
    category: "hr",
    inputSchema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            "Employee ID or name (e.g. 'HR-EMP-00001' or 'John Doe')",
        },
        as_on_date: {
          type: "string",
          description:
            "Date to value the balance on, YYYY-MM-DD. Defaults to today on the site. " +
            "Balances are scoped to the leave period containing this date.",
        },
        leave_type: {
          type: "string",
          description:
            "Return only this leave type. Leave types are named per site.",
        },
      },
      required: ["employee"],
    },
    handler: async (input, ctx) => {
      if (!input.employee) {
        throw new Error("[erpnext_leave_balance] 'employee' is required");
      }

      const employee = await resolveEmployee(
        ctx.client,
        input.employee as string,
        { inputPath: "employee" },
      );

      let asOnDate = input.as_on_date as string | undefined;
      if (asOnDate !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
          throw new Error(
            "[erpnext_leave_balance] 'as_on_date' must be a date in YYYY-MM-DD form",
          );
        }
      } else {
        asOnDate = await siteToday(ctx);
      }

      // Bảng Leave Allocation một mình không trả lời được câu hỏi "còn bao nhiêu ngày phép":
      // nó chỉ nói được cấp bao nhiêu. Số đã nghỉ nằm ở Leave Ledger Entry, và phép cộng trừ
      // giữa hai bảng có đủ luật riêng (hết hạn, nghỉ nửa ngày, kỳ phép) để không nên chép
      // lại ở đây. Hàm này là chính cái mà màn hình HR của ERPNext dùng.
      const details = await ctx.client.callMethod<LeaveDetails>(
        "hrms.hr.doctype.leave_application.leave_application.get_leave_details",
        { employee, date: asOnDate },
        { httpMethod: "GET" },
      );

      const allocation = details?.leave_allocation;
      if (!allocation || typeof allocation !== "object") {
        throw new Error(
          `[erpnext_leave_balance] HR returned no leave allocation block for ${employee} ` +
            `on ${asOnDate}; the balance is unknown, not zero.`,
        );
      }

      const wanted = input.leave_type as string | undefined;
      if (wanted && !(wanted in allocation)) {
        // Không trả danh sách rỗng: "không có loại phép nào tên như vậy" và "loại phép đó
        // còn 0 ngày" là hai câu trả lời khác hẳn nhau, mà một mảng rỗng thì nói cả hai.
        const available = Object.keys(allocation).sort().join(", ");
        throw new Error(
          `[erpnext_leave_balance] ${employee} has no allocated leave type named ` +
            `"${wanted}" on ${asOnDate}. Allocated types: ${
              available || "(none)"
            }`,
        );
      }

      const rows = Object.entries(allocation)
        .filter(([leaveType]) => !wanted || leaveType === wanted)
        .map(([leaveType, entry]) => {
          if (typeof entry?.remaining_leaves !== "number") {
            // Cùng lý do với khối `leave_allocation` thiếu ở trên: HR đổi hình dạng trả về mà
            // ta lặng lẽ điền 0 thì số dư sai đi thẳng vào câu trả lời cho người dùng.
            throw new Error(
              `[erpnext_leave_balance] HR returned no remaining_leaves for ${employee} / ` +
                `${leaveType} on ${asOnDate}; the balance is unknown, not zero.`,
            );
          }
          return {
            leave_type: leaveType,
            allocated: entry.total_leaves ?? 0,
            used: entry.leaves_taken ?? 0,
            pending_approval: entry.leaves_pending_approval ?? 0,
            expired: entry.expired_leaves ?? 0,
            balance: entry.remaining_leaves,
          };
        })
        .sort((a, b) => a.leave_type.localeCompare(b.leave_type));

      return {
        _title: "Leave balance",
        employee,
        as_on_date: asOnDate,
        // Không phân trang: HR trả về mọi loại phép của người này trong một lượt, nên số dòng
        // ở đây ĐÚNG LÀ tổng, không phải độ dài một trang.
        count: rows.length,
        returned: rows.length,
        has_more: false,
        data: rows,
        _meta: DOCLIST_META,
      };
    },
  },
];
