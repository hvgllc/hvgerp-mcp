import { assertEquals, assertThrows } from "@std/assert";
import {
  buildStockMovementsRequest,
  parseStockMovements,
} from "./stock-movements.ts";
import type { StockMovement } from "./stock-movements.ts";

const row: StockMovement = {
  name: "SLE-A",
  item_code: "ITEM-A",
  warehouse: "W1",
  posting_date: "2026-09-05",
  posting_time: "09:00:00.123456",
  voucher_type: "Stock Entry",
  voucher_no: "STE-A",
  actual_qty: -2,
  qty_after_transaction: 8,
  stock_uom: "Nos",
};
const result = (data: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ data }) }],
});

Deno.test("stock movements request pins inventory tool, item, warehouse and limit", () => {
  for (
    const [item, warehouse] of [["ITEM-A", "W1"], ["ITEM-A", "W2"], [
      "ITEM-B",
      "W1",
    ]]
  ) {
    assertEquals(buildStockMovementsRequest(item, warehouse), {
      toolName: "erpnext_stock_ledger_list",
      arguments: { item_code: item, warehouse, limit: 5 },
    });
  }
  assertThrows(() => buildStockMovementsRequest(" ", "W1"));
  assertThrows(() => buildStockMovementsRequest("ITEM-A", ""));
});

Deno.test("stock movements parses text, structured payload and empty ledger", () => {
  assertEquals(parseStockMovements(result([row]), "ITEM-A", "W1"), [row]);
  assertEquals(
    parseStockMovements({ structuredContent: { data: [row] } }, "ITEM-A", "W1"),
    [row],
  );
  assertEquals(parseStockMovements(result([]), "ITEM-A", "W2"), []);
});

Deno.test("stock movements rejects rows for another item or warehouse", () => {
  assertThrows(
    () => parseStockMovements(result([row]), "ITEM-B", "W1"),
    Error,
    "does not match",
  );
  assertThrows(
    () => parseStockMovements(result([row]), "ITEM-A", "W2"),
    Error,
    "does not match",
  );
});

Deno.test("stock movements propagates permission errors and rejects malformed payloads", () => {
  assertThrows(
    () =>
      parseStockMovements(
        { isError: true, ...result("Permission denied") },
        "ITEM-A",
        "W1",
      ),
    Error,
    "Permission denied",
  );
  assertThrows(
    () => parseStockMovements({ isError: true }, "ITEM-A", "W1"),
    Error,
    "request failed",
  );
  for (
    const data of [null, {}, [null], [1], [{ ...row, stock_uom: {} }], [{
      ...row,
      actual_qty: "2",
    }], [{ ...row, posting_time: null }]]
  ) {
    assertThrows(() => parseStockMovements(result(data), "ITEM-A", "W1"));
  }
  assertThrows(() =>
    parseStockMovements(
      { structuredContent: { data: [{ ...row, actual_qty: NaN }] } },
      "ITEM-A",
      "W1",
    )
  );
  assertThrows(() =>
    parseStockMovements(
      { content: [{ type: "text", text: "{" }] },
      "ITEM-A",
      "W1",
    )
  );
  assertThrows(() => parseStockMovements({}, "ITEM-A", "W1"));
});
