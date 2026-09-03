/**
 * HR Tools Tests
 *
 * Focused on link resolution: these handlers accept an employee identifier, and
 * the distinction between "resolves a display name" and "requires an opaque ID"
 * is invisible from the schema — it lives in the handler body. That asymmetry
 * shipped as a real bug on three create handlers, so it is pinned here.
 *
 * @module lib/erpnext/tests/tools/hr_test
 */

// deno-lint-ignore-file no-explicit-any

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { hrTools } from "./hr.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async (_doctype: string, data: unknown) => ({
      name: "NEW-001",
      ...(data as object),
    }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    invalidate: () => {},
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = hrTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

/** A client where `identifier` is not a valid ID but matches `matches` by name. */
function clientResolving(
  identifier: string,
  matches: Array<Record<string, unknown>>,
  onCreate?: (data: Record<string, unknown>) => void,
): FrappeClient {
  return makeMockClient({
    get: async (_doctype: string, name: string) => {
      if (name === identifier) throw new FrappeAPIError("Not Found", 404, null);
      return { name };
    },
    list: async (doctype: string) => (doctype === "Employee" ? matches : []),
    create: async (_doctype: string, data: unknown) => {
      onCreate?.(data as Record<string, unknown>);
      return { name: "NEW-001", ...(data as object) };
    },
  });
}

// ── write paths ─────────────────────────────────────────────────────────────

Deno.test("erpnext_leave_application_create - accepts an employee name, not just an ID", async () => {
  let created: Record<string, unknown> | undefined;
  const client = clientResolving(
    "John Smith",
    [{ name: "HR-EMP-00042", employee_name: "John Smith" }],
    (d) => created = d,
  );

  await getTool("erpnext_leave_application_create").handler(
    {
      employee: "John Smith",
      leave_type: "Casual Leave",
      from_date: "2026-08-01",
      to_date: "2026-08-02",
    },
    makeCtx(client),
  );

  assertEquals(created?.employee, "HR-EMP-00042");
});

Deno.test("erpnext_leave_application_create - refuses to guess between two employees", async () => {
  // The invariant: nothing is created when the name is ambiguous. Filing leave
  // against the wrong person is not something the agent can detect afterwards.
  let createCalled = false;
  const client = clientResolving("John", [
    { name: "HR-EMP-00042", employee_name: "John" },
    { name: "HR-EMP-00099", employee_name: "John" },
  ], () => createCalled = true);

  const error = await assertRejects(
    () =>
      getTool("erpnext_leave_application_create").handler(
        {
          employee: "John",
          leave_type: "Casual Leave",
          from_date: "2026-08-01",
          to_date: "2026-08-02",
        },
        makeCtx(client),
      ),
    Error,
  );

  assertEquals(createCalled, false, "must not create against a guess");
  assertEquals(error.message.includes("HR-EMP-00042"), true);
  assertEquals(error.message.includes("HR-EMP-00099"), true);
});

Deno.test("erpnext_expense_claim_create - accepts an employee name, not just an ID", async () => {
  let created: Record<string, unknown> | undefined;
  const client = clientResolving(
    "Jane Doe",
    [{ name: "HR-EMP-00007", employee_name: "Jane Doe" }],
    (d) => created = d,
  );

  await getTool("erpnext_expense_claim_create").handler(
    {
      employee: "Jane Doe",
      expenses: [{ expense_type: "Travel", amount: 120 }],
    },
    makeCtx(client),
  );

  assertEquals(created?.employee, "HR-EMP-00007");
});

Deno.test("erpnext_leave_application_create - writes the reason into 'description', never 'reason'", async () => {
  // Leave Application has no `reason` column, and Frappe drops unknown keys without
  // complaining: the reason simply disappeared while the call reported success.
  let created: Record<string, unknown> | undefined;
  const client = clientResolving(
    "John Smith",
    [{ name: "HR-EMP-00042", employee_name: "John Smith" }],
    (d) => created = d,
  );

  await getTool("erpnext_leave_application_create").handler(
    {
      employee: "John Smith",
      leave_type: "Phép năm",
      from_date: "2026-08-01",
      to_date: "2026-08-02",
      description: "Về quê",
    },
    makeCtx(client),
  );

  assertEquals(created?.description, "Về quê");
  assertEquals("reason" in (created ?? {}), false);
});

Deno.test("erpnext_expense_claim_create - defaults sanctioned_amount to amount", async () => {
  // total_sanctioned_amount is the sum of this column. Left unset, the claim shows the
  // full claimed amount and an approved total of zero.
  let created: any;
  const client = makeMockClient({
    create: async (_doctype: string, data: unknown) => {
      created = data;
      return { name: "HR-EXP-0001", ...(data as object) };
    },
  });

  await getTool("erpnext_expense_claim_create").handler(
    {
      employee: "HR-EMP-00007",
      expenses: [
        { expense_type: "Travel", amount: 120 },
        { expense_type: "Food", amount: 80, sanctioned_amount: 50 },
      ],
    },
    makeCtx(client),
  );

  assertEquals(created.expenses[0].sanctioned_amount, 120);
  assertEquals(created.expenses[1].sanctioned_amount, 50);
});

// ── read paths ──────────────────────────────────────────────────────────────

Deno.test("erpnext_attendance_list - counts only submitted records by default", async () => {
  // Attendance is submittable and cancelled rows stay in the table. Without the
  // docstatus filter, a question about attendance silently counts cancelled days.
  let seen: any;
  const client = makeMockClient({
    list: async (_doctype: string, options: any) => {
      seen = options;
      return [];
    },
  });

  await getTool("erpnext_attendance_list").handler({}, makeCtx(client));

  assertEquals(
    seen.filters.some((f: unknown[]) =>
      f[0] === "docstatus" && f[1] === "=" && f[2] === 1
    ),
    true,
  );

  await getTool("erpnext_attendance_list").handler(
    { include_cancelled: true },
    makeCtx(client),
  );

  assertEquals(
    seen.filters.some((f: unknown[]) => f[0] === "docstatus"),
    false,
  );
});

Deno.test("erpnext_attendance_list - offers the Work From Home status", async () => {
  const schema = getTool("erpnext_attendance_list").inputSchema as any;
  assertEquals(
    schema.properties.status.enum.includes("Work From Home"),
    true,
  );
});

Deno.test("erpnext_expense_claim_list - exposes the real status values and workflow_state", async () => {
  const tool = getTool("erpnext_expense_claim_list");
  const schema = tool.inputSchema as any;
  // "Pending"/"Approved" were never Expense Claim.status values, so those filters
  // matched nothing at all; claims awaiting approval sit in approval_status Draft.
  assertEquals(schema.properties.status.enum, [
    "Draft",
    "Paid",
    "Unpaid",
    "Rejected",
    "Submitted",
    "Cancelled",
  ]);
  assertEquals(schema.properties.approval_status.enum, [
    "Draft",
    "Approved",
    "Rejected",
    "Cancelled",
  ]);
  assertEquals(typeof schema.properties.workflow_state, "object");

  let seen: any;
  const client = makeMockClient({
    list: async (_doctype: string, options: any) => {
      seen = options;
      return [];
    },
  });

  await tool.handler(
    { status: "Unpaid", workflow_state: "Đã duyệt" },
    makeCtx(client),
  );

  assertEquals(seen.fields.includes("total_sanctioned_amount"), true);
  assertEquals(seen.fields.includes("workflow_state"), true);
  assertEquals(seen.filters, [
    ["status", "=", "Unpaid"],
    ["workflow_state", "=", "Đã duyệt"],
  ]);
});

Deno.test("erpnext_leave_balance - reports allocated, used and remaining from HR's ledger", async () => {
  // The old handler summed Leave Allocation only, so an employee who had taken leave
  // still showed the full allocation as their balance.
  const client = makeMockClient({
    callMethod: async (method: string) => {
      if (method === "frappe.client.get_value") {
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      if (
        method ===
          "hrms.hr.doctype.leave_application.leave_application.get_leave_details"
      ) {
        return {
          leave_allocation: {
            "Phép năm": {
              total_leaves: 12,
              expired_leaves: 0,
              leaves_taken: 2,
              leaves_pending_approval: 0,
              remaining_leaves: 10,
            },
            "Nghỉ ốm": {
              total_leaves: 5,
              expired_leaves: 0,
              leaves_taken: 0,
              leaves_pending_approval: 0,
              remaining_leaves: 5,
            },
          },
        };
      }
      return null;
    },
  });

  const result = await getTool("erpnext_leave_balance").handler(
    { employee: "HR-EMP-00024", as_on_date: "2026-08-28" },
    makeCtx(client),
  ) as any;

  assertEquals(result.as_on_date, "2026-08-28");
  assertEquals(result.count, 2);
  assertEquals(result.has_more, false);
  const annual = result.data.find((r: any) => r.leave_type === "Phép năm");
  assertEquals(annual.allocated, 12);
  assertEquals(annual.used, 2);
  assertEquals(annual.balance, 10);
});

Deno.test("erpnext_leave_balance - can narrow to one leave type", async () => {
  const client = makeMockClient({
    callMethod: async (method: string) =>
      method ===
          "hrms.hr.doctype.leave_application.leave_application.get_leave_details"
        ? {
          leave_allocation: {
            "Phép năm": { total_leaves: 12, remaining_leaves: 10 },
            "Nghỉ ốm": { total_leaves: 5, remaining_leaves: 5 },
          },
        }
        : null,
  });

  const result = await getTool("erpnext_leave_balance").handler(
    {
      employee: "HR-EMP-00030",
      as_on_date: "2026-08-28",
      leave_type: "Nghỉ ốm",
    },
    makeCtx(client),
  ) as any;

  assertEquals(result.data.length, 1);
  assertEquals(result.data[0].leave_type, "Nghỉ ốm");
  assertEquals(result.data[0].balance, 5);
});

Deno.test("erpnext_leave_balance - refuses to report an unknown balance as zero", async () => {
  const client = makeMockClient({ callMethod: async () => null });

  await assertRejects(
    () =>
      getTool("erpnext_leave_balance").handler(
        { employee: "HR-EMP-00024", as_on_date: "2026-08-28" },
        makeCtx(client),
      ),
    Error,
  );
});

Deno.test("erpnext_leave_balance - a leave type with no remaining_leaves is unknown, not zero", async () => {
  const client = makeMockClient({
    callMethod: async (method: string) =>
      method ===
          "hrms.hr.doctype.leave_application.leave_application.get_leave_details"
        ? { leave_allocation: { "Phép năm": { total_leaves: 12 } } }
        : null,
  });

  await assertRejects(
    () =>
      getTool("erpnext_leave_balance").handler(
        { employee: "HR-EMP-00024", as_on_date: "2026-08-28" },
        makeCtx(client),
      ),
    Error,
  );
});

Deno.test("erpnext_leave_balance - names the real leave types instead of returning nothing", async () => {
  // An empty list would read as "that leave type has no days left", which is a different
  // answer from "this employee has no such leave type".
  const client = makeMockClient({
    callMethod: async (method: string) =>
      method ===
          "hrms.hr.doctype.leave_application.leave_application.get_leave_details"
        ? {
          leave_allocation: {
            "Phép năm": { total_leaves: 12, remaining_leaves: 10 },
          },
        }
        : null,
  });

  const error = await assertRejects(
    () =>
      getTool("erpnext_leave_balance").handler(
        {
          employee: "HR-EMP-00024",
          as_on_date: "2026-08-28",
          leave_type: "Annual Leave",
        },
        makeCtx(client),
      ),
    Error,
  );

  assertEquals(error.message.includes("Phép năm"), true);
});

Deno.test("erpnext_leave_balance - falls back to get_time_zone when System Settings is closed", async () => {
  // System Settings only grants read to System Manager, so for most callers the first
  // rung throws. Falling straight through to UTC would shift "today" by up to seven
  // hours in Vietnam, which is the whole reason the date is resolved server-side.
  const called: string[] = [];
  const client = makeMockClient({
    callMethod: async (method: string) => {
      called.push(method);
      if (method === "frappe.client.get_value") {
        throw new Error("PermissionError: System Settings");
      }
      if (method === "frappe.client.get_time_zone") {
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      if (
        method ===
          "hrms.hr.doctype.leave_application.leave_application.get_leave_details"
      ) {
        return {
          leave_allocation: {
            "Phép năm": { total_leaves: 12, remaining_leaves: 10 },
          },
        };
      }
      return null;
    },
  });

  const result = await getTool("erpnext_leave_balance").handler(
    { employee: "HR-EMP-00024" },
    makeCtx(client),
  ) as any;

  // Thứ tự cũng là một phần của hành vi: get_time_zone đọc bảng defaults, nên nó chỉ được
  // hỏi sau khi System Settings từ chối, không bao giờ trước.
  assertEquals(called[0], "frappe.client.get_value");
  assertEquals(called[1], "frappe.client.get_time_zone");
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(result.as_on_date), true);
});

Deno.test("erpnext_leave_balance - rejects a malformed as_on_date instead of guessing", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_leave_balance").handler(
        { employee: "HR-EMP-00024", as_on_date: "28/08/2026" },
        makeCtx(makeMockClient()),
      ),
    Error,
  );
});

Deno.test("erpnext_employee_get - honours its description and resolves a name", async () => {
  // Its description promises a name works. It previously did not resolve at all,
  // so an agent following the description got a 404 — a description that lies is
  // the same defect class the write-path fixes addressed.
  const client = clientResolving("Jane Doe", [
    { name: "HR-EMP-00007", employee_name: "Jane Doe" },
  ]);

  const result = await getTool("erpnext_employee_get").handler(
    { name: "Jane Doe" },
    makeCtx(client),
  ) as any;

  assertEquals(result.data.name, "HR-EMP-00007");
});

// ── attendance day repair ───────────────────────────────────────────────────
//
// Hai tool này bọc `hvg_workspace.api.hr_get_day_attendance` / `hr_save_day_attendance`.
// Phần đáng kiểm không phải phép tính giờ công - phép ấy nằm ở server và cố ý chỉ có một
// nguồn - mà là ba thứ tầng bọc tự chịu trách nhiệm: dựng `rows` đầy đủ từ trạng thái vừa
// đọc, dựng `base` khớp với chính `rows` ấy, và các cửa từ chối.

/** Trạng thái mẫu: một ngày có đúng một lượt Vào, Attendance Absent đã duyệt. */
function brokenDay(overrides: Record<string, unknown> = {}) {
  return {
    employee: { name: "HR-EMP-00044", employee_name: "Nguyen Van A" },
    date: "2026-08-29",
    rows: [
      {
        name: "EMP-CKIN-001",
        time: "2026-08-29 07:30:58",
        log_type: "IN",
        shift: "Ca hành chính",
        attendance: "HR-ATT-2026-00332",
        skip_auto_attendance: 0,
      },
    ],
    worked_minutes: 0,
    shift: { name: "Ca hành chính" },
    attendance: {
      name: "HR-ATT-2026-00332",
      status: "Absent",
      working_hours: 0,
      docstatus: 1,
    },
    locked: true,
    blocked: false,
    locked_reason:
      "Ngày này đã có bản ghi chấm công HR-ATT-2026-00332 đã duyệt.",
    is_self: false,
    ...overrides,
  };
}

/**
 * Client giả cho đường sửa ngày công.
 *
 * `siteToday` hỏi múi giờ trước mọi thứ khác, nên nó phải được trả lời ở đây; để nó rơi
 * xuống nhánh lỗi là biến mọi bài kiểm ngày tương lai thành bài kiểm phụ thuộc đồng hồ.
 */
function attendanceClient(
  dayState: Record<string, unknown>,
  onSave?: (args: Record<string, unknown>) => void,
  saveResult?: Record<string, unknown>,
): FrappeClient {
  return makeMockClient({
    get: async (_doctype: string, name: string) => ({ name }),
    callMethod: async (method: string, args: Record<string, unknown>) => {
      if (method === "frappe.client.get_value") {
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      if (method === "hvg_workspace.api.hr_get_day_attendance") return dayState;
      if (method === "hvg_workspace.api.hr_save_day_attendance") {
        onSave?.(args);
        return saveResult ?? {
          ...dayState,
          cancelled_attendance: ["HR-ATT-2026-00332"],
          changed_count: 1,
          recompute: { attendance: "HR-ATT-2026-00401", skipped: null },
          no_change: false,
          attendance: {
            name: "HR-ATT-2026-00401",
            status: "Present",
            working_hours: 8.5,
            docstatus: 1,
          },
        };
      }
      return null;
    },
  });
}

Deno.test("erpnext_employee_checkin_list - date_to covers the whole last day", async () => {
  // `time` là Datetime. So với `YYYY-MM-DD` trần thì cận trên rơi vào 00:00:00 và mọi
  // lượt bấm của chính ngày cuối khoảng biến mất - đúng ngày người hỏi quan tâm nhất.
  let seen: any;
  const client = makeMockClient({
    list: async (_doctype: string, opts: any) => {
      seen = opts;
      return [];
    },
  });

  await getTool("erpnext_employee_checkin_list").handler(
    {
      employee: "HR-EMP-00044",
      date_from: "2026-08-29",
      date_to: "2026-08-29",
    },
    makeCtx(client),
  );

  assertEquals(seen.filters, [
    ["employee", "=", "HR-EMP-00044"],
    ["time", ">=", "2026-08-29 00:00:00"],
    ["time", "<=", "2026-08-29 23:59:59"],
  ]);
});

Deno.test("erpnext_attendance_day_fix - sends the whole day, not just the added punch", async () => {
  // `hr_save_day_attendance` đọc `rows` là TRẠNG THÁI ĐÍCH của cả ngày và từ chối lượt
  // gửi nào bỏ sót một hàng có sẵn. Caller chỉ nói phần thêm, nên tầng bọc phải tự ghép.
  let sent: any;
  const client = attendanceClient(brokenDay(), (args) => sent = args);

  const result = await getTool("erpnext_attendance_day_fix").handler(
    {
      employee: "HR-EMP-00044",
      date: "2026-08-29",
      reason: "Nhân viên quên bấm giờ ra, đối chiếu camera",
      add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
      confirm_cancel_attendance: true,
    },
    makeCtx(client),
  ) as any;

  assertEquals(sent.rows, [
    { name: "EMP-CKIN-001", time: "2026-08-29 07:30:58", log_type: "IN" },
    { name: "", time: "2026-08-29 17:05:00", log_type: "OUT" },
  ]);
  // `base` mô tả ảnh chụp mà `rows` vừa được dựng trên đó, nên nó chỉ chứa hàng CÓ SẴN.
  assertEquals(sent.base, {
    "EMP-CKIN-001": { time: "2026-08-29 07:30:58", log_type: "IN" },
  });
  assertEquals(sent.reason, "Nhân viên quên bấm giờ ra, đối chiếu camera");
  assertEquals(result.data.attendance.status, "Present");
});

Deno.test("erpnext_attendance_day_fix - fills a blank log_type by position", async () => {
  // Máy chấm công không khai chiều để lại chuỗi rỗng, mà server đòi IN hoặc OUT. Suy theo
  // vị trí, và CHỈ cho hàng rỗng.
  let sent: any;
  const state = brokenDay({
    rows: [
      { name: "EMP-CKIN-001", time: "2026-08-29 07:30:58", log_type: "" },
      { name: "EMP-CKIN-002", time: "2026-08-29 12:00:00", log_type: "OUT" },
    ],
  });
  const client = attendanceClient(state, (args) => sent = args);

  await getTool("erpnext_attendance_day_fix").handler(
    {
      employee: "HR-EMP-00044",
      date: "2026-08-29",
      reason: "Bổ sung lượt ra buổi chiều",
      add: [{ log_type: "IN", time: "2026-08-29 13:00:00" }],
      confirm_cancel_attendance: true,
    },
    makeCtx(client),
  );

  assertEquals(sent.rows[0].log_type, "IN");
  // Hàng đã khai chiều giữ nguyên giá trị của nó: đó là dữ liệu, không phải chỗ trống.
  assertEquals(sent.rows[1].log_type, "OUT");
});

Deno.test("erpnext_attendance_day_fix - reports a skipped recompute instead of claiming success", async () => {
  // Server chỉ hoàn tác khi ngày đó vừa MẤT một Attendance. Ngày chưa từng có bản nào thì
  // lượt lưu thành công với một ngày vẫn không có công, và im lặng ở đây là báo sai.
  const client = attendanceClient(
    brokenDay({ locked: false, attendance: null }),
    undefined,
    {
      ...brokenDay({ locked: false, attendance: null }),
      cancelled_attendance: [],
      changed_count: 1,
      recompute: { attendance: null, skipped: "holiday" },
      no_change: false,
    },
  );

  const result = await getTool("erpnext_attendance_day_fix").handler(
    {
      employee: "HR-EMP-00044",
      date: "2026-08-29",
      reason: "Bổ sung lượt ra còn thiếu",
      add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
    },
    makeCtx(client),
  ) as any;

  assertEquals(result.message.includes("WARNING"), true);
  assertEquals(result.message.includes("holiday"), true);
});

// ── reject paths ────────────────────────────────────────────────────────────

Deno.test("erpnext_attendance_day_fix - refuses to cancel a submitted Attendance unconfirmed", async () => {
  // `hr_save_day_attendance` huỷ bản đã duyệt VÔ ĐIỀU KIỆN. Cờ xác nhận chỉ tồn tại ở
  // tầng này, nên thiếu nó là phải nổ trước khi có gì được ghi.
  let saved = false;
  const client = attendanceClient(brokenDay(), () => saved = true);

  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2026-08-29",
          reason: "Bổ sung lượt ra còn thiếu",
          add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
        },
        makeCtx(client),
      ),
    Error,
    "confirm_cancel_attendance",
  );
  assertEquals(saved, false);
});

Deno.test("erpnext_attendance_day_fix - refuses a future date", async () => {
  let saved = false;
  const client = attendanceClient(brokenDay(), () => saved = true);

  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2999-01-01",
          reason: "Bổ sung lượt ra còn thiếu",
          add: [{ log_type: "OUT", time: "2999-01-01 17:05:00" }],
        },
        makeCtx(client),
      ),
    Error,
    "in the future",
  );
  assertEquals(saved, false);
});

Deno.test("erpnext_attendance_day_fix - refuses an unusable log_type", async () => {
  let saved = false;
  const client = attendanceClient(brokenDay(), () => saved = true);

  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2026-08-29",
          reason: "Bổ sung lượt ra còn thiếu",
          add: [{ log_type: "CHECKOUT", time: "2026-08-29 17:05:00" }],
          confirm_cancel_attendance: true,
        },
        makeCtx(client),
      ),
    Error,
    "log_type must be 'IN' or 'OUT'",
  );
  assertEquals(saved, false);
});

Deno.test("erpnext_attendance_day_fix - refuses a reason too short to explain anything", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2026-08-29",
          reason: "quen",
          add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
        },
        makeCtx(attendanceClient(brokenDay())),
      ),
    Error,
    "at least 10 characters",
  );
});

Deno.test("erpnext_attendance_day_fix - stops on a day the site reports as blocked", async () => {
  // Bản nháp không huỷ được bằng `cancel()`, nên đi tiếp là sửa xong giờ rồi mới vấp lỗi
  // duplicate mà HRMS nuốt im lặng.
  let saved = false;
  const client = attendanceClient(
    brokenDay({
      blocked: true,
      locked_reason:
        "Ngày này đang có bản ghi chấm công nháp HR-ATT-2026-00500.",
    }),
    () => saved = true,
  );

  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2026-08-29",
          reason: "Bổ sung lượt ra còn thiếu",
          add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
          confirm_cancel_attendance: true,
        },
        makeCtx(client),
      ),
    Error,
    "nháp",
  );
  assertEquals(saved, false);
});

Deno.test("erpnext_attendance_day_fix - refuses to edit a checkin from another day", async () => {
  let saved = false;
  const client = attendanceClient(brokenDay(), () => saved = true);

  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2026-08-29",
          reason: "Sửa giờ vào cho đúng",
          edit: [{ name: "EMP-CKIN-999", time: "2026-08-29 08:00:00" }],
          confirm_cancel_attendance: true,
        },
        makeCtx(client),
      ),
    Error,
    "EMP-CKIN-999",
  );
  assertEquals(saved, false);
});

Deno.test("erpnext_attendance_day_fix - refuses a call with nothing to change", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_fix").handler(
        {
          employee: "HR-EMP-00044",
          date: "2026-08-29",
          reason: "Kiểm tra lại ngày công",
        },
        makeCtx(attendanceClient(brokenDay())),
      ),
    Error,
    "nothing to do",
  );
});

Deno.test("erpnext_attendance_day_get - says which app is missing instead of leaking a Frappe trace", async () => {
  const client = makeMockClient({
    get: async (_doctype: string, name: string) => ({ name }),
    callMethod: async () => {
      throw new Error("Failed to get method for command hvg_workspace.api.x");
    },
  });

  await assertRejects(
    () =>
      getTool("erpnext_attendance_day_get").handler(
        { employee: "HR-EMP-00044", date: "2026-08-29" },
        makeCtx(client),
      ),
    Error,
    "hvg_workspace",
  );
});

Deno.test("attendance repair tools carry honest write annotations", async () => {
  // `initialize` dựng văn bản hướng dẫn từ chính danh sách tool, nên một tool ghi mà khai
  // readOnly làm văn bản ấy nói sai ngay cả khi chạy đúng.
  assertEquals(
    getTool("erpnext_attendance_day_fix").annotations?.readOnlyHint,
    false,
  );
  assertEquals(
    getTool("erpnext_attendance_day_fix").annotations?.destructiveHint,
    true,
  );
  assertEquals(
    getTool("erpnext_attendance_day_get").annotations?.readOnlyHint,
    true,
  );
  assertEquals(
    getTool("erpnext_employee_checkin_list").annotations?.readOnlyHint,
    true,
  );
});

// ── Sau lượt review: các nhánh mà bản đầu tiên bỏ sót ────────────────────────

Deno.test("erpnext_attendance_day_get - returns a blocked day instead of throwing", async () => {
  // Mô tả của tool hứa trả `blocked` và `locked_reason` để người hỏi biết vì sao bế tắc.
  // Ném lỗi ở đây là nuốt mất đúng thứ đã hứa, và lượt bấm giờ với ca cũng mất theo.
  const client = attendanceClient(
    brokenDay({
      blocked: true,
      locked_reason:
        "Ngày này đang có bản ghi chấm công nháp HR-ATT-2026-00500.",
    }),
  );

  const result = await getTool("erpnext_attendance_day_get").handler(
    { employee: "HR-EMP-00044", date: "2026-08-29" },
    makeCtx(client),
  ) as { data: Record<string, unknown> };

  assertEquals(result.data.blocked, true);
  assertStringIncludes(String(result.data.locked_reason), "nháp");
  assertEquals((result.data.rows as unknown[]).length, 1);
});

Deno.test("attendance repair tools do not disguise a business error as a missing app", async () => {
  // "not found" xuất hiện trong vô số lỗi nghiệp vụ thật. Dịch tất cả thành "site chưa cài
  // app" là báo sai nguyên nhân, và `FrappeAPIError` bị thay bằng `Error` trần nên người
  // gọi mất luôn `status` với `body` đã parse.
  const client = makeMockClient({
    callMethod: async (method: string) => {
      if (method === "frappe.client.get_value") {
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      throw new Error(
        "[FrappeClient] Employee Checkin EMP-CKIN-08-2026-00123 not found (HTTP 404)",
      );
    },
  });

  const err = await assertRejects(
    () =>
      getTool("erpnext_attendance_day_get").handler(
        { employee: "HR-EMP-00044", date: "2026-08-29" },
        makeCtx(client),
      ),
    Error,
  );
  assertStringIncludes(err.message, "EMP-CKIN-08-2026-00123 not found");
  assert(
    !err.message.includes("hvg_workspace' app installed"),
    "a domain error must not be reported as a missing app",
  );
});

Deno.test("erpnext_attendance_day_fix - infers blank directions from the patched order", async () => {
  // Hai lượt trống trong kho. Thêm một lượt IN vào SỚM NHẤT ngày thì thứ tự đổi, nên chiều
  // suy ra phải đổi theo. Suy trên thứ tự cũ là gửi lên IN, IN, OUT.
  let sent: Record<string, unknown> | undefined;
  const client = attendanceClient(
    brokenDay({
      rows: [
        { name: "CK-1", time: "2026-08-29 08:00:00", log_type: "" },
        { name: "CK-2", time: "2026-08-29 17:00:00", log_type: "" },
      ],
    }),
    (args) => sent = args,
  );

  await getTool("erpnext_attendance_day_fix").handler(
    {
      employee: "HR-EMP-00044",
      date: "2026-08-29",
      reason: "Bổ sung lượt vào sớm theo camera",
      add: [{ log_type: "IN", time: "2026-08-29 07:00:00" }],
      confirm_cancel_attendance: true,
    },
    makeCtx(client),
  );

  assertEquals(sent?.rows, [
    { name: "", time: "2026-08-29 07:00:00", log_type: "IN" },
    { name: "CK-1", time: "2026-08-29 08:00:00", log_type: "OUT" },
    { name: "CK-2", time: "2026-08-29 17:00:00", log_type: "IN" },
  ]);
  // `base` vẫn là ảnh chụp NGUYÊN TRẠNG, chuỗi rỗng giữ nguyên rỗng, nếu không khoá lạc
  // quan của server so với một cái nền chưa từng tồn tại.
  assertEquals(sent?.base, {
    "CK-1": { time: "2026-08-29 08:00:00", log_type: "" },
    "CK-2": { time: "2026-08-29 17:00:00", log_type: "" },
  });
});

Deno.test("erpnext_attendance_day_fix - invalidates the caches it just made stale", async () => {
  // Ghi qua `callMethod` không tự dọn cache. Bỏ bước này thì lượt đọc ngay sau đó còn trả
  // về lượt bấm giờ cũ và bản Attendance vừa bị huỷ.
  const invalidated: Array<[string, string | undefined]> = [];
  const client = attendanceClient(brokenDay());
  (client as unknown as Record<string, AnyFn>).invalidate = (
    doctype: string,
    name?: string,
  ) => invalidated.push([doctype, name]);

  await getTool("erpnext_attendance_day_fix").handler(
    {
      employee: "HR-EMP-00044",
      date: "2026-08-29",
      reason: "Bổ sung lượt ra còn thiếu",
      add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
      confirm_cancel_attendance: true,
    },
    makeCtx(client),
  );

  assertEquals(invalidated, [
    ["Employee Checkin", undefined],
    ["Attendance", "HR-ATT-2026-00332"],
    ["Attendance", "HR-ATT-2026-00401"],
  ]);
});

Deno.test("erpnext_attendance_day_fix - shouts when a cancellation happened unconfirmed", async () => {
  // Cửa xác nhận đo trạng thái của lượt ĐỌC, còn server huỷ ở lượt GHI. Chấm công tự động
  // dựng một bản Attendance đúng vào khe giữa hai lượt thì bản ấy bị huỷ mà không ai xác
  // nhận. Đóng khe phải sửa server; ở đây im lặng mới là hỏng.
  const client = attendanceClient(
    brokenDay({ locked: false, attendance: null, locked_reason: "" }),
  );

  const result = await getTool("erpnext_attendance_day_fix").handler(
    {
      employee: "HR-EMP-00044",
      date: "2026-08-29",
      reason: "Bổ sung lượt ra còn thiếu",
      add: [{ log_type: "OUT", time: "2026-08-29 17:05:00" }],
    },
    makeCtx(client),
  ) as { message: string };

  assertStringIncludes(result.message, "WARNING");
  assertStringIncludes(result.message, "did not confirm a cancellation");
  assertStringIncludes(result.message, "HR-ATT-2026-00332");
});
