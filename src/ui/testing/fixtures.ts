import { UI_VIEWERS } from "../viewers.ts";
import type { DoclistData } from "../doclist-viewer/src/types.ts";
import type { KanbanBoardData } from "../shared/kanban/types.ts";

export { UI_VIEWERS };
export type Viewer = typeof UI_VIEWERS[number];
export const SCENARIOS = [
  "smoke",
  "csv",
  "detail-race",
  "board-race",
  "initial-error",
  "refresh-error",
] as const;
export type Scenario = typeof SCENARIOS[number];
export const GENERATED_AT = "2026-09-05T00:00:00.000Z";

export const TOOL_NAMES: Record<Viewer, string> = {
  "invoice-viewer": "erpnext_sales_invoice_get",
  "stock-viewer": "erpnext_stock_balance",
  "doclist-viewer": "erpnext_customer_list",
  "chart-viewer": "erpnext_sales_chart",
  "kpi-viewer": "erpnext_kpi_revenue",
  "funnel-viewer": "erpnext_sales_funnel",
  "kanban-viewer": "erpnext_kanban_get_board",
};

export function boardFixture(identity: "A" | "B" = "A"): KanbanBoardData {
  return {
    boardId: "task-board",
    title: `Local board ${identity}`,
    doctype: "Task",
    generatedAt: GENERATED_AT,
    moveToolName: "erpnext_kanban_move_card",
    refreshArguments: { doctype: "Task", project: `PROJECT-${identity}` },
    columns: [
      { id: "Open", label: "Open", color: "#2563eb", count: 2 },
      { id: "Working", label: "Working", color: "#d97706", count: 0 },
      { id: "Completed", label: "Completed", color: "#15803d", count: 0 },
    ],
    cards: [
      {
        id: `TASK-${identity}-1`,
        title: `Task ${identity} one`,
        columnId: "Open",
        accent: "#2563eb",
      },
      {
        id: `TASK-${identity}-2`,
        title: `Task ${identity} two`,
        columnId: "Open",
        accent: "#2563eb",
      },
    ],
    allowedTransitions: [
      {
        fromColumn: "Open",
        toColumn: "Working",
        allowed: true,
        label: "Start",
      },
      {
        fromColumn: "Working",
        toColumn: "Completed",
        allowed: true,
        label: "Complete",
      },
    ],
    capabilities: { canMoveCards: true },
    pagination: {
      limit: 20,
      offset: 0,
      loadedCount: 2,
      hasMore: false,
      total: 2,
    },
  };
}

export function toolArguments(viewer: Viewer): Record<string, unknown> {
  if (viewer === "kanban-viewer") return boardFixture().refreshArguments;
  if (viewer === "invoice-viewer") return { name: "INV-LOCAL-001" };
  return {};
}

export function viewerFixture(
  viewer: Viewer,
  chartType: "bar" | "horizontal-bar" | "pie" | "donut" = "bar",
): object {
  const refreshRequest = {
    toolName: TOOL_NAMES[viewer],
    arguments: toolArguments(viewer),
  };
  switch (viewer) {
    case "invoice-viewer":
      return {
        refreshRequest,
        data: {
          name: "INV-LOCAL-001",
          customer: "CUSTOMER-LOCAL",
          customer_name: "Local Customer",
          posting_date: "2026-09-05",
          status: "Draft",
          docstatus: 0,
          currency: "USD",
          grand_total: 30,
          net_total: 30,
          items: [{
            item_code: "ITEM-LOCAL",
            item_name: "Local Item",
            qty: 2,
            rate: 15,
            amount: 30,
          }],
        },
      };
    case "stock-viewer":
      return {
        refreshRequest,
        count: 1,
        data: [{
          item_code: "ITEM-LOCAL",
          warehouse: "Local Warehouse",
          actual_qty: 12,
          reserved_qty: 2,
          projected_qty: 10,
          valuation_rate: 15,
          stock_value: 180,
        }],
      };
    case "doclist-viewer":
      // Ba dòng cố định dùng cho kiểm tra download CSV: biểu thức chỉ tính số,
      // không có URL, macro hay dữ liệu ERPNext thật.
      return {
        refreshRequest,
        count: 3,
        doctype: "Customer",
        _title: "Local CSV records",
        data: [
          {
            name: "CUSTOMER-001",
            customer_name: "Alpha, Incorporated",
            notes: 'A "quoted" value',
            amount: 42,
          },
          {
            name: "CUSTOMER-002",
            customer_name: "=1+1",
            notes: "First line\nSecond line",
            amount: 0,
          },
          {
            name: "CUSTOMER-003",
            customer_name: "Công ty Việt",
            notes: "+SUM(1,2)",
            amount: -1,
          },
        ],
      } satisfies DoclistData;
    case "chart-viewer":
      return {
        refreshRequest,
        title: "Local sales chart",
        type: chartType,
        labels: ["Alpha", "Beta"],
        datasets: [{ label: "Sales", values: [30, 20] }],
        currency: "USD",
        generatedAt: GENERATED_AT,
        _drillDown: "Show sales for {label}",
      };
    case "kpi-viewer":
      return {
        refreshRequest,
        label: "Local revenue",
        value: 1250,
        currency: "USD",
        delta: 12,
        trend: "up",
        trendIsGood: true,
        sparkline: [800, 900, 1250],
        _drillDown: "Show local revenue details",
      };
    case "funnel-viewer":
      return {
        refreshRequest,
        title: "Local sales funnel",
        currency: "USD",
        stages: [
          {
            label: "Lead",
            count: 10,
            value: 5000,
            color: "#2563eb",
            _drillDown: "Show local leads",
          },
          {
            label: "Opportunity",
            count: 5,
            value: 2500,
            color: "#d97706",
            conversionRate: 50,
          },
          {
            label: "Won",
            count: 2,
            value: 1000,
            color: "#15803d",
            conversionRate: 40,
          },
        ],
      };
    case "kanban-viewer":
      return boardFixture();
  }
}

export function detailFixture(name: string): object {
  return {
    data: {
      doctype: "Task",
      name,
      subject: `Detail ${name}`,
      status: "Open",
      description: `Local detail for ${name}`,
      priority: "Medium",
      modified: GENERATED_AT,
      _assign: "[]",
    },
  };
}
