import { assertEquals, assertThrows } from "@std/assert";
import {
  buildStockMovementsRequest,
  loadStockDetails,
  parseStockMovements,
} from "./stock-movements.ts";
import type { StockDetailsState, StockMovement } from "./stock-movements.ts";
import type { ToolResultPayload } from "./refresh.ts";

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

Deno.test("stock details preserves item fields when ledger is denied or malformed", async () => {
  const item = {
    name: "ITEM-A",
    item_name: "Local Name",
    item_group: "Local Group",
    stock_uom: "Nos",
    standard_rate: 15,
  };
  for (
    const ledger of [{
      isError: true,
      content: [{ type: "text", text: "Ledger permission denied" }],
    }, result([{}])]
  ) {
    const states: StockDetailsState[] = [];
    await loadStockDetails(
      async ({ name }) => name === "erpnext_item_get" ? result(item) : ledger,
      "ITEM-A",
      "W1",
      () => true,
      (state) => states.push(state),
    );
    const last = states.at(-1)!;
    assertEquals(last.itemData, item);
    assertEquals(last.itemError, null);
    assertEquals(last.movements, null);
    assertEquals(typeof last.movementsError, "string");
    assertEquals(last.itemLoading, false);
    assertEquals(last.movementsLoading, false);
  }
});

Deno.test("stock details shows item success while ledger is pending", async () => {
  const held = Promise.withResolvers<ToolResultPayload>();
  const started = Promise.withResolvers<void>();
  const states: StockDetailsState[] = [];
  const pending = loadStockDetails(
    ({ name }) => {
      if (name === "erpnext_item_get") {
        return Promise.resolve(
          result({ name: "ITEM-A", standard_rate: 0 }),
        );
      }
      started.resolve();
      return held.promise;
    },
    "ITEM-A",
    "W1",
    () => true,
    (state) => states.push(state),
  );
  await started.promise;
  assertEquals(states.at(-1), {
    itemData: { name: "ITEM-A", standard_rate: 0 },
    movements: null,
    itemError: null,
    movementsError: null,
    itemLoading: false,
    movementsLoading: true,
  });
  held.resolve(result([row]));
  await pending;
  assertEquals(states.at(-1)?.movements, [row]);
  assertEquals(states.at(-1)?.movementsLoading, false);
});

Deno.test("stock details keeps ledger success across item payload, permission and transport failures", async () => {
  for (
    const item of [
      {
        isError: true,
        content: [{ type: "text", text: "Item permission denied" }],
      },
      result(null),
      result([]),
      result(5),
      {},
      { content: [{ type: "text", text: "{" }] },
      new Error("Item request timed out"),
    ]
  ) {
    const calls: string[] = [];
    const states: StockDetailsState[] = [];
    await loadStockDetails(
      async ({ name }) => {
        calls.push(name);
        if (name !== "erpnext_item_get") return result([row]);
        if (item instanceof Error) throw item;
        return item;
      },
      "ITEM-A",
      "W1",
      () => true,
      (state) => states.push(state),
    );
    assertEquals(calls, ["erpnext_item_get", "erpnext_stock_ledger_list"]);
    const last = states.at(-1)!;
    assertEquals(last.itemData, null);
    assertEquals(typeof last.itemError, "string");
    assertEquals(last.movements, [row]);
    assertEquals(last.movementsError, null);
    assertEquals([last.itemLoading, last.movementsLoading], [false, false]);
  }
});

Deno.test("stock details keeps both errors and never converts failed ledger to empty", async () => {
  const states: StockDetailsState[] = [];
  await loadStockDetails(
    ({ name }) => Promise.reject(new Error(`${name} timed out`)),
    "ITEM-A",
    "W1",
    () => true,
    (state) => states.push(state),
  );
  assertEquals(states.at(-1), {
    itemData: null,
    movements: null,
    itemError: "erpnext_item_get timed out",
    movementsError: "erpnext_stock_ledger_list timed out",
    itemLoading: false,
    movementsLoading: false,
  });
});

for (const phase of ["item", "ledger"] as const) {
  for (const outcome of ["success", "error"] as const) {
    for (const next of [["ITEM-A", "W2"], ["ITEM-B", "W1"]]) {
      Deno.test(`stock details ignores late ${phase} ${outcome} after selecting ${next.join("/")}`, async () => {
        let current = true;
        const held = Promise.withResolvers<ToolResultPayload>();
        const started = Promise.withResolvers<void>();
        const updates: StockDetailsState[] = [];
        const calls: string[] = [];
        const old = loadStockDetails(
          ({ name }) => {
            calls.push(name);
            if ((name === "erpnext_item_get") === (phase === "item")) {
              started.resolve();
              return held.promise;
            }
            return Promise.resolve(
              name === "erpnext_item_get"
                ? result({ name: "ITEM-A" })
                : result([row]),
            );
          },
          "ITEM-A",
          "W1",
          () => current,
          (state) => updates.push(state),
        );
        await started.promise;
        current = false;
        const nextRow = { ...row, item_code: next[0], warehouse: next[1] };
        await loadStockDetails(
          async ({ name }) =>
            name === "erpnext_item_get"
              ? result({ name: next[0] })
              : result([nextRow]),
          next[0],
          next[1],
          () => true,
          (state) => updates.push(state),
        );
        const before = structuredClone(updates);
        if (outcome === "error") {
          held.reject(new Error("Old request failed"));
        } else {
          held.resolve(
            phase === "item" ? result({ name: "ITEM-A" }) : result([row]),
          );
        }
        await old;
        assertEquals(updates, before);
        assertEquals(updates.at(-1)?.itemData, { name: next[0] });
        assertEquals(updates.at(-1)?.movements, [nextRow]);
        assertEquals(
          calls,
          phase === "item"
            ? ["erpnext_item_get"]
            : ["erpnext_item_get", "erpnext_stock_ledger_list"],
        );
      });
    }
  }
}

Deno.test("stock details cancelled before start performs no calls or updates", async () => {
  await loadStockDetails(
    () => {
      throw new Error("Unexpected call");
    },
    "ITEM-A",
    "W1",
    () => false,
    () => {
      throw new Error("Unexpected update");
    },
  );
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
