import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import { projectTools } from "./project.ts";
import type { ErpNextToolContext } from "./types.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  return {
    list: async () => [{ name: "user@example.com", enabled: 1 }],
    get: async (_doctype: string, name: string) => ({ name }),
    create: async (_doctype: string, data: Record<string, unknown>) => ({
      name: "TASK-001",
      ...data,
    }),
    update: async (
      _doctype: string,
      name: string,
      data: Record<string, unknown>,
    ) => ({
      name,
      ...data,
    }),
    delete: async () => {},
    callMethod: async () => [],
    ...overrides,
  } as unknown as FrappeClient;
}

function getTool(name: string) {
  const tool = projectTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

Deno.test("erpnext_task_create preserves the existing response without assignees", async () => {
  let createCalls = 0;
  const result = await getTool("erpnext_task_create").handler(
    { project: "PROJ-001", subject: "Plan release", priority: "High" },
    makeCtx(makeMockClient({
      create: async (doctype: string, data: Record<string, unknown>) => {
        createCalls++;
        assertEquals(doctype, "Task");
        assertEquals(data, {
          project: "PROJ-001",
          subject: "Plan release",
          priority: "High",
        });
        return { name: "TASK-001", ...data };
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(createCalls, 1);
  assertEquals(result, {
    data: {
      name: "TASK-001",
      project: "PROJ-001",
      subject: "Plan release",
      priority: "High",
    },
    message: "Task TASK-001 created successfully",
  });
});

Deno.test("erpnext_task_update preserves the existing response without assignees", async () => {
  const result = await getTool("erpnext_task_update").handler(
    { name: "TASK-001", status: "Working" },
    makeCtx(makeMockClient({
      update: async (
        doctype: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        assertEquals([doctype, name, data], ["Task", "TASK-001", {
          status: "Working",
        }]);
        return { name, ...data };
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(result, {
    data: { name: "TASK-001", status: "Working" },
    message: "Task TASK-001 updated successfully",
  });
});

Deno.test("erpnext_task_create assigns a trimmed string through the native API", async () => {
  let assignmentArgs: Record<string, unknown> = {};
  const result = await getTool("erpnext_task_create").handler(
    {
      project: "PROJ-001",
      subject: "Plan release",
      assign_to: " user@example.com ",
      assignment_description: "Review scope",
      assignment_priority: "High",
      assignment_date: "2026-07-13",
    },
    makeCtx(makeMockClient({
      callMethod: async (method: string, args: Record<string, unknown>) => {
        assertEquals(method, "frappe.desk.form.assign_to.add");
        assignmentArgs = args;
        return [{ owner: "user@example.com", name: "TODO-001" }];
      },
      get: async () => ({ name: "TASK-001", status: "Open" }),
    })),
  ) as Record<string, unknown>;

  assertEquals(assignmentArgs, {
    doctype: "Task",
    name: "TASK-001",
    assign_to: ["user@example.com"],
    description: "Review scope",
    priority: "High",
    date: "2026-07-13",
  });
  assertEquals(result.data, { name: "TASK-001", status: "Open" });
  assertEquals(result.assignment, {
    notify_user: true,
    assignees: ["user@example.com"],
    todos: [{ owner: "user@example.com", name: "TODO-001" }],
  });
});

Deno.test("erpnext_task_update deduplicates assignees and returns an existing native ToDo", async () => {
  let updateCalls = 0;
  let assignmentArgs: Record<string, unknown> = {};
  const result = await getTool("erpnext_task_update").handler(
    {
      name: "TASK-001",
      status: "Working",
      assign_to: ["a@example.com", " a@example.com "],
    },
    makeCtx(makeMockClient({
      list: async (_doctype: string, options: { filters?: unknown[][] }) =>
        (options.filters?.[0][2] as string[]).map((name) => ({
          name,
          enabled: 1,
        })),
      update: async () => {
        updateCalls++;
        return { name: "TASK-001" };
      },
      callMethod: async (_method: string, args: Record<string, unknown>) => {
        assignmentArgs = args;
        return [{ owner: "a@example.com", name: "TODO-001" }];
      },
      get: async () => ({ name: "TASK-001", status: "Working" }),
    })),
  ) as Record<string, unknown>;

  assertEquals(updateCalls, 1);
  assertEquals(assignmentArgs, {
    doctype: "Task",
    name: "TASK-001",
    assign_to: ["a@example.com"],
  });
  assertEquals(result.assignment, {
    notify_user: true,
    assignees: ["a@example.com"],
    todos: [{ owner: "a@example.com", name: "TODO-001" }],
  });
});

Deno.test("erpnext_task_create rejects nonexistent and disabled assignees before mutation", async () => {
  const tool = getTool("erpnext_task_create");
  let createCalls = 0;
  const nonexistent = makeMockClient({
    list: async () => [],
    create: async () => {
      createCalls++;
      return { name: "TASK-001" };
    },
  });
  await assertRejects(
    () =>
      tool.handler({
        project: "PROJ-001",
        subject: "Test",
        assign_to: "missing@example.com",
      }, makeCtx(nonexistent)),
    Error,
    "does not exist",
  );

  const disabled = makeMockClient({
    list: async () => [{ name: "disabled@example.com", enabled: 0 }],
    create: async () => {
      createCalls++;
      return { name: "TASK-001" };
    },
  });
  await assertRejects(
    () =>
      tool.handler({
        project: "PROJ-001",
        subject: "Test",
        assign_to: "disabled@example.com",
      }, makeCtx(disabled)),
    Error,
    "disabled",
  );
  assertEquals(createCalls, 0);
});

Deno.test("erpnext_task_update assignment controls without assignees do not update Task", async () => {
  let updateCalls = 0;
  await assertRejects(
    () =>
      getTool("erpnext_task_update").handler(
        {
          name: "TASK-001",
          notify_user: true,
          assignment_description: "Review scope",
          assignment_priority: "High",
          assignment_date: "2026-07-13",
        },
        makeCtx(makeMockClient({
          update: async () => {
            updateCalls++;
            return { name: "TASK-001" };
          },
        })),
      ),
    Error,
    "At least one field to update is required",
  );
  assertEquals(updateCalls, 0);
});

Deno.test("erpnext_task_update assign_to schema accepts strings and arrays", () => {
  const schema = getTool("erpnext_task_update").inputSchema.properties
    ?.assign_to;
  assertEquals(schema?.type, ["string", "array"]);
});

Deno.test("erpnext_task_update rejects notify_user=false before mutation", async () => {
  let updateCalls = 0;
  const client = makeMockClient({
    update: async () => {
      updateCalls++;
      return { name: "TASK-001" };
    },
  });
  await assertRejects(
    () =>
      getTool("erpnext_task_update").handler(
        {
          name: "TASK-001",
          status: "Working",
          assign_to: "user@example.com",
          notify_user: false,
        },
        makeCtx(client),
      ),
    Error,
    "notify_user=false",
  );
  assertEquals(updateCalls, 0);
});

Deno.test("erpnext_task_update accepts assignment-only input and refreshes the Task", async () => {
  let updateCalls = 0;
  const result = await getTool("erpnext_task_update").handler(
    { name: "TASK-001", assign_to: "user@example.com" },
    makeCtx(makeMockClient({
      update: async () => {
        updateCalls++;
        return { name: "TASK-001" };
      },
      callMethod: async () => [{ owner: "user@example.com", name: "TODO-001" }],
      get: async () => ({ name: "TASK-001", subject: "Fresh task" }),
    })),
  ) as Record<string, unknown>;

  assertEquals(updateCalls, 0);
  assertEquals(result.data, { name: "TASK-001", subject: "Fresh task" });
});

Deno.test("erpnext_task_create reports the created Task when assignment fails", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_task_create").handler(
        {
          project: "PROJ-001",
          subject: "Plan release",
          assign_to: "user@example.com",
        },
        makeCtx(makeMockClient({
          callMethod: async () => {
            throw new Error("Assignment permission denied");
          },
        })),
      ),
    Error,
    "Task TASK-001 was created, but assignment failed: Assignment permission denied",
  );
});

Deno.test("erpnext_task_update reports updated fields when assignment fails", async () => {
  let updateCalls = 0;
  await assertRejects(
    () =>
      getTool("erpnext_task_update").handler(
        {
          name: "TASK-001",
          status: "Working",
          assign_to: "user@example.com",
        },
        makeCtx(makeMockClient({
          update: async () => {
            updateCalls++;
            return { name: "TASK-001" };
          },
          callMethod: async () => {
            throw new Error("Assignment permission denied");
          },
        })),
      ),
    Error,
    "Task TASK-001 was updated, but assignment failed: Assignment permission denied",
  );
  assertEquals(updateCalls, 1);
});

Deno.test("assignee validation issues a single User query with an 'in' filter", async () => {
  const listCalls: { doctype: string; filters?: unknown[][] }[] = [];
  await getTool("erpnext_task_update").handler(
    { name: "TASK-001", assign_to: ["a@example.com", "b@example.com"] },
    makeCtx(makeMockClient({
      list: async (doctype: string, options: { filters?: unknown[][] }) => {
        listCalls.push({ doctype, filters: options.filters });
        return [
          { name: "a@example.com", enabled: 1 },
          { name: "b@example.com", enabled: 1 },
        ];
      },
      callMethod: async () => [],
      get: async () => ({ name: "TASK-001" }),
    })),
  );

  assertEquals(listCalls.length, 1);
  assertEquals(listCalls[0].doctype, "User");
  assertEquals(listCalls[0].filters, [["name", "in", [
    "a@example.com",
    "b@example.com",
  ]]]);
});

Deno.test("erpnext_task_update propagates native assignment errors", async () => {
  const nativeError = new Error("Assignment permission denied");
  await assertRejects(
    () =>
      getTool("erpnext_task_update").handler(
        { name: "TASK-001", assign_to: "user@example.com" },
        makeCtx(makeMockClient({
          callMethod: async () => {
            throw nativeError;
          },
        })),
      ),
    Error,
    "Assignment permission denied",
  );
});

Deno.test("erpnext_task_list - an email in assigned_to costs no User read", async () => {
  const reads: string[] = [];
  let taskFilters: unknown = null;
  const client = makeMockClient({
    get: async (doctype: string, name: string) => {
      reads.push(`${doctype}:${name}`);
      throw new FrappeAPIError("Not permitted", 403, {});
    },
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Task") taskFilters = options.filters;
      return [];
    },
  });

  await getTool("erpnext_task_list").handler(
    { assigned_to: "khoa.do@havigroup.com" },
    makeCtx(client),
  );

  // Cùng lý do với `erpnext_doc_list`: email đã là id của `User`.
  assertEquals(reads, []);
  assertStringIncludes(JSON.stringify(taskFilters), "khoa.do@havigroup.com");
});

Deno.test("erpnext_task_list - asks for custom_sku, and only for the column", async () => {
  // Hai khẳng định trong một phép thử vì chúng là hai nửa của cùng một quyết định: cột SKU phải
  // được hỏi, và `custom_agent_meta` phải KHÔNG được hỏi. Kéo `custom_agent_meta` về đây là mở
  // đường cho một bản chép lại luật trích mã phía TypeScript, và ba bản chép độc lập đã cho ba
  // con số sai khác nhau khi đo trên site thật.
  let taskFields: unknown = null;
  const client = makeMockClient({
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Task") taskFields = options.fields;
      return [{
        name: "TASK-001",
        subject: "Áo thu",
        custom_sku: "CQ-DUC-001",
      }];
    },
  });

  const result = await getTool("erpnext_task_list").handler(
    {},
    makeCtx(client),
  );

  const fields = taskFields as string[];
  assertEquals(fields.includes("custom_sku"), true);
  assertEquals(fields.includes("custom_agent_meta"), false);
  assertStringIncludes(JSON.stringify(result), "CQ-DUC-001");
});

Deno.test("erpnext_task_list - passes an empty custom_sku through untouched", async () => {
  // Không có đợt backfill nào, nên mọi việc tạo trước khi trường SKU lên prod đều trả về rỗng.
  // Tool phải chuyển nguyên trạng: chỗ này mà tự suy ra một mã từ dữ liệu khác thì MCP sẽ nói
  // ngược với báo cáo đối soát của `hvg_workspace`, và người đọc sẽ tưởng một trong hai bên hỏng.
  const client = makeMockClient({
    list: async () => [
      { name: "TASK-OLD", subject: "Việc cũ", custom_sku: null },
    ],
  });

  const result = await getTool("erpnext_task_list").handler(
    {},
    makeCtx(client),
  );

  const rows = (result as { data: Record<string, unknown>[] }).data;
  assertEquals(rows[0].custom_sku, null);
});

/** Lỗi Frappe trả về khi câu `SELECT` hỏi một cột site không có. */
function unknownColumnError(field: string): FrappeAPIError {
  return new FrappeAPIError("Internal Server Error", 500, {
    exception:
      `OperationalError: (1054, "Unknown column '${field}' in 'SELECT'")`,
  });
}

Deno.test("erpnext_task_list - a site without custom_sku still gets its Tasks", async () => {
  // `custom_sku` là của `hvg_workspace`, không phải của ERPNext, và Frappe không bỏ qua im lặng
  // một cột nó không tìm thấy: nó giết cả câu `SELECT` bằng SQL 1054. Hỏi vô điều kiện là làm
  // hỏng `erpnext_task_list` trên mọi site chuẩn, tức trên chính nhóm người dùng mà gói này phát
  // hành cho.
  const attempts: string[][] = [];
  const client = makeMockClient({
    list: async (_doctype: string, options: { fields: string[] }) => {
      attempts.push(options.fields);
      if (options.fields.includes("custom_sku")) {
        throw unknownColumnError("custom_sku");
      }
      return [{ name: "TASK-001", subject: "Plain ERPNext task" }];
    },
  });

  const result = await getTool("erpnext_task_list").handler(
    {},
    makeCtx(client),
  );

  assertEquals(attempts.length, 2);
  assertEquals(attempts[1].includes("custom_sku"), false);
  assertEquals(attempts[1].length, 8);
  const rows = (result as { data: Record<string, unknown>[] }).data;
  assertEquals(rows[0].name, "TASK-001");
});

Deno.test("erpnext_task_list - stops asking a site that answered 1054 once", async () => {
  // Một vòng phí là chấp nhận được, mỗi lượt gọi một vòng phí thì không.
  const attempts: string[][] = [];
  const client = makeMockClient({
    list: async (_doctype: string, options: { fields: string[] }) => {
      attempts.push(options.fields);
      if (options.fields.includes("custom_sku")) {
        throw unknownColumnError("custom_sku");
      }
      return [];
    },
  });

  const tool = getTool("erpnext_task_list");
  await tool.handler({}, makeCtx(client));
  await tool.handler({}, makeCtx(client));

  // Lượt đầu: hỏi có SKU rồi hỏi lại không SKU. Lượt sau: đúng một lần, không SKU.
  assertEquals(attempts.length, 3);
  assertEquals(attempts[2].includes("custom_sku"), false);
});

Deno.test("erpnext_task_list - does not read an unrelated failure as a missing column", async () => {
  // Nuốt một lỗi bất kỳ rồi thử lại sẽ dạy client một điều sai mà nó giữ tới hết tiến trình, và
  // che mất lỗi thật của lượt gọi. Chỉ 1054 đúng tên cột mới được coi là "site không có cột này".
  let calls = 0;
  const client = makeMockClient({
    list: async () => {
      calls++;
      throw new FrappeAPIError("Not permitted", 403, {});
    },
  });

  await assertRejects(
    () => getTool("erpnext_task_list").handler({}, makeCtx(client)),
    FrappeAPIError,
    "Not permitted",
  );
  assertEquals(calls, 1);
});
