import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
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
    callMethod: async (method: string) =>
      method === "frappe.client.get_count" ? 0 : "khoa.do@havigroup.com",
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
  assertEquals(
    (result.sections as Record<string, unknown>).leave_applications,
    undefined,
  );
});

Deno.test("erpnext_my_work reports a refused section instead of failing the call", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "Timesheet") {
        throw new FrappeAPIError("Not permitted for Timesheet", 403, {});
      }
      return [];
    },
  });

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  const sections = result.sections as Record<string, Record<string, unknown>>;
  assertStringIncludes(
    sections.timesheets.error as string,
    "Not permitted for Timesheet",
  );
  // The other sections still answered.
  assertEquals(sections.todos.count, 0);
});

Deno.test("erpnext_my_work does not report a 5xx section as a permission refusal", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "Timesheet") {
        throw new FrappeAPIError("Internal Server Error", 500, {});
      }
      return [];
    },
  });

  // Một mục hỏng vì máy chủ, không vì quyền. Gói nó vào một kết quả thành công thì client không
  // còn tín hiệu nào để thử lại, và mô hình đọc bản tổng hợp thiếu như thể nó đã đầy đủ.
  await assertRejects(
    () => tool("erpnext_my_work").handler({}, ctx),
    FrappeAPIError,
    "Internal Server Error",
  );
});

Deno.test("erpnext_my_work does not report a network failure as a permission refusal", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "ToDo") throw new TypeError("connection reset");
      return [];
    },
  });

  await assertRejects(
    () => tool("erpnext_my_work").handler({}, ctx),
    TypeError,
    "connection reset",
  );
});

Deno.test("erpnext_my_work treats cancelled and rejected claims as closed", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["expense_claims"] },
    makeCtx({}, calls),
  );

  // Excluding only `Paid` still let a CANCELLED or REJECTED claim through as "open
  // work": both are finished business, not money the company still owes.
  const claim = calls.find((call) => call.doctype === "Expense Claim");
  assertEquals(claim?.options.filters, [
    ["employee", "=", "HR-EMP-00044"],
    ["status", "not in", ["Paid", "Cancelled", "Rejected"]],
  ]);
});

Deno.test("erpnext_my_work returns one flat row array the viewer can render", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "ToDo") return [{ name: "TODO-1", status: "Open" }];
      if (doctype === "Task") return [{ name: "TASK-1", status: "Working" }];
      return [];
    },
  });

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  // `DoclistViewer.consumeToolResult()` refuses any payload whose `data` is not an
  // array, so the old six-nested-objects shape left the viewer sitting on an empty
  // state no matter how much work the tool had found.
  const rows = result.data as Record<string, unknown>[];
  assertEquals(Array.isArray(rows), true);
  assertEquals(rows.length, 2);
  assertEquals(result.count, 2);
  assertStringIncludes(result._title as string, "Do Khoa");
  // One flat table spans six doctypes, so every row has to name its own group.
  assertEquals(rows.map((row) => row.section), ["todos", "tasks"]);
  assertEquals(rows.map((row) => row.doctype), ["ToDo", "Task"]);
  // Per-section counts stay reachable without repeating the rows.
  const sections = result.sections as Record<string, Record<string, unknown>>;
  assertEquals(sections.todos.count, 1);
  assertEquals(sections.timesheets.count, 0);
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

Deno.test("erpnext_my_work asks for draft timesheets, not merely uncancelled ones", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["timesheets"] },
    makeCtx({}, calls),
  );

  // `Timesheet` is submittable and its `status` carries seven values on ERPNext v16
  // (Draft, Submitted, Partially Billed, Billed, Payslip, Completed, Cancelled), six of
  // which only appear after submission. Excluding `Cancelled` alone therefore returned
  // every SUBMITTED timesheet as work still waiting on this person.
  const timesheet = calls.find((call) => call.doctype === "Timesheet");
  assertEquals(timesheet?.options.filters, [
    ["employee", "=", "HR-EMP-00044"],
    ["docstatus", "=", 0],
  ]);
});

// ── mục dự án: hợp của `Project User` với `_assign` ─────────────────────────

const USER = "khoa.do@havigroup.com";
const MEMBER_FILTER = ["Project User", "user", "=", USER];
const ASSIGN_FILTER = ["_assign", "like", `%"${USER}"%`];
const OPEN_FILTER = ["status", "=", "Open"];

/** Nhận ra nửa nào của hợp đang được hỏi, bằng chính bộ lọc đã gửi đi. */
function asksFor(
  options: Record<string, unknown>,
  needle: readonly unknown[],
): boolean {
  return JSON.stringify(options.filters ?? []).includes(JSON.stringify(needle));
}

function project(name: string, endDate: string | null) {
  return {
    name,
    project_name: name,
    status: "Open",
    expected_end_date: endDate,
  };
}

Deno.test("erpnext_my_work asks for projects both by team membership and by assignment", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["projects"] },
    makeCtx({}, calls),
  );

  // Lọc mỗi `_assign` là hỏng trên site thật: 1 trong 142 dự án có `_assign` khác rỗng, trong khi
  // `Project User` có 688 dòng, nên mục này trả rỗng cho gần như mọi người.
  const projects = calls.filter((call) => call.doctype === "Project");
  assertEquals(projects.length, 2);
  assertEquals(projects[0].options.filters, [OPEN_FILTER, MEMBER_FILTER]);
  assertEquals(projects[1].options.filters, [OPEN_FILTER, ASSIGN_FILTER]);
  // Thứ tự phải là toàn phần, không thì phần cắt `limit` của trang ghép không tái lập được.
  assertEquals(projects[0].options.order_by, "expected_end_date asc, name asc");
  assertEquals(projects[1].options.order_by, "expected_end_date asc, name asc");
});

Deno.test("erpnext_my_work drops the open-only filter from both project halves", async () => {
  clearCallerProfileCache();
  const calls: ListCall[] = [];
  await tool("erpnext_my_work").handler(
    { sections: ["projects"], include_closed: true },
    makeCtx({}, calls),
  );

  const projects = calls.filter((call) => call.doctype === "Project");
  assertEquals(projects[0].options.filters, [MEMBER_FILTER]);
  assertEquals(projects[1].options.filters, [ASSIGN_FILTER]);
});

Deno.test("erpnext_my_work returns projects reachable only through Project User", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype !== "Project") return [];
      // Người thật này có 98 dự án qua bảng con và 0 qua `_assign`; hình dạng đó là cả lỗi.
      return asksFor(options, MEMBER_FILTER)
        ? [project("PROJ-0037", null), project("PROJ-0100", "2026-09-30")]
        : [];
    },
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["projects"] },
    ctx,
  ) as Record<string, unknown>;

  const rows = result.data as Record<string, unknown>[];
  assertEquals(rows.map((row) => row.name), ["PROJ-0037", "PROJ-0100"]);
  assertEquals(rows.every((row) => row.section === "projects"), true);
  const sections = result.sections as Record<string, Record<string, unknown>>;
  assertEquals(sections.projects.count, 2);
  assertEquals(sections.projects.returned, 2);
  assertEquals(sections.projects.has_more, false);
});

Deno.test("erpnext_my_work counts a project reachable both ways only once", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype !== "Project") return [];
      // Cùng một dự án trả về từ cả hai nửa: hợp chứ không phải nối.
      return [project("PROJ-0007", "2026-10-01")];
    },
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["projects"] },
    ctx,
  ) as Record<string, unknown>;

  assertEquals((result.data as unknown[]).length, 1);
  assertEquals(result.count, 1);
});

Deno.test("erpnext_my_work orders the merged project page the way MariaDB does", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype !== "Project") return [];
      return asksFor(options, MEMBER_FILTER)
        ? [project("PROJ-B", null), project("PROJ-D", "2026-12-01")]
        : [project("PROJ-A", null), project("PROJ-C", "2026-06-01")];
    },
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["projects"] },
    ctx,
  ) as Record<string, unknown>;

  // `ORDER BY expected_end_date asc` của MariaDB đặt ô rỗng lên TRƯỚC - đo trên chính site, nơi
  // 113 trong 142 dự án không có `expected_end_date`. Sắp sai chỗ này thì phần cắt theo `limit`
  // của trang ghép bỏ nhầm đúng những hàng máy chủ xếp lên đầu.
  assertEquals(
    (result.data as Record<string, unknown>[]).map((row) => row.name),
    ["PROJ-A", "PROJ-B", "PROJ-C", "PROJ-D"],
  );
});

Deno.test("erpnext_my_work reports the real project total for a truncated page", async () => {
  clearCallerProfileCache();
  const counted: unknown[] = [];
  const ctx = makeCtx({
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype !== "Project") return [];
      return asksFor(options, MEMBER_FILTER)
        ? [project("PROJ-0037", null), project("PROJ-0050", null)]
        : [project("PROJ-0900", null), project("PROJ-0901", null)];
    },
    callMethod: async (method: string, params: Record<string, unknown>) => {
      if (method !== "frappe.client.get_count") return USER;
      const filters = params.filters as unknown[];
      counted.push(filters);
      const text = JSON.stringify(filters);
      if (
        text.includes(JSON.stringify(MEMBER_FILTER)) &&
        text.includes(JSON.stringify(ASSIGN_FILTER))
      ) return 1;
      return text.includes(JSON.stringify(MEMBER_FILTER)) ? 98 : 4;
    },
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["projects"], limit: 2 },
    ctx,
  ) as Record<string, unknown>;

  const sections = result.sections as Record<string, Record<string, unknown>>;
  // 98 + 4 - 1: `frappe.client.get_count` không nhận `or_filters`, nên hợp phải đếm bằng bao hàm
  // - loại trừ chứ không có một lời gọi nào đếm thẳng được.
  assertEquals(sections.projects.count, 101);
  assertEquals(sections.projects.returned, 2);
  assertEquals(sections.projects.has_more, true);
  assertEquals(counted.length, 3);
  assertEquals(counted[0], [OPEN_FILTER, MEMBER_FILTER]);
  assertEquals(counted[1], [OPEN_FILTER, ASSIGN_FILTER]);
  assertEquals(counted[2], [OPEN_FILTER, MEMBER_FILTER, ASSIGN_FILTER]);
  // Trang bị cắt thì tổng thật, không phải độ dài trang, mới là câu trả lời cho "bao nhiêu".
  assertEquals(result.count, 101);
  assertEquals(result.returned, 2);
  assertEquals(result.has_more, true);
});

Deno.test("erpnext_my_work leaves the project total unknown rather than reporting the page length", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype !== "Project") return [];
      return asksFor(options, MEMBER_FILTER)
        ? [project("PROJ-0037", null), project("PROJ-0050", null)]
        : [];
    },
    callMethod: async (method: string) =>
      method === "frappe.client.get_count" ? null : USER,
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["projects"], limit: 2 },
    ctx,
  ) as Record<string, unknown>;

  const sections = result.sections as Record<string, Record<string, unknown>>;
  assertEquals(sections.projects.count, null);
  assertEquals(sections.projects.returned, 2);
  // Trang đầy mà tổng chưa biết thì rất có thể còn hàng phía sau: nghiêng về "còn nữa".
  assertEquals(sections.projects.has_more, true);
  assertStringIncludes(sections.projects.count_error as string, "get_count");
  assertEquals(result.count, null);
  assertStringIncludes(result.count_error as string, "unknown");
});

Deno.test("erpnext_my_work rejects a union total below the page it is holding", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype !== "Project") return [];
      return asksFor(options, MEMBER_FILTER)
        ? [project("PROJ-0037", null), project("PROJ-0050", null)]
        : [];
    },
    callMethod: async (method: string, params: Record<string, unknown>) => {
      if (method !== "frappe.client.get_count") return USER;
      // Ba lần đếm không nằm trong một giao dịch: một lượt ghi xen giữa làm phép trừ ra số âm.
      return JSON.stringify(params.filters).includes(
          JSON.stringify(ASSIGN_FILTER),
        )
        ? 9
        : 1;
    },
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["projects"], limit: 2 },
    ctx,
  ) as Record<string, unknown>;

  const sections = result.sections as Record<string, Record<string, unknown>>;
  assertEquals(sections.projects.count, null);
  assertStringIncludes(
    sections.projects.count_error as string,
    "below the 2 documents already in hand",
  );
});

// ── tổng thật cho mọi mục, không phải độ dài trang ──────────────────────────

Deno.test("erpnext_my_work reports the real ToDo total for a truncated page", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "ToDo") return [{ name: "TODO-1", status: "Open" }];
      return [];
    },
    callMethod: async (method: string) =>
      method === "frappe.client.get_count" ? 7 : USER,
  });

  const result = await tool("erpnext_my_work").handler(
    { sections: ["todos"], limit: 1 },
    ctx,
  ) as Record<string, unknown>;

  const sections = result.sections as Record<string, Record<string, unknown>>;
  // Người có 7 ToDo và `limit` 1 từng nhận đúng chữ "1" để trả lời "tôi còn bao nhiêu việc".
  assertEquals(sections.todos.count, 7);
  assertEquals(sections.todos.returned, 1);
  assertEquals(sections.todos.has_more, true);
  assertEquals(result.count, 7);
  assertEquals(result.returned, 1);
  assertEquals(result.has_more, true);
});

Deno.test("erpnext_my_work adds the section totals up, and counts no page twice", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "ToDo") return [{ name: "TODO-1", status: "Open" }];
      if (doctype === "Task") return [{ name: "TASK-1", status: "Working" }];
      return [];
    },
  });

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  // Trang ngắn hơn `limit` đã tự chứng minh mình là toàn bộ kết quả, nên không tốn lần đếm nào.
  assertEquals(result.count, 2);
  assertEquals(result.returned, 2);
  assertEquals(result.has_more, false);
  assertEquals(result.count_error, undefined);
});

Deno.test("erpnext_my_work will not total a roll-up with a refused section in it", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => {
      if (doctype === "Employee") return [EMPLOYEE_ROW];
      if (doctype === "Timesheet") {
        throw new FrappeAPIError("Not permitted for Timesheet", 403, {});
      }
      if (doctype === "ToDo") return [{ name: "TODO-1", status: "Open" }];
      return [];
    },
  });

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  // Cộng các mục đọc được rồi trình bày như tổng của mọi việc là đúng cái lời nói dối mà số đếm
  // này sinh ra để dẹp: người đọc không có cách nào biết một phân hệ đã rơi ra ngoài.
  assertEquals(result.count, null);
  assertEquals(result.returned, 1);
  assertStringIncludes(
    result.count_error as string,
    "'timesheets' was refused",
  );
});

Deno.test("erpnext_my_work will not total a roll-up with a skipped section in it", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    list: async (doctype: string) => doctype === "Employee" ? [] : [],
  });

  const result = await tool("erpnext_my_work").handler({}, ctx) as Record<
    string,
    unknown
  >;

  assertEquals(result.count, null);
  assertStringIncludes(
    result.count_error as string,
    "'leave_applications' was skipped",
  );
});
