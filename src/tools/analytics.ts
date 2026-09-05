/**
 * ERPNext Analytics Tools
 *
 * Tools that return shaped data for chart/funnel viewers.
 * - erpnext_stock_chart        → Bar chart of stock levels by item
 * - erpnext_sales_chart        → Bar/donut chart of sales by customer or item
 * - erpnext_ar_aging           → Stacked bar of AR aging buckets by customer
 * - erpnext_gross_profit       → Composed chart: revenue bars + margin % line
 * - erpnext_profit_loss        → P&L from the general ledger: income vs expenses per month
 *
 * @module lib/erpnext/tools/analytics
 */

import type { FrappeFilter } from "../api/types.ts";
import { normalizeLimit } from "../api/frappe-client.ts";
import type { ErpNextTool } from "./types.ts";
import {
  cellNumber,
  periodColumns,
  receivableInvoiceRows,
  runQueryReport,
} from "./query-report.ts";
import { siteToday } from "./site-date.ts";
import {
  analyticsNumber,
  companyAnalyticsTool,
  listAnalyticsItemUnits,
  resolveReportCompany,
} from "./analytics-context.ts";
import { CHART_META, FUNNEL_META, KPI_META } from "./viewer-meta.ts";

/**
 * Upper bound on the item codes `erpnext_product_radar` will compare.
 *
 * Two reasons, and the readability one is the binding constraint: a radar chart
 * with more than eight series is unreadable, and each item costs one Bin query.
 *
 * Enforced twice, and both are load-bearing. `maxItems` in the tool's
 * `inputSchema` covers the MCP path, where the framework validates before the
 * handler runs. But `ErpNextToolsClient.execute()` (`client.ts:167`) is an
 * exported API that calls handlers directly, with no validator in between — so
 * the schema alone leaves that path unbounded, and the handler checks too.
 */
const MAX_RADAR_ITEMS = 8;

/**
 * Trần số tháng của `erpnext_profit_loss`.
 *
 * Mỗi tháng là một cột trong báo cáo, nên số tháng lớn không làm hỏng gì nhưng làm bảng
 * rộng đến mức vô nghĩa với một biểu đồ. Năm năm là đủ cho mọi câu hỏi xu hướng.
 */
const MAX_PL_MONTHS = 60;

/** Ngày dạng YYYY-MM-DD của một mốc dựng bằng `Date.UTC`. */
function utcDateString(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export const analyticsTools: ErpNextTool[] = [
  // ── Stock Chart ───────────────────────────────────────────────────────────

  {
    name: "erpnext_stock_chart",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Get stock levels as a bar chart. Shows actual_qty per item (optionally filtered by warehouse). " +
      "Groups items and returns chart-ready data. " +
      "Use type='horizontal-bar' for readability with many items.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        warehouse: { type: "string", description: "Filter by warehouse name" },
        item_group: { type: "string", description: "Filter by item group" },
        limit: {
          type: "number",
          minimum: 1,
          description: "Max items to show (default 20)",
        },
        type: {
          type: "string",
          enum: ["bar", "horizontal-bar"],
          description:
            "Chart type (default: horizontal-bar for many items, bar for few)",
        },
        min_qty: {
          type: "number",
          description:
            "Only show items with qty >= this value (filters out zeros)",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = normalizeLimit((input.limit as number) ?? 20);
      const filters: FrappeFilter[] = [[
        "actual_qty",
        ">",
        (input.min_qty as number) ?? 0,
      ]];

      if (input.warehouse) {
        filters.push(["warehouse", "=", input.warehouse as string]);
      }

      // Bin has no item_group field — resolve the group to its item codes and
      // filter in memory (the code set can exceed a sane "in" filter size).
      let allowedItems: Set<string> | null = null;
      if (input.item_group) {
        const groupItems = await ctx.client.list("Item", {
          fields: ["name"],
          filters: [["item_group", "=", input.item_group as string]],
          limit: 1000,
        });
        allowedItems = new Set(groupItems.map((i) => i.name as string));
      }

      const bins = await ctx.client.list("Bin", {
        fields: ["item_code", "warehouse", "actual_qty"],
        filters,
        // widen the fetch when filtering by group in memory, then slice below
        limit: allowedItems ? 1000 : limit,
        order_by: "actual_qty desc",
      });

      // Aggregate by item_code (sum across warehouses if no filter)
      const byItem: Record<string, { qty: number }> = {};
      for (const bin of bins) {
        const item = bin.item_code as string;
        if (allowedItems && !allowedItems.has(item)) continue;
        if (!byItem[item]) byItem[item] = { qty: 0 };
        byItem[item].qty += Number(bin.actual_qty) || 0;
      }

      const sorted = Object.entries(byItem)
        .sort(([, a], [, b]) => b.qty - a.qty)
        .slice(0, limit);

      const warehouseLabel = (input.warehouse as string) ?? "All Warehouses";
      const chartType = (input.type as string) ??
        (sorted.length > 6 ? "horizontal-bar" : "bar");

      return {
        title: "Stock Levels",
        subtitle: warehouseLabel,
        type: chartType,
        labels: sorted.map(([item]) => item),
        datasets: [
          {
            label: "Qty on Hand",
            values: sorted.map(([, { qty }]) => qty),
            color: "#60a5fa",
          },
        ],
        unit: "units",
        generatedAt: new Date().toISOString(),
        _meta: CHART_META,
      };
    },
  },

  // ── Sales Chart ───────────────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_sales_chart",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description: "Analyze sales revenue as a chart. " +
      "group_by='customer' → bar chart of top customers by revenue. " +
      "group_by='item' → bar chart of top items sold. " +
      "group_by='status' → donut chart of invoice status breakdown. " +
      "Reads from Sales Invoice (submitted only by default).",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["customer", "item", "status"],
          description: "Dimension to group by (default: customer)",
        },
        limit: {
          type: "number",
          minimum: 1,
          description: "Top N results (default 10)",
        },
        include_drafts: {
          type: "boolean",
          description: "Include Draft invoices (default false)",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      const limit = normalizeLimit((input.limit as number) ?? 10);
      const groupBy = (input.group_by as string) ?? "customer";
      const filters: FrappeFilter[] = [];

      if (!input.include_drafts) {
        filters.push(["docstatus", "=", 1]); // Submitted only
      }

      if (groupBy === "status") {
        // Get invoice counts + amounts by status — fetch more to cover all statuses
        const invoices = await context.listDocuments("Sales Invoice", {
          fields: ["name", "status", "base_grand_total"],
          filters: [["docstatus", "!=", 2]], // exclude cancelled
          limit: 500,
          order_by: "modified desc",
        });

        const byStatus: Record<string, number> = {};
        for (const inv of invoices) {
          const s = (inv.status as string) ?? "Unknown";
          byStatus[s] = (byStatus[s] ?? 0) +
            (analyticsNumber(inv, "base_grand_total"));
        }

        const sorted = Object.entries(byStatus).sort(([, a], [, b]) => b - a);

        return {
          title: "Invoice Revenue by Status",
          type: "donut",
          labels: sorted.map(([s]) => s),
          datasets: [{ label: "Revenue", values: sorted.map(([, v]) => v) }],
          currency,
          generatedAt: new Date().toISOString(),
          _meta: CHART_META,
        };
      }

      if (groupBy === "item") {
        // Fetch invoice items (Sales Invoice Item child table)
        const items = await context.listItems("Sales Invoice", {
          fields: ["item_code", "item_name", "base_amount"],
          filters: [["docstatus", "=", 1]],
          limit: 500,
          order_by: "base_amount desc",
        });

        const byItem: Record<string, { name: string; total: number }> = {};
        for (const row of items) {
          const code = (row.item_code as string) ?? "Unknown";
          if (!byItem[code]) {
            byItem[code] = {
              name: (row.item_name as string) ?? code,
              total: 0,
            };
          }
          byItem[code].total += analyticsNumber(row, "base_amount");
        }

        const sorted = Object.entries(byItem)
          .sort(([, a], [, b]) => b.total - a.total)
          .slice(0, limit);

        return {
          title: "Top Items by Revenue",
          subtitle: `Top ${sorted.length} items`,
          type: "horizontal-bar",
          labels: sorted.map(([, { name }]) => name),
          datasets: [{
            label: "Revenue",
            values: sorted.map(([, { total }]) => total),
            color: "#c084fc",
          }],
          currency,
          generatedAt: new Date().toISOString(),
          _meta: CHART_META,
        };
      }

      // Default: group by customer
      const invoices = await context.listDocuments("Sales Invoice", {
        fields: ["customer", "customer_name", "base_grand_total"],
        filters,
        limit: 500,
        order_by: "modified desc",
      });

      const byCustomer: Record<string, { name: string; total: number }> = {};
      for (const inv of invoices) {
        const code = (inv.customer as string) ?? "Unknown";
        if (!byCustomer[code]) {
          byCustomer[code] = {
            name: (inv.customer_name as string) ?? code,
            total: 0,
          };
        }
        byCustomer[code].total += analyticsNumber(inv, "base_grand_total");
      }

      const sorted = Object.entries(byCustomer)
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, limit);

      return {
        title: "Top Customers by Revenue",
        subtitle: `Top ${sorted.length} customers`,
        type: "horizontal-bar",
        labels: sorted.map(([, { name }]) => name),
        datasets: [{
          label: "Revenue",
          values: sorted.map(([, { total }]) => total),
          color: "#4ade80",
        }],
        currency,
        generatedAt: new Date().toISOString(),
        _meta: CHART_META,
      };
    },
  }),

  // ── Revenue Trend (line / area) ─────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_revenue_trend",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Sales revenue trend over time. Returns a line chart (or area if type='area') " +
      "with monthly revenue from Sales Orders. " +
      "Add group_by='customer' for multi-line per customer. " +
      "Use type='stacked-area' to stack customers.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        months: {
          type: "number",
          description: "How many months back to include (default 6)",
        },
        type: {
          type: "string",
          enum: ["line", "area", "stacked-area"],
          description: "Chart type (default: line)",
        },
        group_by: {
          type: "string",
          enum: ["total", "customer"],
          description: "Group by total or per customer (default: total)",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      const monthsBack = (input.months as number) ?? 6;
      const chartType = (input.type as string) ?? "line";
      const groupBy = (input.group_by as string) ?? "total";

      // Build date range
      const now = new Date();
      const startDate = new Date(
        now.getFullYear(),
        now.getMonth() - monthsBack + 1,
        1,
      );
      const startStr = startDate.toISOString().split("T")[0];

      const orders = await context.listDocuments("Sales Order", {
        fields: ["customer_name", "base_grand_total", "transaction_date"],
        filters: [["transaction_date", ">=", startStr], ["docstatus", "!=", 2]],
        limit: 1000,
        order_by: "transaction_date asc",
      });

      // Build month labels
      const months: string[] = [];
      for (let m = 0; m < monthsBack; m++) {
        const d = new Date(
          now.getFullYear(),
          now.getMonth() - monthsBack + 1 + m,
          1,
        );
        months.push(
          `${d.toLocaleString("en", { month: "short" })} ${
            d.getFullYear().toString().slice(2)
          }`,
        );
      }

      if (groupBy === "customer") {
        // Multi-line: one dataset per customer
        const byCustomerMonth: Record<string, number[]> = {};
        for (const order of orders) {
          const d = new Date(order.transaction_date as string);
          const mIdx = (d.getFullYear() - startDate.getFullYear()) * 12 +
            d.getMonth() - startDate.getMonth();
          if (mIdx < 0 || mIdx >= monthsBack) continue;
          const cust = (order.customer_name as string) ?? "Unknown";
          if (!byCustomerMonth[cust]) {
            byCustomerMonth[cust] = new Array(monthsBack).fill(0);
          }
          byCustomerMonth[cust][mIdx] += analyticsNumber(
            order,
            "base_grand_total",
          );
        }

        // Top 5 customers by total
        const sorted = Object.entries(byCustomerMonth)
          .sort(([, a], [, b]) =>
            b.reduce((s, v) => s + v, 0) - a.reduce((s, v) => s + v, 0)
          )
          .slice(0, 5);

        const COLORS = ["#60a5fa", "#4ade80", "#fbbf24", "#c084fc", "#f472b6"];
        return {
          title: "Revenue by Customer",
          subtitle: `Last ${monthsBack} months`,
          type: chartType,
          labels: months,
          datasets: sorted.map(([name, values], i) => ({
            label: name,
            values,
            color: COLORS[i % COLORS.length],
            showDots: chartType === "line",
            ...(chartType === "stacked-area" ? { stack: "revenue" } : {}),
          })),
          currency,
          yAxisLabel: "Revenue",
          _meta: CHART_META,
        };
      }

      // Single line: total revenue per month
      const monthlyTotals = new Array(monthsBack).fill(0);
      for (const order of orders) {
        const d = new Date(order.transaction_date as string);
        const mIdx = (d.getFullYear() - startDate.getFullYear()) * 12 +
          d.getMonth() - startDate.getMonth();
        if (mIdx >= 0 && mIdx < monthsBack) {
          monthlyTotals[mIdx] += analyticsNumber(order, "base_grand_total");
        }
      }

      return {
        title: "Revenue Trend",
        subtitle: `Last ${monthsBack} months`,
        type: chartType,
        labels: months,
        datasets: [{
          label: "Revenue",
          values: monthlyTotals,
          color: "#60a5fa",
          showDots: true,
        }],
        currency,
        yAxisLabel: "Revenue",
        _meta: CHART_META,
      };
    },
  }),

  // ── Order Breakdown (stacked bar / pie) ─────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_order_breakdown",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Breakdown of Sales Orders by customer (stacked-bar by status) or as a pie chart of totals. " +
      "type='stacked-bar' → orders stacked by status per customer. " +
      "type='pie' → total order value per customer as pie. " +
      "type='donut' → same as pie but with donut hole.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["stacked-bar", "pie", "donut"],
          description: "Chart type (default: stacked-bar)",
        },
        limit: {
          type: "number",
          minimum: 1,
          description: "Top N customers (default 8)",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      const chartType = (input.type as string) ?? "stacked-bar";
      const limit = normalizeLimit((input.limit as number) ?? 8);

      const orders = await context.listDocuments("Sales Order", {
        fields: ["customer_name", "status", "base_grand_total"],
        filters: [["docstatus", "!=", 2]],
        limit: 500,
        order_by: "modified desc",
      });

      if (chartType === "pie" || chartType === "donut") {
        const byCustomer: Record<string, number> = {};
        for (const o of orders) {
          const c = (o.customer_name as string) ?? "Unknown";
          byCustomer[c] = (byCustomer[c] ?? 0) +
            (analyticsNumber(o, "base_grand_total"));
        }
        const sorted = Object.entries(byCustomer).sort(([, a], [, b]) => b - a)
          .slice(0, limit);

        return {
          title: "Orders by Customer",
          type: chartType,
          labels: sorted.map(([c]) => c),
          datasets: [{ label: "Total", values: sorted.map(([, v]) => v) }],
          currency,
          _meta: CHART_META,
        };
      }

      // Stacked bar: customers on X, stacked by status
      const STATUS_ORDER = [
        "Draft",
        "To Deliver and Bill",
        "To Bill",
        "Completed",
        "Cancelled",
      ];
      const STATUS_COLORS: Record<string, string> = {
        Draft: "#78716c",
        "To Deliver and Bill": "#60a5fa",
        "To Bill": "#c084fc",
        Completed: "#4ade80",
        Cancelled: "#f87171",
      };

      const byCustomerStatus: Record<string, Record<string, number>> = {};
      for (const o of orders) {
        const c = (o.customer_name as string) ?? "Unknown";
        const s = (o.status as string) ?? "Draft";
        if (!byCustomerStatus[c]) byCustomerStatus[c] = {};
        byCustomerStatus[c][s] = (byCustomerStatus[c][s] ?? 0) +
          (analyticsNumber(o, "base_grand_total"));
      }

      // Top N customers
      const customerTotals = Object.entries(byCustomerStatus)
        .map(([c, statuses]) => ({
          name: c,
          total: Object.values(statuses).reduce((s, v) => s + v, 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, limit);

      const customers = customerTotals.map((c) => c.name);
      const activeStatuses = STATUS_ORDER.filter((s) =>
        customers.some((c) => (byCustomerStatus[c]?.[s] ?? 0) > 0)
      );

      return {
        title: "Order Value by Customer & Status",
        type: "stacked-bar",
        labels: customers,
        datasets: activeStatuses.map((s) => ({
          label: s === "To Deliver and Bill" ? "To Deliver" : s,
          values: customers.map((c) => byCustomerStatus[c]?.[s] ?? 0),
          color: STATUS_COLORS[s] ?? "#94a3b8",
          stack: "status",
        })),
        currency,
        xAxisLabel: "Customer",
        yAxisLabel: "Order Value",
        _meta: CHART_META,
      };
    },
  }),

  // ── Revenue vs Orders Composed ──────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_revenue_vs_orders",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Composed chart (bar + line) showing revenue (bars, left axis) vs order count (line, right axis) " +
      "per customer. Demonstrates dual-axis composed chart.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Top N customers (default 8)",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      const limit = normalizeLimit((input.limit as number) ?? 8);
      const orders = await context.listDocuments("Sales Order", {
        fields: ["customer_name", "base_grand_total"],
        filters: [["docstatus", "!=", 2]],
        limit: 500,
        order_by: "modified desc",
      });

      const byCustomer: Record<string, { total: number; count: number }> = {};
      for (const o of orders) {
        const c = (o.customer_name as string) ?? "Unknown";
        if (!byCustomer[c]) byCustomer[c] = { total: 0, count: 0 };
        byCustomer[c].total += analyticsNumber(o, "base_grand_total");
        byCustomer[c].count += 1;
      }

      const sorted = Object.entries(byCustomer)
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, limit);

      return {
        title: "Revenue vs Order Count",
        subtitle: `Top ${sorted.length} customers`,
        type: "composed",
        labels: sorted.map(([c]) => c),
        datasets: [
          {
            label: "Revenue",
            values: sorted.map(([, { total }]) => total),
            color: "#60a5fa",
            type: "bar",
          },
          {
            label: "Orders",
            values: sorted.map(([, { count }]) => count),
            color: "#fbbf24",
            type: "line",
            yAxisId: "right",
            showDots: true,
          },
        ],
        showRightAxis: true,
        yAxisLabel: `Revenue (${currency})`,
        rightAxisLabel: "# Orders",
        currency,
        _meta: CHART_META,
      };
    },
  }),

  // ── Stock Value Treemap ─────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_stock_treemap",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Stock value as a treemap. Each rectangle represents an item, sized by stock value. " +
      "Use group_by='warehouse' to group by warehouse instead.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["item", "warehouse"],
          description: "Group by item or warehouse (default: item)",
        },
        limit: {
          type: "number",
          minimum: 1,
          description: "Top N entries (default 15)",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      const groupBy = (input.group_by as string) ?? "item";
      const limit = normalizeLimit((input.limit as number) ?? 15);

      const bins = await context.listBins({
        fields: ["item_code", "warehouse", "stock_value"],
        filters: [["stock_value", ">", 0]],
        limit: 500,
        order_by: "stock_value desc",
      });

      const grouped: Record<string, number> = {};
      for (const bin of bins) {
        const key = groupBy === "warehouse"
          ? (bin.warehouse as string)
          : (bin.item_code as string);
        grouped[key] = (grouped[key] ?? 0) +
          (analyticsNumber(bin, "stock_value"));
      }

      const sorted = Object.entries(grouped)
        .sort(([, a], [, b]) => b - a)
        .slice(0, limit);

      const COLORS = [
        "#60a5fa",
        "#4ade80",
        "#fbbf24",
        "#818cf8",
        "#c084fc",
        "#fb923c",
        "#34d399",
        "#f472b6",
        "#a78bfa",
        "#f97316",
        "#22d3ee",
        "#e879f9",
      ];

      return {
        title: `Stock Value by ${
          groupBy === "warehouse" ? "Warehouse" : "Item"
        }`,
        type: "treemap",
        labels: [],
        datasets: [],
        treeData: sorted.map(([name, value], i) => ({
          name: name.length > 20 ? name.slice(0, 18) + "…" : name,
          value: Math.round(value),
          color: COLORS[i % COLORS.length],
        })),
        currency,
        _meta: CHART_META,
      };
    },
  }),

  // ── Product Comparison Radar ────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_product_radar",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description: "Radar chart comparing items across multiple dimensions: " +
      "stock level, stock value, order frequency, and revenue. " +
      "Pass 2-8 item codes to compare, or none to auto-select top items.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string" },
          // No `minItems`: an empty array is the documented way to ask for
          // auto-selection, and the schema is enforced before the handler runs.
          // A lower bound here would reject that call as malformed.
          maxItems: MAX_RADAR_ITEMS,
          description:
            "2-8 item codes to compare. Leave empty for auto-select top items.",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      let itemCodes = (input.items as string[]) ?? [];

      // Not redundant with the schema's `maxItems`: this handler is also reached
      // through `ErpNextToolsClient.execute()`, which invokes handlers directly
      // and never validates. Without this, that path fans out to one Bin query
      // per item with no ceiling. Rejects before any round-trip.
      if (itemCodes.length > MAX_RADAR_ITEMS) {
        throw new Error(
          `erpnext_product_radar accepts at most ${MAX_RADAR_ITEMS} item codes, received ${itemCodes.length}. ` +
            `A radar chart with more series is unreadable — compare in batches of ${MAX_RADAR_ITEMS} or fewer.`,
        );
      }

      // Auto-select top items if not provided
      if (itemCodes.length === 0) {
        const topBins = await context.listBins({
          fields: ["item_code"],
          filters: [["actual_qty", ">", 0]],
          limit: 4,
          order_by: "stock_value desc",
        });
        itemCodes = topBins.map((b) => b.item_code as string);
      }

      if (itemCodes.length < 2) {
        return {
          title: "Product Comparison",
          type: "radar",
          labels: [],
          datasets: [],
          _meta: CHART_META,
        };
      }

      // Gather data for each item
      const dimensions = [
        "Stock Qty",
        `Stock Value (${currency})`,
        "Order Lines",
        `Revenue (${currency})`,
      ];
      const raw: Record<string, number[]> = {};

      // Stock data — one Bin query per item, issued together rather than in
      // sequence. A per-item query (rather than a single `in` filter) is
      // deliberate: `limit` then applies per item, so an item fragmented across
      // many warehouses cannot be truncated by a sibling item's rows.
      const binResults = await Promise.all(
        itemCodes.map((code) =>
          context.listBins({
            fields: ["actual_qty", "stock_value"],
            filters: [["item_code", "=", code]],
            limit: 100,
          })
        ),
      );

      itemCodes.forEach((code, i) => {
        const bins = binResults[i];
        const totalQty = bins.reduce(
          (s, b) => s + (Number(b.actual_qty) || 0),
          0,
        );
        const totalVal = bins.reduce(
          (s, b) => s + (analyticsNumber(b, "stock_value")),
          0,
        );
        raw[code] = [totalQty, totalVal, 0, 0];
      });

      // Order data — fetch all, filter in memory (the item set can exceed a sane "in" filter size)
      const soItems = await context.listItems("Sales Order", {
        fields: ["item_code", "qty", "base_amount"],
        filters: [["docstatus", "!=", 2]],
        limit: 500,
      });

      const itemSet = new Set(itemCodes);
      for (const row of soItems) {
        const code = row.item_code as string;
        if (itemSet.has(code) && raw[code]) {
          raw[code][2] += 1; // order lines
          raw[code][3] += analyticsNumber(row, "base_amount"); // revenue
        }
      }

      // Normalize to 0-100 scale per dimension
      const maxPerDim = dimensions.map((_, di) =>
        Math.max(1, ...itemCodes.map((c) => raw[c]?.[di] ?? 0))
      );

      const COLORS = ["#60a5fa", "#f472b6", "#4ade80", "#fbbf24"];
      return {
        title: "Product Comparison",
        subtitle: itemCodes.join(" vs "),
        type: "radar",
        labels: dimensions,
        datasets: itemCodes.map((code, i) => ({
          label: code,
          values: dimensions.map((_, di) =>
            Math.round(((raw[code]?.[di] ?? 0) / maxPerDim[di]) * 100)
          ),
          color: COLORS[i % COLORS.length],
        })),
        _meta: CHART_META,
      };
    },
  }),

  // ── Price vs Quantity Scatter ────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_price_vs_qty",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Scatter chart: item selling price (X) vs total qty ordered (Y). " +
      "Each point is an item. Colored by item group if available.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max items to show (default 30)",
        },
      },
    },
    handler: async (input, ctx, context) => {
      const { currency } = context;
      const limit = normalizeLimit((input.limit as number) ?? 30);

      // Get items with selling price
      const items = await ctx.client.list("Item Price", {
        fields: ["item_code", "price_list_rate", "currency", "uom"],
        filters: [["selling", "=", 1]],
        limit: 200,
        order_by: "modified desc",
      });

      const priceMap: Record<string, Record<string, unknown>> = {};
      for (const ip of items) {
        const code = ip.item_code as string;
        if (!Object.hasOwn(priceMap, code)) priceMap[code] = ip;
      }

      // Get order quantities
      const soItems = await context.listItems("Sales Order", {
        fields: ["item_code", "stock_qty"],
        filters: [["docstatus", "!=", 2]],
        limit: 500,
      });

      const qtyMap: Record<string, number> = {};
      for (const row of soItems) {
        const code = row.item_code as string;
        qtyMap[code] = (qtyMap[code] ?? 0) +
          (analyticsNumber(row, "stock_qty"));
      }

      // Combine: only items that have both price and orders
      const allItems = Object.keys(priceMap).filter((c) => qtyMap[c] != null);
      const limited = allItems.slice(0, limit);

      if (limited.length === 0) {
        // Fallback: use stock data
        const bins = await context.listBins({
          fields: ["item_code", "valuation_rate", "actual_qty"],
          filters: [["actual_qty", ">", 0], ["valuation_rate", ">", 0]],
          limit,
          order_by: "stock_value desc",
        });

        return {
          title: "Valuation Rate vs Stock Qty",
          type: "scatter",
          labels: [],
          datasets: [],
          scatterData: [{
            label: "Items",
            color: "#818cf8",
            points: bins.map((b) => ({
              x: Math.round(analyticsNumber(b, "valuation_rate")),
              y: Math.round(Number(b.actual_qty) || 0),
              label: b.item_code as string,
            })),
          }],
          xAxisLabel: `Valuation Rate (${currency}/stock unit)`,
          yAxisLabel: "Stock Qty",
          _meta: CHART_META,
        };
      }

      const itemDocs = await listAnalyticsItemUnits(ctx, limited);
      const stockUnits = new Map(
        itemDocs.map((item) => [item.name, item.stock_uom]),
      );
      for (const code of limited) {
        const price = priceMap[code];
        if (price.currency !== currency) {
          throw new Error(
            `Item Price for '${code}' has missing or unexpected currency; expected ${currency}. Historical conversion is unavailable.`,
          );
        }
        const stockUom = stockUnits.get(code);
        if (
          typeof stockUom !== "string" || stockUom === "" ||
          price.uom !== stockUom
        ) {
          throw new Error(
            `Item Price for '${code}' must use its verified stock UOM; conversion is unavailable.`,
          );
        }
      }

      return {
        title: "Price vs Quantity Ordered",
        type: "scatter",
        labels: [],
        datasets: [],
        scatterData: [{
          label: "Items",
          color: "#818cf8",
          points: limited.map((code) => ({
            x: Math.round(analyticsNumber(priceMap[code], "price_list_rate")),
            y: Math.round(qtyMap[code]),
            label: code,
          })),
        }],
        xAxisLabel: `Selling Price (${currency}/stock unit)`,
        yAxisLabel: "Total Stock Qty Ordered",
        _meta: CHART_META,
      };
    },
  }),

  // ── KPI: Revenue MTD ────────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_kpi_revenue",
    annotations: { readOnlyHint: true },
    _meta: KPI_META,
    description: "KPI card: total Sales Order revenue for the current month, " +
      "with delta % vs previous month and sparkline of last 6 months.",
    category: "analytics",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, _ctx, context) => {
      const { currency } = context;
      const now = new Date();
      // Single API call: fetch all orders from 6 months ago to today
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      const sinceStr = sixMonthsAgo.toISOString().split("T")[0];

      const allOrders = await context.listDocuments("Sales Order", {
        fields: ["base_grand_total", "transaction_date"],
        filters: [
          ["transaction_date", ">=", sinceStr],
          ["docstatus", "!=", 2],
        ],
        limit: 5000,
      });

      // Bucket into 6 monthly bins
      const sparkline: number[] = [0, 0, 0, 0, 0, 0];
      for (const o of allOrders) {
        const d = new Date(o.transaction_date as string);
        // Month index: 0 = oldest (5 months ago), 5 = current month
        const monthDiff = (now.getFullYear() - d.getFullYear()) * 12 +
          (now.getMonth() - d.getMonth());
        const idx = 5 - monthDiff;
        if (idx >= 0 && idx < 6) {
          sparkline[idx] += analyticsNumber(o, "base_grand_total");
        }
      }

      const currentTotal = sparkline[5];
      const prevTotal = sparkline[4];

      const delta = prevTotal > 0
        ? ((currentTotal - prevTotal) / prevTotal) * 100
        : 0;

      return {
        label: "Revenue MTD",
        value: currentTotal,
        currency,
        delta: Math.round(delta * 10) / 10,
        deltaLabel: "vs last month",
        trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
        trendIsGood: true,
        sparkline,
        color: "#60a5fa",
        _meta: KPI_META,
      };
    },
  }),

  // ── KPI: Outstanding Receivables ────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_kpi_outstanding",
    annotations: { readOnlyHint: true },
    _meta: KPI_META,
    description:
      "KPI card: total outstanding receivables from submitted Sales Invoices " +
      "with positive outstanding balance from Accounts Receivable in company currency. Shows count of open invoices.",
    category: "analytics",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx, context) => {
      const { currency } = context;
      const reportDate = await siteToday(ctx);
      const reportRows = await receivableInvoiceRows(
        ctx,
        context.company,
        currency,
        reportDate,
      );
      const invoices = reportRows;

      const total = invoices.reduce(
        (sum, inv) => sum + inv.outstanding_amount,
        0,
      );
      const count = new Set(invoices.map((row) => row.voucher_no)).size;

      return {
        label: "Outstanding Receivables",
        value: total,
        formattedValue: `${count} inv. / ${
          total.toLocaleString("en-US", { style: "currency", currency })
        }`,
        currency,
        trend: total > 0 ? "up" : "flat",
        trendIsGood: false,
        color: "#fbbf24",
        _meta: KPI_META,
      };
    },
  }),

  // ── KPI: Orders This Month ──────────────────────────────────────────────

  {
    name: "erpnext_kpi_orders",
    annotations: { readOnlyHint: true },
    _meta: KPI_META,
    description: "KPI card: count of Sales Orders created this month, " +
      "with delta % vs last month.",
    category: "analytics",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx) => {
      const now = new Date();
      const thisMonthStart = `${now.getFullYear()}-${
        String(now.getMonth() + 1).padStart(2, "0")
      }-01`;
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
      const lastMonthEndStr = lastMonthEnd.toISOString().split("T")[0];

      const currentOrders = await ctx.client.list("Sales Order", {
        fields: ["name"],
        filters: [
          ["transaction_date", ">=", thisMonthStart],
          ["docstatus", "!=", 2],
        ],
        limit: 1000,
      });
      const currentCount = currentOrders.length;

      const prevOrders = await ctx.client.list("Sales Order", {
        fields: ["name"],
        filters: [
          ["transaction_date", ">=", lastMonthStartStr],
          ["transaction_date", "<=", lastMonthEndStr],
          ["docstatus", "!=", 2],
        ],
        limit: 1000,
      });
      const prevCount = prevOrders.length;

      const delta = prevCount > 0
        ? ((currentCount - prevCount) / prevCount) * 100
        : 0;

      return {
        label: "Orders This Month",
        value: currentCount,
        formattedValue: `${currentCount} orders`,
        unit: "orders",
        delta: Math.round(delta * 10) / 10,
        deltaLabel: "vs last month",
        trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
        trendIsGood: true,
        color: "#4ade80",
        _meta: KPI_META,
      };
    },
  },

  // ── KPI: Gross Margin ──────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_kpi_gross_margin",
    annotations: { readOnlyHint: true },
    _meta: KPI_META,
    description:
      "KPI card: estimated gross margin % based on Sales Order revenue vs " +
      "valuation rate from stock (Bin). Margin = (revenue - cost) / revenue * 100.",
    category: "analytics",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, _ctx, context) => {
      // Revenue from Sales Order Items (all non-cancelled)
      const soItems = await context.listItems("Sales Order", {
        fields: ["item_code", "stock_qty", "base_amount"],
        filters: [
          ["docstatus", "!=", 2],
        ],
        limit: 1000,
      });

      const revenue = soItems.reduce(
        (sum, row) => sum + (analyticsNumber(row, "base_amount")),
        0,
      );

      // Giá vốn chỉ là ước tính hiện tại; valuation_rate có đơn vị trên stock UOM.
      const itemQty: Record<string, number> = {};
      for (const row of soItems) {
        const code = row.item_code as string;
        itemQty[code] = (itemQty[code] ?? 0) +
          (analyticsNumber(row, "stock_qty"));
      }

      // Fetch valuation rates
      const bins = await context.listBins({
        fields: ["item_code", "valuation_rate"],
        filters: [["valuation_rate", ">", 0]],
        limit: 500,
      });

      const valMap: Record<string, number> = {};
      for (const bin of bins) {
        const code = bin.item_code as string;
        if (!valMap[code]) {
          valMap[code] = analyticsNumber(bin, "valuation_rate");
        }
      }

      let cost = 0;
      for (const [code, qty] of Object.entries(itemQty)) {
        if (valMap[code] === undefined) {
          throw new Error(`Missing estimated stock cost for item '${code}'.`);
        }
        cost += valMap[code] * qty;
      }

      const margin = revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0;

      return {
        label: "Gross Margin",
        value: Math.round(margin * 10) / 10,
        unit: "%",
        trend: margin >= 30 ? "up" : margin >= 15 ? "flat" : "down",
        trendIsGood: true,
        color: "#c084fc",
        _meta: KPI_META,
      };
    },
  }),

  // ── KPI: Overdue Invoices ──────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_kpi_overdue",
    annotations: { readOnlyHint: true },
    _meta: KPI_META,
    description: "KPI card: count and total value of overdue Sales Invoices " +
      "(due_date < today, outstanding_amount > 0, submitted).",
    category: "analytics",
    inputSchema: { type: "object", properties: {} },
    handler: async (_input, ctx, context) => {
      const { currency } = context;
      const reportDate = await siteToday(ctx);
      const reportRows = await receivableInvoiceRows(
        ctx,
        context.company,
        currency,
        reportDate,
      );
      const invoices = reportRows.filter((row) => row.due_date < reportDate);

      const count = new Set(invoices.map((row) => row.voucher_no)).size;
      const total = invoices.reduce(
        (sum, inv) => sum + inv.outstanding_amount,
        0,
      );

      return {
        label: "Overdue Invoices",
        value: count,
        formattedValue: `${count} inv. / ${
          total.toLocaleString("en-US", { style: "currency", currency })
        }`,
        trend: count > 0 ? "up" : "flat",
        trendIsGood: false,
        color: "#f87171",
        _meta: KPI_META,
      };
    },
  }),

  // ── Sales Funnel ──────────────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_sales_funnel",
    annotations: { readOnlyHint: true },
    _meta: FUNNEL_META,
    description:
      "Sales funnel from Lead → Opportunity → Quotation → Sales Order. " +
      "Shows count and value at each stage with conversion rates between stages. " +
      "Opportunity, Quotation and Order are scoped to one company; Leads count all visible records.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["this_month", "this_quarter", "this_year", "all"],
          description: "Time period (default: all)",
        },
      },
    },
    handler: async (_input, ctx, context) => {
      const { currency } = context;
      const period = (_input.period as string) ?? "all";
      const now = new Date();
      let sinceDate: string | null = null;
      if (period === "this_month") {
        sinceDate = `${now.getFullYear()}-${
          String(now.getMonth() + 1).padStart(2, "0")
        }-01`;
      } else if (period === "this_quarter") {
        const qMonth = Math.floor(now.getMonth() / 3) * 3 + 1;
        sinceDate = `${now.getFullYear()}-${
          String(qMonth).padStart(2, "0")
        }-01`;
      } else if (period === "this_year") {
        sinceDate = `${now.getFullYear()}-01-01`;
      }

      // Leads use "creation", the rest use "transaction_date"
      const leadFilters: FrappeFilter[] = sinceDate
        ? [["creation", ">=", sinceDate]]
        : [];
      const txnFilters: FrappeFilter[] = sinceDate
        ? [["transaction_date", ">=", sinceDate]]
        : [];
      const submittedTxnFilters: FrappeFilter[] = [
        ...txnFilters,
        ["docstatus", "!=", 2],
      ];

      // The four funnel stages are independent queries — none feeds the next —
      // so they go out together. Awaiting them in sequence cost four round-trips
      // to Frappe for one tool call.
      const [leads, opps, quots, orders] = await Promise.all([
        ctx.client.list("Lead", {
          fields: ["name"],
          filters: leadFilters,
          limit: 500,
        }),
        context.listDocuments("Opportunity", {
          fields: ["name", "base_opportunity_amount"],
          filters: txnFilters,
          limit: 500,
        }),
        context.listDocuments("Quotation", {
          fields: ["name", "base_grand_total"],
          filters: submittedTxnFilters,
          limit: 500,
        }),
        context.listDocuments("Sales Order", {
          fields: ["name", "base_grand_total"],
          filters: submittedTxnFilters,
          limit: 500,
        }),
      ]);

      const stages = [
        {
          label: "Leads",
          count: leads.length,
          color: "#818cf8",
        },
        {
          label: "Opportunities",
          count: opps.length,
          value: opps.reduce(
            (s, o) => s + (analyticsNumber(o, "base_opportunity_amount")),
            0,
          ),
          color: "#60a5fa",
          conversionRate: leads.length > 0
            ? Math.round((opps.length / leads.length) * 100)
            : 0,
        },
        {
          label: "Quotations",
          count: quots.length,
          value: quots.reduce(
            (s, q) => s + (analyticsNumber(q, "base_grand_total")),
            0,
          ),
          color: "#4ade80",
          conversionRate: opps.length > 0
            ? Math.round((quots.length / opps.length) * 100)
            : 0,
        },
        {
          label: "Orders",
          count: orders.length,
          value: orders.reduce(
            (s, o) => s + (analyticsNumber(o, "base_grand_total")),
            0,
          ),
          color: "#fbbf24",
          conversionRate: quots.length > 0
            ? Math.round((orders.length / quots.length) * 100)
            : 0,
        },
      ];

      const periodLabels: Record<string, string> = {
        this_month: "This Month",
        this_quarter: "This Quarter",
        this_year: "This Year",
        all: "All Time",
      };

      return {
        title: "Sales Funnel",
        subtitle: `${
          periodLabels[period] ?? "All Time"
        }; ${context.company}; Leads: all visible companies`,
        stages,
        currency,
        _meta: FUNNEL_META,
      };
    },
  }),

  // ── AR Aging ──────────────────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_ar_aging",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Accounts Receivable Aging — stacked bar showing outstanding invoices by customer, " +
      "grouped into aging buckets (0-30, 31-60, 61-90, 90+ days). " +
      "Shows who owes you money and for how long.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Top N customers (default 10)",
        },
        type: {
          type: "string",
          enum: ["stacked-bar", "horizontal-bar", "treemap"],
          description: "Chart type (default: stacked-bar)",
        },
      },
    },
    handler: async (input, ctx, context) => {
      const { currency } = context;
      const limit = normalizeLimit((input.limit as number) ?? 10);
      const chartType = (input.type as string) ?? "stacked-bar";

      const reportDate = await siteToday(ctx);
      const reportRows = await receivableInvoiceRows(
        ctx,
        context.company,
        currency,
        reportDate,
      );
      const invoices = reportRows;

      const today = new Date(reportDate);
      const BUCKETS = [
        { label: "0-30 days", min: 0, max: 30, color: "#4ade80" },
        { label: "31-60 days", min: 31, max: 60, color: "#fbbf24" },
        { label: "61-90 days", min: 61, max: 90, color: "#fb923c" },
        { label: "90+ days", min: 91, max: 99999, color: "#f87171" },
      ];

      // Group by customer + aging bucket
      const byCustomer: Record<string, number[]> = {};
      for (const inv of invoices) {
        const customer = (inv.customer_name as string) ?? "Unknown";
        const dateStr = (inv.due_date as string) ??
          (inv.posting_date as string);
        const dueDate = dateStr ? new Date(dateStr) : today;
        const agingDays = Math.max(
          0,
          Math.floor((today.getTime() - dueDate.getTime()) / 86400000),
        );

        if (!byCustomer[customer]) {
          byCustomer[customer] = new Array(BUCKETS.length).fill(0);
        }

        const bucketIdx = BUCKETS.findIndex((b) =>
          agingDays >= b.min && agingDays <= b.max
        );
        if (bucketIdx >= 0) {
          byCustomer[customer][bucketIdx] += inv.outstanding_amount;
        }
      }

      // Sort by total outstanding, take top N
      const sorted = Object.entries(byCustomer)
        .map(([name, buckets]) => ({
          name,
          buckets,
          total: buckets.reduce((s, v) => s + v, 0),
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, limit);

      if (chartType === "treemap") {
        const COLORS = [
          "#60a5fa",
          "#4ade80",
          "#fbbf24",
          "#818cf8",
          "#c084fc",
          "#fb923c",
          "#34d399",
          "#f472b6",
          "#a78bfa",
          "#f97316",
        ];
        return {
          title: "Accounts Receivable by Customer",
          type: "treemap",
          labels: [],
          datasets: [],
          treeData: sorted.map(({ name, total }, i) => ({
            name: name.length > 20 ? name.slice(0, 18) + "..." : name,
            value: Math.round(total),
            color: COLORS[i % COLORS.length],
          })),
          currency,
          _meta: CHART_META,
        };
      }

      // stacked-bar or horizontal-bar
      const customers = sorted.map(({ name }) => name);
      return {
        title: "Accounts Receivable Aging",
        subtitle: `Top ${customers.length} customers`,
        type: chartType,
        labels: customers,
        datasets: BUCKETS.map((bucket, bi) => ({
          label: bucket.label,
          values: sorted.map(({ buckets }) => buckets[bi]),
          color: bucket.color,
          stack: "aging",
        })),
        currency,
        xAxisLabel: "Customer",
        yAxisLabel: "Outstanding Amount",
        _meta: CHART_META,
      };
    },
  }),

  // ── Gross Profit ──────────────────────────────────────────────────────────

  companyAnalyticsTool({
    name: "erpnext_gross_profit",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Gross profit analysis — composed chart showing revenue (bars) vs margin % (line) by item or customer. " +
      "Uses Sales Invoice Item for revenue and Bin valuation_rate for cost estimation.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Top N entries (default 10)",
        },
        group_by: {
          type: "string",
          enum: ["item", "customer"],
          description: "Group by item or customer (default: item)",
        },
      },
    },
    handler: async (input, _ctx, context) => {
      const { currency } = context;
      const limit = normalizeLimit((input.limit as number) ?? 10);
      const groupBy = (input.group_by as string) ?? "item";

      // Ba nhánh dữ liệu chạy song song; nhánh child và Bin tự xác minh company
      // qua chứng từ cha và Warehouse trước khi đọc các dòng tiền.
      const needsCustomers = groupBy === "customer";
      const [siItems, bins, invoices] = await Promise.all([
        // Submitted Sales Invoice Items for revenue
        context.listItems("Sales Invoice", {
          fields: [
            "parent",
            "item_code",
            "item_name",
            "base_amount",
            "stock_qty",
          ],
          filters: [["docstatus", "=", 1]],
          limit: 500,
          order_by: "base_amount desc",
        }),
        // Bin for valuation_rate (cost per unit)
        context.listBins({
          fields: ["item_code", "valuation_rate"],
          filters: [["valuation_rate", ">", 0]],
          limit: 500,
        }),
        // Invoices, to map parent invoice name to customer
        needsCustomers
          ? context.listDocuments("Sales Invoice", {
            fields: ["name", "customer_name"],
            filters: [["docstatus", "=", 1]],
            limit: 500,
          })
          : Promise.resolve([]),
      ]);

      const costMap: Record<string, number> = {};
      for (const bin of bins) {
        const code = bin.item_code as string;
        // Keep highest valuation_rate if multiple warehouses
        costMap[code] = Math.max(
          costMap[code] ?? 0,
          analyticsNumber(bin, "valuation_rate"),
        );
      }

      if (needsCustomers) {
        const custMap: Record<string, string> = {};
        for (const inv of invoices) {
          custMap[inv.name as string] = (inv.customer_name as string) ??
            "Unknown";
        }

        const byCustomer: Record<string, { revenue: number; cost: number }> =
          {};
        for (const row of siItems) {
          const customer = custMap[row.parent as string] ?? "Unknown";
          if (!byCustomer[customer]) {
            byCustomer[customer] = { revenue: 0, cost: 0 };
          }
          const qty = analyticsNumber(row, "stock_qty");
          const unitCost = costMap[row.item_code as string];
          if (unitCost === undefined) {
            throw new Error(
              `Missing estimated stock cost for item '${row.item_code}'.`,
            );
          }
          byCustomer[customer].revenue += analyticsNumber(row, "base_amount");
          byCustomer[customer].cost += qty * unitCost;
        }

        const sorted = Object.entries(byCustomer)
          .sort(([, a], [, b]) => b.revenue - a.revenue)
          .slice(0, limit);

        const labels = sorted.map(([name]) => name);
        const revenues = sorted.map(([, { revenue }]) => Math.round(revenue));
        const margins = sorted.map(([, { revenue, cost }]) =>
          revenue > 0
            ? Math.round(((revenue - cost) / revenue) * 10000) / 100
            : 0
        );

        return {
          title: "Gross Profit by Customer",
          subtitle:
            `Top ${labels.length} customers; estimated cost from current stock valuation`,
          type: "composed",
          labels,
          datasets: [
            {
              label: "Revenue",
              values: revenues,
              color: "#60a5fa",
              type: "bar" as const,
            },
            {
              label: "Margin %",
              values: margins,
              color: "#4ade80",
              type: "line" as const,
              yAxisId: "right" as const,
              showDots: true,
            },
          ],
          showRightAxis: true,
          currency,
          yAxisLabel: "Revenue",
          rightAxisLabel: "Margin %",
          _meta: CHART_META,
        };
      }

      // Default: group by item
      const byItem: Record<
        string,
        { name: string; revenue: number; cost: number }
      > = {};
      for (const row of siItems) {
        const code = (row.item_code as string) ?? "Unknown";
        if (!byItem[code]) {
          byItem[code] = {
            name: (row.item_name as string) ?? code,
            revenue: 0,
            cost: 0,
          };
        }
        const qty = analyticsNumber(row, "stock_qty");
        const unitCost = costMap[code];
        if (unitCost === undefined) {
          throw new Error(`Missing estimated stock cost for item '${code}'.`);
        }
        byItem[code].revenue += analyticsNumber(row, "base_amount");
        byItem[code].cost += qty * unitCost;
      }

      const sorted = Object.entries(byItem)
        .sort(([, a], [, b]) => b.revenue - a.revenue)
        .slice(0, limit);

      const labels = sorted.map(([, { name }]) => name);
      const revenues = sorted.map(([, { revenue }]) => Math.round(revenue));
      const margins = sorted.map(([, { revenue, cost }]) =>
        revenue > 0 ? Math.round(((revenue - cost) / revenue) * 10000) / 100 : 0
      );

      return {
        title: "Gross Profit by Item",
        subtitle:
          `Top ${labels.length} items; estimated cost from current stock valuation`,
        type: "composed",
        labels,
        datasets: [
          {
            label: "Revenue",
            values: revenues,
            color: "#60a5fa",
            type: "bar" as const,
          },
          {
            label: "Margin %",
            values: margins,
            color: "#4ade80",
            type: "line" as const,
            yAxisId: "right" as const,
            showDots: true,
          },
        ],
        showRightAxis: true,
        currency,
        yAxisLabel: "Revenue",
        rightAxisLabel: "Margin %",
        _meta: CHART_META,
      };
    },
  }),

  // ── Profit & Loss ─────────────────────────────────────────────────────────

  {
    name: "erpnext_profit_loss",
    annotations: { readOnlyHint: true },
    _meta: CHART_META,
    description:
      "Profit & Loss per month, read from the general ledger through ERPNext's own " +
      "'Profit and Loss Statement' report: income bars, expense bars and a net profit line. " +
      "Numbers match what the ERPNext P&L screen shows for the same company and period, " +
      "because they come from the same report, not from a hand-rolled sum of orders. " +
      "Requires 'company' when the site has more than one. Use type='composed' for bars+line.",
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        months: {
          type: "number",
          minimum: 1,
          maximum: MAX_PL_MONTHS,
          description:
            `How many months back, ending with the current month (default 6, max ${MAX_PL_MONTHS})`,
        },
        company: {
          type: "string",
          description:
            "Which company to report on. Optional only when the site has exactly one company.",
        },
        type: {
          type: "string",
          enum: ["bar", "stacked-bar", "composed"],
          description: "Chart type (default: composed)",
        },
      },
    },
    handler: async (input, ctx) => {
      const monthsBack = (input.months as number) ?? 6;
      if (!Number.isInteger(monthsBack) || monthsBack < 1) {
        throw new Error(
          `[erpnext_profit_loss] 'months' must be a whole number of at least 1, got ${
            JSON.stringify(input.months)
          }`,
        );
      }
      if (monthsBack > MAX_PL_MONTHS) {
        throw new Error(
          `[erpnext_profit_loss] 'months' is capped at ${MAX_PL_MONTHS}, got ${monthsBack}`,
        );
      }
      const chartType = (input.type as string) ?? "composed";

      const company = await resolveReportCompany(ctx, input);

      // Cửa sổ báo cáo tính từ "hôm nay" theo múi giờ site, và mọi phép cộng tháng làm bằng
      // `Date.UTC`. Bản cũ dựng `new Date(y, m, 1)` theo giờ máy rồi gọi `toISOString()`:
      // ở UTC+7 chuỗi ra lùi một ngày, nên ngày mồng một thành ngày cuối tháng trước và cả
      // cửa sổ trượt đi một tháng.
      const today = await siteToday(ctx);
      const [todayYear, todayMonth] = today.split("-").map(Number);
      if (!Number.isInteger(todayYear) || !Number.isInteger(todayMonth)) {
        throw new Error(
          `[erpnext_profit_loss] could not read today's date from the site (got '${today}')`,
        );
      }
      const periodStart = utcDateString(
        new Date(Date.UTC(todayYear, todayMonth - monthsBack, 1)),
      );
      // Ngày 0 của tháng kế tiếp chính là ngày cuối tháng hiện tại, kể cả tháng 2 năm nhuận.
      const periodEnd = utcDateString(
        new Date(Date.UTC(todayYear, todayMonth, 0)),
      );

      const report = await runQueryReport(
        ctx,
        "Profit and Loss Statement",
        {
          company,
          filter_based_on: "Date Range",
          period_start_date: periodStart,
          period_end_date: periodEnd,
          periodicity: "Monthly",
          // Cộng dồn tắt: mỗi cột phải là riêng tháng đó, nếu không biểu đồ vẽ ra một đường
          // chỉ đi lên và mọi tháng đều "lãi hơn" tháng trước.
          accumulated_values: 0,
        },
      );

      const periods = periodColumns(report);
      if (periods.length === 0) {
        throw new Error(
          "[erpnext_profit_loss] the Profit and Loss Statement returned no period columns for " +
            `${company} between ${periodStart} and ${periodEnd}. Check that the company has a ` +
            "fiscal year covering that range.",
        );
      }

      // Dòng gốc của cây tài khoản: `indent` là số (dòng tổng tổng hợp và dòng trống mà báo
      // cáo chèn vào giữa không có `indent`), và không có cha. Cộng đúng những dòng này là
      // cộng đúng một lần: mọi dòng con đã nằm trong tổng của gốc rồi.
      const rootRows = report.result.filter((row) =>
        row !== null && typeof row === "object" &&
        cellNumber(row.indent) !== null && !row.parent_account
      );
      const rootAccounts = rootRows
        .map((row) => row.account)
        .filter((name): name is string =>
          typeof name === "string" && name !== ""
        );
      if (rootAccounts.length !== rootRows.length) {
        throw new Error(
          "[erpnext_profit_loss] the Profit and Loss Statement returned a top-level row with no " +
            "account name, so its amounts cannot be classified as income or expense.",
        );
      }

      // Dòng báo cáo không mang `root_type`, nên phải hỏi lại chính bảng Account. Không suy ra
      // từ nhãn: nhãn đã qua `_()` nên trên site tiếng Việt "Income" hiện thành "Thu nhập".
      const rootTypeByAccount = new Map<string, string>();
      if (rootAccounts.length > 0) {
        const accounts = await ctx.client.list("Account", {
          fields: ["name", "root_type"],
          filters: [["name", "in", rootAccounts]],
          limit: rootAccounts.length,
        });
        for (const account of accounts) {
          if (
            typeof account.name === "string" &&
            typeof account.root_type === "string"
          ) {
            rootTypeByAccount.set(account.name, account.root_type);
          }
        }
      }

      const income = new Array<number>(periods.length).fill(0);
      const expenses = new Array<number>(periods.length).fill(0);

      for (const row of rootRows) {
        const account = row.account as string;
        const rootType = rootTypeByAccount.get(account);
        if (rootType !== "Income" && rootType !== "Expense") {
          throw new Error(
            `[erpnext_profit_loss] top-level report row '${account}' has root_type ${
              rootType === undefined ? "unknown" : `'${rootType}'`
            }, so it cannot be counted as income or expense. Refusing to report a total that ` +
              "silently drops it.",
          );
        }
        const bucket = rootType === "Income" ? income : expenses;
        periods.forEach((period, index) => {
          const raw = row[period.fieldname];
          if (raw === undefined || raw === null || raw === "") return;
          const amount = cellNumber(raw);
          if (amount === null) {
            throw new Error(
              `[erpnext_profit_loss] report cell ${account} / ${period.fieldname} is ${
                JSON.stringify(raw)
              }, which is not an amount.`,
            );
          }
          bucket[index] += amount;
        });
      }

      // Đối chiếu ngay trong cùng một phản hồi: `report_summary` do ERPNext tự tính từ dòng
      // tổng của chính báo cáo này, nên nếu cách cộng ở trên đọc sai cấu trúc cây thì hai
      // con số lệch nhau. Sai lệch thì ném lỗi chứ không vẽ biểu đồ, vì một biểu đồ lãi lỗ
      // sai không tự khai là sai.
      const crossCheck = verifyAgainstSummary(report.report_summary, {
        income: income.reduce((sum, value) => sum + value, 0),
        expenses: expenses.reduce((sum, value) => sum + value, 0),
      });

      const currency = reportCurrency(report.report_summary, rootRows);
      const round = (value: number) => Math.round(value * 100) / 100;
      const netProfit = income.map((value, index) =>
        round(value - expenses[index])
      );

      // deno-lint-ignore no-explicit-any
      const datasets: any[] = [
        {
          label: "Income",
          values: income.map(round),
          color: "#4ade80",
          type: "bar",
        },
        {
          label: "Expenses",
          values: expenses.map(round),
          color: "#f87171",
          type: "bar",
        },
      ];

      if (chartType === "composed") {
        datasets.push({
          label: "Net Profit",
          values: netProfit,
          color: "#60a5fa",
          type: "line",
          yAxisId: "right",
          showDots: true,
        });
      }

      return {
        title: "Profit & Loss",
        subtitle:
          `${company}, last ${monthsBack} months (${periodStart} to ${periodEnd})`,
        type: chartType,
        labels: periods.map((period) => period.label),
        datasets,
        ...(chartType === "composed"
          ? { showRightAxis: true, rightAxisLabel: "Net Profit" }
          : {}),
        ...(currency ? { currency } : {}),
        yAxisLabel: "Amount",
        source: {
          report: "Profit and Loss Statement",
          company,
          period_start_date: periodStart,
          period_end_date: periodEnd,
          periodicity: "Monthly",
          cross_check: crossCheck,
        },
        refreshRequest: {
          toolName: "erpnext_profit_loss",
          arguments: { ...input, company },
        },
        _meta: CHART_META,
      };
    },
  },
];

/**
 * Sai số cho phép khi so tổng tự cộng với tổng của ERPNext.
 *
 * Một xu cho phần làm tròn tiền tệ, cộng thêm một phần tương đối cho sai số dấu phẩy động:
 * cộng gần bảy trăm triệu bằng `double` theo hai thứ tự khác nhau ra hai kết quả lệch nhau
 * ở hàng cuối, và đó không phải lỗi số liệu.
 */
function amountTolerance(expected: number): number {
  return 0.01 + Math.abs(expected) * 1e-12;
}

/**
 * So tổng thu và tổng chi tự cộng với dải tóm tắt của chính báo cáo.
 *
 * `report_summary` có thứ tự cố định trong `financial_statements.py`: [0] tổng thu, [1] tổng
 * chi, [2] lãi lỗ ròng. Nhãn thì đã qua `_()` nên không dùng để nhận diện được.
 */
function verifyAgainstSummary(
  summary: { value?: unknown }[] | undefined,
  derived: { income: number; expenses: number },
): Record<string, unknown> {
  const expectedIncome = summary && summary.length > 1
    ? cellNumber(summary[0]?.value)
    : null;
  const expectedExpenses = summary && summary.length > 1
    ? cellNumber(summary[1]?.value)
    : null;

  if (expectedIncome === null || expectedExpenses === null) {
    return {
      status: "unavailable",
      detail:
        "the report returned no usable summary row, so the totals below could not be checked " +
        "against ERPNext's own figures",
      derived_income: derived.income,
      derived_expenses: derived.expenses,
    };
  }

  const incomeGap = Math.abs(derived.income - expectedIncome);
  const expenseGap = Math.abs(derived.expenses - expectedExpenses);
  if (
    incomeGap > amountTolerance(expectedIncome) ||
    expenseGap > amountTolerance(expectedExpenses)
  ) {
    throw new Error(
      "[erpnext_profit_loss] the per-month totals do not add up to what the report itself " +
        `reports: income ${derived.income} vs ${expectedIncome}, expenses ${derived.expenses} ` +
        `vs ${expectedExpenses}. Refusing to return a P&L chart that disagrees with ERPNext.`,
    );
  }

  return {
    status: "verified",
    detail:
      "per-month totals match the report's own income and expense summary to the cent",
    income: expectedIncome,
    expenses: expectedExpenses,
  };
}

/** Đồng tiền của báo cáo: ưu tiên dải tóm tắt, sau đó cột `currency` của dòng tài khoản. */
function reportCurrency(
  summary: { currency?: unknown }[] | undefined,
  rows: Record<string, unknown>[],
): string | undefined {
  for (const entry of summary ?? []) {
    if (typeof entry?.currency === "string" && entry.currency !== "") {
      return entry.currency;
    }
  }
  for (const row of rows) {
    if (typeof row.currency === "string" && row.currency !== "") {
      return row.currency;
    }
  }
  return undefined;
}
