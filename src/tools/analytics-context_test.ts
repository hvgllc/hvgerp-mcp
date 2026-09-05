import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { FrappeDoc, FrappeListOptions } from "../api/types.ts";
import {
  analyticsNumber,
  resolveAnalyticsContext,
} from "./analytics-context.ts";

function fixture(options: {
  companies?: FrappeDoc[];
  currency?: unknown;
  list?: (doctype: string, options?: FrappeListOptions) => Promise<FrappeDoc[]>;
  get?: (doctype: string, name: string) => Promise<FrappeDoc>;
} = {}) {
  return {
    client: {
      list: options.list ??
        (async () => options.companies ?? [{ name: "Vietnam Company" }]),
      get: options.get ?? (async (_doctype: string, name: string) => ({
        name,
        default_currency: options.currency === undefined
          ? "VND"
          : options.currency,
      })),
    } as unknown as FrappeClient,
  };
}

Deno.test("analytics context resolves the only visible VND company", async () => {
  const result = await resolveAnalyticsContext(fixture(), {});
  assertEquals(result.company, "Vietnam Company");
  assertEquals(result.currency, "VND");
});

Deno.test("analytics context rejects missing and ambiguous companies", async () => {
  await assertRejects(
    () => resolveAnalyticsContext(fixture({ companies: [] }), {}),
    Error,
    "No Company",
  );
  await assertRejects(
    () =>
      resolveAnalyticsContext(
        fixture({
          companies: [{ name: "Vietnam Company" }, { name: "US Company" }],
        }),
        {},
      ),
    Error,
    "'company' is required",
  );
});

Deno.test("analytics context validates explicit company through a permitted GET", async () => {
  const result = await resolveAnalyticsContext(
    fixture({
      list: async () => {
        throw new Error("Explicit company must not list all companies");
      },
      get: async (doctype, name) => {
        assertEquals([doctype, name], ["Company", "US Company"]);
        return { name, default_currency: "USD" };
      },
    }),
    { company: " US Company " },
  );
  assertEquals([result.company, result.currency], ["US Company", "USD"]);
});

Deno.test("analytics context preserves Company permission errors", async () => {
  const denied = new Error("Company permission denied");
  for (const input of [{}, { company: "Private Company" }]) {
    const error = await assertRejects(() =>
      resolveAnalyticsContext(
        fixture({
          list: async () => {
            throw denied;
          },
          get: async () => {
            throw denied;
          },
        }),
        input,
      )
    );
    assertEquals(error, denied);
  }
});

Deno.test("analytics context rejects invalid currency without inventing a default", async () => {
  for (const currency of ["", null, 0, "vnd", " USD "]) {
    await assertRejects(
      () => resolveAnalyticsContext(fixture({ currency }), {}),
      Error,
      "default_currency",
    );
  }
});

Deno.test("analytics context rejects invalid direct-call company inputs", async () => {
  for (const company of ["", " ", 3, null]) {
    await assertRejects(
      () => resolveAnalyticsContext(fixture(), { company }),
      Error,
      "non-empty Company",
    );
  }
});

Deno.test("analytics context scopes child rows through the parent, never a fictitious company field", async () => {
  const ctx = fixture({
    list: async (doctype, options) => {
      if (doctype === "Company") return [{ name: "Vietnam Company" }];
      if (doctype === "Sales Order") {
        assertEquals(options?.filters, [["docstatus", "!=", 2], [
          "company",
          "=",
          "Vietnam Company",
        ]]);
        return [{ name: "SO-VND" }];
      }
      assertEquals(doctype, "Sales Order Item");
      assertEquals(options?.filters, [["docstatus", "!=", 2], ["parent", "in", [
        "SO-VND",
      ]], ["parenttype", "=", "Sales Order"]]);
      assert(!options?.filters?.some((filter) => filter[0] === "company"));
      return [{
        name: "ROW",
        parent: "SO-VND",
        parenttype: "Sales Order",
        base_amount: 250000,
      }];
    },
  });
  const context = await resolveAnalyticsContext(ctx, {});
  const rows = await context.listItems("Sales Order", {
    fields: ["base_amount"],
    filters: [["docstatus", "!=", 2]],
    limit: 500,
  });
  assertEquals(rows[0].base_amount, 250000);
});

Deno.test("analytics context refuses a child with unverified company ownership", async () => {
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype) => {
        if (doctype === "Company") return [{ name: "Vietnam Company" }];
        if (doctype === "Sales Invoice") {
          return [{ name: "INV-VND" }];
        }
        return [{
          name: "ROW",
          parent: "INV-OTHER",
          parenttype: "Sales Invoice",
        }];
      },
    }),
    {},
  );
  await assertRejects(
    () => context.listItems("Sales Invoice", {}),
    Error,
    "unverified company ownership",
  );
});

Deno.test("analytics context scopes Bin through Warehouse and reuses only the per-call lookup", async () => {
  let warehouseReads = 0;
  const ctx = fixture({
    list: async (doctype, options) => {
      if (doctype === "Company") return [{ name: "Vietnam Company" }];
      if (doctype === "Warehouse") {
        warehouseReads++;
        assertEquals(options?.filters, [["company", "=", "Vietnam Company"]]);
        return [{ name: "WH-VND" }];
      }
      assertEquals(doctype, "Bin");
      assertEquals(options?.filters, [["warehouse", "in", ["WH-VND"]]]);
      return [{ name: "BIN", warehouse: "WH-VND", stock_value: 250000 }];
    },
  });
  const context = await resolveAnalyticsContext(ctx, {});
  await Promise.all([context.listBins({}), context.listBins({})]);
  assertEquals(warehouseReads, 1);
  const next = await resolveAnalyticsContext(ctx, {});
  await next.listBins({});
  assertEquals(warehouseReads, 2);
});

Deno.test("analytics context does not issue an unscoped query when ownership set is empty", async () => {
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype) => {
        if (doctype === "Company") return [{ name: "Vietnam Company" }];
        if (doctype === "Warehouse" || doctype === "Sales Order") {
          return [];
        }
        throw new Error("Unscoped financial read");
      },
    }),
    {},
  );
  assertEquals(await context.listBins({}), []);
  assertEquals(await context.listItems("Sales Order", {}), []);
});

Deno.test("analytics numbers preserve zero and reject unknown values", () => {
  assertEquals(analyticsNumber({ base_amount: 0 }, "base_amount"), 0);
  assertEquals(
    analyticsNumber({ base_amount: "250000" }, "base_amount"),
    250000,
  );
  for (const value of [undefined, null, "", NaN, Infinity, [], true]) {
    assertThrows(
      () => analyticsNumber({ base_amount: value }, "base_amount"),
      Error,
      "refusing to report zero",
    );
  }
});
