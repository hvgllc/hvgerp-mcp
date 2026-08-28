/**
 * ERPNext HR Tools
 *
 * MCP tools for human resources: employees, attendance, leave applications.
 *
 * @module lib/erpnext/tools/hr
 */

import type { FrappeFilter } from "../api/types.ts";
import type { ErpNextTool } from "./types.ts";
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
