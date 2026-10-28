/**
 * OMS Tools Tests
 *
 * Kiểm các tool tài khoản bán hàng và đơn hàng sàn: tool gọi đúng wrapper của
 * `hvg_workspace.api_token_reads`, gửi đúng tên đối số, và từ chối đầu vào sai trước khi
 * chạm tới ERP. Client là mock nên không có lượt gọi mạng nào.
 *
 * @module lib/erpnext/tests/tools/oms_test
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { omsTools } from "./oms.ts";
import { FrappeAPIError } from "../api/frappe-client.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

// ── Mock FrappeClient ─────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

/** Một lượt `callMethod` mà mock ghi lại. */
interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
  opts: { httpMethod?: "GET" | "POST" } | undefined;
}

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "TEST-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    invalidate: () => {},
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

/** Mock trả `reply` cho mọi lượt gọi và ghi lại từng lượt vào `calls`. */
function recordingClient(reply: unknown): {
  client: FrappeClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client = makeMockClient({
    callMethod: async (
      method: string,
      args: Record<string, unknown>,
      opts?: { httpMethod?: "GET" | "POST" },
    ) => {
      calls.push({ method, args, opts });
      return reply;
    },
  });
  return { client, calls };
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = omsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

const WRAPPERS = "hvg_workspace.api_token_reads";

// ── Bề mặt chung ─────────────────────────────────────────────────────────────

Deno.test("oms tools - every tool sits in the oms category", () => {
  assertEquals(omsTools.length, 8);
  for (const tool of omsTools) {
    assertEquals(tool.category, "oms", tool.name);
  }
});

Deno.test("oms tools - read tools are read-only and write tools are not", () => {
  const writes = omsTools
    .filter((t) => t.annotations?.readOnlyHint === false)
    .map((t) => t.name)
    .sort();
  assertEquals(writes, [
    "erpnext_merchant_account_update",
    "erpnext_merchant_order_comment_create",
    "erpnext_merchant_order_item_update",
  ]);
  assertEquals(
    getTool("erpnext_merchant_order_comment_create").annotations
      ?.idempotentHint,
    false,
  );
  assertEquals(
    getTool("erpnext_merchant_order_item_update").annotations?.idempotentHint,
    true,
  );
});

Deno.test("oms tools - a site without the wrapper gets a readable error", async () => {
  const lookupFailure = new FrappeAPIError(
    "ValidationError",
    417,
    {
      exc_type: "ValidationError",
      exception:
        "frappe.exceptions.ValidationError: Failed to get method for command " +
        "hvg_workspace.api_token_reads.list_sales_orders",
    },
  );
  const client = makeMockClient({
    callMethod: async () => {
      throw lookupFailure;
    },
  });
  const err = await assertRejects(
    () => getTool("erpnext_merchant_order_list").handler({}, makeCtx(client)),
    Error,
  );
  assertStringIncludes(
    err.message,
    "this site does not expose 'hvg_workspace.api_token_reads.list_sales_orders'",
  );
  assertStringIncludes(err.message, "hvg_workspace");
  assertInstanceOf(err.cause, FrappeAPIError);
});

Deno.test("oms tools - a business error from ERP passes through untouched", async () => {
  const refusal = new FrappeAPIError("Không tìm thấy đơn", 404, {
    exc_type: "DoesNotExistError",
  });
  const client = makeMockClient({
    callMethod: async () => {
      throw refusal;
    },
  });
  const err = await assertRejects(
    () =>
      getTool("erpnext_merchant_order_get").handler(
        { name: "SO-404" },
        makeCtx(client),
      ),
    FrappeAPIError,
  );
  assert(err === refusal, "the original FrappeAPIError must be rethrown");
});

// ── erpnext_merchant_account_list ────────────────────────────────────────────

Deno.test("erpnext_merchant_account_list - forwards filters and trims SPA metadata", async () => {
  const { client, calls } = recordingClient({
    rows: [{ name: "M-1", merchant_type: "TikTok", status: "Active" }],
    summary: { Active: 1 },
    total: 1,
    start: 0,
    page_length: 50,
    responsible_departments: ["Team A"],
    last_synced_at: "2026-10-28 10:00:00",
    cursor: null,
    next_cursor: "M-1",
  });
  const result = await getTool("erpnext_merchant_account_list").handler(
    {
      status: "all",
      merchant_types: ["TikTok", "Etsy"],
      search: "shop",
      page_length: 20,
    },
    makeCtx(client),
  ) as Record<string, unknown>;

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, `${WRAPPERS}.list_merchant_accounts`);
  assertEquals(calls[0].args, {
    status: "all",
    merchant_types: ["TikTok", "Etsy"],
    search: "shop",
    page_length: 20,
  });
  assertEquals(result.data, [
    { name: "M-1", merchant_type: "TikTok", status: "Active" },
  ]);
  assertEquals(result.next_cursor, "M-1");
  assertEquals(result.total, 1);
  assertEquals(result.summary, { Active: 1 });
  assertEquals(result.responsible_departments, undefined);
  assertEquals(result.last_synced_at, undefined);
  assertStringIncludes(String(result.message), "cursor");
});

Deno.test("erpnext_merchant_account_list - rejects a non-array filter", async () => {
  const { client, calls } = recordingClient({ rows: [] });
  await assertRejects(
    () =>
      getTool("erpnext_merchant_account_list").handler(
        { merchant_types: "TikTok" },
        makeCtx(client),
      ),
    Error,
    "'merchant_types' must be an array of strings",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_account_get ─────────────────────────────────────────────

Deno.test("erpnext_merchant_account_get - reads one account by name", async () => {
  const { client, calls } = recordingClient({
    name: "M-1",
    merchant_type: "Amazon",
    order_count: 12,
  });
  const result = await getTool("erpnext_merchant_account_get").handler(
    { name: "M-1" },
    makeCtx(client),
  ) as Record<string, unknown>;
  assertEquals(calls[0].method, `${WRAPPERS}.get_merchant_account`);
  assertEquals(calls[0].args, { name: "M-1" });
  assertEquals(result.data, {
    name: "M-1",
    merchant_type: "Amazon",
    order_count: 12,
  });
});

Deno.test("erpnext_merchant_account_get - requires name", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () => getTool("erpnext_merchant_account_get").handler({}, makeCtx(client)),
    Error,
    "'name' is required",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_account_update ──────────────────────────────────────────

Deno.test("erpnext_merchant_account_update - sends only the fields given", async () => {
  const { client, calls } = recordingClient({ name: "M-1", status: "Closed" });
  const result = await getTool("erpnext_merchant_account_update").handler(
    { name: "M-1", status: "Closed" },
    makeCtx(client),
  ) as Record<string, unknown>;
  assertEquals(calls[0].method, `${WRAPPERS}.update_merchant_account`);
  assertEquals(calls[0].args, { name: "M-1", status: "Closed" });
  assertEquals(calls[0].opts?.httpMethod ?? "POST", "POST");
  assertEquals(result.data, { name: "M-1", status: "Closed" });
});

Deno.test("erpnext_merchant_account_update - refuses a call with nothing to change", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () =>
      getTool("erpnext_merchant_account_update").handler(
        { name: "M-1" },
        makeCtx(client),
      ),
    Error,
    "at least one of",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_order_list ──────────────────────────────────────────────

Deno.test("erpnext_merchant_order_list - forwards filters and keeps only the order data", async () => {
  const row = {
    name: "SO-1",
    row_name: "ROW-1",
    item_code: "TSHIRT",
    fulfill_stage: "NeedDesign",
    structure_version: "SO-1:abc",
  };
  const { client, calls } = recordingClient({
    rows: [row],
    summary: { orders: 1 },
    total: 1,
    states: { NeedDesign: 1 },
    next_cursor: null,
    accounts: [{ name: "M-1" }],
    sales_teams: ["Team A"],
    can_export: true,
    item_categories: ["Apparel"],
    fulfill_units: ["Printify"],
    last_synced_at: "2026-10-28 10:00:00",
    kpi_since: "2026-01-01",
    start: 0,
    page_length: 50,
  });
  const result = await getTool("erpnext_merchant_order_list").handler(
    {
      status: "active",
      merchants: ["M-1"],
      fulfill_stages: ["NeedDesign"],
      date_from: "2026-10-01",
      date_to: "2026-10-28",
    },
    makeCtx(client),
  ) as Record<string, unknown>;

  assertEquals(calls[0].method, `${WRAPPERS}.list_sales_orders`);
  assertEquals(calls[0].args, {
    status: "active",
    merchants: ["M-1"],
    fulfill_stages: ["NeedDesign"],
    date_from: "2026-10-01",
    date_to: "2026-10-28",
  });
  assertEquals(Object.keys(result).sort(), [
    "data",
    "message",
    "next_cursor",
    "states",
    "summary",
    "total",
  ]);
  assertEquals(result.data, [row]);
  assertEquals(result.next_cursor, null);
});

Deno.test("erpnext_merchant_order_list - says how to read the next page", async () => {
  const { client } = recordingClient({
    rows: [{ name: "SO-1" }],
    total: 80,
    next_cursor: "2026-10-28 10:00:00|SO-1",
  });
  const result = await getTool("erpnext_merchant_order_list").handler(
    {},
    makeCtx(client),
  ) as Record<string, unknown>;
  assertEquals(result.next_cursor, "2026-10-28 10:00:00|SO-1");
  assertStringIncludes(
    String(result.message),
    "cursor='2026-10-28 10:00:00|SO-1'",
  );
});

Deno.test("erpnext_merchant_order_list - rejects a non-string search", async () => {
  const { client, calls } = recordingClient({ rows: [] });
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_list").handler(
        { search: 42 },
        makeCtx(client),
      ),
    Error,
    "'search' must be a string",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_order_get ───────────────────────────────────────────────

Deno.test("erpnext_merchant_order_get - reads with POST so the audit row survives", async () => {
  const { client, calls } = recordingClient({
    name: "SO-1",
    structure_version: "SO-1:abc",
    items: [{ row_name: "ROW-1" }],
  });
  const result = await getTool("erpnext_merchant_order_get").handler(
    { name: "SO-1" },
    makeCtx(client),
  ) as Record<string, unknown>;
  assertEquals(calls[0].method, `${WRAPPERS}.get_sales_order`);
  assertEquals(calls[0].args, { name: "SO-1" });
  assertEquals(calls[0].opts?.httpMethod, "POST");
  assertEquals((result.data as Record<string, unknown>).name, "SO-1");
});

Deno.test("erpnext_merchant_order_get - requires name", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () => getTool("erpnext_merchant_order_get").handler({}, makeCtx(client)),
    Error,
    "'name' is required",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_order_comment_list ──────────────────────────────────────

Deno.test("erpnext_merchant_order_comment_list - lists comments of one order", async () => {
  const comments = [{ name: "C-1", content: "Đã in", mine: false }];
  const { client, calls } = recordingClient(comments);
  const result = await getTool("erpnext_merchant_order_comment_list").handler(
    { sales_order: "SO-1" },
    makeCtx(client),
  ) as Record<string, unknown>;
  assertEquals(calls[0].method, `${WRAPPERS}.list_sales_order_comments`);
  assertEquals(calls[0].args, { sales_order: "SO-1" });
  assertEquals(result.data, comments);
});

Deno.test("erpnext_merchant_order_comment_list - requires sales_order", async () => {
  const { client, calls } = recordingClient([]);
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_comment_list").handler(
        {},
        makeCtx(client),
      ),
    Error,
    "'sales_order' is required",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_order_comment_create ────────────────────────────────────

Deno.test("erpnext_merchant_order_comment_create - maps mentions to the ERP shape", async () => {
  const { client, calls } = recordingClient([{ name: "C-2" }]);
  const result = await getTool("erpnext_merchant_order_comment_create")
    .handler(
      {
        sales_order: "SO-1",
        content: "Nhờ kiểm lại design",
        mentions: ["a@example.com", "b@example.com"],
      },
      makeCtx(client),
    ) as Record<string, unknown>;
  assertEquals(calls[0].method, `${WRAPPERS}.add_sales_order_comment`);
  assertEquals(calls[0].args, {
    sales_order: "SO-1",
    content: "Nhờ kiểm lại design",
    mentions: [{ user: "a@example.com" }, { user: "b@example.com" }],
  });
  assertEquals(result.data, [{ name: "C-2" }]);
});

Deno.test("erpnext_merchant_order_comment_create - omits mentions when none are given", async () => {
  const { client, calls } = recordingClient([]);
  await getTool("erpnext_merchant_order_comment_create").handler(
    { sales_order: "SO-1", content: "OK" },
    makeCtx(client),
  );
  assertEquals(calls[0].args, { sales_order: "SO-1", content: "OK" });
});

Deno.test("erpnext_merchant_order_comment_create - refuses blank content", async () => {
  const { client, calls } = recordingClient([]);
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_comment_create").handler(
        { sales_order: "SO-1", content: "   " },
        makeCtx(client),
      ),
    Error,
    "'content' is required",
  );
  assertEquals(calls.length, 0);
});

// ── erpnext_merchant_order_item_update ───────────────────────────────────────

/** Mỗi field của tool ứng với một wrapper và một tên đối số bên ERP. */
const ITEM_CASES: {
  field: string;
  value: unknown;
  method: string;
  arg: string;
  sent: unknown;
}[] = [
  {
    field: "note",
    value: "Khách đổi size",
    method: "update_sales_order_item_note",
    arg: "note",
    sent: "Khách đổi size",
  },
  {
    field: "tracking_number",
    value: "1Z999",
    method: "update_sales_order_item_tracking",
    arg: "tracking_number",
    sent: "1Z999",
  },
  {
    field: "label_link",
    value: "https://example.com/label.pdf",
    method: "update_sales_order_item_label_link",
    arg: "label_link",
    sent: "https://example.com/label.pdf",
  },
  {
    field: "design_link",
    value: {
      front: "https://example.com/f.png",
      back: "",
      left: "",
      right: "https://example.com/r.png",
    },
    method: "update_sales_order_item_design_link",
    arg: "design_link",
    sent: "https://example.com/f.png\n\n\nhttps://example.com/r.png",
  },
  {
    field: "fulfill_stage",
    value: "NeedFulfill",
    method: "update_sales_order_item_fulfill_stage",
    arg: "stage",
    sent: "NeedFulfill",
  },
];

for (const c of ITEM_CASES) {
  Deno.test(`erpnext_merchant_order_item_update - ${c.field} calls ${c.method}`, async () => {
    const { client, calls } = recordingClient({ ok: true });
    await getTool("erpnext_merchant_order_item_update").handler(
      {
        sales_order: "SO-1",
        row_name: "ROW-1",
        order_structure: "SO-1:abc",
        [c.field]: c.value,
      },
      makeCtx(client),
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, `${WRAPPERS}.${c.method}`);
    assertEquals(calls[0].args, {
      sales_order: "SO-1",
      row_name: "ROW-1",
      order_structure: "SO-1:abc",
      [c.arg]: c.sent,
    });
  });
}

Deno.test("erpnext_merchant_order_item_update - an empty string clears the value", async () => {
  const { client, calls } = recordingClient({ note: "" });
  await getTool("erpnext_merchant_order_item_update").handler(
    { sales_order: "SO-1", row_name: "ROW-1", note: "" },
    makeCtx(client),
  );
  assertEquals(calls[0].args, {
    sales_order: "SO-1",
    row_name: "ROW-1",
    note: "",
  });
});

Deno.test("erpnext_merchant_order_item_update - refuses a call with no field", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_item_update").handler(
        { sales_order: "SO-1", row_name: "ROW-1" },
        makeCtx(client),
      ),
    Error,
    "exactly one of",
  );
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_merchant_order_item_update - refuses two fields in one call", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_item_update").handler(
        {
          sales_order: "SO-1",
          row_name: "ROW-1",
          note: "x",
          fulfill_stage: "Done",
        },
        makeCtx(client),
      ),
    Error,
    "exactly one of",
  );
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_merchant_order_item_update - design_link needs all four positions", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_item_update").handler(
        {
          sales_order: "SO-1",
          row_name: "ROW-1",
          design_link: { front: "https://example.com/f.png" },
        },
        makeCtx(client),
      ),
    Error,
    "'design_link.back' must be a string",
  );
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_merchant_order_item_update - design_link refuses a line break inside a link", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_item_update").handler(
        {
          sales_order: "SO-1",
          row_name: "ROW-1",
          design_link: {
            front: "https://example.com/f.png\nhttps://example.com/b.png",
            back: "",
            left: "",
            right: "",
          },
        },
        makeCtx(client),
      ),
    Error,
    "line break",
  );
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_merchant_order_item_update - requires row_name", async () => {
  const { client, calls } = recordingClient({});
  await assertRejects(
    () =>
      getTool("erpnext_merchant_order_item_update").handler(
        { sales_order: "SO-1", note: "x" },
        makeCtx(client),
      ),
    Error,
    "'row_name' is required",
  );
  assertEquals(calls.length, 0);
});
