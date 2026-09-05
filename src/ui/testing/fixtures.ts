import { UI_VIEWERS } from "../viewers.ts";
import type { DoclistData } from "../doclist-viewer/src/types.ts";
import type { KanbanBoardData } from "../shared/kanban/types.ts";
import type { StockMovement } from "../shared/stock-movements.ts";

export { UI_VIEWERS };
export type Viewer = typeof UI_VIEWERS[number];
export const SCENARIOS = [
  "smoke",
  "csv",
  "detail-race",
  "board-race",
  "initial-error",
  "refresh-error",
  "stock-movements",
  "stock-permission",
  "stock-malformed",
  "stock-race",
] as const;
export type Scenario = typeof SCENARIOS[number];
export const GENERATED_AT = "2026-09-05T00:00:00.000Z";

export function stockInventoryFixture() {
  return {
    refreshRequest: { toolName: "erpnext_stock_balance", arguments: {} },
    count: 4,
    data: [
      { item_code: "ITEM-A", warehouse: "W1", actual_qty: 18 },
      { item_code: "ITEM-A", warehouse: "W2", actual_qty: 7 },
      { item_code: "ITEM-B", warehouse: "W1", actual_qty: 3 },
      { item_code: "ITEM-B", warehouse: "W2", actual_qty: 0 },
    ].map((row) => ({
      ...row,
      reserved_qty: 0,
      projected_qty: row.actual_qty,
      valuation_rate: 10,
      stock_value: row.actual_qty * 10,
    })),
  };
}

function movementFixture(
  name: string,
  item: string,
  warehouse: string,
  quantity: number,
  date: string,
  time: string,
  cancelled = 0,
  balance = quantity,
): StockMovement & { is_cancelled: number } {
  return {
    name,
    item_code: item,
    warehouse,
    posting_date: date,
    posting_time: time,
    voucher_type: "Stock Entry",
    voucher_no: `STE-${name}`,
    actual_qty: quantity,
    qty_after_transaction: balance,
    stock_uom: "Nos",
    is_cancelled: cancelled,
  };
}

const STOCK_LEDGER_ROWS = [
  movementFixture(
    "A-W1-001",
    "ITEM-A",
    "W1",
    1,
    "2026-09-01",
    "08:00:00.000000",
  ),
  movementFixture(
    "A-W1-005",
    "ITEM-A",
    "W1",
    10,
    "2026-09-05",
    "09:00:00.000000",
    0,
    20,
  ),
  movementFixture(
    "A-W1-003",
    "ITEM-A",
    "W1",
    3,
    "2026-09-04",
    "09:00:00.000000",
    0,
    6,
  ),
  movementFixture(
    "A-W1-006",
    "ITEM-A",
    "W1",
    -2,
    "2026-09-05",
    "09:00:00.000000",
    0,
    18,
  ),
  movementFixture(
    "A-W1-004",
    "ITEM-A",
    "W1",
    4,
    "2026-09-05",
    "08:00:00.000000",
    0,
    10,
  ),
  movementFixture(
    "A-W1-002",
    "ITEM-A",
    "W1",
    2,
    "2026-09-03",
    "09:00:00.000000",
    0,
    3,
  ),
  movementFixture(
    "A-W1-CANCELLED",
    "ITEM-A",
    "W1",
    999,
    "2026-09-05",
    "23:00:00.000000",
    1,
  ),
  movementFixture(
    "A-W2-001",
    "ITEM-A",
    "W2",
    7,
    "2026-09-05",
    "07:00:00.000000",
  ),
  movementFixture(
    "B-W1-001",
    "ITEM-B",
    "W1",
    3,
    "2026-09-05",
    "06:00:00.000000",
  ),
  movementFixture(
    "LOCAL-001",
    "ITEM-LOCAL",
    "Local Warehouse",
    12,
    "2026-09-05",
    "05:00:00.000000",
  ),
];

export function stockLedgerFixture(
  itemCode: string,
  warehouse: string,
  limit = 5,
): { data: StockMovement[] } {
  if (
    !itemCode.trim() || !warehouse.trim() || !Number.isInteger(limit) ||
    limit < 1 || limit > 20
  ) {
    throw new Error("Invalid local stock ledger query");
  }
  const rows = STOCK_LEDGER_ROWS.filter((row) =>
    row.item_code === itemCode && row.warehouse === warehouse &&
    row.is_cancelled === 0
  )
    .sort((left, right) =>
      right.posting_date.localeCompare(left.posting_date) ||
      right.posting_time.localeCompare(left.posting_time) ||
      right.name.localeCompare(left.name)
    )
    .slice(0, limit);
  return {
    data: rows.map(({ is_cancelled: _cancelled, ...row }) => ({ ...row })),
  };
}

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

export function detailFixture(name: string, doctype = "Task") {
  return {
    data: {
      doctype,
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

export function createDetailFixtureStore() {
  const documents = new Map<string, Record<string, unknown>>();
  const key = (doctype: string, name: string) =>
    JSON.stringify([doctype, name]);
  return {
    get(doctype: string, name: string): Record<string, unknown> {
      return structuredClone(
        documents.get(key(doctype, name)) ?? detailFixture(name, doctype).data,
      );
    },
    set(doctype: string, name: string, doc: Record<string, unknown>) {
      documents.set(
        key(doctype, name),
        structuredClone({ ...doc, doctype, name }),
      );
    },
  };
}
