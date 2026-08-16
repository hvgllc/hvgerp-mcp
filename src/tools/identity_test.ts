import { assertEquals, assertStringIncludes } from "@std/assert";
import type { FrappeClient } from "../api/frappe-client.ts";
import { clearCallerProfileCache } from "../api/identity.ts";
import { identityTools } from "./identity.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

function tool(name: string): ErpNextTool {
  const found = identityTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

const USER_DOC = {
  name: "khoa.do@havigroup.com",
  email: "khoa.do@havigroup.com",
  full_name: "Do Khoa",
  user_type: "System User",
  enabled: 1,
  roles: [{ role: "Employee" }],
};

const EMPLOYEE_ROW = {
  name: "HR-EMP-00044",
  employee_name: "Do Khoa",
  designation: "Ky su",
  department: "Cong nghe - HVG",
  company: "Havi Group",
  reports_to: null,
  status: "Active",
  date_of_joining: "2024-01-15",
};

/** Records every list() call so a test can assert which filter reached Frappe. */
interface ListCall {
  doctype: string;
  options: Record<string, unknown>;
}

function makeCtx(
  overrides: Record<string, AnyFn> = {},
  calls: ListCall[] = [],
): ErpNextToolContext {
  const client = {
    callMethod: async () => "khoa.do@havigroup.com",
    get: async () => USER_DOC,
    list: async (doctype: string, options: Record<string, unknown>) => {
      calls.push({ doctype, options });
      return doctype === "Employee" ? [EMPLOYEE_ROW] : [];
    },
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    ...overrides,
  } as unknown as FrappeClient;
  return { client };
}

Deno.test("erpnext_whoami reports the caller, their roles and their Employee", async () => {
  clearCallerProfileCache();
  const result = await tool("erpnext_whoami").handler({}, makeCtx()) as Record<
    string,
    unknown
  >;

  assertEquals(
    (result.user as Record<string, unknown>).name,
    "khoa.do@havigroup.com",
  );
  assertEquals(result.roles, ["Employee"]);
  assertEquals(
    (result.employee as Record<string, unknown>).name,
    "HR-EMP-00044",
  );
});

Deno.test("erpnext_whoami warns when the profile is a shared service account", async () => {
  clearCallerProfileCache();
  const result = await tool("erpnext_whoami").handler({}, makeCtx()) as Record<
    string,
    unknown
  >;

  assertEquals(result.identity_mode, "shared-service-account");
  assertStringIncludes(
    result.warning as string,
    "NOT the identity of the person you are talking to",
  );
});

Deno.test("erpnext_whoami says so when the caller has no Employee record", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => doctype === "Employee" ? [] : [],
  });
  const result = await tool("erpnext_whoami").handler({}, ctx) as Record<
    string,
    unknown
  >;

  assertEquals(result.employee, null);
  assertStringIncludes(
    result.employee_note as string,
    "cannot be queried for them",
  );
});

Deno.test("erpnext_my_work filters ToDos by the caller and Tasks by assignment", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["todos", "tasks"] },
    makeCtx({}, calls),
  );

  const todo = calls.find((call) => call.doctype === "ToDo");
  assertEquals(todo?.options.filters, [
    ["allocated_to", "=", "khoa.do@havigroup.com"],
    ["status", "=", "Open"],
  ]);

  const task = calls.find((call) => call.doctype === "Task");
  assertEquals(task?.options.filters, [
    ["_assign", "like", '%"khoa.do@havigroup.com"%'],
    ["status", "not in", ["Completed", "Cancelled"]],
  ]);
});

Deno.test("erpnext_my_work drops the open-only filter when asked for closed work", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["todos"], include_closed: true },
    makeCtx({}, calls),
  );

  const todo = calls.find((call) => call.doctype === "ToDo");
  assertEquals(todo?.options.filters, [
    ["allocated_to", "=", "khoa.do@havigroup.com"],
  ]);
});

Deno.test("erpnext_my_work skips employee-keyed sections without an Employee", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  const ctx = makeCtx({
    list: async (doctype: string, options: Record<string, unknown>) => {
      calls.push({ doctype, options });
      return [];
    },
  }, calls);

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  const skipped = result.skipped_sections as Record<string, unknown>;
  assertEquals(skipped.sections, [
    "leave_applications",
    "expense_claims",
    "timesheets",
  ]);
  // Skipped means not queried: an unfiltered payroll read would be a disclosure.
  assertEquals(
    calls.filter((call) => call.doctype === "Leave Application").length,
    0,
  );
  assertEquals(result.leave_applications, undefined);
});

Deno.test("erpnext_my_work reports a refused section instead of failing the call", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "Timesheet") {
        throw new Error("Not permitted for Timesheet");
      }
      return [];
    },
  });

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  assertEquals(
    (result.timesheets as Record<string, unknown>).error,
    "Not permitted for Timesheet",
  );
  // The other sections still answered.
  assertEquals((result.todos as Record<string, unknown>).count, 0);
});

Deno.test("erpnext_my_work ignores unknown section names", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["todos", "salaries"] },
    makeCtx({}, calls),
  );

  const doctypes = calls.map((call) => call.doctype);
  assertEquals(doctypes.includes("Salary Slip"), false);
  assertEquals(doctypes.includes("ToDo"), true);
});

Deno.test("identity tools are annotated read-only", () => {
  for (const candidate of identityTools) {
    assertEquals(candidate.annotations?.readOnlyHint, true, candidate.name);
  }
});
