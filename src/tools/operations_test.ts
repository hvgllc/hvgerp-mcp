/**
 * Operations Tools Tests
 *
 * Tests for erpnext_doc_create and other generic operation tools.
 *
 * @module lib/erpnext/tests/tools/operations_test
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { operationsTools } from "./operations.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

// deno-lint-ignore no-explicit-any
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
  const tool = operationsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

// ── erpnext_doc_create ──────────────────────────────────────────────────────

Deno.test("erpnext_doc_create - exists in operations tools", () => {
  const tool = getTool("erpnext_doc_create");
  assertEquals(tool.name, "erpnext_doc_create");
  assertEquals(tool.category, "operations");
});

Deno.test("erpnext_doc_create - throws if doctype missing", async () => {
  const tool = getTool("erpnext_doc_create");
  await assertRejects(
    () => tool.handler({ data: {} }, makeCtx(makeMockClient())),
    Error,
    "doctype",
  );
});

Deno.test("erpnext_doc_create - throws if data missing", async () => {
  const tool = getTool("erpnext_doc_create");
  await assertRejects(
    () => tool.handler({ doctype: "Item" }, makeCtx(makeMockClient())),
    Error,
    "data",
  );
});

Deno.test("erpnext_doc_create - throws if data is not object", async () => {
  const tool = getTool("erpnext_doc_create");
  await assertRejects(
    () =>
      tool.handler({ doctype: "Item", data: "bad" }, makeCtx(makeMockClient())),
    Error,
    "data",
  );
});

Deno.test("erpnext_doc_create - calls client.create with correct args", async () => {
  let capturedDoctype = "";
  let capturedData: Record<string, unknown> = {};

  const mockClient = makeMockClient({
    create: async (doctype: string, data: Record<string, unknown>) => {
      capturedDoctype = doctype;
      capturedData = data;
      return { name: "Transit", ...data };
    },
  });

  const tool = getTool("erpnext_doc_create");
  const result = await tool.handler(
    {
      doctype: "Warehouse Type",
      data: { name: "Transit", warehouse_type: "Transit" },
    },
    makeCtx(mockClient),
  ) as Record<string, unknown>;

  assertEquals(capturedDoctype, "Warehouse Type");
  assertEquals(capturedData.name, "Transit");
  assertEquals(capturedData.warehouse_type, "Transit");

  const doc = result.data as Record<string, unknown>;
  assertEquals(doc.name, "Transit");
  assertEquals(typeof result.message, "string");
});

Deno.test("erpnext_doc_create - works with Item Group (tree doctype)", async () => {
  const mockClient = makeMockClient({
    create: async (_doctype: string, data: Record<string, unknown>) => ({
      name: "Products",
      ...data,
    }),
  });

  const tool = getTool("erpnext_doc_create");
  const result = await tool.handler(
    {
      doctype: "Item Group",
      data: {
        name: "Products",
        item_group_name: "Products",
        parent_item_group: "All Item Groups",
      },
    },
    makeCtx(mockClient),
  ) as Record<string, unknown>;

  const doc = result.data as Record<string, unknown>;
  assertEquals(doc.name, "Products");
  assertEquals(doc.parent_item_group, "All Item Groups");
});

// ── erpnext_doc_submit ───────────────────────────────────────────────────────

Deno.test("erpnext_doc_submit - skips cache on the pre-submit get and invalidates after", async () => {
  let getSkipCache: boolean | undefined;
  let invalidatedDoctype = "";
  let invalidatedName = "";

  const mockClient = makeMockClient({
    get: async (
      _doctype: string,
      _name: string,
      opts?: { skipCache?: boolean },
    ) => {
      getSkipCache = opts?.skipCache;
      return { name: "SO-001", modified: "2026-01-01 00:00:00" };
    },
    callMethod: async () => ({ name: "SO-001", docstatus: 1 }),
    invalidate: (doctype: string, name?: string) => {
      invalidatedDoctype = doctype;
      invalidatedName = name ?? "";
    },
  });

  const tool = getTool("erpnext_doc_submit");
  await tool.handler(
    { doctype: "Sales Order", name: "SO-001" },
    makeCtx(mockClient),
  );

  assertEquals(getSkipCache, true);
  assertEquals(invalidatedDoctype, "Sales Order");
  assertEquals(invalidatedName, "SO-001");
});

Deno.test("erpnext_doc_submit - disables rounded total when base_rounded_total is null (fresh instance)", async () => {
  let submittedDoc: Record<string, unknown> = {};

  const mockClient = makeMockClient({
    get: async () => ({
      name: "SO-001",
      base_rounded_total: null,
      modified: "2026-01-01 00:00:00",
    }),
    callMethod: async (
      _method: string,
      args: { doc: Record<string, unknown> },
    ) => {
      submittedDoc = args.doc;
      return { name: "SO-001", docstatus: 1 };
    },
  });

  const tool = getTool("erpnext_doc_submit");
  const result = await tool.handler(
    { doctype: "Sales Order", name: "SO-001" },
    makeCtx(mockClient),
  ) as Record<string, unknown>;

  assertEquals(submittedDoc.disable_rounded_total, 1);
  assertEquals((result.warnings as string[]).length, 1);
});

// ── erpnext_doc_cancel ───────────────────────────────────────────────────────

Deno.test("erpnext_doc_cancel - invalidates cache after cancel", async () => {
  let invalidatedDoctype = "";
  let invalidatedName = "";

  const mockClient = makeMockClient({
    callMethod: async () => ({ name: "SO-001", docstatus: 2 }),
    invalidate: (doctype: string, name?: string) => {
      invalidatedDoctype = doctype;
      invalidatedName = name ?? "";
    },
  });

  const tool = getTool("erpnext_doc_cancel");
  await tool.handler(
    { doctype: "Sales Order", name: "SO-001" },
    makeCtx(mockClient),
  );

  assertEquals(invalidatedDoctype, "Sales Order");
  assertEquals(invalidatedName, "SO-001");
});

// ── erpnext_file_upload ────────────────────────────────────────────────────

Deno.test("erpnext_file_upload - validates input and delegates to the client", async () => {
  const tool = getTool("erpnext_file_upload");
  await assertRejects(
    () =>
      tool.handler({
        file_name: "nested/report.pdf",
        content_base64: "YQ==",
        attached_to_doctype: "Task",
        attached_to_name: "TASK-001",
      }, makeCtx(makeMockClient())),
    Error,
    "filename without a path",
  );
  await assertRejects(
    () =>
      tool.handler({
        file_name: "report.pdf",
        content_base64: "YQ==",
        attached_to_doctype: "Task",
        attached_to_name: "TASK-001",
        attached_to_field: 42,
      }, makeCtx(makeMockClient())),
    Error,
    "attached_to_field",
  );

  let captured: Record<string, unknown> = {};
  const result = await tool.handler(
    {
      file_name: "report.pdf",
      content_base64: "YQ==",
      attached_to_doctype: "Task",
      attached_to_name: "TASK-001",
      attached_to_field: "attachment",
      is_private: false,
    },
    makeCtx(makeMockClient({
      uploadFile: async (input: Record<string, unknown>) => {
        captured = input;
        return { name: "FILE-001" };
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(captured, {
    fileName: "report.pdf",
    contentBase64: "YQ==",
    attachedToDoctype: "Task",
    attachedToName: "TASK-001",
    attachedToField: "attachment",
    isPrivate: false,
  });
  assertEquals(result.message, "report.pdf attached to Task TASK-001");
});

Deno.test("erpnext_file_upload - defaults to private", async () => {
  let isPrivate: boolean | undefined;
  await getTool("erpnext_file_upload").handler(
    {
      file_name: "report.pdf",
      content_base64: "YQ==",
      attached_to_doctype: "Task",
      attached_to_name: "TASK-001",
    },
    makeCtx(makeMockClient({
      uploadFile: async (input: { isPrivate: boolean }) => {
        isPrivate = input.isPrivate;
        return { name: "FILE-001" };
      },
    })),
  );
  assertEquals(isPrivate, true);
});

Deno.test("erpnext_file_upload - is marked destructive", () => {
  assertEquals(
    getTool("erpnext_file_upload").annotations?.destructiveHint,
    true,
  );
});

// ── erpnext_doc_list ────────────────────────────────────────────────────────

Deno.test("erpnext_doc_list - has _meta.ui for doclist-viewer", () => {
  const tool = getTool("erpnext_doc_list");
  assertEquals(tool._meta?.ui?.resourceUri, "ui://hvgerp-mcp/doclist-viewer");
});

// ── erpnext_doc_update ──────────────────────────────────────────────────────

Deno.test("erpnext_doc_update - throws if doctype missing", async () => {
  const tool = getTool("erpnext_doc_update");
  await assertRejects(
    () => tool.handler({ name: "X", data: {} }, makeCtx(makeMockClient())),
    Error,
    "doctype",
  );
});

// ── erpnext_doc_delete ──────────────────────────────────────────────────────

Deno.test("erpnext_doc_delete - calls client.delete", async () => {
  let deletedDoctype = "";
  let deletedName = "";

  const mockClient = makeMockClient({
    delete: async (doctype: string, name: string) => {
      deletedDoctype = doctype;
      deletedName = name;
    },
  });

  const tool = getTool("erpnext_doc_delete");
  const result = await tool.handler(
    { doctype: "Customer", name: "CUST-001" },
    makeCtx(mockClient),
  ) as Record<string, unknown>;

  assertEquals(deletedDoctype, "Customer");
  assertEquals(deletedName, "CUST-001");
  assertEquals(result.deleted, true);
});

// ── erpnext_doc_assign ──────────────────────────────────────────────────────

Deno.test("erpnext_doc_assign - assigns through the native API and returns the fresh doc", async () => {
  let assignmentArgs: Record<string, unknown> = {};
  const result = await getTool("erpnext_doc_assign").handler(
    {
      doctype: "Issue",
      name: "ISS-001",
      assign_to: "user@example.com",
      assignment_priority: "High",
    },
    makeCtx(makeMockClient({
      list: async () => [{ name: "user@example.com", enabled: 1 }],
      get: async (_doctype: string, name: string) => ({
        name,
        status: "Open",
      }),
      callMethod: async (method: string, args: Record<string, unknown>) => {
        assertEquals(method, "frappe.desk.form.assign_to.add");
        assignmentArgs = args;
        return [{ owner: "user@example.com", name: "TODO-001" }];
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(assignmentArgs, {
    doctype: "Issue",
    name: "ISS-001",
    assign_to: ["user@example.com"],
    priority: "High",
  });
  assertEquals(result.data, { name: "ISS-001", status: "Open" });
  assertEquals(
    result.message,
    "Issue ISS-001 is now assigned to user@example.com",
  );
  assertEquals(result.assignment, {
    notify_user: true,
    assignees: ["user@example.com"],
    todos: [{ owner: "user@example.com", name: "TODO-001" }],
  });
});

Deno.test("erpnext_doc_assign - fails fast on a missing document before validating users", async () => {
  let listCalls = 0;
  let callMethodCalls = 0;
  await assertRejects(
    () =>
      getTool("erpnext_doc_assign").handler(
        { doctype: "Issue", name: "MISSING", assign_to: "user@example.com" },
        makeCtx(makeMockClient({
          get: async () => {
            throw new Error("Issue MISSING not found");
          },
          list: async () => {
            listCalls++;
            return [{ name: "user@example.com", enabled: 1 }];
          },
          callMethod: async () => {
            callMethodCalls++;
            return [];
          },
        })),
      ),
    Error,
    "not found",
  );
  assertEquals(listCalls, 0);
  assertEquals(callMethodCalls, 0);
});

Deno.test("erpnext_doc_assign - rejects unknown assignees before mutation", async () => {
  let callMethodCalls = 0;
  await assertRejects(
    () =>
      getTool("erpnext_doc_assign").handler(
        { doctype: "Task", name: "TASK-001", assign_to: "ghost@example.com" },
        makeCtx(makeMockClient({
          list: async () => [],
          callMethod: async () => {
            callMethodCalls++;
            return [];
          },
        })),
      ),
    Error,
    "does not exist",
  );
  assertEquals(callMethodCalls, 0);
});

Deno.test("erpnext_doc_assign - requires assign_to", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_doc_assign").handler(
        { doctype: "Task", name: "TASK-001" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "'assign_to' is required",
  );
});

// ── erpnext_doc_unassign ────────────────────────────────────────────────────

Deno.test("erpnext_doc_unassign - removes through the native API and returns remaining", async () => {
  let removeArgs: Record<string, unknown> = {};
  const result = await getTool("erpnext_doc_unassign").handler(
    { doctype: "Task", name: "TASK-001", assign_to: " user@example.com " },
    makeCtx(makeMockClient({
      callMethod: async (method: string, args: Record<string, unknown>) => {
        assertEquals(method, "frappe.desk.form.assign_to.remove");
        removeArgs = args;
        return [{ owner: "other@example.com", name: "TODO-002" }];
      },
      get: async (_doctype: string, name: string) => ({ name }),
    })),
  ) as Record<string, unknown>;

  assertEquals(removeArgs, {
    doctype: "Task",
    name: "TASK-001",
    assign_to: "user@example.com",
  });
  assertEquals(
    result.message,
    "user@example.com unassigned from Task TASK-001",
  );
  assertEquals(result.assignment, {
    removed: "user@example.com",
    remaining: [{ owner: "other@example.com", name: "TODO-002" }],
  });
});

Deno.test("erpnext_doc_unassign - contextualizes native errors", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_doc_unassign").handler(
        { doctype: "Task", name: "TASK-001", assign_to: "user@example.com" },
        makeCtx(makeMockClient({
          callMethod: async () => {
            throw new Error("No assignment found");
          },
        })),
      ),
    Error,
    "Task TASK-001 unassignment failed: No assignment found",
  );
});

Deno.test("erpnext_doc_unassign - rejects a missing or empty assign_to", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_doc_unassign").handler(
        { doctype: "Task", name: "TASK-001", assign_to: "  " },
        makeCtx(makeMockClient()),
      ),
    Error,
    "non-empty user email",
  );
});

Deno.test("erpnext_doc_unassign - an email assignee costs no User read", async () => {
  let userReads = 0;

  await getTool("erpnext_doc_unassign").handler(
    { doctype: "Task", name: "TASK-001", assign_to: "user@example.com" },
    makeCtx(makeMockClient({
      get: async (doctype: string, name: string) => {
        if (doctype === "User") userReads++;
        return { name };
      },
      callMethod: async () => [],
    })),
  );

  // ID của một `User` trong Frappe CHÍNH LÀ email, nên tra cứu nó không đổi được kết quả mà chỉ mua
  // thêm một lượt `GET User/{email}`. Nhân viên thường không có quyền đọc `User`, nên lượt đọc thừa
  // đó biến thành 403 và chặn luôn một thao tác mà chính họ được phép làm. `resolveAssignees` của
  // `erpnext_doc_assign` đã theo quy tắc này từ đầu.
  assertEquals(userReads, 0);
});

// ── erpnext_method_call ─────────────────────────────────────────────────────

// Temporarily override the allowlist env var for the duration of a test block.
function withAllowlist(value?: string): Disposable {
  const saved = Deno.env.get("ERPNEXT_METHOD_ALLOWLIST");
  if (value === undefined) {
    Deno.env.delete("ERPNEXT_METHOD_ALLOWLIST");
  } else {
    Deno.env.set("ERPNEXT_METHOD_ALLOWLIST", value);
  }
  return {
    [Symbol.dispose]() {
      Deno.env.delete("ERPNEXT_METHOD_ALLOWLIST");
      if (saved !== undefined) Deno.env.set("ERPNEXT_METHOD_ALLOWLIST", saved);
    },
  };
}

Deno.test("erpnext_method_call - calls an allowlisted method via POST", async () => {
  using _env = withAllowlist("my_app.api.*");
  const calls: unknown[] = [];
  const result = await getTool("erpnext_method_call").handler(
    { method: "my_app.api.update_meta", args: { name: "T-1", meta: "a: 1" } },
    makeCtx(makeMockClient({
      callMethod: (method: string, args: unknown, opts: unknown) => {
        calls.push({ method, args, opts });
        return Promise.resolve({ ok: true });
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(calls, [{
    method: "my_app.api.update_meta",
    args: { name: "T-1", meta: "a: 1" },
    opts: { httpMethod: "POST" },
  }]);
  assertEquals(result.data, { ok: true });
  assertEquals(result.method, "my_app.api.update_meta");
});

Deno.test("erpnext_method_call - forwards http_method GET", async () => {
  using _env = withAllowlist("my_app.api.read_meta");
  let seen: unknown;
  await getTool("erpnext_method_call").handler(
    { method: "my_app.api.read_meta", http_method: "GET" },
    makeCtx(makeMockClient({
      callMethod: (_m: string, _a: unknown, opts: unknown) => {
        seen = opts;
        return Promise.resolve(null);
      },
    })),
  );
  assertEquals(seen, { httpMethod: "GET" });
});

Deno.test("erpnext_method_call - invalidates the named document after the call", async () => {
  using _env = withAllowlist("my_app.api.*");
  const invalidated: string[][] = [];
  const result = await getTool("erpnext_method_call").handler(
    {
      method: "my_app.api.update_meta",
      invalidate: { doctype: "Task", name: "TASK-001" },
    },
    makeCtx(makeMockClient({
      invalidate: (doctype: string, name: string) => {
        invalidated.push([doctype, name]);
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(invalidated, [["Task", "TASK-001"]]);
  assertEquals(result.invalidated, { doctype: "Task", name: "TASK-001" });
});

Deno.test("erpnext_method_call - allows any method when the allowlist is unset", async () => {
  using _env = withAllowlist(undefined);
  let seen: string | undefined;
  const result = await getTool("erpnext_method_call").handler(
    { method: "frappe.client.get_count" },
    makeCtx(makeMockClient({
      callMethod: (method: string) => {
        seen = method;
        return Promise.resolve(7);
      },
    })),
  ) as Record<string, unknown>;

  assertEquals(seen, "frappe.client.get_count");
  assertEquals(result.data, 7);
});

Deno.test("erpnext_method_call - refuses a method outside the allowlist", async () => {
  using _env = withAllowlist("my_app.api.*");
  await assertRejects(
    () =>
      getTool("erpnext_method_call").handler(
        { method: "frappe.client.delete" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "is not in ERPNEXT_METHOD_ALLOWLIST",
  );
});

Deno.test("erpnext_method_call - rejects a method path that could rewrite the URL", async () => {
  using _env = withAllowlist("*");
  await assertRejects(
    () =>
      getTool("erpnext_method_call").handler(
        { method: "my_app.api.x?cmd=frappe.client.delete" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "is not a valid method path",
  );
});

// The path check is the one guard that is not opt-in, so it has to hold in the
// default state too, where there is no allowlist left to catch a crafted path.
Deno.test("erpnext_method_call - still rejects a crafted path with no allowlist", async () => {
  using _env = withAllowlist(undefined);
  await assertRejects(
    () =>
      getTool("erpnext_method_call").handler(
        { method: "my_app.api.x?cmd=frappe.client.delete" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "is not a valid method path",
  );
});

Deno.test("erpnext_method_call - rejects a missing method", async () => {
  using _env = withAllowlist("*");
  await assertRejects(
    () => getTool("erpnext_method_call").handler({}, makeCtx(makeMockClient())),
    Error,
    "non-empty dotted path",
  );
});

Deno.test("erpnext_method_call - rejects non-object args", async () => {
  using _env = withAllowlist("*");
  await assertRejects(
    () =>
      getTool("erpnext_method_call").handler(
        { method: "my_app.api.x", args: ["a", "b"] },
        makeCtx(makeMockClient()),
      ),
    Error,
    "'args' must be an object",
  );
});

Deno.test("erpnext_method_call - rejects an incomplete invalidate target", async () => {
  using _env = withAllowlist("*");
  await assertRejects(
    () =>
      getTool("erpnext_method_call").handler(
        { method: "my_app.api.x", invalidate: { doctype: "Task" } },
        makeCtx(makeMockClient()),
      ),
    Error,
    "must be non-empty strings",
  );
});

Deno.test("erpnext_method_call - rejects an unsupported http_method", async () => {
  using _env = withAllowlist("*");
  await assertRejects(
    () =>
      getTool("erpnext_method_call").handler(
        { method: "my_app.api.x", http_method: "DELETE" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "'http_method' must be 'GET' or 'POST'",
  );
});

Deno.test("erpnext_doc_assign is annotated idempotent, matching its own description", () => {
  const assign = getTool("erpnext_doc_assign");

  // The description promises re-assigning an already-assigned user returns the existing
  // ToDo without re-notifying. `idempotentHint: false` said the opposite, so a client that
  // reads annotations to decide whether a retry is safe files a safe call under "ask first".
  assertStringIncludes(assign.description, "Idempotent");
  assertEquals(assign.annotations?.idempotentHint, true);
});

// ── Ô lọc người dùng không được đổi một truy vấn hợp lệ lấy một 403 ───────────

Deno.test("erpnext_doc_list - an email in assigned_to costs no User read", async () => {
  const reads: string[] = [];
  let taskFilters: unknown = null;
  const client = makeMockClient({
    get: async (doctype: string, name: string) => {
      reads.push(`${doctype}:${name}`);
      // Đúng thứ Frappe trả cho một nhân viên thường đọc hồ sơ người khác.
      throw new FrappeAPIError("Not permitted", 403, {});
    },
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype === "Task") taskFilters = options.filters;
      return [];
    },
  });

  await getTool("erpnext_doc_list").handler(
    { doctype: "Task", assigned_to: "khoa.do@havigroup.com" },
    makeCtx(client),
  );

  // Một `User` id của Frappe CHÍNH LÀ địa chỉ thư, nên lượt đọc kia không thể đổi được kết quả -
  // nó chỉ đổi được một bộ lọc chạy được thành một lỗi quyền.
  assertEquals(reads, []);
  assertStringIncludes(JSON.stringify(taskFilters), "khoa.do@havigroup.com");
});

Deno.test("erpnext_doc_list - an email in owner costs no User read", async () => {
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

  await getTool("erpnext_doc_list").handler(
    { doctype: "Task", owner: "khoa.do@havigroup.com" },
    makeCtx(client),
  );

  assertEquals(reads, []);
  assertStringIncludes(JSON.stringify(taskFilters), "khoa.do@havigroup.com");
});

Deno.test("erpnext_doc_list - a full name in assigned_to is still looked up", async () => {
  // Vế đối chứng: lối tắt chỉ được áp cho thứ đã là một id. Một cái tên người vẫn phải qua
  // `User`, nếu không ô lọc lặng lẽ tìm một User tên "Do Khoa" và trả về rỗng.
  let searchFilters: unknown = null;
  const client = makeMockClient({
    get: async () => {
      throw new FrappeAPIError("Not found", 404, {});
    },
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype !== "User") return [];
      searchFilters = options.filters;
      return [{ name: "khoa.do@havigroup.com", full_name: "Do Khoa" }];
    },
  });

  await getTool("erpnext_doc_list").handler(
    { doctype: "Task", assigned_to: "Do Khoa" },
    makeCtx(client),
  );

  assertStringIncludes(JSON.stringify(searchFilters), "Do Khoa");
});

// ── erpnext_calendar_events ──────────────────────────────────────────────────

Deno.test("erpnext_calendar_events - rejects a range that is not a plain date", async () => {
  const tool = getTool("erpnext_calendar_events");
  await assertRejects(
    () => tool.handler({ start: "next monday" }, makeCtx(makeMockClient())),
    Error,
    "YYYY-MM-DD",
  );
  await assertRejects(
    () =>
      tool.handler(
        { start: "2026-08-17", end: "2026/08/24" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "YYYY-MM-DD",
  );
});

Deno.test("erpnext_calendar_events - defaults the range to a week after start", async () => {
  // deno-lint-ignore no-explicit-any
  let seenArgs: Record<string, any> = {};
  const client = makeMockClient({
    // deno-lint-ignore no-explicit-any
    callMethod: async (method: string, args: Record<string, any>) => {
      assertEquals(method, "frappe.desk.doctype.event.event.get_events");
      seenArgs = args;
      return [];
    },
  });

  await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-28" },
    makeCtx(client),
  );

  assertEquals(seenArgs.start, "2026-08-28");
  // Seven days INCLUSIVE of start, because ERPNext compares both bounds with
  // BETWEEN; start + 7 would quietly return an eight-day week.
  // Crossing a month boundary is where naive string arithmetic breaks.
  assertEquals(seenArgs.end, "2026-09-03");
  assertEquals("user" in seenArgs, false);
});

Deno.test("erpnext_calendar_events - refuses a range wider than a year", async () => {
  let calls = 0;
  const client = makeMockClient({
    callMethod: async () => {
      calls++;
      return [];
    },
  });

  await assertRejects(
    () =>
      getTool("erpnext_calendar_events").handler(
        { start: "2026-01-01", end: "2030-01-01" },
        makeCtx(client),
      ),
    Error,
    "narrower window",
  );
  // ERPNext expands the whole range before `limit` applies, so the guard is
  // worth nothing unless it fires before the call goes out.
  assertEquals(calls, 0);
});

Deno.test("erpnext_calendar_events - refuses an end that precedes start", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_calendar_events").handler(
        { start: "2026-08-17", end: "2026-08-10" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "is before",
  );
});

Deno.test("erpnext_calendar_events - accepts a range of exactly the maximum span", async () => {
  let calls = 0;
  const client = makeMockClient({
    callMethod: async () => {
      calls++;
      return [];
    },
  });

  // 2026 is not a leap year, so start + 365 days is a 366-day inclusive range.
  await getTool("erpnext_calendar_events").handler(
    { start: "2026-01-01", end: "2027-01-01" },
    makeCtx(client),
  );

  assertEquals(calls, 1);
});

Deno.test("erpnext_calendar_events - keeps each expanded occurrence and marks its origin", async () => {
  const client = makeMockClient({
    callMethod: async () => [
      {
        name: "EV00045",
        subject: "Hop giao ban tuan",
        starts_on: "2026-08-17 08:30:00",
        ends_on: null,
        all_day: 0,
        event_type: "Public",
        owner: "lead@example.com",
        repeat_this_event: 1,
        repeat_on: "Weekly",
        original_starts_on: "2026-01-05 08:30:00",
      },
      {
        name: "EV00046",
        subject: "Review thang",
        starts_on: "2026-08-19 14:00:00",
        ends_on: "2026-08-19 15:00:00",
        all_day: 0,
        event_type: "Private",
        owner: "me@example.com",
      },
    ],
  });

  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", end: "2026-08-23" },
    makeCtx(client),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.doctype, "Event");
  assertEquals(result.count, 2);
  assertEquals(result.returned, 2);
  assertEquals(result.has_more, false);
  assertEquals(result.data[0].recurring_from, "2026-01-05 08:30:00");
  assertEquals(result.data[0].is_recurring, true);
  // A one-off event must not claim to be an occurrence of anything.
  assertEquals("recurring_from" in result.data[1], false);
  assertEquals(result.data[1].is_recurring, false);
  assertEquals(result.data[1].ends_on, "2026-08-19 15:00:00");
});

Deno.test("erpnext_calendar_events - flags a repeating event even without original_starts_on", async () => {
  // Older expansion passes copy the row without attaching `original_starts_on`;
  // the caller must still be able to tell the occurrence is a repeat.
  const client = makeMockClient({
    callMethod: async () => [
      {
        name: "EV00045",
        subject: "Hop giao ban tuan",
        starts_on: "2026-08-17 08:30:00",
        repeat_this_event: 1,
        repeat_on: "Weekly",
      },
    ],
  });

  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", end: "2026-08-23" },
    makeCtx(client),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.data[0].is_recurring, true);
  assertEquals("recurring_from" in result.data[0], false);
});

Deno.test("erpnext_calendar_events - limit truncates the page but not the total", async () => {
  const client = makeMockClient({
    callMethod: async () =>
      Array.from({ length: 5 }, (_, index) => ({
        name: `EV-${index}`,
        subject: `Event ${index}`,
        starts_on: "2026-08-17 08:30:00",
      })),
  });

  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", limit: 2 },
    makeCtx(client),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.count, 5);
  assertEquals(result.returned, 2);
  assertEquals(result.has_more, true);
});

Deno.test("erpnext_calendar_events - refuses a date that matches the shape but does not exist", async () => {
  let calls = 0;
  const client = makeMockClient({
    callMethod: async () => {
      calls++;
      return [];
    },
  });

  // Rolls over to 2026-03-03 if it is merely parsed, silently shifting the
  // whole window into another month.
  await assertRejects(
    () =>
      getTool("erpnext_calendar_events").handler(
        { start: "2026-02-31" },
        makeCtx(client),
      ),
    Error,
    "not a real calendar date",
  );
  // Unparseable: every later comparison becomes NaN, which is false against
  // both < and >, so the range guards would wave it through.
  await assertRejects(
    () =>
      getTool("erpnext_calendar_events").handler(
        { start: "2026-08-17", end: "9999-99-99" },
        makeCtx(client),
      ),
    Error,
    "not a real calendar date",
  );
  assertEquals(calls, 0);
});

Deno.test("erpnext_calendar_events - every occurrence gets its own row identity", async () => {
  // Frappe returns each expanded occurrence carrying the stored master's
  // `name`, so `name` cannot key viewer state: the doclist viewer would open
  // one expanded panel under every occurrence of the master at once.
  const client = makeMockClient({
    callMethod: async () => [
      {
        name: "EV00045",
        subject: "Hop giao ban tuan",
        starts_on: "2026-08-17 08:30:00",
        repeat_this_event: 1,
        repeat_on: "Weekly",
      },
      {
        name: "EV00045",
        subject: "Hop giao ban tuan",
        starts_on: "2026-08-24 08:30:00",
        repeat_this_event: 1,
        repeat_on: "Weekly",
      },
    ],
  });

  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", end: "2026-08-30" },
    makeCtx(client),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.data.length, 2);
  // The document id is unchanged - the row action still has to fetch a real Event.
  assertEquals(result.data[0].name, "EV00045");
  assertEquals(result.data[1].name, "EV00045");
  // The row identity is not.
  assertEquals(result.data[0]._id === result.data[1]._id, false);
  assertEquals(
    new Set(result.data.map((row: { _id: string }) => row._id)).size,
    2,
  );
});

Deno.test("erpnext_calendar_events - rejects a non-array answer instead of reporting an empty calendar", async () => {
  const client = makeMockClient({
    // What a misconfigured or half-broken endpoint hands back.
    // deno-lint-ignore no-explicit-any
    callMethod: async () => ({ message: "no" }) as any,
  });

  await assertRejects(
    () =>
      getTool("erpnext_calendar_events").handler(
        { start: "2026-08-17" },
        makeCtx(client),
      ),
    Error,
    "instead of an array of events",
  );
});

Deno.test("erpnext_calendar_events - orders occurrences by start before applying the limit", async () => {
  // ERPNext appends every expansion of a repeating master in that master's own
  // position, so the array arrives in per-master blocks. Unsorted, the limit
  // would be spent on late occurrences of the first master and drop the
  // earliest one-off event entirely.
  const client = makeMockClient({
    callMethod: async () => [
      { name: "EV-A", subject: "Daily", starts_on: "2026-08-18 09:00:00" },
      { name: "EV-A", subject: "Daily", starts_on: "2026-08-19 09:00:00" },
      { name: "EV-A", subject: "Daily", starts_on: "2026-08-20 09:00:00" },
      { name: "EV-B", subject: "Kickoff", starts_on: "2026-08-17 15:00:00" },
    ],
  });

  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", end: "2026-08-23", limit: 2 },
    makeCtx(client),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.data.map((row: { starts_on: string }) => row.starts_on), [
    "2026-08-17 15:00:00",
    "2026-08-18 09:00:00",
  ]);
  assertEquals(result.count, 4);
  assertEquals(result.has_more, true);
});

Deno.test("erpnext_calendar_events - breaks a start-time tie by name so the order is stable", async () => {
  const client = makeMockClient({
    callMethod: async () => [
      { name: "EV-Z", subject: "Later name", starts_on: "2026-08-17 09:00:00" },
      {
        name: "EV-A",
        subject: "Earlier name",
        starts_on: "2026-08-17 09:00:00",
      },
    ],
  });

  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17" },
    makeCtx(client),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.data.map((row: { name: string }) => row.name), [
    "EV-A",
    "EV-Z",
  ]);
});

Deno.test("erpnext_calendar_events - forwards an explicit user to ERPNext", async () => {
  // deno-lint-ignore no-explicit-any
  let seenArgs: Record<string, any> = {};
  const client = makeMockClient({
    // deno-lint-ignore no-explicit-any
    callMethod: async (_method: string, args: Record<string, any>) => {
      seenArgs = args;
      return [];
    },
  });

  await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", user: "boss@example.com" },
    makeCtx(client),
  );

  assertEquals(seenArgs.user, "boss@example.com");
});

Deno.test("erpnext_calendar_events - row identity survives an event appearing earlier in the window", async () => {
  // `DoclistViewer` keeps `expandedId` across a refresh, so a positional id
  // silently reattaches the open panel to a different occurrence the moment the
  // set shifts. One event created earlier in the window is enough: with
  // `${name}::${index}` every later occurrence moved by one.
  const OCCURRENCES = [
    {
      name: "EV00045",
      subject: "Hop giao ban tuan",
      starts_on: "2026-08-17 08:30:00",
      repeat_this_event: 1,
      repeat_on: "Weekly",
    },
    {
      name: "EV00045",
      subject: "Hop giao ban tuan",
      starts_on: "2026-08-24 08:30:00",
      repeat_this_event: 1,
      repeat_on: "Weekly",
    },
  ];
  const EARLIER = {
    name: "EV00099",
    subject: "Hop dot xuat",
    starts_on: "2026-08-16 09:00:00",
  };

  const ask = async (events: unknown[]) =>
    await getTool("erpnext_calendar_events").handler(
      { start: "2026-08-16", end: "2026-08-30" },
      makeCtx(makeMockClient({ callMethod: async () => events })),
      // deno-lint-ignore no-explicit-any
    ) as any;

  const before = await ask(OCCURRENCES);
  const after = await ask([EARLIER, ...OCCURRENCES]);

  const idOf = (
    // deno-lint-ignore no-explicit-any
    result: any,
    startsOn: string,
    // deno-lint-ignore no-explicit-any
  ) => result.data.find((row: any) => row.starts_on === startsOn)._id;

  assertEquals(after.data.length, 3);
  for (const occurrence of OCCURRENCES) {
    assertEquals(
      idOf(after, occurrence.starts_on),
      idOf(before, occurrence.starts_on),
    );
  }
});

Deno.test("erpnext_calendar_events - two rows with the same master and start still differ", async () => {
  // The guarantee the positional id used to provide, kept: an identity built
  // from attributes has to stay unique even when ERPNext hands back a row
  // twice, or the viewer is back to opening one panel under both.
  const duplicate = {
    name: "EV00045",
    subject: "Hop giao ban tuan",
    starts_on: "2026-08-17 08:30:00",
  };
  const result = await getTool("erpnext_calendar_events").handler(
    { start: "2026-08-17", end: "2026-08-30" },
    makeCtx(makeMockClient({ callMethod: async () => [duplicate, duplicate] })),
    // deno-lint-ignore no-explicit-any
  ) as any;

  assertEquals(result.data.length, 2);
  assertEquals(
    new Set(result.data.map((row: { _id: string }) => row._id)).size,
    2,
  );
});
