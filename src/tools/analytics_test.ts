/**
 * Analytics Tools Tests
 *
 * Tests for ERPNext analytics/chart MCP tools.
 * Injects a mock FrappeClient to avoid real network calls.
 *
 * @module lib/erpnext/tests/tools/analytics_test
 */

// deno-lint-ignore-file no-explicit-any

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SchemaValidator } from "@casys/mcp-server";
import { analyticsTools } from "./analytics.ts";
import { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

for (const kind of ["ordinary", "long", "Unicode"] as const) {
  Deno.test(`scatter Item UOM lookup bounds actual URLs for 200 ${kind} codes`, async () => {
    const names = Array.from(
      { length: 200 },
      (_, i) =>
        `ITEM-CODE-2026-${String(i).padStart(8, "0")}-${
          kind === "Unicode"
            ? "Kho hàng 東京/&".repeat(8)
            : kind === "long"
            ? "X".repeat(100)
            : "stock"
        }`,
    );
    const original = globalThis.fetch;
    const requested: string[] = [];
    let itemReads = 0;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(
        url.pathname.replace("/api/resource/", ""),
      );
      if (path === "Company/Vietnam Company") {
        return Response.json({
          data: { name: "Vietnam Company", default_currency: "VND" },
        });
      }
      if (path === "Item Price") {
        return Response.json({
          data: names.map((item_code, i) => ({
            name: `PRICE-${i}`,
            item_code,
            currency: "VND",
            uom: "Unit",
            price_list_rate: i + 10,
          })),
        });
      }
      if (path === "Sales Order") {
        return Response.json({ data: [{ name: "SO-1" }] });
      }
      if (path === "Sales Order Item") {
        return Response.json({
          data: names.map((item_code, i) => ({
            name: `ROW-${i}`,
            parent: "SO-1",
            parenttype: "Sales Order",
            item_code,
            stock_qty: i + 1,
          })),
        });
      }
      assertEquals(path, "Item");
      assert(
        (url.pathname + url.search).length <= 6000,
        "Actual Item request exceeds encoded budget",
      );
      itemReads++;
      const filters = JSON.parse(url.searchParams.get("filters")!);
      const chunk: string[] = filters[0][2];
      assertEquals(filters, [["name", "in", chunk]]);
      assertEquals(Number(url.searchParams.get("limit")), chunk.length);
      assertEquals(JSON.parse(url.searchParams.get("fields")!), [
        "name",
        "stock_uom",
      ]);
      requested.push(...chunk);
      return Response.json({
        data: [...chunk].reverse().map((name) => ({ name, stock_uom: "Unit" })),
      });
    };
    try {
      const result = await getTool("erpnext_price_vs_qty").handler(
        { company: "Vietnam Company", limit: 200 },
        makeCtx(
          new FrappeClient({
            baseUrl: "https://fixture.invalid",
            apiKey: "fixture",
            apiSecret: "fixture",
            retries: 0,
          }),
        ),
      ) as any;
      assert(itemReads > 1);
      assertEquals(requested, names);
      assertEquals(
        result.scatterData[0].points,
        names.map((label, i) => ({ x: i + 10, y: i + 1, label })),
      );
      assertEquals(result.xAxisLabel, "Selling Price (VND/stock unit)");
      assertEquals(result.refreshRequest.arguments.company, "Vietnam Company");
    } finally {
      globalThis.fetch = original;
    }
  });
}

for (
  const failure of [
    "oversized",
    "later-error",
    "duplicate",
    "outside",
    "missing",
  ]
) {
  Deno.test(`scatter Item UOM lookup rejects ${failure} without fallback or partial chart`, async () => {
    const names = failure === "oversized"
      ? ["東京".repeat(1000)]
      : Array.from({ length: 200 }, (_, i) => `ITEM-${i}-${"X".repeat(100)}`);
    const denied = new Error("Later Item lookup denied");
    let itemReads = 0;
    let fallbackReads = 0;
    const client = makeMockClient({
      get: async (_doctype, name) => ({ name, default_currency: "VND" }),
      list: async (doctype, options) => {
        if (doctype === "Item Price") {
          return names.map((item_code) => ({
            name: item_code,
            item_code,
            currency: "VND",
            uom: "Unit",
            price_list_rate: 10,
          }));
        }
        if (doctype === "Sales Order") return [{ name: "SO-1" }];
        if (doctype === "Sales Order Item") {
          return names.map((item_code) => ({
            name: item_code,
            parent: "SO-1",
            parenttype: "Sales Order",
            item_code,
            stock_qty: 1,
          }));
        }
        if (doctype !== "Item") {
          fallbackReads++;
          return [];
        }
        itemReads++;
        const chunk = options!.filters![0][2] as string[];
        if (failure === "later-error" && itemReads === 2) throw denied;
        const rows = chunk.map((name) => ({ name, stock_uom: "Unit" }));
        if (failure === "duplicate") return [rows[0], ...rows];
        if (failure === "outside") {
          return [...rows, { name: names.at(-1)!, stock_uom: "Unit" }];
        }
        if (failure === "missing") return rows.slice(1);
        return rows;
      },
    });
    const error = await assertRejects(() =>
      getTool("erpnext_price_vs_qty").handler({
        company: "Vietnam Company",
        limit: 200,
      }, makeCtx(client))
    );
    if (failure === "later-error") {
      assertEquals(error, denied);
      assertEquals(itemReads, 2);
    }
    if (failure === "oversized") assertEquals(itemReads, 0);
    assertEquals(fallbackReads, 0);
  });
}

Deno.test("analytics currency - sales totals use recorded VND base amounts", async () => {
  const calls: { doctype: string; options: any }[] = [];
  const client = makeMockClient({
    get: async (doctype, name) => {
      assertEquals(doctype, "Company");
      return { name, default_currency: "VND" };
    },
    list: async (doctype, options) => {
      calls.push({ doctype, options });
      if (doctype === "Company") return [{ name: "Vietnam Company" }];
      assertEquals(doctype, "Sales Invoice");
      return [{
        name: "INV-USD",
        company: "Vietnam Company",
        customer: "C1",
        customer_name: "Customer",
        currency: "USD",
        grand_total: 10,
        base_grand_total: 250000,
      }, {
        name: "INV-EUR",
        company: "Vietnam Company",
        customer: "C1",
        customer_name: "Customer",
        currency: "EUR",
        grand_total: 20,
        base_grand_total: 560000,
      }];
    },
  });
  const result = await getTool("erpnext_sales_chart").handler(
    {},
    makeCtx(client),
  ) as any;
  assertEquals(result.currency, "VND");
  assertEquals(result.datasets[0].values, [810000]);
  const invoiceCall = calls.find((call) => call.doctype === "Sales Invoice")!;
  assert(invoiceCall.options.fields.includes("base_grand_total"));
  assert(
    invoiceCall.options.filters.some((filter: unknown) =>
      JSON.stringify(filter) ===
        JSON.stringify(["company", "=", "Vietnam Company"])
    ),
  );
  assertEquals(result.refreshRequest.arguments.company, "Vietnam Company");
});

Deno.test("analytics currency - multiple companies require explicit company", async () => {
  let financialReads = 0;
  const client = makeMockClient({
    list: async (doctype) => {
      if (doctype === "Company") {
        return [{ name: "Vietnam Company" }, { name: "US Company" }];
      }
      financialReads++;
      return [];
    },
  });
  await assertRejects(
    () => getTool("erpnext_sales_chart").handler({}, makeCtx(client)),
    Error,
    "'company' is required",
  );
  assertEquals(financialReads, 0);
});

/** Generate an ISO date N months back from today, day 15 — keeps tests robust
 *  against the system clock (the analytics tools window-filter from `now`). */
function relativeMonth(monthsBack: number, day = 15): string {
  const d = new Date();
  d.setDate(day);
  d.setMonth(d.getMonth() - monthsBack);
  return d.toISOString().split("T")[0];
}

// ── Mock FrappeClient ─────────────────────────────────────────────────────────

type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "NEW-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

/** Fixture cũ kiểm hình dạng viewer; các test currency bên trên dùng client riêng nghiêm ngặt. */
function makeCompanyMockClient(
  overrides: Record<string, AnyFn> = {},
): FrappeClient {
  const list = overrides.list ?? (async () => []);
  return makeMockClient({
    ...overrides,
    callMethod: overrides.callMethod ?? (async (method, args, opts) => {
      if (
        method === "frappe.client.get_value" ||
        method === "frappe.client.get_time_zone"
      ) {
        assertEquals(opts, { httpMethod: "GET" });
        assertEquals(
          args,
          method === "frappe.client.get_value"
            ? { doctype: "System Settings", fieldname: "time_zone" }
            : {},
        );
        return { time_zone: "UTC" };
      }
      assertEquals(method, "frappe.desk.query_report.run");
      const rows = await list("Sales Invoice", {});
      return {
        columns: [{
          fieldname: "outstanding",
          fieldtype: "Currency",
          options: "currency",
        }],
        result: rows.map((row: Record<string, unknown>, index: number) => ({
          voucher_type: "Sales Invoice",
          voucher_no: `INV-${index}`,
          currency: "EUR",
          party: `CUSTOMER-${index}`,
          party_account: "Receivables",
          posting_date: "2026-01-01",
          due_date: "2026-01-01",
          ...row,
          outstanding: row.outstanding_amount,
        })),
      };
    }),
    get: async (_doctype, name) => ({ name, default_currency: "EUR" }),
    list: async (doctype, options) => {
      if (doctype === "Company") return [{ name: "Fixture Company" }];
      if (doctype === "Warehouse") return [{ name: "W1" }, { name: "W2" }];
      if (
        (doctype === "Sales Invoice" || doctype === "Sales Order") &&
        options?.fields?.length === 1 && options.fields[0] === "name"
      ) {
        return [{ name: "SINV-001" }];
      }
      const rows = await list(doctype, options);
      return rows.map((row: Record<string, unknown>, index: number) => ({
        name: `FIXTURE-${doctype}-${index}`,
        ...(doctype === "Bin" ? { warehouse: "W1" } : {}),
        ...(doctype.endsWith(" Item")
          ? { parent: "SINV-001", parenttype: doctype.slice(0, -5) }
          : {}),
        ...row,
      }));
    },
  });
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = analyticsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function completeDatasetClient(datasets: Record<string, any[]>) {
  const calls: { doctype: string; offset: number; size: number }[] = [];
  const client = makeMockClient({
    get: async (_doctype, name) => ({ name, default_currency: "VND" }),
    list: async (doctype, options = {}) => {
      const offset = options.limit_start ?? 0;
      const size = options.limit ?? 20;
      calls.push({ doctype, offset, size });
      let rows = datasets[doctype] ?? [];
      for (const [field, operator, value] of options.filters ?? []) {
        rows = rows.filter((row) => {
          if (operator === "=") return row[field] === value;
          if (operator === "!=") return row[field] !== value;
          if (operator === ">=") return row[field] >= value;
          if (operator === "<=") return row[field] <= value;
          if (operator === ">") return row[field] > value;
          if (operator === "in") return value.includes(row[field]);
          throw new Error(`Unsupported fixture filter: ${operator}`);
        });
      }
      for (
        const part of (options.order_by ?? "name asc").split(",").reverse()
      ) {
        const [field, direction] = part.trim().split(/\s+/);
        rows = [...rows].sort((a, b) =>
          (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) *
          (direction === "desc" ? -1 : 1)
        );
      }
      return rows.slice(offset, offset + size);
    },
  });
  return { client, calls };
}

Deno.test("complete treemap rejects 1001 ownership chunks with a measured whole-tool request budget", async () => {
  const names = Array.from(
    { length: 1001 },
    (_, i) => `WH-${i}-${"東京".repeat(250)}`,
  );
  let companyReads = 0;
  let ownershipReads = 0;
  let binReads = 0;
  const client = makeMockClient({
    get: async (doctype, name) => {
      assertEquals(doctype, "Company");
      companyReads++;
      return { name, default_currency: "VND" };
    },
    list: async (doctype, options) => {
      if (doctype === "Warehouse") {
        ownershipReads++;
        assertEquals(options.filters, [["company", "=", "Vietnam Company"]]);
        return names.slice(
          options.limit_start,
          options.limit_start + options.limit,
        ).map((name) => ({ name }));
      }
      assertEquals(doctype, "Bin");
      binReads++;
      return [];
    },
  });
  await assertRejects(
    () =>
      getTool("erpnext_stock_treemap").handler(
        { company: "Vietnam Company" },
        makeCtx(client),
      ),
    Error,
    "1000 request safety limit",
  );
  assertEquals({ companyReads, ownershipReads, binReads }, {
    companyReads: 1,
    ownershipReads: 2,
    binReads: 1000,
  });
});

Deno.test("complete stock ranks across 1003 Bin rows before applying top one", async () => {
  const fixture = completeDatasetClient({
    Bin: [
      { name: "BIN-A", item_code: "A", warehouse: "W1", actual_qty: 10 },
      ...Array.from(
        { length: 1000 },
        (_, i) => ({
          name: `BIN-OTHER-${i}`,
          item_code: `OTHER-${i}`,
          warehouse: "W1",
          actual_qty: 1,
        }),
      ),
      { name: "BIN-B-1", item_code: "B", warehouse: "W1", actual_qty: 6 },
      { name: "BIN-B-2", item_code: "B", warehouse: "W2", actual_qty: 6 },
    ],
  });
  const result = await getTool("erpnext_stock_chart").handler(
    { limit: 1 },
    makeCtx(fixture.client),
  ) as any;
  assertEquals(result.labels, ["B"]);
  assertEquals(result.datasets[0].values, [12]);
  assertEquals(fixture.calls, [{ doctype: "Bin", offset: 0, size: 1000 }, {
    doctype: "Bin",
    offset: 1000,
    size: 1000,
  }]);
});

Deno.test("complete order delta uses both complete monthly count windows", async () => {
  const fixture = completeDatasetClient({
    "Sales Order": [
      ...Array.from(
        { length: 2002 },
        (_, i) => ({
          name: `CURRENT-${i}`,
          transaction_date: relativeMonth(0),
          docstatus: 1,
        }),
      ),
      ...Array.from(
        { length: 1001 },
        (_, i) => ({
          name: `PREVIOUS-${i}`,
          transaction_date: relativeMonth(1),
          docstatus: 1,
        }),
      ),
    ],
  });
  const result = await getTool("erpnext_kpi_orders").handler(
    {},
    makeCtx(fixture.client),
  ) as any;
  assertEquals(result.value, 2002);
  assertEquals(result.delta, 100);
  assertEquals(fixture.calls.map((call) => call.offset), [
    0,
    1000,
    2000,
    0,
    1000,
  ]);
});

for (const count of [0, 999, 1000, 1001, 2501, 5001]) {
  Deno.test(`complete analytics counts and sums ${count} orders before presentation`, async () => {
    const rows = Array.from({ length: count }, (_, i) => ({
      name: `SO-${String(i).padStart(6, "0")}`,
      company: "Vietnam Company",
      docstatus: 1,
      transaction_date: relativeMonth(0),
      customer_name: "Customer",
      base_grand_total: 2,
      status: "Completed",
    }));
    const fixture = completeDatasetClient({ "Sales Order": rows });
    const orders = await getTool("erpnext_kpi_orders").handler(
      {},
      makeCtx(fixture.client),
    ) as any;
    assertEquals(orders.value, count);
    for (
      const name of [
        "erpnext_kpi_revenue",
        "erpnext_revenue_trend",
        "erpnext_order_breakdown",
        "erpnext_revenue_vs_orders",
      ]
    ) {
      const result = await getTool(name).handler({
        company: "Vietnam Company",
        type: "pie",
      }, makeCtx(fixture.client)) as any;
      const total = name === "erpnext_kpi_revenue"
        ? result.value
        : result.datasets[0].values.reduce(
          (sum: number, value: number) => sum + value,
          0,
        );
      assertEquals(total, count * 2, name);
    }
  });
}

Deno.test("complete stock aggregation ranks the sum across warehouses after item group lookup", async () => {
  const items = Array.from(
    { length: 1001 },
    (_, i) => ({
      name: `ITEM-${String(i).padStart(5, "0")}`,
      item_group: "Group",
    }),
  );
  const fixture = completeDatasetClient({
    Item: items,
    Bin: [
      {
        name: "BIN-1",
        item_code: items[0].name,
        warehouse: "W1",
        actual_qty: 10,
      },
      {
        name: "BIN-2",
        item_code: items[1000].name,
        warehouse: "W1",
        actual_qty: 6,
      },
      {
        name: "BIN-3",
        item_code: items[1000].name,
        warehouse: "W2",
        actual_qty: 6,
      },
    ],
  });
  const result = await getTool("erpnext_stock_chart").handler({
    item_group: "Group",
    limit: 1,
  }, makeCtx(fixture.client)) as any;
  assertEquals(result.labels, [items[1000].name]);
  assertEquals(result.datasets[0].values, [12]);
});

Deno.test("complete funnel counts all 501 records at each independent stage", async () => {
  const datasets = Object.fromEntries(
    ["Lead", "Opportunity", "Quotation", "Sales Order"].map((
      doctype,
    ) => [
      doctype,
      Array.from({ length: 501 }, (_, i) => ({
        name: `${doctype}-${i}`,
        company: "Vietnam Company",
        docstatus: 1,
        base_opportunity_amount: 3,
        base_grand_total: 4,
      })),
    ]),
  );
  const fixture = completeDatasetClient(datasets);
  const result = await getTool("erpnext_sales_funnel").handler({
    company: "Vietnam Company",
  }, makeCtx(fixture.client)) as any;
  assertEquals(result.stages.map((stage: any) => stage.count), [
    501,
    501,
    501,
    501,
  ]);
  assertEquals(result.stages.slice(1).map((stage: any) => stage.value), [
    1503,
    2004,
    2004,
  ]);
});

Deno.test("complete sales, stock and profit aggregates retain 1001 child rows and warehouse costs", async () => {
  const count = 1001;
  const datasets = {
    "Sales Invoice": Array.from(
      { length: count },
      (_, i) => ({
        name: `INV-${i}`,
        company: "Vietnam Company",
        docstatus: 1,
        customer: "CUSTOMER",
        customer_name: "Customer",
        status: "Paid",
        base_grand_total: 10,
      }),
    ),
    "Sales Invoice Item": Array.from(
      { length: count },
      (_, i) => ({
        name: `SI-ROW-${i}`,
        parent: "INV-1000",
        parenttype: "Sales Invoice",
        docstatus: 1,
        item_code: "ITEM",
        item_name: "Item",
        base_amount: 10,
        stock_qty: 1,
      }),
    ),
    "Sales Order": [{ name: "SO-1", company: "Vietnam Company", docstatus: 1 }],
    "Sales Order Item": Array.from(
      { length: count },
      (_, i) => ({
        name: `SO-ROW-${i}`,
        parent: "SO-1",
        parenttype: "Sales Order",
        docstatus: 1,
        item_code: "ITEM",
        base_amount: 10,
        stock_qty: 1,
      }),
    ),
    Warehouse: [{ name: "W1", company: "Vietnam Company" }, {
      name: "W2",
      company: "Vietnam Company",
    }],
    Bin: Array.from(
      { length: count },
      (_, i) => ({
        name: `BIN-${i}`,
        item_code: i === count - 1 ? "ITEM" : "OTHER",
        warehouse: "W1",
        modified: "2026-09-05 12:00:00",
        actual_qty: 1,
        stock_value: 5,
        valuation_rate: 5,
      }),
    ),
  };
  const fixture = completeDatasetClient(datasets);
  for (const group_by of ["customer", "item", "status"]) {
    const result = await getTool("erpnext_sales_chart").handler({
      company: "Vietnam Company",
      group_by,
    }, makeCtx(fixture.client)) as any;
    assertEquals(result.datasets[0].values, [count * 10], group_by);
  }
  for (const group_by of ["customer", "item"]) {
    const result = await getTool("erpnext_gross_profit").handler({
      company: "Vietnam Company",
      group_by,
    }, makeCtx(fixture.client)) as any;
    assertEquals(result.datasets[0].values, [count * 10], group_by);
    assertEquals(result.datasets[1].values, [50], group_by);
    if (group_by === "customer") assertEquals(result.labels, ["Customer"]);
  }
  const margin = await getTool("erpnext_kpi_gross_margin").handler({
    company: "Vietnam Company",
  }, makeCtx(fixture.client)) as any;
  assertEquals(margin.value, 50);
  for (const group_by of ["warehouse", "item"]) {
    const result = await getTool("erpnext_stock_treemap").handler({
      company: "Vietnam Company",
      group_by,
    }, makeCtx(fixture.client)) as any;
    assertEquals(
      result.treeData.reduce((sum: number, row: any) => sum + row.value, 0),
      count * 5,
    );
  }
});

Deno.test("complete scatter reads a price beyond 1000 and sums every matching order line", async () => {
  const fixture = completeDatasetClient({
    "Item Price": Array.from({ length: 1001 }, (_, i) => ({
      name: `PRICE-${String(i).padStart(5, "0")}`,
      item_code: i === 1000 ? "TAIL" : `UNRELATED-${i}`,
      selling: 1,
      price_list_rate: 10,
      currency: "VND",
      uom: "Unit",
      modified: "2026-09-05 12:00:00",
    })),
    "Sales Order": [{ name: "SO-1", company: "Vietnam Company", docstatus: 1 }],
    "Sales Order Item": Array.from(
      { length: 1001 },
      (_, i) => ({
        name: `SO-ROW-${i}`,
        parent: "SO-1",
        parenttype: "Sales Order",
        docstatus: 1,
        item_code: "TAIL",
        stock_qty: 2,
      }),
    ),
    Item: [{ name: "TAIL", stock_uom: "Unit" }],
  });
  const result = await getTool("erpnext_price_vs_qty").handler({
    company: "Vietnam Company",
    limit: 1,
  }, makeCtx(fixture.client)) as any;
  assertEquals(result.scatterData[0].points, [{
    x: 10,
    y: 2002,
    label: "TAIL",
  }]);
  assertEquals(
    fixture.calls.map(({ doctype, offset }) => ({ doctype, offset })),
    [
      { doctype: "Item Price", offset: 0 },
      { doctype: "Item Price", offset: 1000 },
      { doctype: "Sales Order", offset: 0 },
      { doctype: "Sales Order Item", offset: 0 },
      { doctype: "Sales Order Item", offset: 1000 },
      { doctype: "Item", offset: 0 },
    ],
  );
});

Deno.test("complete radar keeps all 1001 Bin and order rows within its selected item scope", async () => {
  const fixture = completeDatasetClient({
    Warehouse: [{ name: "W1", company: "Vietnam Company" }],
    Bin: [
      ...Array.from(
        { length: 1001 },
        (_, i) => ({
          name: `BIN-${i}`,
          item_code: "A",
          warehouse: "W1",
          actual_qty: 1,
          stock_value: 1,
        }),
      ),
      {
        name: "BIN-B",
        item_code: "B",
        warehouse: "W1",
        actual_qty: 1001,
        stock_value: 1001,
      },
    ],
    "Sales Order": [{ name: "SO-1", company: "Vietnam Company", docstatus: 1 }],
    "Sales Order Item": [
      ...Array.from(
        { length: 1001 },
        (_, i) => ({
          name: `ROW-${i}`,
          parent: "SO-1",
          parenttype: "Sales Order",
          docstatus: 1,
          item_code: "A",
          base_amount: 1,
        }),
      ),
      ...Array.from(
        { length: 1001 },
        (_, i) => ({
          name: `ROW-B-${i}`,
          parent: "SO-1",
          parenttype: "Sales Order",
          docstatus: 1,
          item_code: "B",
          base_amount: 1,
        }),
      ),
    ],
  });
  const result = await getTool("erpnext_product_radar").handler({
    company: "Vietnam Company",
    items: ["A", "B"],
  }, makeCtx(fixture.client)) as any;
  assertEquals(result.datasets.map((row: any) => row.values), [[
    100,
    100,
    100,
    100,
  ], [100, 100, 100, 100]]);
  assertEquals(
    fixture.calls.filter((call) => call.doctype === "Warehouse").length,
    1,
  );
  assertEquals(
    fixture.calls.filter((call) => call.doctype === "Bin").length,
    3,
  );
  assertEquals(
    fixture.calls.filter((call) => call.doctype === "Sales Order Item").length,
    3,
  );
});

for (
  const tool of [
    "erpnext_kpi_outstanding",
    "erpnext_kpi_overdue",
    "erpnext_ar_aging",
  ]
) {
  Deno.test(`complete receivable report retains 1001 ledger rows for ${tool}`, async () => {
    let reportCalls = 0;
    const client = makeMockClient({
      get: async (_doctype, name) => ({ name, default_currency: "VND" }),
      callMethod: async (method, args, options) => {
        if (method === "frappe.client.get_value") return { time_zone: "UTC" };
        assertEquals(method, "frappe.desk.query_report.run");
        assertEquals(options, { httpMethod: "GET" });
        assertEquals(args.report_name, "Accounts Receivable");
        assertEquals(args.ignore_prepared_report, true);
        assertEquals(args.filters.company, "Vietnam Company");
        reportCalls++;
        return {
          columns: [],
          result: Array.from({ length: 1001 }, (_, i) => ({
            voucher_type: "Sales Invoice",
            voucher_no: `INV-${i}`,
            party: "Customer",
            party_account: "Receivables",
            customer_name: "Customer",
            currency: "VND",
            outstanding: 2,
            posting_date: "2020-01-01",
            due_date: "2020-01-01",
          })),
        };
      },
    });
    const result = await getTool(tool).handler(
      { company: "Vietnam Company" },
      makeCtx(client),
    ) as any;
    if (tool === "erpnext_kpi_outstanding") assertEquals(result.value, 2002);
    else if (tool === "erpnext_kpi_overdue") assertEquals(result.value, 1001);
    else {assertEquals(
        result.datasets.reduce(
          (sum: number, row: any) =>
            sum + row.values.reduce((s: number, n: number) => s + n, 0),
          0,
        ),
        2002,
      );}
    assertEquals(reportCalls, 1);
  });
}

for (
  const toolName of [
    "erpnext_kpi_outstanding",
    "erpnext_kpi_overdue",
    "erpnext_ar_aging",
  ]
) {
  Deno.test(`AR site date - ${toolName} keeps timezone fallback separate from report permission errors`, async () => {
    const calls: string[] = [];
    let denyReport = false;
    const denied = new Error("Accounts Receivable permission denied");
    const client = makeMockClient({
      get: async () => ({ name: "Vietnam Company", default_currency: "VND" }),
      callMethod: async (method, args, opts) => {
        calls.push(method);
        assertEquals(opts, { httpMethod: "GET" });
        if (method === "frappe.client.get_value") {
          assertEquals(args, {
            doctype: "System Settings",
            fieldname: "time_zone",
          });
          throw new Error("System Settings permission denied");
        }
        if (method === "frappe.client.get_time_zone") {
          assertEquals(args, {});
          return { time_zone: "Asia/Ho_Chi_Minh" };
        }
        assertEquals(method, "frappe.desk.query_report.run");
        if (denyReport) throw denied;
        return { columns: [], result: [] };
      },
    });
    await getTool(toolName).handler(
      { company: "Vietnam Company" },
      makeCtx(client),
    );
    assertEquals(calls, [
      "frappe.client.get_value",
      "frappe.client.get_time_zone",
      "frappe.desk.query_report.run",
    ]);
    denyReport = true;
    assertEquals(
      await assertRejects(() =>
        getTool(toolName).handler(
          { company: "Vietnam Company" },
          makeCtx(client),
        )
      ),
      denied,
    );
    assertEquals(calls.slice(3), calls.slice(0, 3));
  });
  for (
    const scenario of [
      {
        now: "2026-09-04T18:30:00Z",
        zone: "Asia/Ho_Chi_Minh",
        date: "2026-09-05",
      },
      {
        now: "2026-09-05T02:30:00Z",
        zone: "America/Los_Angeles",
        date: "2026-09-04",
      },
    ]
  ) {
    Deno.test(`AR site date - ${toolName} uses one ${scenario.zone} snapshot at bucket boundaries`, async () => {
      const OriginalDate = globalThis.Date;
      let now = OriginalDate.parse(scenario.now);
      globalThis.Date = new Proxy(OriginalDate, {
        construct: (target, args) =>
          Reflect.construct(target, args.length ? args : [now]),
        get: (target, property) =>
          property === "now" ? () => now : Reflect.get(target, property),
      });
      try {
        let zoneReads = 0;
        let reports = 0;
        const client = makeMockClient({
          get: async () => ({
            name: "Vietnam Company",
            default_currency: "VND",
          }),
          callMethod: async (method, args, opts) => {
            assertEquals(opts, { httpMethod: "GET" });
            if (method === "frappe.client.get_value") {
              zoneReads++;
              assertEquals(args, {
                doctype: "System Settings",
                fieldname: "time_zone",
              });
              return { time_zone: scenario.zone };
            }
            assertEquals(method, "frappe.desk.query_report.run");
            reports++;
            assertEquals(args.filters.report_date, scenario.date);
            // Mô phỏng report trả về sau nửa đêm: phân loại vẫn phải dùng snapshot đã chọn.
            now += 2 * 86400000;
            return {
              columns: [],
              result: [-1, 0, 1, 30, 31, 60, 61, 90, 91].map((days, index) => ({
                voucher_type: "Sales Invoice",
                voucher_no: `INV-${index}`,
                party: "Customer",
                party_account: "Receivables",
                currency: "VND",
                outstanding: 100,
                posting_date: "2026-01-01",
                due_date: new OriginalDate(
                  OriginalDate.parse(scenario.date) - days * 86400000,
                ).toISOString().slice(0, 10),
              })),
            };
          },
        });
        const result = await getTool(toolName).handler({
          company: "Vietnam Company",
        }, makeCtx(client)) as any;
        assertEquals([zoneReads, reports], [1, 1]);
        if (toolName === "erpnext_kpi_outstanding") {
          assertEquals(result.value, 900);
        } else if (toolName === "erpnext_kpi_overdue") {
          assertEquals(result.value, 7);
        } else {
          assertEquals(
            result.datasets.map((dataset: any) => dataset.values),
            [[400], [200], [200], [100]],
          );
        }
      } finally {
        globalThis.Date = OriginalDate;
      }
    });
  }
}

function makeVndAnalyticsClient(
  options: {
    missingBase?: boolean;
    missingCost?: boolean;
    priceCurrency?: string;
    priceUom?: unknown;
    priceRate?: unknown;
    itemError?: Error;
    priceRows?: Record<string, unknown>[];
  } = {},
) {
  const calls: { doctype: string; options: any }[] = [];
  const documents = [1, 2].map((n) => ({
    name: `DOC-${n}`,
    company: "Vietnam Company",
    customer: `CUSTOMER-${n}`,
    customer_name: `Customer ${n}`,
    currency: n === 1 ? "USD" : "EUR",
    grand_total: n * 10,
    base_grand_total: options.missingBase ? undefined : n * 250000,
    opportunity_amount: n * 10,
    base_opportunity_amount: n * 250000,
    status: "Draft",
    transaction_date: relativeMonth(0),
  }));
  const client = makeMockClient({
    get: async (doctype, name) => {
      assertEquals(doctype, "Company");
      return { name, default_currency: "VND" };
    },
    list: async (doctype, opts) => {
      calls.push({ doctype, options: opts });
      if (doctype === "Company") return [{ name: "Vietnam Company" }];
      if (
        [
          "Sales Invoice",
          "Sales Order",
          "Quotation",
          "Opportunity",
          "Warehouse",
        ].includes(doctype)
      ) {
        assert(
          opts.filters.some((f: unknown) =>
            JSON.stringify(f) ===
              JSON.stringify(["company", "=", "Vietnam Company"])
          ),
        );
        return doctype === "Warehouse" ? [{ name: "WH-VND" }] : documents;
      }
      if (doctype === "Lead") {
        assert(!opts.filters.some((f: string[]) => f[0] === "company"));
        return [{ name: "LEAD-1" }, { name: "LEAD-2" }];
      }
      if (doctype === "Bin") {
        assert(!opts.filters.some((f: string[]) => f[0] === "company"));
        assert(
          opts.filters.some((f: unknown) =>
            JSON.stringify(f) ===
              JSON.stringify(["warehouse", "in", ["WH-VND"]])
          ),
        );
        const item = opts.filters.find((f: string[]) =>
          f[0] === "item_code" && f[1] === "="
        )?.[2];
        return options.missingCost
          ? []
          : [1, 2].filter((n) => !item || item === `ITEM-${n}`).map((n) => ({
            name: `BIN-${n}`,
            item_code: `ITEM-${n}`,
            warehouse: "WH-VND",
            stock_value: n * 100000,
            actual_qty: n * 2,
            valuation_rate: 50000,
          }));
      }
      if (doctype.endsWith(" Item")) {
        assert(!opts.filters.some((f: string[]) => f[0] === "company"));
        assert(
          opts.filters.some((f: unknown) =>
            JSON.stringify(f) ===
              JSON.stringify(["parent", "in", ["DOC-1", "DOC-2"]])
          ),
        );
        return [1, 2].map((n) => ({
          name: `ROW-${n}`,
          parent: `DOC-${n}`,
          parenttype: doctype.slice(0, -5),
          item_code: `ITEM-${n}`,
          item_name: `Item ${n}`,
          qty: n,
          stock_qty: n * 2,
          uom: "Box",
          stock_uom: "Unit",
          conversion_factor: 2,
          amount: n * 10,
          base_amount: options.missingBase ? undefined : n * 250000,
        }));
      }
      if (doctype === "Item Price") {
        if (options.priceRows) return options.priceRows;
        return [1, 2].map((n) => ({
          name: `PRICE-${n}`,
          item_code: `ITEM-${n}`,
          currency: options.priceCurrency ?? "VND",
          price_list_rate: options.priceRate ?? n * 100000,
          uom: options.priceUom === undefined ? "Unit" : options.priceUom,
        }));
      }
      if (doctype === "Item") {
        if (options.itemError) throw options.itemError;
        const requested = opts.filters.find((f: unknown[]) =>
          f[0] === "name"
        )[2] as string[];
        return [1, 2].map((n) => ({ name: `ITEM-${n}`, stock_uom: "Unit" }))
          .filter((item) => requested.includes(item.name));
      }
      throw new Error(`Unexpected fixture doctype ${doctype}`);
    },
  });
  return { client, calls };
}

const baseCurrencyCases: {
  name: string;
  input?: Record<string, unknown>;
  check: (result: any) => void;
}[] = [
  {
    name: "erpnext_sales_chart",
    check: (r) => assertEquals(r.datasets[0].values, [500000, 250000]),
  },
  {
    name: "erpnext_sales_chart",
    input: { group_by: "status" },
    check: (r) => assertEquals(r.datasets[0].values, [750000]),
  },
  {
    name: "erpnext_sales_chart",
    input: { group_by: "item" },
    check: (r) => assertEquals(r.datasets[0].values, [500000, 250000]),
  },
  {
    name: "erpnext_revenue_trend",
    input: { months: 1 },
    check: (r) => assertEquals(r.datasets[0].values, [750000]),
  },
  {
    name: "erpnext_revenue_trend",
    input: { months: 1, group_by: "customer" },
    check: (r) =>
      assertEquals(r.datasets.map((d: any) => d.values[0]), [500000, 250000]),
  },
  {
    name: "erpnext_order_breakdown",
    input: { type: "pie" },
    check: (r) => assertEquals(r.datasets[0].values, [500000, 250000]),
  },
  {
    name: "erpnext_order_breakdown",
    check: (r) => assertEquals(r.datasets[0].values, [500000, 250000]),
  },
  {
    name: "erpnext_revenue_vs_orders",
    check: (r) => {
      assertEquals(r.datasets[0].values, [500000, 250000]);
      assertEquals(r.datasets[1].values, [1, 1]);
    },
  },
  {
    name: "erpnext_stock_treemap",
    check: (r) =>
      assertEquals(r.treeData.map((d: any) => d.value), [200000, 100000]),
  },
  {
    name: "erpnext_stock_treemap",
    input: { group_by: "warehouse" },
    check: (r) => assertEquals(r.treeData[0].value, 300000),
  },
  {
    name: "erpnext_kpi_revenue",
    check: (r) => {
      assertEquals(r.value, 750000);
      assertEquals(r.sparkline[5], 750000);
    },
  },
  {
    name: "erpnext_sales_funnel",
    check: (r) => {
      assertEquals(r.stages.slice(1).map((s: any) => s.value), [
        750000,
        750000,
        750000,
      ]);
      assertEquals(r.stages[0].count, 2);
    },
  },
];

for (const testCase of baseCurrencyCases) {
  Deno.test(`analytics VND matrix - ${testCase.name} ${JSON.stringify(testCase.input ?? {})}`, async () => {
    const { client } = makeVndAnalyticsClient();
    const tool = getTool(testCase.name);
    const input = testCase.input ?? {};
    const result = await tool.handler(input, makeCtx(client)) as any;
    assertEquals(result.currency, "VND");
    testCase.check(result);
    assertEquals(result.refreshRequest, {
      toolName: testCase.name,
      arguments: { ...input, company: "Vietnam Company" },
    });
    assertEquals(result._meta, tool._meta);
    const validator = new SchemaValidator();
    validator.addSchema(tool.name, tool.inputSchema as Record<string, unknown>);
    assert(validator.validate(tool.name, input).valid);
    assert(
      validator.validate(tool.name, { ...input, company: "Vietnam Company" })
        .valid,
    );
  });
}

Deno.test("analytics VND matrix - radar normalizes only same-company money and preserves count dimensions", async () => {
  const { client } = makeVndAnalyticsClient();
  const result = await getTool("erpnext_product_radar").handler({
    items: ["ITEM-1", "ITEM-2"],
  }, makeCtx(client)) as any;
  assertEquals(result.labels, [
    "Stock Qty",
    "Stock Value (VND)",
    "Order Lines",
    "Revenue (VND)",
  ]);
  assertEquals(result.datasets[0].values, [50, 50, 100, 50]);
  assertEquals(result.datasets[1].values, [100, 100, 100, 100]);
  assertEquals(result.currency, undefined);
  assertEquals(result.refreshRequest.arguments.company, "Vietnam Company");
});

Deno.test("analytics VND matrix - missing recorded base amount is not silently zero", async () => {
  const { client } = makeVndAnalyticsClient({ missingBase: true });
  await assertRejects(
    () => getTool("erpnext_sales_chart").handler({}, makeCtx(client)),
    Error,
    "base_grand_total",
  );
});

for (const name of ["erpnext_kpi_gross_margin", "erpnext_gross_profit"]) {
  Deno.test(`analytics VND matrix - ${name} uses stock quantity and reports missing cost`, async () => {
    const { client } = makeVndAnalyticsClient();
    const result = await getTool(name).handler({}, makeCtx(client)) as any;
    if (name === "erpnext_kpi_gross_margin") {
      assertEquals(result.value, 60);
      assertEquals(result.unit, "%");
    } else {
      assertEquals(result.currency, "VND");
      assertEquals(result.datasets[0].values, [500000, 250000]);
      assertEquals(result.datasets[1].values, [60, 60]);
      const customer = await getTool(name).handler(
        { group_by: "customer" },
        makeCtx(client),
      ) as any;
      assertEquals(customer.datasets[0].values, [500000, 250000]);
      assertEquals(customer.datasets[1].values, [60, 60]);
    }
    const missing = makeVndAnalyticsClient({ missingCost: true });
    await assertRejects(
      () => getTool(name).handler({}, makeCtx(missing.client)),
      Error,
      "Missing estimated stock cost",
    );
    assertEquals(result.refreshRequest.arguments.company, "Vietnam Company");
  });
}

Deno.test("analytics VND matrix - scatter uses verified stock-UOM prices and stock quantity", async () => {
  for (const priceRate of [100000, "100000"]) {
    const { client } = makeVndAnalyticsClient({ priceRate });
    const result = await getTool("erpnext_price_vs_qty").handler(
      {},
      makeCtx(client),
    ) as any;
    assertEquals(result.scatterData[0].points.map((p: any) => [p.x, p.y]), [[
      100000,
      2,
    ], [100000, 4]]);
    assertEquals(result.xAxisLabel, "Selling Price (VND/stock unit)");
    assertEquals(result.refreshRequest.arguments.company, "Vietnam Company");
  }
});

Deno.test("analytics VND matrix - scatter refuses currency and UOM mismatches instead of falling back", async () => {
  for (
    const options of [
      { priceCurrency: "USD" },
      { priceCurrency: "" },
      { priceUom: "Box" },
      { priceUom: null },
      { priceUom: "" },
      { priceRate: "not-a-number" },
    ]
  ) {
    const { client } = makeVndAnalyticsClient(options);
    await assertRejects(
      () => getTool("erpnext_price_vs_qty").handler({}, makeCtx(client)),
      Error,
    );
  }
  const denied = new Error("Item permission denied");
  const { client } = makeVndAnalyticsClient({ itemError: denied });
  assertEquals(
    await assertRejects(() =>
      getTool("erpnext_price_vs_qty").handler({}, makeCtx(client))
    ),
    denied,
  );
});

Deno.test("analytics VND matrix - scatter keeps the newest selected price and validates only relevant prices", async () => {
  const prices = [
    {
      name: "PRICE-UNRELATED",
      item_code: "UNRELATED",
      currency: "USD",
      uom: "Unknown",
      price_list_rate: 999,
    },
    {
      name: "PRICE-NEW",
      item_code: "ITEM-1",
      currency: "VND",
      uom: "Unit",
      price_list_rate: 0,
    },
    {
      name: "PRICE-OLD",
      item_code: "ITEM-1",
      currency: "USD",
      uom: "Box",
      price_list_rate: 999,
    },
  ];
  const { client } = makeVndAnalyticsClient({ priceRows: prices });
  const result = await getTool("erpnext_price_vs_qty").handler(
    {},
    makeCtx(client),
  ) as any;
  assertEquals(result.scatterData[0].points, [{ x: 0, y: 2, label: "ITEM-1" }]);
  const invalid = makeVndAnalyticsClient({ priceRows: [prices[2], prices[1]] });
  await assertRejects(
    () => getTool("erpnext_price_vs_qty").handler({}, makeCtx(invalid.client)),
    Error,
    "currency",
  );
});

Deno.test("analytics VND matrix - scatter fallback uses VND warehouse valuation only when no price points exist", async () => {
  const { client } = makeVndAnalyticsClient({ priceRows: [] });
  const result = await getTool("erpnext_price_vs_qty").handler(
    {},
    makeCtx(client),
  ) as any;
  assertEquals(result.title, "Valuation Rate vs Stock Qty");
  assertEquals(result.xAxisLabel, "Valuation Rate (VND/stock unit)");
  assertEquals(result.scatterData[0].points.map((p: any) => [p.x, p.y]), [[
    50000,
    2,
  ], [50000, 4]]);
});

for (
  const name of [
    "erpnext_kpi_outstanding",
    "erpnext_kpi_overdue",
    "erpnext_ar_aging",
  ]
) {
  Deno.test(`analytics VND matrix - ${name} uses report company balances without counting subtotal or other vouchers`, async () => {
    const client = makeMockClient({
      list: async (doctype) => {
        assertEquals(doctype, "Company");
        return [{ name: "Vietnam Company" }];
      },
      get: async () => ({ name: "Vietnam Company", default_currency: "VND" }),
      callMethod: async (method, args, opts) => {
        if (
          method === "frappe.client.get_value" ||
          method === "frappe.client.get_time_zone"
        ) {
          assertEquals(opts, { httpMethod: "GET" });
          assertEquals(
            args,
            method === "frappe.client.get_value"
              ? { doctype: "System Settings", fieldname: "time_zone" }
              : {},
          );
          return { time_zone: "UTC" };
        }
        assertEquals(method, "frappe.desk.query_report.run");
        assertEquals(opts, { httpMethod: "GET" });
        assertEquals(args.ignore_prepared_report, true);
        assertEquals(args.filters.company, "Vietnam Company");
        assertEquals(args.filters.in_party_currency, 0);
        assertEquals(args.filters.presentation_currency, undefined);
        assertEquals(args.filters.party_account, undefined);
        return {
          columns: [],
          result: [
            {
              voucher_type: "Sales Invoice",
              voucher_no: "INV-USD",
              party: "Customer",
              party_account: "Receivables",
              posting_date: "2020-01-01",
              due_date: "2020-02-01",
              currency: "VND",
              outstanding: 250000,
              outstanding_in_account_currency: 10,
              account_currency: "USD",
            },
            {
              voucher_type: "Sales Invoice",
              voucher_no: "INV-EUR",
              party: "Customer",
              party_account: "Receivables",
              posting_date: "2020-01-01",
              due_date: "2020-02-01",
              currency: "VND",
              outstanding: "500000",
              outstanding_in_account_currency: 20,
              account_currency: "EUR",
            },
            {
              voucher_type: "Sales Invoice",
              voucher_no: "INV-USD",
              party: "Customer",
              party_account: "Other Receivables",
              posting_date: "2020-01-01",
              due_date: "2020-02-01",
              currency: "VND",
              outstanding: 125000,
            },
            { party: "Total", outstanding: 875000 },
            {
              voucher_type: "Journal Entry",
              voucher_no: "JE-1",
              outstanding: 999999,
            },
          ],
        };
      },
    });
    const result = await getTool(name).handler({}, makeCtx(client)) as any;
    if (name === "erpnext_kpi_outstanding") {
      assertEquals(result.value, 875000);
      assertEquals(result.currency, "VND");
      assert(result.formattedValue.startsWith("2 inv. / "));
    } else if (name === "erpnext_kpi_overdue") {
      assertEquals(result.value, 2);
      assert(result.formattedValue.includes("875,000"));
    } else {
      assertEquals(result.currency, "VND");
      assertEquals(result.datasets[3].values, [875000]);
      const tree = await getTool(name).handler(
        { type: "treemap" },
        makeCtx(client),
      ) as any;
      assertEquals(tree.treeData[0].value, 875000);
    }
    assertEquals(result.refreshRequest.arguments.company, "Vietnam Company");
  });
}

function assertChartMeta(result: any, viewerName = "chart-viewer") {
  assert(result._meta, "Result should have _meta");
  assertEquals(result._meta.ui.resourceUri, `ui://hvgerp-mcp/${viewerName}`);
}

Deno.test("all monetary analytics preserve company ambiguity and permission failures", async () => {
  for (
    const tool of analyticsTools.filter((tool) =>
      !["erpnext_stock_chart", "erpnext_kpi_orders", "erpnext_profit_loss"]
        .includes(tool.name)
    )
  ) {
    const validator = new SchemaValidator();
    validator.addSchema(tool.name, tool.inputSchema as Record<string, unknown>);
    assert(validator.validate(tool.name, {}).valid, tool.name);
    assert(
      validator.validate(tool.name, { company: "Vietnam Company" }).valid,
      tool.name,
    );
    const ambiguous = makeMockClient({
      list: async (doctype) => {
        assertEquals(doctype, "Company");
        return [{ name: "Vietnam Company" }, { name: "US Company" }];
      },
    });
    await assertRejects(
      () => tool.handler({}, makeCtx(ambiguous)),
      Error,
      "'company' is required",
    );
    const denied = new Error(`${tool.name} Company permission denied`);
    const privateCompany = makeMockClient({
      get: async () => {
        throw denied;
      },
    });
    assertEquals(
      await assertRejects(() =>
        tool.handler({ company: "Private" }, makeCtx(privateCompany))
      ),
      denied,
    );
  }
});

// ── Legacy pipeline surface removed ─────────────────────────────────────────

Deno.test("analytics tools no longer expose legacy order/purchase pipeline viewers", () => {
  assertEquals(
    analyticsTools.some((tool) => tool.name === "erpnext_order_pipeline"),
    false,
  );
  assertEquals(
    analyticsTools.some((tool) => tool.name === "erpnext_purchase_pipeline"),
    false,
  );
});

// ── erpnext_stock_chart ─────────────────────────────────────────────────────

Deno.test("erpnext_stock_chart - returns bar chart data", async () => {
  const mockClient = makeMockClient({
    list: async () => [
      {
        name: "BIN-A-W1",
        item_code: "ITEM-A",
        warehouse: "W1",
        actual_qty: 50,
        stock_value: 5000,
      },
      {
        name: "BIN-B-W1",
        item_code: "ITEM-B",
        warehouse: "W1",
        actual_qty: 30,
        stock_value: 3000,
      },
      {
        name: "BIN-A-W2",
        item_code: "ITEM-A",
        warehouse: "W2",
        actual_qty: 20,
        stock_value: 2000,
      },
    ],
  });

  const tool = getTool("erpnext_stock_chart");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.title, "Stock Levels");
  assert(result.labels.length === 2, "Should aggregate by item");
  assertEquals(result.labels[0], "ITEM-A"); // highest qty first
  assertEquals(result.datasets[0].values[0], 70); // 50+20
  assertChartMeta(result);
});

Deno.test("erpnext_stock_chart - uses horizontal-bar for many items", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    name: `BIN-${i}`,
    item_code: `ITEM-${i}`,
    warehouse: "W1",
    actual_qty: 100 - i * 10,
    stock_value: 1000,
  }));

  const mockClient = makeMockClient({ list: async () => items });

  const tool = getTool("erpnext_stock_chart");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "horizontal-bar");
});

// ── erpnext_sales_chart ─────────────────────────────────────────────────────

Deno.test("erpnext_sales_chart - status grouping returns donut", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { name: "SINV-001", status: "Paid", base_grand_total: 5000 },
      { name: "SINV-002", status: "Paid", base_grand_total: 3000 },
      { name: "SINV-003", status: "Unpaid", base_grand_total: 2000 },
    ],
  });

  const tool = getTool("erpnext_sales_chart");
  const result = await tool.handler(
    { group_by: "status" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.type, "donut");
  assertEquals(result.labels[0], "Paid"); // highest value first
  assertEquals(result.datasets[0].values[0], 8000);
  assertChartMeta(result);
});

Deno.test("erpnext_sales_chart - customer grouping returns horizontal-bar", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { customer: "C1", customer_name: "Customer One", base_grand_total: 5000 },
      { customer: "C2", customer_name: "Customer Two", base_grand_total: 3000 },
    ],
  });

  const tool = getTool("erpnext_sales_chart");
  const result = await tool.handler(
    { group_by: "customer" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.type, "horizontal-bar");
  assertEquals(result.labels[0], "Customer One");
  assertChartMeta(result);
});

// ── erpnext_revenue_trend ───────────────────────────────────────────────────

Deno.test("erpnext_revenue_trend - returns line chart with monthly data", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      {
        customer_name: "Acme",
        base_grand_total: 5000,
        transaction_date: relativeMonth(0, 10),
      },
      {
        customer_name: "Acme",
        base_grand_total: 3000,
        transaction_date: relativeMonth(1, 15),
      },
    ],
  });

  const tool = getTool("erpnext_revenue_trend");
  const result = await tool.handler(
    { months: 3, type: "line" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.type, "line");
  assertEquals(result.labels.length, 3);
  assertEquals(result.datasets.length, 1); // total mode
  assertChartMeta(result);
});

Deno.test("erpnext_revenue_trend - customer grouping produces multiple datasets", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      {
        customer_name: "Acme",
        base_grand_total: 5000,
        transaction_date: relativeMonth(0, 10),
      },
      {
        customer_name: "Globex",
        base_grand_total: 3000,
        transaction_date: relativeMonth(1, 15),
      },
    ],
  });

  const tool = getTool("erpnext_revenue_trend");
  const result = await tool.handler(
    { months: 2, group_by: "customer" },
    makeCtx(mockClient),
  ) as any;

  assert(result.datasets.length >= 2, "Should have dataset per customer");
  assertChartMeta(result);
});

// ── erpnext_order_breakdown ─────────────────────────────────────────────────

Deno.test("erpnext_order_breakdown - stacked-bar groups by customer and status", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { customer_name: "Acme", status: "Draft", base_grand_total: 1000 },
      {
        customer_name: "Acme",
        status: "To Deliver and Bill",
        base_grand_total: 2000,
      },
      { customer_name: "Globex", status: "Draft", base_grand_total: 500 },
    ],
  });

  const tool = getTool("erpnext_order_breakdown");
  const result = await tool.handler(
    { type: "stacked-bar" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.type, "stacked-bar");
  assertEquals(result.labels[0], "Acme"); // highest total first
  assert(result.datasets.length >= 1);
  assert(result.datasets.every((d: { stack: string }) => d.stack === "status"));
  assertChartMeta(result);
});

Deno.test("erpnext_order_breakdown - pie mode returns single dataset", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { customer_name: "Acme", status: "Draft", base_grand_total: 3000 },
      { customer_name: "Globex", status: "Draft", base_grand_total: 1000 },
    ],
  });

  const tool = getTool("erpnext_order_breakdown");
  const result = await tool.handler(
    { type: "pie" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.type, "pie");
  assertEquals(result.datasets.length, 1);
  assertChartMeta(result);
});

// ── erpnext_revenue_vs_orders ───────────────────────────────────────────────

Deno.test("erpnext_revenue_vs_orders - returns composed chart with dual axis", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { customer_name: "Acme", base_grand_total: 5000 },
      { customer_name: "Acme", base_grand_total: 3000 },
      { customer_name: "Globex", base_grand_total: 2000 },
    ],
  });

  const tool = getTool("erpnext_revenue_vs_orders");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "composed");
  assertEquals(result.showRightAxis, true);
  assertEquals(result.datasets.length, 2);
  assertEquals(result.datasets[0].type, "bar");
  assertEquals(result.datasets[1].type, "line");
  assertEquals(result.datasets[1].yAxisId, "right");
  // Acme: 2 orders, 8000 total
  assertEquals(result.datasets[0].values[0], 8000);
  assertEquals(result.datasets[1].values[0], 2);
  assertChartMeta(result);
});

// ── erpnext_stock_treemap ───────────────────────────────────────────────────

Deno.test("erpnext_stock_treemap - returns treemap data", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { item_code: "ITEM-A", warehouse: "W1", stock_value: 5000 },
      { item_code: "ITEM-B", warehouse: "W1", stock_value: 3000 },
    ],
  });

  const tool = getTool("erpnext_stock_treemap");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "treemap");
  assert(result.treeData.length === 2);
  assertEquals(result.treeData[0].name, "ITEM-A");
  assertEquals(result.treeData[0].value, 5000);
  assertChartMeta(result);
});

Deno.test("erpnext_stock_treemap - group by warehouse aggregates", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { item_code: "ITEM-A", warehouse: "W1", stock_value: 5000 },
      { item_code: "ITEM-B", warehouse: "W1", stock_value: 3000 },
      { item_code: "ITEM-A", warehouse: "W2", stock_value: 2000 },
    ],
  });

  const tool = getTool("erpnext_stock_treemap");
  const result = await tool.handler(
    { group_by: "warehouse" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.treeData.length, 2);
  const w1 = result.treeData.find((t: { name: string }) => t.name === "W1");
  assertEquals(w1.value, 8000);
});

// ── erpnext_product_radar ───────────────────────────────────────────────────

Deno.test("erpnext_product_radar - returns radar with auto-selected items", async () => {
  let callCount = 0;
  const mockClient = makeCompanyMockClient({
    list: async (doctype: string) => {
      if (doctype === "Bin") {
        callCount++;
        if (callCount === 1) {
          // Auto-select top items
          return [
            { item_code: "ITEM-A" },
            { item_code: "ITEM-B" },
          ];
        }
        // Per-item bin queries
        return [{ actual_qty: 50, stock_value: 5000 }];
      }
      if (doctype === "Sales Order Item") {
        return [];
      }
      return [];
    },
  });

  const tool = getTool("erpnext_product_radar");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "radar");
  assertEquals(result.datasets.length, 2);
  assertEquals(result.labels.length, 4); // 4 dimensions
  assertChartMeta(result);
});

Deno.test("erpnext_product_radar - the schema bounds the fan-out and still allows auto-select", () => {
  // Exercised through the framework's validator against the tool's real schema,
  // because that is the only place the bound lives — the handler holds no
  // duplicate of it. Calling `tool.handler()` directly would bypass validation
  // entirely and prove nothing about what a caller actually gets.
  //
  // The empty-array case is the one that matters most: it is the documented way
  // to ask for auto-selection, so a lower bound on this array would reject a
  // supported call as malformed. An earlier revision added `minItems: 2` and
  // broke exactly that.
  const validator = new SchemaValidator();
  const tool = getTool("erpnext_product_radar");
  validator.addSchema(tool.name, tool.inputSchema as Record<string, unknown>);

  const items = (n: number) => ({
    items: Array.from({ length: n }, (_, i) => `ITEM-${i}`),
  });

  assertEquals(
    validator.validate(tool.name, items(9)).valid,
    false,
    "9 items must be rejected: each item costs one Bin query",
  );
  assertEquals(
    validator.validate(tool.name, items(8)).valid,
    true,
    "8 is inside the contract",
  );
  assertEquals(
    validator.validate(tool.name, { items: [] }).valid,
    true,
    "an empty array is the documented auto-select invocation",
  );

  // How that rejection is *worded* is the framework's contract, tested there.
  // This asserts only what this repo owns: that the bound exists and that
  // auto-selection stays reachable through it.
});

Deno.test("erpnext_product_radar - auto-select still works with no items given", async () => {
  // Guards the behaviour the schema must keep reachable, end to end.
  const mockClient = makeCompanyMockClient({
    list: async (doctype: string, opts?: { limit?: number }) => {
      if (doctype !== "Bin") return [];
      return opts?.limit === 4
        ? [{ item_code: "ITEM-A" }, { item_code: "ITEM-B" }]
        : [{ actual_qty: 5, stock_value: 500 }];
    },
  });

  const tool = getTool("erpnext_product_radar");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "radar");
  assertEquals(result.datasets.length, 2);
});

// ── erpnext_price_vs_qty ────────────────────────────────────────────────────

Deno.test("erpnext_price_vs_qty - falls back to Bin data when no Item Price", async () => {
  let callCount = 0;
  const mockClient = makeCompanyMockClient({
    list: async (doctype: string) => {
      callCount++;
      if (doctype === "Item Price") return [];
      if (doctype === "Sales Order Item") return [];
      if (doctype === "Bin") {
        return [
          { item_code: "ITEM-A", valuation_rate: 100, actual_qty: 50 },
          { item_code: "ITEM-B", valuation_rate: 200, actual_qty: 30 },
        ];
      }
      return [];
    },
  });

  const tool = getTool("erpnext_price_vs_qty");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "scatter");
  assert(result.scatterData.length > 0);
  assertEquals(result.scatterData[0].points.length, 2);
  assertChartMeta(result);
});

// ── erpnext_kpi_revenue ─────────────────────────────────────────────────────

Deno.test("erpnext_kpi_revenue - returns KPI with sparkline (single API call)", async () => {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${
    String(now.getMonth() + 1).padStart(2, "0")
  }-15`;
  const lastMonth =
    new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString().split(
      "T",
    )[0];

  const mockClient = makeCompanyMockClient({
    list: async () => [
      { base_grand_total: 5000, transaction_date: thisMonth },
      { base_grand_total: 3000, transaction_date: lastMonth },
    ],
  });

  const tool = getTool("erpnext_kpi_revenue");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.label, "Revenue MTD");
  assertEquals(result.currency, "EUR");
  assertEquals(result.value, 5000); // only current month bucket
  assert(Array.isArray(result.sparkline));
  assertEquals(result.sparkline.length, 6);
  assertEquals(result.sparkline[5], 5000); // current month
  assertEquals(result.sparkline[4], 3000); // previous month
  assert(result.trendIsGood === true);
  assertChartMeta(result, "kpi-viewer");
});

// ── erpnext_kpi_outstanding ─────────────────────────────────────────────────

Deno.test("erpnext_kpi_outstanding - sums outstanding invoices", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { outstanding_amount: 2000 },
      { outstanding_amount: 3000 },
    ],
  });

  const tool = getTool("erpnext_kpi_outstanding");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.label, "Outstanding Receivables");
  assertEquals(result.value, 5000);
  assert(result.trendIsGood === false);
  assertChartMeta(result, "kpi-viewer");
});

// ── erpnext_kpi_orders ──────────────────────────────────────────────────────

Deno.test("erpnext_kpi_orders - counts orders this month", async () => {
  const mockClient = makeMockClient({
    list: async () => [{ name: "SO-1", base_grand_total: 1000 }, {
      name: "SO-2",
      base_grand_total: 2000,
    }],
  });

  const tool = getTool("erpnext_kpi_orders");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.label, "Orders This Month");
  assertEquals(result.value, 2); // count, not sum
  assert(result.unit === "orders");
  assertChartMeta(result, "kpi-viewer");
});

// ── erpnext_kpi_gross_margin ────────────────────────────────────────────────

Deno.test("erpnext_kpi_gross_margin - computes margin from SO items and Bin", async () => {
  let callIdx = 0;
  const mockClient = makeCompanyMockClient({
    list: async (doctype: string) => {
      callIdx++;
      if (doctype === "Sales Order Item") {
        return [
          { item_code: "ITEM-A", stock_qty: 10, base_amount: 5000 },
          { item_code: "ITEM-B", stock_qty: 5, base_amount: 2500 },
        ];
      }
      if (doctype === "Bin") {
        return [
          { item_code: "ITEM-A", valuation_rate: 300 },
          { item_code: "ITEM-B", valuation_rate: 200 },
        ];
      }
      return [];
    },
  });

  const tool = getTool("erpnext_kpi_gross_margin");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.label, "Gross Margin");
  assertEquals(result.unit, "%");
  // Revenue 7500, cost = 10*300 + 5*200 = 4000, margin = (7500-4000)/7500*100 = 46.7%
  assert(result.value > 40 && result.value < 50);
  assertChartMeta(result, "kpi-viewer");
});

// ── erpnext_kpi_overdue ─────────────────────────────────────────────────────

Deno.test("erpnext_kpi_overdue - counts overdue invoices", async () => {
  const mockClient = makeCompanyMockClient({
    list: async () => [
      { outstanding_amount: 1500, due_date: "2026-01-01" },
      { outstanding_amount: 500, due_date: "2025-12-15" },
    ],
  });

  const tool = getTool("erpnext_kpi_overdue");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.label, "Overdue Invoices");
  assertEquals(result.value, 2);
  assert(result.trendIsGood === false);
  assertChartMeta(result, "kpi-viewer");
});

// ── erpnext_sales_funnel ────────────────────────────────────────────────────

Deno.test("erpnext_sales_funnel - returns 4-stage funnel with conversion rates", async () => {
  const mockClient = makeCompanyMockClient({
    list: async (doctype: string) => {
      if (doctype === "Lead") {
        return [{ name: "L1" }, { name: "L2" }, { name: "L3" }, { name: "L4" }];
      }
      if (doctype === "Opportunity") {
        return [{ name: "O1", base_opportunity_amount: 5000 }, {
          name: "O2",
          base_opportunity_amount: 3000,
        }];
      }
      if (doctype === "Quotation") {
        return [{ name: "Q1", base_grand_total: 4000 }];
      }
      if (doctype === "Sales Order") {
        return [{ name: "SO1", base_grand_total: 3500 }];
      }
      return [];
    },
  });

  const tool = getTool("erpnext_sales_funnel");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.title, "Sales Funnel");
  assertEquals(result.stages.length, 4);
  assertEquals(result.stages[0].label, "Leads");
  assertEquals(result.stages[0].count, 4);
  assertEquals(result.stages[1].label, "Opportunities");
  assertEquals(result.stages[1].count, 2);
  assertEquals(result.stages[1].conversionRate, 50); // 2/4
  assertEquals(result.stages[2].conversionRate, 50); // 1/2
  assertEquals(result.stages[3].conversionRate, 100); // 1/1
  assertChartMeta(result, "funnel-viewer");
});

// ── erpnext_ar_aging ────────────────────────────────────────────────────────

Deno.test("erpnext_ar_aging - groups invoices into aging buckets", async () => {
  const today = new Date();
  const d10 = new Date(today);
  d10.setDate(today.getDate() - 10);
  const d45 = new Date(today);
  d45.setDate(today.getDate() - 45);
  const d100 = new Date(today);
  d100.setDate(today.getDate() - 100);

  const mockClient = makeCompanyMockClient({
    list: async () => [
      {
        customer_name: "Acme",
        outstanding_amount: 1000,
        due_date: d10.toISOString().split("T")[0],
        posting_date: d10.toISOString().split("T")[0],
      },
      {
        customer_name: "Acme",
        outstanding_amount: 2000,
        due_date: d45.toISOString().split("T")[0],
        posting_date: d45.toISOString().split("T")[0],
      },
      {
        customer_name: "Globex",
        outstanding_amount: 3000,
        due_date: d100.toISOString().split("T")[0],
        posting_date: d100.toISOString().split("T")[0],
      },
    ],
  });

  const tool = getTool("erpnext_ar_aging");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "stacked-bar");
  assert(result.labels.length > 0);
  assert(result.datasets.length > 0);
  assertChartMeta(result);
});

// ── erpnext_gross_profit ────────────────────────────────────────────────────

Deno.test("erpnext_gross_profit - returns composed chart with margin line", async () => {
  const mockClient = makeCompanyMockClient({
    list: async (doctype: string) => {
      if (doctype === "Sales Invoice Item") {
        return [
          {
            item_code: "ITEM-A",
            stock_qty: 10,
            base_amount: 5000,
            parent: "SINV-001",
          },
          {
            item_code: "ITEM-B",
            stock_qty: 5,
            base_amount: 2500,
            parent: "SINV-001",
          },
        ];
      }
      if (doctype === "Sales Invoice") {
        return [{ name: "SINV-001", customer_name: "Acme" }];
      }
      if (doctype === "Bin") {
        return [
          { item_code: "ITEM-A", valuation_rate: 300 },
          { item_code: "ITEM-B", valuation_rate: 200 },
        ];
      }
      return [];
    },
  });

  const tool = getTool("erpnext_gross_profit");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.type, "composed");
  assertEquals(result.showRightAxis, true);
  assert(result.datasets.length >= 2);
  assertChartMeta(result);
});

// ── erpnext_profit_loss ─────────────────────────────────────────────────────

const INCOME_ROOT = "Income - HVG";
const EXPENSE_ROOT = "Expenses - HVG";
const MONTH_ABBR = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** Tên cột kỳ mà báo cáo sinh ra cho khoảng ngày, dạng `aug_2026`. */
function monthKeys(start: string, end: string): string[] {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  const count = (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
  const keys: string[] = [];
  for (let step = 0; step < count; step++) {
    const index = startMonth - 1 + step;
    keys.push(
      `${MONTH_ABBR[index % 12]}_${startYear + Math.floor(index / 12)}`,
    );
  }
  return keys;
}

/**
 * Một phản hồi "Profit and Loss Statement" giả, dựng theo đúng hình dạng đã đo trên
 * production: dòng gốc có `indent`, dòng con nằm dưới gốc, và hai dòng tổng hợp mà báo cáo
 * chèn vào cuối thì không có `indent`.
 */
function makePlReport(
  filters: any,
  opts: {
    income?: number[];
    expenses?: number[];
    summary?: [number, number] | null;
  } = {},
) {
  const keys = monthKeys(filters.period_start_date, filters.period_end_date);
  const income = opts.income ?? keys.map(() => 0);
  const expenses = opts.expenses ?? keys.map(() => 0);
  const byMonth = (values: number[]) =>
    Object.fromEntries(keys.map((key, index) => [key, values[index] ?? 0]));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

  const rootRow = (account: string, values: number[]) => ({
    account,
    account_name: account,
    parent_account: "",
    indent: 0.0,
    currency: "VND",
    is_group: 1,
    ...byMonth(values),
    total: sum(values),
  });

  const result: Record<string, unknown>[] = [
    rootRow(INCOME_ROOT, income),
    rootRow(EXPENSE_ROOT, expenses),
    // Dòng con: số của nó đã nằm trong tổng của gốc, cộng thêm là đếm hai lần.
    {
      ...rootRow(EXPENSE_ROOT, expenses),
      account: "Administrative Expenses - HVG",
      parent_account: EXPENSE_ROOT,
      indent: 2.0,
      is_group: 0,
    },
    // Dòng tổng tổng hợp và dòng trống: không có `indent`, không được cộng.
    {
      account: "'Tổng Chi phí (Ghi nợ)'",
      account_name: "'Tổng Chi phí (Ghi nợ)'",
      currency: "VND",
      ...byMonth(expenses),
      total: sum(expenses),
    },
    {},
  ];

  const summary = opts.summary === null
    ? undefined
    : (opts.summary ?? [sum(income), sum(expenses)]);

  return {
    columns: [
      {
        fieldname: "account",
        label: "Tài Khoản",
        fieldtype: "Link",
        options: "Account",
      },
      {
        fieldname: "currency",
        label: "Tiền tệ",
        fieldtype: "Link",
        options: "Currency",
        hidden: 1,
      },
      ...keys.map((key) => ({
        // Nhãn đã qua `_()`: cột phải nhận diện bằng `fieldtype`, không bằng nhãn.
        fieldname: key,
        label: `thg ${key} tiếng Việt`,
        fieldtype: "Currency",
        options: "currency",
      })),
      {
        fieldname: "total",
        label: "Tổng cộng",
        fieldtype: "Currency",
        options: "currency",
      },
    ],
    result,
    ...(summary
      ? {
        report_summary: [
          {
            label: "Tổng thu nhập",
            value: summary[0],
            datatype: "Currency",
            currency: "VND",
          },
          {
            label: "Tổng chi phí",
            value: summary[1],
            datatype: "Currency",
            currency: "VND",
          },
          {
            label: "Lợi nhuận ròng",
            value: summary[0] - summary[1],
            datatype: "Currency",
            currency: "VND",
          },
        ],
      }
      : {}),
  };
}

/** Client giả cho `erpnext_profit_loss`: công ty, báo cáo, và bảng root_type. */
function makePlClient(opts: {
  companies?: string[];
  accounts?: Record<string, string>;
  report?: (filters: any) => unknown;
} = {}) {
  const companies = opts.companies ?? ["Havi Group"];
  const accounts = opts.accounts ??
    { [INCOME_ROOT]: "Income", [EXPENSE_ROOT]: "Expense" };
  const listedDoctypes: string[] = [];
  const runArgs: any[] = [];

  const client = makeMockClient({
    list: async (doctype: string, options: any) => {
      listedDoctypes.push(doctype);
      if (doctype === "Company") return companies.map((name) => ({ name }));
      if (doctype === "Account") {
        const wanted = (options?.filters?.[0]?.[2] ?? []) as string[];
        return wanted
          .filter((name) => name in accounts)
          .map((name) => ({ name, root_type: accounts[name] }));
      }
      return [];
    },
    callMethod: async (method: string, args: any) => {
      if (method === "frappe.client.get_value") {
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      if (method === "frappe.desk.query_report.run") {
        runArgs.push(args);
        const filters = args.filters as any;
        return (opts.report ?? ((f: any) => makePlReport(f)))(filters);
      }
      return null;
    },
  });

  return { client, listedDoctypes, runArgs };
}

Deno.test("erpnext_profit_loss - reads the ledger report, not Sales/Purchase Orders", async () => {
  // Chính là lỗi phải sửa: site có 0 Sales Order và 0 Purchase Order, nên bản cũ luôn báo
  // thu 0 và chi 0 trong khi sổ cái có gần bảy trăm triệu chi phí.
  const { client, listedDoctypes, runArgs } = makePlClient({
    report: (filters) =>
      makePlReport(filters, {
        expenses: monthKeys(
          filters.period_start_date,
          filters.period_end_date,
        ).map((_, index, all) => index === all.length - 1 ? 709262820.06 : 0),
      }),
  });

  const tool = getTool("erpnext_profit_loss");
  const result = await tool.handler({ months: 6 }, makeCtx(client)) as any;

  assertEquals(listedDoctypes.includes("Sales Order"), false);
  assertEquals(listedDoctypes.includes("Purchase Order"), false);
  assertEquals(runArgs[0].report_name, "Profit and Loss Statement");

  const expenses = result.datasets.find((d: any) => d.label === "Expenses");
  assertEquals(expenses.values.at(-1), 709262820.06);
  assertEquals(result.currency, "VND");
  assertEquals(result.source.cross_check.status, "verified");
  assertEquals(result.source.cross_check.expenses, 709262820.06);
  assertChartMeta(result);
});

Deno.test("erpnext_profit_loss - never lets the report queue a Prepared Report", async () => {
  // Không có cờ này, `query_report.run` có thể chèn một bản ghi Prepared Report, tức là một
  // tool khai read-only lại ghi lên site sản xuất.
  const { client, runArgs } = makePlClient();
  await getTool("erpnext_profit_loss").handler({ months: 3 }, makeCtx(client));

  assertEquals(runArgs[0].ignore_prepared_report, true);
  assertEquals(runArgs[0].filters.accumulated_values, 0);
  assertEquals(runArgs[0].filters.periodicity, "Monthly");
  assertEquals(runArgs[0].filters.filter_based_on, "Date Range");
});

Deno.test("erpnext_profit_loss - window starts on the first of a month and ends on a month end", async () => {
  // Bản cũ dựng ngày theo giờ máy rồi gọi `toISOString()`: ở múi giờ dương, ngày mồng một
  // trượt về ngày cuối tháng trước và cả cửa sổ lệch một tháng.
  const { client } = makePlClient();
  const result = await getTool("erpnext_profit_loss").handler(
    { months: 6 },
    makeCtx(client),
  ) as any;

  const start = result.source.period_start_date as string;
  const end = result.source.period_end_date as string;
  assertEquals(start.slice(-3), "-01");

  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const lastDayOfEndMonth = new Date(Date.UTC(endYear, endMonth, 0))
    .getUTCDate();
  assertEquals(endDay, lastDayOfEndMonth);

  const [startYear, startMonth] = start.split("-").map(Number);
  assertEquals((endYear - startYear) * 12 + (endMonth - startMonth), 5);
  assertEquals(result.labels.length, 6);
});

Deno.test("erpnext_profit_loss - counts each root once, ignoring child and total rows", async () => {
  const { client } = makePlClient({
    report: (filters) =>
      makePlReport(filters, {
        income: [100, 200, 300],
        expenses: [10, 20, 30],
      }),
  });

  const result = await getTool("erpnext_profit_loss").handler(
    { months: 3 },
    makeCtx(client),
  ) as any;

  const income = result.datasets.find((d: any) => d.label === "Income");
  const expenses = result.datasets.find((d: any) => d.label === "Expenses");
  const net = result.datasets.find((d: any) => d.label === "Net Profit");
  assertEquals(income.values, [100, 200, 300]);
  assertEquals(expenses.values, [10, 20, 30]);
  assertEquals(net.values, [90, 180, 270]);
});

Deno.test("erpnext_profit_loss - refuses to chart totals that disagree with the report", async () => {
  const { client } = makePlClient({
    report: (filters) =>
      makePlReport(filters, {
        expenses: [10, 20, 30],
        // ERPNext tự báo một tổng khác: nghĩa là cách đọc cây tài khoản ở đây đã sai.
        summary: [0, 999],
      }),
  });

  await assertRejects(
    () =>
      getTool("erpnext_profit_loss").handler({ months: 3 }, makeCtx(client)),
    Error,
    "do not add up",
  );
});

Deno.test("erpnext_profit_loss - refuses a top-level account it cannot classify", async () => {
  const { client } = makePlClient({
    accounts: { [INCOME_ROOT]: "Income" },
  });

  await assertRejects(
    () =>
      getTool("erpnext_profit_loss").handler({ months: 3 }, makeCtx(client)),
    Error,
    EXPENSE_ROOT,
  );
});

Deno.test("erpnext_profit_loss - says so when the report gives nothing to check against", async () => {
  const { client } = makePlClient({
    report: (filters) =>
      makePlReport(filters, { expenses: [1, 2, 3], summary: null }),
  });

  const result = await getTool("erpnext_profit_loss").handler(
    { months: 3 },
    makeCtx(client),
  ) as any;

  assertEquals(result.source.cross_check.status, "unavailable");
  assertEquals(result.source.cross_check.derived_expenses, 6);
});

Deno.test("erpnext_profit_loss - requires 'company' when the site has several", async () => {
  const { client } = makePlClient({
    companies: ["Havi Group", "Havi Logistics"],
  });

  await assertRejects(
    () =>
      getTool("erpnext_profit_loss").handler({ months: 3 }, makeCtx(client)),
    Error,
    "'company' is required",
  );
});

Deno.test("erpnext_profit_loss - passes an explicit company straight through", async () => {
  const { client, runArgs, listedDoctypes } = makePlClient({
    companies: ["Havi Group", "Havi Logistics"],
  });

  await getTool("erpnext_profit_loss").handler(
    { months: 3, company: "Havi Logistics" },
    makeCtx(client),
  );

  assertEquals(runArgs[0].filters.company, "Havi Logistics");
  // Công ty đã biết thì không cần hỏi lại danh sách.
  assertEquals(listedDoctypes.includes("Company"), false);
});

Deno.test("erpnext_profit_loss - rejects a months value it cannot honour", async () => {
  const tool = getTool("erpnext_profit_loss");
  for (const months of [0, -1, 2.5, 61]) {
    await assertRejects(
      () => tool.handler({ months }, makeCtx(makePlClient().client)),
      Error,
      "months",
    );
  }
});

// ── All tools have required fields ──────────────────────────────────────────

Deno.test("all analytics tools have name, description, category, handler", () => {
  for (const tool of analyticsTools) {
    assert(tool.name, `Tool should have name`);
    assert(tool.description, `${tool.name} should have description`);
    assert(
      tool.category === "analytics",
      `${tool.name} should have category "analytics"`,
    );
    assert(
      typeof tool.handler === "function",
      `${tool.name} should have handler function`,
    );
    assert(tool.inputSchema, `${tool.name} should have inputSchema`);
  }
});

Deno.test("all analytics tools have _meta with resourceUri", () => {
  for (const tool of analyticsTools) {
    const meta = (tool as any)._meta;
    assert(meta, `${tool.name} should have _meta`);
    assert(meta.ui, `${tool.name} should have _meta.ui`);
    assert(
      meta.ui.resourceUri,
      `${tool.name} should have _meta.ui.resourceUri`,
    );
    assert(
      meta.ui.resourceUri.startsWith("ui://hvgerp-mcp/"),
      `${tool.name} resourceUri should start with ui://hvgerp-mcp/`,
    );
  }
});
