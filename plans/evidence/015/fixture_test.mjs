import { deepStrictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import {
  stockInventoryFixture,
  stockLedgerFixture,
} from "../../../src/ui/testing/fixtures.ts";
import { parseStockMovements } from "../../../src/ui/shared/stock-movements.ts";

test("stock ledger browser fixture scopes two items and two warehouses", () => {
  deepStrictEqual(
    stockInventoryFixture().data.map((
      { item_code, warehouse },
    ) => [item_code, warehouse]),
    [["ITEM-A", "W1"], ["ITEM-A", "W2"], ["ITEM-B", "W1"], ["ITEM-B", "W2"]],
  );
  for (
    const [item, warehouse, names] of [["ITEM-A", "W2", ["A-W2-001"]], [
      "ITEM-B",
      "W1",
      ["B-W1-001"],
    ], ["ITEM-B", "W2", []]]
  ) {
    const payload = stockLedgerFixture(item, warehouse);
    deepStrictEqual(payload.data.map((row) => row.name), names);
    deepStrictEqual(
      parseStockMovements({ structuredContent: payload }, item, warehouse),
      payload.data,
    );
  }
});

test("stock ledger browser fixture sorts date then time then name and excludes cancelled before limit", () => {
  const expected = [
    "A-W1-006",
    "A-W1-005",
    "A-W1-004",
    "A-W1-003",
    "A-W1-002",
    "A-W1-001",
  ];
  deepStrictEqual(
    stockLedgerFixture("ITEM-A", "W1").data.map((row) => row.name),
    expected.slice(0, 5),
  );
  deepStrictEqual(
    stockLedgerFixture("ITEM-A", "W1", 20).data.map((row) => row.name),
    expected,
  );
  deepStrictEqual(
    stockLedgerFixture("ITEM-A", "W1", 1).data.map((row) => row.name),
    expected.slice(0, 1),
  );
  const rows = stockLedgerFixture("ITEM-A", "W1").data;
  rows[0].actual_qty = 100;
  deepStrictEqual(stockLedgerFixture("ITEM-A", "W1").data[0].actual_qty, -2);
  for (const limit of [0, 21, 1.5, NaN, Infinity]) {
    throws(() => stockLedgerFixture("ITEM-A", "W1", limit));
  }
  throws(() => stockLedgerFixture("", "W1"));
});
