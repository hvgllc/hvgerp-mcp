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
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

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

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = analyticsTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function assertChartMeta(result: any, viewerName = "chart-viewer") {
  assert(result._meta, "Result should have _meta");
  assertEquals(result._meta.ui.resourceUri, `ui://hvgerp-mcp/${viewerName}`);
}

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
        item_code: "ITEM-A",
        warehouse: "W1",
        actual_qty: 50,
        stock_value: 5000,
      },
      {
        item_code: "ITEM-B",
        warehouse: "W1",
        actual_qty: 30,
        stock_value: 3000,
      },
      {
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
  const mockClient = makeMockClient({
    list: async () => [
      { name: "SINV-001", status: "Paid", grand_total: 5000 },
      { name: "SINV-002", status: "Paid", grand_total: 3000 },
      { name: "SINV-003", status: "Unpaid", grand_total: 2000 },
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
  const mockClient = makeMockClient({
    list: async () => [
      { customer: "C1", customer_name: "Customer One", grand_total: 5000 },
      { customer: "C2", customer_name: "Customer Two", grand_total: 3000 },
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
  const mockClient = makeMockClient({
    list: async () => [
      {
        customer_name: "Acme",
        grand_total: 5000,
        transaction_date: relativeMonth(0, 10),
      },
      {
        customer_name: "Acme",
        grand_total: 3000,
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
  const mockClient = makeMockClient({
    list: async () => [
      {
        customer_name: "Acme",
        grand_total: 5000,
        transaction_date: relativeMonth(0, 10),
      },
      {
        customer_name: "Globex",
        grand_total: 3000,
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
  const mockClient = makeMockClient({
    list: async () => [
      { customer_name: "Acme", status: "Draft", grand_total: 1000 },
      {
        customer_name: "Acme",
        status: "To Deliver and Bill",
        grand_total: 2000,
      },
      { customer_name: "Globex", status: "Draft", grand_total: 500 },
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
  const mockClient = makeMockClient({
    list: async () => [
      { customer_name: "Acme", status: "Draft", grand_total: 3000 },
      { customer_name: "Globex", status: "Draft", grand_total: 1000 },
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
  const mockClient = makeMockClient({
    list: async () => [
      { customer_name: "Acme", grand_total: 5000 },
      { customer_name: "Acme", grand_total: 3000 },
      { customer_name: "Globex", grand_total: 2000 },
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
  const mockClient = makeMockClient({
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
  const mockClient = makeMockClient({
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
  const mockClient = makeMockClient({
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
  const mockClient = makeMockClient({
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
  const mockClient = makeMockClient({
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

  const mockClient = makeMockClient({
    list: async () => [
      { grand_total: 5000, transaction_date: thisMonth },
      { grand_total: 3000, transaction_date: lastMonth },
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
  const mockClient = makeMockClient({
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
    list: async () => [{ grand_total: 1000 }, { grand_total: 2000 }],
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
  const mockClient = makeMockClient({
    list: async (doctype: string) => {
      callIdx++;
      if (doctype === "Sales Order Item") {
        return [
          { item_code: "ITEM-A", qty: 10, amount: 5000 },
          { item_code: "ITEM-B", qty: 5, amount: 2500 },
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
  const mockClient = makeMockClient({
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
  const mockClient = makeMockClient({
    list: async (doctype: string) => {
      if (doctype === "Lead") {
        return [{ name: "L1" }, { name: "L2" }, { name: "L3" }, { name: "L4" }];
      }
      if (doctype === "Opportunity") {
        return [{ name: "O1", opportunity_amount: 5000 }, {
          name: "O2",
          opportunity_amount: 3000,
        }];
      }
      if (doctype === "Quotation") return [{ name: "Q1", grand_total: 4000 }];
      if (doctype === "Sales Order") {
        return [{ name: "SO1", grand_total: 3500 }];
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

  const mockClient = makeMockClient({
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
  const mockClient = makeMockClient({
    list: async (doctype: string) => {
      if (doctype === "Sales Invoice Item") {
        return [
          { item_code: "ITEM-A", qty: 10, amount: 5000, parent: "SINV-001" },
          { item_code: "ITEM-B", qty: 5, amount: 2500, parent: "SINV-001" },
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
