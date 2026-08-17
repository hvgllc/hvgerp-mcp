/**
 * Identity tools — who is asking, and what is on their plate.
 *
 * These two tools exist because every other tool in this server needs an answer they could not
 * produce. "Show my open tasks" has no ERPNext query behind it until "my" has been turned into a
 * `User` id, and a model with no way to do that either asks the person to repeat their own email or
 * quietly answers for whoever the deployment happens to run as.
 *
 * `erpnext_whoami` is the lookup; `erpnext_my_work` is the roll-up that would otherwise cost five
 * round trips and five guesses about which field each doctype keys ownership on (ToDo uses
 * `allocated_to`, Task uses the `_assign` JSON column, HR doctypes use `employee` — three different
 * answers to the same question).
 *
 * @module lib/erpnext/tools/identity
 */

import type { FrappeFilter } from "../api/types.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";
import { DOCLIST_META } from "./viewer-meta.ts";
import { assignedToFilter } from "./assignment.ts";
import { type CallerProfile, loadCallerProfile } from "../api/identity.ts";
import { FrappeAPIError } from "../api/frappe-client.ts";

/**
 * Told to the model whenever the reply describes the deployment's service account.
 *
 * Without it a profile still looks like a personal one, and the model would introduce the service
 * account's roles as the user's own.
 */
const SHARED_ACCOUNT_WARNING =
  "This deployment runs every MCP call under one shared ERPNext service account, so this is the " +
  "service account's identity — NOT the identity of the person you are talking to. Do not present " +
  "it as theirs, and treat any 'my ...' answer as unscoped. Set MCP_CALLER_IDENTITY=required and " +
  "remove ERPNEXT_API_KEY/ERPNEXT_API_SECRET to bind calls to the end user.";

/** Sections `erpnext_my_work` can return, in the order they are reported. */
const WORK_SECTIONS = [
  "todos",
  "tasks",
  "projects",
  "leave_applications",
  "expense_claims",
  "timesheets",
] as const;

type WorkSection = typeof WORK_SECTIONS[number];

/** Sections keyed on an `Employee` link rather than on a `User`. */
const EMPLOYEE_SECTIONS: ReadonlySet<WorkSection> = new Set([
  "leave_applications",
  "expense_claims",
  "timesheets",
]);

function identityNote(profile: CallerProfile): string | undefined {
  return profile.identity_mode === "shared-service-account"
    ? SHARED_ACCOUNT_WARNING
    : undefined;
}

/** Kết quả của một mục: hoặc các row đọc được, hoặc lý do không đọc được. */
type SectionOutcome =
  | { count: number; data: Record<string, unknown>[] }
  | { error: string };

/** Báo cáo một mục trong payload: chỉ số lượng hoặc lý do không đọc được, không lặp lại row. */
type SectionSummary = { count: number } | { error: string };

async function listSection(
  ctx: ErpNextToolContext,
  doctype: string,
  fields: string[],
  filters: FrappeFilter[],
  limit: number,
  orderBy: string,
): Promise<SectionOutcome> {
  try {
    const data = await ctx.client.list(doctype, {
      fields,
      filters,
      limit,
      order_by: orderBy,
    });
    return { count: data.length, data: data as Record<string, unknown>[] };
  } catch (error) {
    // Chỉ lời từ chối quyền mới được nuốt. Một doctype không đọc được không được phép làm trắng cả
    // bản tổng hợp: người không có quyền Payroll hay Projects vẫn có ToDo, và báo lời từ chối ngay
    // trong mục đó hữu ích hơn là làm hỏng cả lời gọi.
    //
    // Ngược lại, 5xx / timeout / lỗi mạng nói rằng câu trả lời KHÔNG đáng tin chứ không phải là
    // không đầy đủ. Ghi chúng vào một kết quả thành công là đưa cho client một bản tổng hợp thiếu
    // mà không kèm tín hiệu nào để thử lại, và mô hình sẽ đọc "không có việc nào" thay vì "chưa
    // đọc được". Cùng ranh giới mà `loadCallerProfile` đã dùng cho lượt đọc Employee.
    if (!(error instanceof FrappeAPIError) || error.status !== 403) throw error;
    return { error: error.message };
  }
}

export const identityTools: ErpNextTool[] = [
  {
    name: "erpnext_whoami",
    annotations: { readOnlyHint: true },
    description:
      "Identify the ERPNext user this session is acting as: their User ID (email), full name, " +
      "roles, and linked Employee record (ID, designation, department, company, manager). " +
      "`roles` and `employee` may be null because the deployment withheld them rather than " +
      "because they are empty — read `roles_note`, `employee_lookup` and `employee_note` before " +
      "telling anyone they have no roles or no HR record. " +
      "CALL THIS FIRST whenever the request says 'my', 'me', 'I', 'mine', or names no subject at " +
      "all ('what is on my plate', 'my leave balance', 'tasks assigned to me') — every other tool " +
      "needs a concrete user or employee ID and this is the only tool that produces one. " +
      "`identity_mode` says whether the answer describes the end user ('per-caller') or a shared " +
      "service account ('shared-service-account'); under the latter it is NOT the person you are " +
      "talking to.",
    category: "identity",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const profile = await loadCallerProfile(ctx.client);
      const note = identityNote(profile);
      return {
        user: profile.user,
        roles: profile.roles,
        ...(profile.roles === null
          ? {
            roles_note:
              "This deployment does not let this user read their own role list (User.roles is a " +
              "permlevel-1 field, readable only by System Manager, and it comes back emptied " +
              "rather than omitted — `user_type` being null alongside it is the same withholding, " +
              "not a user without a type). Their roles are unknown — do not say they have none, " +
              "and do not infer what they may or may not do from this. What they can actually " +
              "reach is enforced by ERPNext on every call regardless.",
          }
          : {}),
        employee: profile.employee,
        employee_lookup: profile.employee_lookup,
        identity_mode: profile.identity_mode,
        ...(profile.employee ? {} : {
          employee_note: profile.employee_lookup === "forbidden"
            ? "This user may not read the Employee doctype, so whether they have an HR record is " +
              "unknown — do not tell them they have none. Employee-scoped data (leave, " +
              "attendance, expense claims, salary, timesheets) cannot be queried for them until " +
              "an administrator grants read access to Employee."
            : "This user has no Employee record, so employee-scoped data (leave, attendance, " +
              "expense claims, salary, timesheets) cannot be queried for them.",
        }),
        ...(note ? { warning: note } : {}),
      };
    },
  },

  {
    name: "erpnext_my_work",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "Everything currently open for the calling user, in one call: ToDos allocated to them, " +
      "Tasks and Projects assigned to them, and — when they have an Employee record — their " +
      "pending Leave Applications, unsettled Expense Claims and Timesheets. Use this for " +
      "'what am I working on', 'my tasks', 'my pending items', 'công việc của tôi'. Resolves the " +
      "caller itself, so it needs no user or employee argument. Each section is fetched " +
      "independently: a section the user may not read reports its own error instead of failing " +
      "the call.",
    category: "identity",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max rows per section (default 10)",
        },
        sections: {
          type: "array",
          description:
            "Which sections to fetch (default: all). Values: todos, tasks, projects, " +
            "leave_applications, expense_claims, timesheets.",
          items: { type: "string", enum: [...WORK_SECTIONS] },
        },
        include_closed: {
          type: "boolean",
          description:
            "Include finished work (completed/cancelled tasks, closed ToDos). Default false.",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 10;
      const includeClosed = input.include_closed === true;
      const requested = Array.isArray(input.sections)
        ? (input.sections as string[]).filter((
          section,
        ): section is WorkSection =>
          (WORK_SECTIONS as readonly string[]).includes(section)
        )
        : [...WORK_SECTIONS];

      const profile = await loadCallerProfile(ctx.client);
      const userId = profile.user.name;
      const employeeId = profile.employee?.name;
      const assigned = assignedToFilter(userId);

      const result: Record<string, unknown> = {
        user: profile.user,
        employee: profile.employee,
        employee_lookup: profile.employee_lookup,
        identity_mode: profile.identity_mode,
      };
      const note = identityNote(profile);
      if (note) result.warning = note;

      const skipped = requested.filter(
        (section) => EMPLOYEE_SECTIONS.has(section) && !employeeId,
      );
      if (skipped.length > 0) {
        result.skipped_sections = {
          sections: skipped,
          reason: profile.employee_lookup === "forbidden"
            ? `"${userId}" may not read the Employee doctype, so these sections have no key to ` +
              "filter on. This is a missing permission, not a missing HR record."
            : `"${userId}" has no Employee record, so these sections have no key to filter on.`,
        };
      }

      // Một mảng row duy nhất chứ không phải sáu object lồng nhau: `_meta: DOCLIST_META` gắn
      // tool này vào doclist viewer, mà `DoclistViewer.consumeToolResult()` từ chối mọi payload
      // không có `data` là mảng (`src/ui/doclist-viewer/src/DoclistViewer.tsx`), nên hình dạng cũ
      // để viewer đứng yên ở trạng thái rỗng dù tool trả về đầy việc. Chi tiết từng mục chuyển
      // sang `sections` dưới dạng count/error, không lặp lại row.
      const sections: Record<string, SectionSummary> = {};
      const rows: Record<string, unknown>[] = [];

      const collect = (
        section: WorkSection,
        doctype: string,
        outcome: SectionOutcome,
      ): void => {
        if ("error" in outcome) {
          sections[section] = outcome;
          return;
        }
        sections[section] = { count: outcome.count };
        for (const row of outcome.data) rows.push({ ...row, section, doctype });
      };

      for (const section of requested) {
        if (EMPLOYEE_SECTIONS.has(section) && !employeeId) continue;

        switch (section) {
          case "todos":
            collect(
              "todos",
              "ToDo",
              await listSection(
                ctx,
                "ToDo",
                [
                  "name",
                  "description",
                  "status",
                  "priority",
                  "date",
                  "reference_type",
                  "reference_name",
                ],
                includeClosed
                  ? [["allocated_to", "=", userId]]
                  : [["allocated_to", "=", userId], ["status", "=", "Open"]],
                limit,
                "date asc",
              ),
            );
            break;

          case "tasks":
            collect(
              "tasks",
              "Task",
              await listSection(
                ctx,
                "Task",
                [
                  "name",
                  "subject",
                  "project",
                  "status",
                  "priority",
                  "exp_end_date",
                  "progress",
                ],
                includeClosed ? [assigned] : [
                  assigned,
                  ["status", "not in", ["Completed", "Cancelled"]],
                ],
                limit,
                "exp_end_date asc",
              ),
            );
            break;

          case "projects":
            collect(
              "projects",
              "Project",
              await listSection(
                ctx,
                "Project",
                [
                  "name",
                  "project_name",
                  "status",
                  "percent_complete",
                  "expected_end_date",
                ],
                includeClosed
                  ? [assigned]
                  : [assigned, ["status", "=", "Open"]],
                limit,
                "expected_end_date asc",
              ),
            );
            break;

          case "leave_applications":
            collect(
              "leave_applications",
              "Leave Application",
              await listSection(
                ctx,
                "Leave Application",
                [
                  "name",
                  "leave_type",
                  "from_date",
                  "to_date",
                  "total_leave_days",
                  "status",
                ],
                includeClosed
                  ? [["employee", "=", employeeId!]]
                  : [["employee", "=", employeeId!], ["status", "=", "Open"]],
                limit,
                "from_date desc",
              ),
            );
            break;

          case "expense_claims":
            collect(
              "expense_claims",
              "Expense Claim",
              await listSection(
                ctx,
                "Expense Claim",
                [
                  "name",
                  "posting_date",
                  "total_claimed_amount",
                  "total_sanctioned_amount",
                  "approval_status",
                  "status",
                  "docstatus",
                ],
                includeClosed
                  ? [["employee", "=", employeeId!]]
                  // `Expense Claim.status` có sáu giá trị trên ERPNext v16 (đo trên chính site:
                  // Draft, Paid, Unpaid, Rejected, Submitted, Cancelled), nên loại mỗi `Paid` vẫn để
                  // lọt đơn đã HUỶ và đơn bị TỪ CHỐI vào mục "việc đang mở" - cả hai đều là việc đã
                  // khép lại, không phải khoản chờ thanh toán.
                  : [
                    ["employee", "=", employeeId!],
                    ["status", "not in", ["Paid", "Cancelled", "Rejected"]],
                  ],
                limit,
                "posting_date desc",
              ),
            );
            break;

          case "timesheets":
            collect(
              "timesheets",
              "Timesheet",
              await listSection(
                ctx,
                "Timesheet",
                [
                  "name",
                  "start_date",
                  "end_date",
                  "total_hours",
                  "status",
                  "docstatus",
                ],
                includeClosed
                  ? [["employee", "=", employeeId!]]
                  // `docstatus = 0` chứ không phải một danh sách trạng thái: `Timesheet.status`
                  // có bảy giá trị trên ERPNext v16 (đo trên chính site: Draft, Submitted,
                  // Partially Billed, Billed, Payslip, Completed, Cancelled), nên loại mỗi
                  // `Cancelled` là trả về cả bảng chấm công đã NỘP - việc đã chốt, không còn
                  // chờ người này làm gì. Sáu trong bảy giá trị đó chỉ xuất hiện sau khi nộp,
                  // nên `docstatus` là ranh giới đúng và không phải sửa lại khi ERPNext thêm
                  // trạng thái thanh toán mới.
                  : [["employee", "=", employeeId!], ["docstatus", "=", 0]],
                limit,
                "start_date desc",
              ),
            );
            break;
        }
      }

      result.count = rows.length;
      result.data = rows;
      result.sections = sections;
      result._title = includeClosed
        ? `All work for ${profile.user.full_name ?? userId}`
        : `Open work for ${profile.user.full_name ?? userId}`;
      result._meta = DOCLIST_META;
      return result;
    },
  },
];
