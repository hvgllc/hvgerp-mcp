import { extractToolResultText } from "./refresh.ts";
import type { ToolResultPayload, UiRefreshRequestData } from "./refresh.ts";

export interface StockMovement {
  name: string;
  item_code: string;
  warehouse: string;
  posting_date: string;
  posting_time: string;
  voucher_type: string;
  voucher_no: string;
  actual_qty: number;
  qty_after_transaction: number;
  stock_uom: string;
}

export interface StockDetailsState {
  itemData: Record<string, unknown> | null;
  movements: StockMovement[] | null;
  itemError: string | null;
  movementsError: string | null;
  itemLoading: boolean;
  movementsLoading: boolean;
}

export type StockDetailsCall = (
  request: { name: string; arguments: Record<string, unknown> },
) => Promise<ToolResultPayload>;

export async function loadStockDetails(
  callTool: StockDetailsCall,
  itemCode: string,
  warehouse: string,
  isCurrent: () => boolean,
  publish: (state: StockDetailsState) => void,
): Promise<void> {
  const state: StockDetailsState = {
    itemData: null,
    movements: null,
    itemError: null,
    movementsError: null,
    itemLoading: true,
    movementsLoading: true,
  };
  if (!isCurrent()) return;
  publish({ ...state });

  // Đọc Item trước để resolveItem của ledger có thể dùng cache vừa làm nóng.
  // Lỗi Item không được chặn phần ledger có thể đọc độc lập.
  try {
    const itemRes = await callTool({
      name: "erpnext_item_get",
      arguments: { name: itemCode },
    });
    if (!isCurrent()) return;
    const text = extractToolResultText(itemRes);
    if (itemRes.isError) throw new Error(text || "Item request failed");
    const payload: unknown = text ? JSON.parse(text) : null;
    const data = payload && typeof payload === "object" && "data" in payload
      ? payload.data
      : payload;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid item payload");
    }
    state.itemData = data as Record<string, unknown>;
  } catch (cause) {
    state.itemError = cause instanceof Error
      ? cause.message
      : "Item request failed";
  }
  if (!isCurrent()) return;
  state.itemLoading = false;
  publish({ ...state });

  try {
    const request = buildStockMovementsRequest(itemCode, warehouse);
    const moveRes = await callTool({
      name: request.toolName,
      arguments: request.arguments,
    });
    if (!isCurrent()) return;
    state.movements = parseStockMovements(moveRes, itemCode, warehouse);
  } catch (cause) {
    state.movementsError = cause instanceof Error
      ? cause.message
      : "Stock movements request failed";
  }
  if (isCurrent()) {
    publish({ ...state, movementsLoading: false });
  }
}

export function buildStockMovementsRequest(
  itemCode: string,
  warehouse: string,
): UiRefreshRequestData {
  if (!itemCode.trim() || !warehouse.trim()) {
    throw new Error("Item and warehouse are required");
  }
  return {
    toolName: "erpnext_stock_ledger_list",
    arguments: { item_code: itemCode, warehouse, limit: 5 },
  };
}

export function parseStockMovements(
  result: ToolResultPayload,
  itemCode: string,
  warehouse: string,
): StockMovement[] {
  const text = extractToolResultText(result);
  if (result.isError) throw new Error(text || "Stock movements request failed");
  const payload: unknown = text ? JSON.parse(text) : null;
  if (
    !payload || typeof payload !== "object" || !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error("Invalid stock movements payload");
  }
  return payload.data.map((row: unknown) => {
    if (!row || typeof row !== "object") {
      throw new Error("Invalid stock movement row");
    }
    const value = row as Record<string, unknown>;
    for (
      const field of [
        "name",
        "item_code",
        "warehouse",
        "posting_date",
        "posting_time",
        "voucher_type",
        "voucher_no",
        "stock_uom",
      ]
    ) {
      if (
        typeof value[field] !== "string" || !(value[field] as string).trim()
      ) throw new Error("Invalid stock movement row");
    }
    for (const field of ["actual_qty", "qty_after_transaction"]) {
      if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
        throw new Error("Invalid stock movement quantity");
      }
    }
    if (value.item_code !== itemCode || value.warehouse !== warehouse) {
      throw new Error(
        "Stock movement does not match the selected item and warehouse",
      );
    }
    return value as unknown as StockMovement;
  });
}
