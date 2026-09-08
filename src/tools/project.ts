/**
 * ERPNext Project Tools
 *
 * MCP tools for project management: projects, tasks, timesheets.
 *
 * @module lib/erpnext/tools/project
 */

import type { FrappeFilter } from "../api/types.ts";
import type { ErpNextTool } from "./types.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import { listResult } from "./list-result.ts";
import { DOCLIST_META } from "./viewer-meta.ts";
import {
  applyAssignment,
  assignedToFilter,
  ASSIGNMENT_INPUT_PROPERTIES,
  fetchDocAfterAssignment,
  prepareAssignment,
  resolveAssignees,
  validateAssignees,
} from "./assignment.ts";
import { resolveAssigneeUser, resolveEmployee } from "../api/resolve.ts";

/**
 * The eight columns `erpnext_task_list` reads on every ERPNext site, custom fields excluded.
 */
const TASK_LIST_FIELDS = [
  "name",
  "subject",
  "project",
  "status",
  "priority",
  "exp_start_date",
  "exp_end_date",
  "progress",
];

/**
 * Mã sản phẩm, do `hvg_workspace.api.update_task_meta` ghi. Chỉ đọc CỘT, tuyệt đối không tự tách
 * `sku:` ra khỏi `custom_agent_meta`: luật trích mã có ít nhất ba mặt độc lập cùng phải khớp (vị
 * ngữ người phụ trách, phép lọc `is_group`/`is_template`, và phạm vi áp biểu thức chỗ điền mẫu
 * `x{4,}` lên GIÁ TRỊ chứ không lên cả khối), nên mỗi bản chép lại chỉ cần trượt một mặt là ra một
 * con số trông hoàn toàn hợp lý mà vẫn sai. Đo ngày 29/08/2026 trên site thật, ba bản chép độc lập
 * cho ba số sai khác nhau. Nguồn duy nhất là `_read_task_sku`, và nó không whitelist nên MCP không
 * gọi được.
 */
const TASK_SKU_FIELD = "custom_sku";

/**
 * Loại sản phẩm, cùng nguồn và cùng luật với {@link TASK_SKU_FIELD}: `update_task_meta` ghi cột,
 * còn dòng `product_type:` trong `custom_agent_meta` chỉ là bản nháp người dùng gõ. Đọc CỘT, tuyệt
 * đối không tự tách dòng đó ra: `_extract_task_product_type` còn phải tra tên vào `HVG Product
 * Category` bằng đúng collation `utf8mb4_unicode_ci` mới biết giá trị có thật hay không, nên một
 * bản chép lại ở đây sẽ nhận cả những tên không tồn tại trong danh mục.
 *
 * Cột này đi sau `custom_sku` một đợt phát hành, nên một site có `custom_sku` vẫn có thể thiếu nó -
 * đó là lý do danh sách dưới đây theo dõi từng cột riêng chứ không coi cả hai là một gói.
 */
const TASK_PRODUCT_TYPE_FIELD = "custom_product_type";

/**
 * The `hvg_workspace` columns `erpnext_task_list` asks for when the site turns out to have them.
 */
const TASK_OPTIONAL_FIELDS = [TASK_SKU_FIELD, TASK_PRODUCT_TYPE_FIELD];

/**
 * Which optional columns a site turned out NOT to have, remembered per client.
 *
 * These fields belong to `hvg_workspace`, not to ERPNext, so most sites this package is published
 * for do not have them - and Frappe does not quietly skip a column it cannot find. It fails the
 * whole `SELECT` with MySQL error 1054, which is exactly how five list tools came to return an
 * error instead of a list on v16 (3.3.3). Asking for the fields unconditionally would break
 * `erpnext_task_list` on every standard site.
 *
 * A `WeakMap` rather than a module-level flag because one process may talk to several sites, and
 * a site without a field must not teach the next client to stop asking. Only ABSENCE is recorded,
 * never presence: a site that has both columns pays no probe at all, and a site that lacks one
 * pays one wasted request for that column, once.
 *
 * A `Set` rather than a single flag because the two columns shipped in different releases. Frappe
 * names exactly one column per 1054, so a site missing both is learned one column per retry - and
 * each retry drops one entry from the request, which is what bounds the loop.
 */
const taskMissingFields = new WeakMap<FrappeClient, Set<string>>();

/**
 * The column a MySQL 1054 names, e.g. `Unknown column 'tabTask.custom_sku' in 'SELECT'`.
 *
 * The optional backslash covers the quote surviving a JSON round-trip of the response body.
 */
const UNKNOWN_COLUMN_RE = /Unknown column \\?['"`]([^'"`\\]+)/i;

/**
 * Whether this error is Frappe refusing the given column because the site does not have it.
 *
 * Reads the response body ONLY, and compares the column the database named. Searching
 * `error.message` for the field would be wrong twice over: the message embeds the request path,
 * and that path carries every optional column inside the `fields` query parameter, so an
 * unknown-column error about a COMPLETELY DIFFERENT column would match. The retry, which drops
 * only the column it believes was named, would then fail again anyway - after teaching the client
 * a lie it keeps for the rest of the process, so a site whose real schema problem later gets fixed
 * would silently stop being asked for a column it does have. With more than one optional column
 * the same substring match would also drop them one by one on a single unrelated failure.
 */
function isUnknownColumnError(error: unknown, field: string): boolean {
  if (!(error instanceof FrappeAPIError)) return false;
  const body = typeof error.body === "string"
    ? error.body
    : JSON.stringify(error.body ?? "");
  const named = UNKNOWN_COLUMN_RE.exec(body)?.[1];
  if (named === undefined) return false;
  // Có bản Frappe nêu trần tên cột, có bản nêu kèm bảng (`tabTask.custom_sku`).
  return named.split(".").pop() === field;
}

export const projectTools: ErpNextTool[] = [
  // ── Projects ──────────────────────────────────────────────────────────────

  {
    name: "erpnext_project_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description: "List Projects. Filterable by status. " +
      "Fields: name, project_name, status, percent_complete, expected_start_date, " +
      "expected_end_date, estimated_costing.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        status: {
          type: "string",
          description: "Filter by status (Open, Completed, Cancelled)",
          enum: ["Open", "Completed", "Cancelled"],
        },
        company: { type: "string", description: "Filter by company" },
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
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.company) {
        filters.push(["company", "=", input.company as string]);
      }
      if (input.date_from) {
        filters.push(["expected_start_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["expected_end_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Project", {
        fields: [
          "name",
          "project_name",
          "status",
          "percent_complete",
          "expected_start_date",
          "expected_end_date",
          "estimated_costing",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Project", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_project_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Project by name. Returns full document including tasks summary.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_project_get] 'name' is required");
      }
      const doc = await ctx.client.get("Project", input.name as string);
      return { data: doc };
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────

  {
    name: "erpnext_task_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description: "List Tasks. Filterable by project, status, priority. " +
      "Fields: name, subject, project, status, priority, exp_start_date, exp_end_date, progress. " +
      "Sites carrying hvg_workspace also get 'custom_sku' and 'custom_product_type'; both are " +
      "absent elsewhere, and a site may carry the first without the second. Where present they " +
      "are empty for every Task created before each field shipped and never backfilled, so an " +
      "empty value means 'not recorded here', never 'no product'.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        project: { type: "string", description: "Filter by project name" },
        status: {
          type: "string",
          description:
            "Filter by status (Open, Working, Pending Review, Overdue, Completed, Cancelled)",
        },
        priority: {
          type: "string",
          description: "Filter by priority (Low, Medium, High, Urgent)",
          enum: ["Low", "Medium", "High", "Urgent"],
        },
        assigned_to: {
          type: "string",
          description:
            'Only tasks assigned to this person. Accepts "me" for the calling user, ' +
            "a User id (email) or a full name.",
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
      // Cùng lý do với `erpnext_doc_list`: email đã là ID của `User`, nên lượt đọc thêm chỉ
      // mua được một 403 cho nhân viên không có quyền đọc hồ sơ người khác.
      if (input.assigned_to) {
        filters.push(
          assignedToFilter(
            await resolveAssigneeUser(ctx.client, input.assigned_to as string, {
              allowPartialMatch: true,
            }),
          ),
        );
      }
      if (input.project) {
        filters.push(["project", "=", input.project as string]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.priority) {
        filters.push(["priority", "=", input.priority as string]);
      }
      if (input.date_from) {
        filters.push(["exp_start_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["exp_end_date", "<=", input.date_to as string]);
      }

      const query = { filters, limit, order_by: "modified desc" };
      // Chưa biết site có cột nào thì cứ hỏi cả hai: site của Havi có, và đó là ca thường.
      const missing = taskMissingFields.get(ctx.client);
      let optional = TASK_OPTIONAL_FIELDS.filter((field) =>
        !missing?.has(field)
      );

      let docs;
      for (;;) {
        try {
          docs = await ctx.client.list("Task", {
            fields: [...TASK_LIST_FIELDS, ...optional],
            ...query,
          });
          break;
        } catch (error) {
          const absent = optional.find((field) =>
            isUnknownColumnError(error, field)
          );
          // Lỗi không phải "site thiếu một cột mình vừa hỏi" thì để nguyên nó đi lên: nuốt ở đây
          // là biến một site hỏng thật thành một danh sách trông bình thường.
          if (absent === undefined) throw error;
          // Site không mang cột đó. Nhớ lại để lượt sau không tốn thêm một vòng nữa, rồi hỏi lại
          // thay vì ném lỗi vào mặt người chỉ muốn liệt kê công việc. Mỗi vòng bỏ đúng một cột
          // khỏi `optional`, nên vòng lặp dừng chậm nhất sau `TASK_OPTIONAL_FIELDS.length` lượt.
          let known = taskMissingFields.get(ctx.client);
          if (known === undefined) {
            known = new Set<string>();
            taskMissingFields.set(ctx.client, known);
          }
          known.add(absent);
          optional = optional.filter((field) => field !== absent);
        }
      }

      return await listResult(ctx, "Task", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_task_create",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    description:
      "Create a new Task in a project. Requires project and subject. " +
      "Dates in YYYY-MM-DD format. Use assign_to for Frappe's native assignment workflow; native notifications are sent to assigned users.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name" },
        subject: { type: "string", description: "Task subject/title" },
        status: {
          type: "string",
          description: "Task status (default: Open)",
          enum: [
            "Open",
            "Working",
            "Pending Review",
            "Overdue",
            "Completed",
            "Cancelled",
          ],
        },
        priority: {
          type: "string",
          description: "Task priority (default: Medium)",
          enum: ["Low", "Medium", "High", "Urgent"],
        },
        exp_start_date: {
          type: "string",
          description: "Expected start date YYYY-MM-DD",
        },
        exp_end_date: {
          type: "string",
          description: "Expected end date YYYY-MM-DD",
        },
        ...ASSIGNMENT_INPUT_PROPERTIES,
      },
      required: ["project", "subject"],
    },
    handler: async (input, ctx) => {
      if (!input.project) {
        throw new Error("[erpnext_task_create] 'project' is required");
      }
      if (!input.subject) {
        throw new Error("[erpnext_task_create] 'subject' is required");
      }

      let assignment = prepareAssignment(input, "erpnext_task_create");
      if (assignment) {
        assignment = await resolveAssignees(assignment, ctx);
        await validateAssignees(
          assignment.assignees,
          "erpnext_task_create",
          ctx,
        );
      }

      const data: Record<string, unknown> = {
        project: input.project as string,
        subject: input.subject as string,
      };
      if (input.status) data.status = input.status as string;
      if (input.priority) data.priority = input.priority as string;
      if (input.exp_start_date) {
        data.exp_start_date = input.exp_start_date as string;
      }
      if (input.exp_end_date) data.exp_end_date = input.exp_end_date as string;

      const doc = await ctx.client.create("Task", data);
      if (!assignment) {
        return {
          data: doc,
          message: `Task ${doc.name} created successfully`,
        };
      }

      const assignmentInfo = await applyAssignment(
        "Task",
        doc.name as string,
        assignment,
        ctx,
        `[erpnext_task_create] Task ${doc.name} was created, but assignment failed`,
      );
      const freshDoc = await fetchDocAfterAssignment(
        "Task",
        doc.name as string,
        ctx,
        "erpnext_task_create",
      );
      return {
        data: freshDoc,
        message: `Task ${doc.name} created successfully`,
        assignment: assignmentInfo,
      };
    },
  },

  {
    name: "erpnext_task_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Task by name. Returns full document including description and dependencies.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name (e.g. TASK-00001)" },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_task_get] 'name' is required");
      }
      const doc = await ctx.client.get("Task", input.name as string);
      return { data: doc };
    },
  },

  {
    name: "erpnext_task_update",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    description:
      "Update an existing Task. Pass only the fields you want to change. " +
      "Commonly used to change status, progress, or dates. Use assign_to for Frappe's native assignment workflow; native notifications are sent to assigned users.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Task name (e.g. TASK-00001)" },
        status: {
          type: "string",
          description: "New status",
          enum: [
            "Open",
            "Working",
            "Pending Review",
            "Overdue",
            "Completed",
            "Cancelled",
          ],
        },
        priority: {
          type: "string",
          description: "New priority",
          enum: ["Low", "Medium", "High", "Urgent"],
        },
        progress: {
          type: "number",
          description: "Completion percentage (0-100)",
        },
        exp_end_date: {
          type: "string",
          description: "New expected end date YYYY-MM-DD",
        },
        description: { type: "string", description: "New task description" },
        ...ASSIGNMENT_INPUT_PROPERTIES,
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_task_update] 'name' is required");
      }

      let assignment = prepareAssignment(input, "erpnext_task_update");
      if (assignment) {
        assignment = await resolveAssignees(assignment, ctx);
        await validateAssignees(
          assignment.assignees,
          "erpnext_task_update",
          ctx,
        );
      }

      const data: Record<string, unknown> = {};
      for (
        const key of [
          "status",
          "priority",
          "progress",
          "exp_end_date",
          "description",
        ]
      ) {
        if (input[key] !== undefined) data[key] = input[key];
      }

      if (Object.keys(data).length === 0 && !assignment) {
        throw new Error(
          "[erpnext_task_update] At least one field to update is required",
        );
      }

      const name = input.name as string;
      if (!assignment) {
        const doc = await ctx.client.update("Task", name, data);
        return {
          data: doc,
          message: `Task ${name} updated successfully`,
        };
      }

      const fieldsUpdated = Object.keys(data).length > 0;
      if (fieldsUpdated) {
        await ctx.client.update("Task", name, data);
      }
      const failureContext = fieldsUpdated
        ? `[erpnext_task_update] Task ${name} was updated, but assignment failed`
        : `[erpnext_task_update] Task ${name} assignment failed`;
      const assignmentInfo = await applyAssignment(
        "Task",
        name,
        assignment,
        ctx,
        failureContext,
      );
      const freshDoc = await fetchDocAfterAssignment(
        "Task",
        name,
        ctx,
        "erpnext_task_update",
      );
      return {
        data: freshDoc,
        message: `Task ${name} updated successfully`,
        assignment: assignmentInfo,
      };
    },
  },

  // ── Timesheets ────────────────────────────────────────────────────────────

  {
    name: "erpnext_timesheet_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description: "List Timesheets. Filterable by employee, project. " +
      "Fields: name, employee, start_date, end_date, status, total_hours.",
    category: "project",
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
        project: { type: "string", description: "Filter by project name" },
        status: {
          type: "string",
          description: "Filter by status (Draft, Submitted, Cancelled)",
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
      if (input.project) {
        filters.push(["project", "=", input.project as string]);
      }
      if (input.status) {
        filters.push(["status", "=", input.status as string]);
      }
      if (input.date_from) {
        filters.push(["start_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["end_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Timesheet", {
        fields: [
          "name",
          "employee",
          "start_date",
          "end_date",
          "status",
          "total_hours",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Timesheet", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_timesheet_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Timesheet by name. Returns full document with time log details.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Timesheet name" },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_timesheet_get] 'name' is required");
      }
      const doc = await ctx.client.get("Timesheet", input.name as string);
      return { data: doc };
    },
  },

  {
    name: "erpnext_project_create",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    description:
      "Create a new Project. Requires project_name. Optionally set expected_start_date and expected_end_date.",
    category: "project",
    inputSchema: {
      type: "object",
      properties: {
        project_name: { type: "string", description: "Project name" },
        status: {
          type: "string",
          description: "Initial status (default: Open)",
          enum: ["Open", "Completed", "Cancelled"],
        },
        expected_start_date: {
          type: "string",
          description: "Expected start date YYYY-MM-DD",
        },
        expected_end_date: {
          type: "string",
          description: "Expected end date YYYY-MM-DD",
        },
        estimated_costing: {
          type: "number",
          description: "Budget estimate",
        },
        company: { type: "string", description: "Company name" },
      },
      required: ["project_name"],
    },
    handler: async (input, ctx) => {
      if (!input.project_name) {
        throw new Error("[erpnext_project_create] 'project_name' is required");
      }

      const data: Record<string, unknown> = {
        project_name: input.project_name as string,
      };
      if (input.status) data.status = input.status as string;
      if (input.expected_start_date) {
        data.expected_start_date = input.expected_start_date as string;
      }
      if (input.expected_end_date) {
        data.expected_end_date = input.expected_end_date as string;
      }
      if (input.estimated_costing !== undefined) {
        data.estimated_costing = input.estimated_costing;
      }
      if (input.company) data.company = input.company as string;

      const doc = await ctx.client.create("Project", data);
      return {
        data: doc,
        message: `Project ${doc.name} created successfully`,
      };
    },
  },
];
