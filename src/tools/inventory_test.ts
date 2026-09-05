/**
 * Inventory Tools Tests
 *
 * Tests for ERPNext inventory MCP tools (items, stock balance, stock entries,
 * warehouses). Injects a mock FrappeClient to avoid real network calls.
 *
 * @module lib/erpnext/src/tools/inventory_test
 */

// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertRejects } from "@std/assert";
import { inventoryTools } from "./inventory.ts";
import { FrappeAPIError, FrappeClient } from "../api/frappe-client.ts";
import { MemoryCache } from "../cache/memory.ts";
import { NoopCache } from "../cache/noop.ts";
import { operationsTools } from "./operations.ts";
import { loadStockDetails } from "../ui/shared/stock-movements.ts";
import type { StockDetailsState } from "../ui/shared/stock-movements.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "ITEM-NEW-001" }),
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
  const tool = inventoryTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

Deno.test("stock details uses one ERP Item GET with cold and expired MemoryCache", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1000;
  let itemGets = 0;
  const counts: number[] = [];
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (decodeURIComponent(url.pathname) === "/api/resource/Item/ITEM-A") {
      itemGets++;
      await Promise.resolve();
      return Response.json({ data: { name: "ITEM-A", item_name: "Widget" } });
    }
    assertEquals(
      decodeURIComponent(url.pathname),
      "/api/resource/Stock Ledger Entry",
    );
    return Response.json({ data: [] });
  };
  try {
    for (const expired of [false, true]) {
      const cache = new MemoryCache();
      const client = new FrappeClient({
        baseUrl: "https://erp.test",
        authHeader: () => "token test:test",
        cache,
      });
      if (expired) {
        await client.get("Item", "ITEM-A");
        now += 1_000_000;
      }
      const before = itemGets;
      const states: StockDetailsState[] = [];
      await loadStockDetails(
        async ({ name, arguments: args }) => ({
          structuredContent: await getTool(name).handler(
            args,
            makeCtx(client),
          ) as Record<string, unknown>,
        }),
        "ITEM-A",
        "W1",
        () => true,
        (state) => states.push(state),
      );
      assertEquals(states.at(-1)?.itemData?.name, "ITEM-A");
      assertEquals(states.at(-1)?.movements, []);
      counts.push(itemGets - before);
    }
    assertEquals(counts, [1, 1]);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

Deno.test("stock details remains correct with cache disabled without promising GET deduplication", async () => {
  const originalFetch = globalThis.fetch;
  let itemGets = 0;
  globalThis.fetch = (input) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    if (path === "/api/resource/Item/ITEM-A") {
      itemGets++;
      return Promise.resolve(Response.json({ data: { name: "ITEM-A" } }));
    }
    assertEquals(path, "/api/resource/Stock Ledger Entry");
    return Promise.resolve(Response.json({ data: [] }));
  };
  try {
    const client = new FrappeClient({
      baseUrl: "https://erp.test",
      authHeader: () => "token test:test",
      cache: new NoopCache(),
    });
    const states: StockDetailsState[] = [];
    await loadStockDetails(
      async ({ name, arguments: args }) => ({
        structuredContent: await getTool(name).handler(
          args,
          makeCtx(client),
        ) as Record<string, unknown>,
      }),
      "ITEM-A",
      "W1",
      () => true,
      (state) => states.push(state),
    );
    assertEquals(itemGets, 2);
    assertEquals(states.at(-1)?.itemData, { name: "ITEM-A" });
    assertEquals(states.at(-1)?.movements, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stock ledger rereads after Stock Entry submit and cancel without TTL wait", async () => {
  const originalFetch = globalThis.fetch;
  let submitted = false;
  let ledgerGets = 0;
  globalThis.fetch = async (input) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    if (path === "/api/resource/Item/ITEM-A") {
      return Response.json({ data: { name: "ITEM-A" } });
    }
    if (path === "/api/resource/Stock Entry/STE-A") {
      return Response.json({
        data: {
          name: "STE-A",
          doctype: "Stock Entry",
          modified: "2026-09-05 09:00:00",
        },
      });
    }
    if (
      path === "/api/method/frappe.client.submit" ||
      path === "/api/method/frappe.client.cancel"
    ) {
      submitted = path.endsWith("submit");
      return Response.json({
        message: { name: "STE-A", docstatus: submitted ? 1 : 2 },
      });
    }
    assertEquals(path, "/api/resource/Stock Ledger Entry");
    const filters = JSON.parse(
      new URL(String(input)).searchParams.get("filters")!,
    );
    assertEquals(filters, [["item_code", "=", "ITEM-A"], [
      "warehouse",
      "=",
      "W1",
    ], ["is_cancelled", "=", 0]]);
    ledgerGets++;
    return Response.json({
      data: submitted ? [{ name: "SLE-NEW", is_cancelled: 0 }] : [],
    });
  };
  try {
    const client = new FrappeClient({
      baseUrl: "https://erp.test",
      authHeader: () => "token test:test",
      cache: new MemoryCache(),
    });
    const ctx = makeCtx(client);
    const read = () =>
      getTool("erpnext_stock_ledger_list").handler({
        item_code: "ITEM-A",
        warehouse: "W1",
      }, ctx);
    assertEquals(await read(), { data: [] });
    const results: unknown[] = [];
    for (const name of ["erpnext_doc_submit", "erpnext_doc_cancel"]) {
      const tool = operationsTools.find((tool) => tool.name === name)!;
      await tool.handler({ doctype: "Stock Entry", name: "STE-A" }, ctx);
      results.push(await read());
    }
    assertEquals(results, [{ data: [{ name: "SLE-NEW", is_cancelled: 0 }] }, {
      data: [],
    }]);
    assertEquals(ledgerGets, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("stock ledger list is a bounded read-only inventory tool", async () => {
  const tool = getTool("erpnext_stock_ledger_list");
  assertEquals(tool.category, "inventory");
  assertEquals(tool.annotations?.readOnlyHint, true);
  assertEquals(tool.inputSchema.required, ["item_code", "warehouse"]);
  let captured: unknown;
  const rows = [{ name: "SLE-A" }];
  const result = await tool.handler(
    { item_code: "Widget", warehouse: "W1" },
    makeCtx(makeMockClient({
      get: async () => {
        throw new FrappeAPIError("Item ID not found", 404, {});
      },
      list: async (doctype, options) => {
        if (doctype === "Item") {
          assertEquals(options.filters, [["item_name", "=", "Widget"]]);
          return [{ name: "ITEM-A", item_name: "Widget" }];
        }
        captured = { doctype, options };
        return rows;
      },
    })),
  );
  assertEquals(result, { data: rows });
  assertEquals(captured, {
    doctype: "Stock Ledger Entry",
    options: {
      fields: [
        "name",
        "item_code",
        "warehouse",
        "posting_date",
        "posting_time",
        "voucher_type",
        "voucher_no",
        "actual_qty",
        "qty_after_transaction",
        "stock_uom",
      ],
      filters: [["item_code", "=", "ITEM-A"], ["warehouse", "=", "W1"], [
        "is_cancelled",
        "=",
        0,
      ]],
      limit: 5,
      order_by: "posting_date desc, posting_time desc, name desc",
    },
  });
});

Deno.test("stock ledger validates every input before resolving or querying", async () => {
  const tool = getTool("erpnext_stock_ledger_list");
  let calls = 0;
  const ctx = makeCtx(makeMockClient({
    get: async () => {
      calls++;
      return {};
    },
    list: async () => {
      calls++;
      return [];
    },
  }));
  for (
    const input of [
      {},
      { item_code: "ITEM-A" },
      { warehouse: "W1" },
      ...["", "  ", null, 4, [], {}].flatMap((value) => [
        { item_code: value, warehouse: "W1" },
        { item_code: "ITEM-A", warehouse: value },
      ]),
      ...[null, 0, -1, 21, 1.5, "5", NaN, Infinity].map((limit) => ({
        item_code: "ITEM-A",
        warehouse: "W1",
        limit,
      })),
    ]
  ) await assertRejects(() => tool.handler(input, ctx), Error);
  assertEquals(calls, 0);
});

Deno.test("stock ledger propagates resolution and permission errors without fallback", async () => {
  const tool = getTool("erpnext_stock_ledger_list");
  for (const phase of ["get", "list"]) {
    let ledgerCalls = 0;
    const error = new FrappeAPIError("Ledger permission denied", 403, {});
    const ctx = makeCtx(makeMockClient({
      get: async () => {
        if (phase === "get") throw error;
        return { name: "ITEM-A" };
      },
      list: async (doctype) => {
        assertEquals(doctype, "Stock Ledger Entry");
        ledgerCalls++;
        throw error;
      },
    }));
    assertEquals(
      await assertRejects(() =>
        tool.handler({ item_code: "ITEM-A", warehouse: "W1" }, ctx)
      ),
      error,
    );
    assertEquals(ledgerCalls, phase === "get" ? 0 : 1);
  }
});

Deno.test("stock ledger keeps each item and warehouse pair and ignores query overrides", async () => {
  const tool = getTool("erpnext_stock_ledger_list");
  for (
    const [item, warehouse] of [["ITEM-A", "W1"], ["ITEM-A", "W2"], [
      "ITEM-B",
      "W1",
    ]]
  ) {
    for (const limit of [1, 5, 20]) {
      let calls = 0;
      const ctx = makeCtx(makeMockClient({
        get: async (doctype, name) => {
          assertEquals(doctype, "Item");
          assertEquals(name, item);
          return { name };
        },
        list: async (doctype, options) => {
          calls++;
          assertEquals(doctype, "Stock Ledger Entry");
          assertEquals(options.filters, [["item_code", "=", item], [
            "warehouse",
            "=",
            warehouse,
          ], ["is_cancelled", "=", 0]]);
          assertEquals(options.limit, limit);
          assertEquals(
            options.order_by,
            "posting_date desc, posting_time desc, name desc",
          );
          return [];
        },
      }));
      assertEquals(
        await tool.handler({
          item_code: item,
          warehouse,
          limit,
          doctype: "Stock Entry",
          filters: [],
          fields: ["*"],
          order_by: "modified asc",
        }, ctx),
        { data: [] },
      );
      assertEquals(calls, 1);
    }
  }
});

// ── erpnext_item_create ──────────────────────────────────────────────────────

Deno.test("erpnext_item_create - throws if item_code missing", async () => {
  const tool = getTool("erpnext_item_create");
  await assertRejects(
    () => tool.handler({ item_name: "Widget" }, makeCtx(makeMockClient())),
    Error,
    "item_code",
  );
});

Deno.test("erpnext_item_create - throws if item_name missing", async () => {
  const tool = getTool("erpnext_item_create");
  await assertRejects(
    () => tool.handler({ item_code: "WIDGET-1" }, makeCtx(makeMockClient())),
    Error,
    "item_name",
  );
});

Deno.test("erpnext_item_create - forwards optional fields", async () => {
  let capturedData: any;
  const mockClient = makeMockClient({
    create: async (_doctype: string, data: any) => {
      capturedData = data;
      return { name: "WIDGET-1" };
    },
  });

  const tool = getTool("erpnext_item_create");
  await tool.handler(
    {
      item_code: "WIDGET-1",
      item_name: "Widget",
      item_group: "Products",
      is_stock_item: true,
      standard_rate: 25.5,
    },
    makeCtx(mockClient),
  );

  assertEquals(capturedData.item_code, "WIDGET-1");
  assertEquals(capturedData.item_group, "Products");
  assertEquals(capturedData.is_stock_item, true);
  assertEquals(capturedData.standard_rate, 25.5);
});

Deno.test("erpnext_item_create - maps public uom to ERPNext stock_uom", async () => {
  let capturedData: Record<string, unknown> | undefined;
  const mockClient = makeMockClient({
    create: async (_doctype: string, data: Record<string, unknown>) => {
      capturedData = data;
      return { name: "WIDGET-1" };
    },
  });

  const tool = getTool("erpnext_item_create");
  await tool.handler(
    { item_code: "WIDGET-1", item_name: "Widget", uom: "Nos" },
    makeCtx(mockClient),
  );

  assertEquals(capturedData?.stock_uom, "Nos");
  assertEquals(capturedData && "uom" in capturedData, false);
});

// ── erpnext_item_update ──────────────────────────────────────────────────────

Deno.test("erpnext_item_update - requires at least one field beyond name", async () => {
  const tool = getTool("erpnext_item_update");
  await assertRejects(
    () => tool.handler({ name: "WIDGET-1" }, makeCtx(makeMockClient())),
    Error,
    "At least one field",
  );
});

Deno.test("erpnext_item_update - sends only provided fields", async () => {
  let capturedData: any;
  let capturedName: string | undefined;
  const mockClient = makeMockClient({
    update: async (_doctype: string, name: string, data: any) => {
      capturedName = name;
      capturedData = data;
      return { name };
    },
  });

  const tool = getTool("erpnext_item_update");
  await tool.handler(
    { name: "WIDGET-1", standard_rate: 30 },
    makeCtx(mockClient),
  );

  assertEquals(capturedName, "WIDGET-1");
  assertEquals(capturedData, { standard_rate: 30 });
});

// ── erpnext_stock_balance ────────────────────────────────────────────────────

Deno.test("erpnext_stock_balance - applies item_code and warehouse filters", async () => {
  let capturedFilters: unknown;
  const mockClient = makeMockClient({
    list: async (_doctype: string, opts: any) => {
      capturedFilters = opts.filters;
      return [{
        item_code: "WIDGET-1",
        warehouse: "Stores - C",
        actual_qty: 10,
      }];
    },
  });

  const tool = getTool("erpnext_stock_balance");
  const result = await tool.handler(
    { item_code: "WIDGET-1", warehouse: "Stores - C" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(capturedFilters, [
    ["item_code", "=", "WIDGET-1"],
    ["warehouse", "=", "Stores - C"],
  ]);
  assertEquals(result.doctype, "Bin");
  assertEquals(result.count, 1);
});

// ── erpnext_stock_entry_create ───────────────────────────────────────────────

Deno.test("erpnext_stock_entry_create - throws if stock_entry_type missing", async () => {
  const tool = getTool("erpnext_stock_entry_create");
  await assertRejects(
    () =>
      tool.handler({ items: [{ item_code: "X" }] }, makeCtx(makeMockClient())),
    Error,
    "stock_entry_type",
  );
});

Deno.test("erpnext_stock_entry_create - throws if items missing or empty", async () => {
  const tool = getTool("erpnext_stock_entry_create");
  await assertRejects(
    () =>
      tool.handler(
        { stock_entry_type: "Material Receipt", items: [] },
        makeCtx(makeMockClient()),
      ),
    Error,
    "items",
  );
});

// ── Tool registry sanity ────────────────────────────────────────────────────

Deno.test("all inventory tools have name, description, category, handler", () => {
  for (const tool of inventoryTools) {
    assertEquals(typeof tool.name, "string");
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.category, "inventory");
    assertEquals(typeof tool.handler, "function");
  }
});
