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
