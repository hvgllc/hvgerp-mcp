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

async function listSection(
  ctx: ErpNextToolContext,
  doctype: string,
  fields: string[],
  filters: FrappeFilter[],
  limit: number,
  orderBy: string,
): Promise<{ count: number; data: unknown[] } | { error: string }> {
  try {
    const data = await ctx.client.list(doctype, {
      fields,
      filters,
      limit,
      order_by: orderBy,
    });
    return { count: data.length, data };
  } catch (error) {
    // One inaccessible doctype must not blank the whole roll-up: a user without Payroll or Projects
    // permissions still has ToDos, and reporting the refusal per section is more useful than
    // failing the call.
    return {
      error: error instanceof Error ? error.message : String(error),
    };
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

      for (const section of requested) {
        if (EMPLOYEE_SECTIONS.has(section) && !employeeId) continue;

        switch (section) {
          case "todos":
            result.todos = await listSection(
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
            );
            break;

          case "tasks":
            result.tasks = await listSection(
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
            );
            break;

          case "projects":
            result.projects = await listSection(
              ctx,
              "Project",
              [
                "name",
                "project_name",
                "status",
                "percent_complete",
                "expected_end_date",
              ],
              includeClosed ? [assigned] : [assigned, ["status", "=", "Open"]],
              limit,
              "expected_end_date asc",
            );
            break;

          case "leave_applications":
            result.leave_applications = await listSection(
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
            );
            break;

          case "expense_claims":
            result.expense_claims = await listSection(
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
                : [["employee", "=", employeeId!], ["status", "!=", "Paid"]],
              limit,
              "posting_date desc",
            );
            break;

          case "timesheets":
            result.timesheets = await listSection(
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
                : [["employee", "=", employeeId!], [
                  "status",
                  "!=",
                  "Cancelled",
                ]],
              limit,
              "start_date desc",
            );
            break;
        }
      }

      result._meta = DOCLIST_META;
      return result;
    },
  },
];
