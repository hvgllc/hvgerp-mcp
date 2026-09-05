import { assertEquals, assertRejects } from "@std/assert";
import type { FrappeDoc } from "../api/types.ts";
import {
  ANALYTICS_MAX_REQUESTS,
  ANALYTICS_MAX_ROWS,
  listCompleteAnalytics,
} from "./analytics-pagination.ts";

for (const size of [0, 999, 1000, 1001, 2000, 2501, 100000]) {
  Deno.test(`complete pagination reads ${size} rows with bounded page sizes`, async () => {
    const offsets: number[] = [];
    const budget = { requests: 0, rows: 0 };
    const result = await listCompleteAnalytics(
      async (doctype, options) => {
        assertEquals(doctype, "Bin");
        assertEquals(options.fields, ["actual_qty", "name"]);
        assertEquals(options.order_by, "actual_qty desc, name asc");
        assertEquals(options.filters, [["warehouse", "=", "W1"]]);
        assertEquals(options.limit, 1000);
        const offset = options.limit_start!;
        offsets.push(offset);
        return Array.from(
          { length: Math.min(1000, size - offset) },
          (_, i) => ({ name: `BIN-${offset + i}`, actual_qty: 1 }),
        );
      },
      "Bin",
      {
        fields: ["actual_qty"],
        filters: [["warehouse", "=", "W1"]],
        order_by: "actual_qty desc",
      },
      budget,
    );
    assertEquals(result.length, size);
    assertEquals(
      offsets,
      Array.from({ length: Math.floor(size / 1000) + 1 }, (_, i) => i * 1000),
    );
    assertEquals(budget, { requests: offsets.length, rows: size });
  });
}

for (
  const bad of [
    null,
    {},
    [null],
    [{ name: "" }],
    [{ name: " " }],
    [{ name: 1 }],
    [{ name: "same" }, { name: "same" }],
    Array.from({ length: 1001 }, (_, i) => ({ name: String(i) })),
  ]
) {
  Deno.test(`complete pagination rejects malformed page ${JSON.stringify(bad)?.slice(0, 40)}`, async () => {
    await assertRejects(() =>
      listCompleteAnalytics(async () => bad as FrappeDoc[], "Item", {})
    );
  });
}

for (const failure of ["repeat", "denied", "row-budget", "request-budget"]) {
  Deno.test(`complete pagination rejects ${failure} without returning a prefix`, async () => {
    let requests = 0;
    const denied = new Error("DocType permission denied");
    const budget = {
      requests: failure === "request-budget" ? ANALYTICS_MAX_REQUESTS - 1 : 0,
      rows: failure === "row-budget" ? ANALYTICS_MAX_ROWS - 1000 : 0,
    };
    const error = await assertRejects(() =>
      listCompleteAnalytics(
        async (_doctype, options) => {
          requests++;
          if (failure === "denied" && requests === 2) throw denied;
          return Array.from(
            { length: 1000 },
            (_, i) => ({
              name: `ROW-${
                failure === "repeat" ? i : options.limit_start! + i
              }`,
            }),
          );
        },
        "Sales Order",
        {},
        budget,
      )
    );
    if (failure === "denied") assertEquals(error, denied);
    assertEquals(requests, failure === "request-budget" ? 1 : 2);
  });
}

Deno.test("complete pagination rejects unsupported ordering before requesting data", async () => {
  let reads = 0;
  await assertRejects(() =>
    listCompleteAnalytics(
      async () => {
        reads++;
        return [];
      },
      "Item",
      { order_by: "sum(qty) desc" },
    )
  );
  assertEquals(reads, 0);
});

Deno.test("complete pagination reads 100001 actual rows then rejects the entire aggregate", async () => {
  let reads = 0;
  await assertRejects(
    () =>
      listCompleteAnalytics(
        async (_doctype, options) => {
          reads++;
          const offset = options.limit_start!;
          return Array.from(
            { length: Math.min(1000, 100001 - offset) },
            (_, i) => ({ name: `ROW-${offset + i}` }),
          );
        },
        "Sales Order",
        {},
      ),
    Error,
    "100000 row safety limit",
  );
  assertEquals(reads, 101);
});
