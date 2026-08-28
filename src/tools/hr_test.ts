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

import { assertEquals, assertRejects } from "@std/assert";
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
