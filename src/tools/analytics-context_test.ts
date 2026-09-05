import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FrappeClient } from "../api/frappe-client.ts";
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

for (const source of ["Sales Order", "Sales Invoice", "Warehouse"] as const) {
  for (const longNames of [false, true]) {
    Deno.test(`analytics scope URI - ${source} preserves global top N with ${longNames ? "long Unicode" : "1000"} names`, async () => {
      const names = Array.from(
        { length: longNames ? 40 : 1000 },
        (_, i) =>
          `${String(i).padStart(4, "0")}-${
            longNames
              ? "Kho hàng Việt Nam & 東京/".repeat(6)
              : "DOC-2026-000000"
          }`,
      );
      const bin = source === "Warehouse";
      const field = bin ? "warehouse" : "parent";
      const doctype = bin ? "Bin" : `${source} Item`;
      const sortField = source === "Sales Order"
        ? "modified"
        : bin
        ? "stock_value"
        : "base_amount";
      const requested = new Set<string>();
      let childRequests = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        assertEquals(init?.method, "GET");
        if (url.href.length > 8192) {
          return new Response("URI Too Long", { status: 414 });
        }
        const path = decodeURIComponent(
          url.pathname.split("/api/resource/")[1],
        );
        if (path === "Company/Vietnam Company") {
          return Response.json({
            data: { name: "Vietnam Company", default_currency: "VND" },
          });
        }
        const filters = JSON.parse(url.searchParams.get("filters") ?? "[]");
        if (path === source) {
          assert(
            filters.some((filter: unknown) =>
              JSON.stringify(filter) ===
                JSON.stringify(["company", "=", "Vietnam Company"])
            ),
          );
          return Response.json({ data: names.map((name) => ({ name })) });
        }
        assertEquals(path, doctype);
        childRequests++;
        const scopedNames = filters.find((filter: unknown[]) =>
          filter[0] === field
        )[2] as string[];
        scopedNames.forEach((name) => {
          assert(names.includes(name));
          requested.add(name);
        });
        assertEquals(url.searchParams.get("order_by"), `${sortField} desc`);
        const limit = Number(url.searchParams.get("limit"));
        assertEquals(limit, 7);
        const fields = JSON.parse(url.searchParams.get("fields")!);
        assert(fields.includes(sortField));
        const data = scopedNames.map((name) => {
          const rank = names.indexOf(name);
          return {
            name: `ROW-${rank}`,
            [field]: name,
            ...(bin ? {} : { parenttype: source }),
            base_amount: String(rank),
            stock_value: rank,
            modified: new Date(Date.UTC(2020, 0, rank + 1)).toISOString().slice(
              0,
              19,
            ).replace("T", " "),
          };
        }).sort((a, b) => Number(b.base_amount) - Number(a.base_amount)).slice(
          0,
          limit,
        );
        return Response.json({ data });
      };
      try {
        const context = await resolveAnalyticsContext({
          client: new FrappeClient({
            baseUrl: `https://fixture.invalid/${"proxy/".repeat(30)}`,
            apiKey: "fixture",
            apiSecret: "fixture",
            retries: 0,
          }),
        }, { company: "Vietnam Company" });
        const options = {
          fields: ["name"],
          limit: 7,
          ...(sortField === "modified"
            ? {}
            : { order_by: `${sortField} desc` }),
        };
        const rows = bin
          ? await context.listBins(options)
          : await context.listItems(source, options);
        assertEquals(
          rows.map((row) => row.name),
          Array.from({ length: 7 }, (_, i) => `ROW-${names.length - 1 - i}`),
        );
        assert(childRequests > 1);
        assertEquals([...requested].sort(), [...names].sort());
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

for (const bin of [false, true]) {
  Deno.test(`analytics scope chunks - ${bin ? "Bin" : "child"} rejects cross-chunk ownership and missing sort values`, async () => {
    const names = Array.from({ length: 1000 }, (_, i) => `DOCUMENT-2026-${i}`);
    for (const failure of ["ownership", "modified", "permission"]) {
      const denied = new Error("Scoped permission denied");
      const context = await resolveAnalyticsContext(
        fixture({
          list: async (doctype, options) => {
            if (doctype === "Company") return [{ name: "Vietnam Company" }];
            if (doctype === (bin ? "Warehouse" : "Sales Order")) {
              return names.map((name) => ({ name }));
            }
            const scopeField = bin ? "warehouse" : "parent";
            const chunk = options!.filters!.find((filter) =>
              filter[0] === scopeField
            )![2] as string[];
            assert(chunk.length < names.length);
            if (failure === "permission") throw denied;
            return [{
              name: "ROW",
              [scopeField]: failure === "ownership" ? names.at(-1)! : chunk[0],
              ...(bin ? {} : { parenttype: "Sales Order" }),
            }];
          },
        }),
        {},
      );
      const error = await assertRejects(
        () =>
          bin
            ? context.listBins({ limit: 10 })
            : context.listItems("Sales Order", { limit: 10 }),
        Error,
        failure === "ownership"
          ? "unverified company ownership"
          : failure === "modified"
          ? "modified timestamp"
          : "Scoped permission denied",
      );
      if (failure === "permission") assertEquals(error, denied);
    }
  });
}

Deno.test("analytics scope refuses an individually oversized encoded query before reading rows", async () => {
  let childReads = 0;
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype) => {
        if (doctype === "Company") return [{ name: "Vietnam Company" }];
        if (doctype === "Warehouse" || doctype === "Sales Order") {
          return [{ name: "東京".repeat(1000) }];
        }
        childReads++;
        return [];
      },
    }),
    {},
  );
  await assertRejects(
    () => context.listBins({ limit: 10 }),
    Error,
    "encoded request budget",
  );
  await assertRejects(
    () => context.listItems("Sales Order", { limit: 10 }),
    Error,
    "encoded request budget",
  );
  assertEquals(childReads, 0);
});

Deno.test("analytics scope stable merge keeps the global cap when sort values tie", async () => {
  const names = Array.from({ length: 1000 }, (_, i) => `WAREHOUSE-2026-${i}`);
  let requests = 0;
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype, options) => {
        if (doctype === "Company") return [{ name: "Vietnam Company" }];
        if (doctype === "Warehouse") {
          return names.map((name) => ({ name }));
        }
        requests++;
        const chunk = options!.filters!.find((filter) =>
          filter[0] === "warehouse"
        )![2] as string[];
        assertEquals(options!.order_by, "modified desc");
        return chunk.slice(0, 2).map((warehouse) => ({
          name: warehouse,
          warehouse,
          modified: "2026-09-05 01:02:03.000001",
        }));
      },
    }),
    {},
  );
  const rows = await context.listBins({ limit: 2 });
  assert(requests > 1);
  assertEquals(rows.map((row) => row.name), names.slice(0, 2));
});
