import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FrappeClient } from "../api/frappe-client.ts";
import type { FrappeDoc, FrappeListOptions } from "../api/types.ts";
import {
  analyticsNumber,
  listAnalyticsItemUnits,
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

for (const parent of ["Sales Order", "Sales Invoice", "Warehouse"] as const) {
  for (const unicode of [false, true]) {
    Deno.test(`complete scoped ${parent} paginates all chunks with actual ${unicode ? "Unicode" : "ordinary"} request budgets`, async () => {
      const owners = Array.from(
        { length: 3 },
        (_, i) =>
          `OWNER-${i}-${unicode ? "Kho hàng 東京/&".repeat(60) : "local"}`,
      );
      const child = parent === "Warehouse" ? "Bin" : `${parent} Item`;
      const field = parent === "Warehouse" ? "warehouse" : "parent";
      const offsets = new Map<string, number[]>();
      const original = globalThis.fetch;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert((url.pathname + url.search).length <= 6000);
        const doctype = decodeURIComponent(
          url.pathname.replace("/api/resource/", ""),
        );
        if (doctype === "Company/Vietnam Company") {
          return Response.json({
            data: { name: "Vietnam Company", default_currency: "VND" },
          });
        }
        const filters = JSON.parse(url.searchParams.get("filters")!);
        if (doctype === parent) {
          assert(
            filters.some((f: unknown) =>
              JSON.stringify(f) ===
                JSON.stringify(["company", "=", "Vietnam Company"])
            ),
          );
          return Response.json({ data: owners.map((name) => ({ name })) });
        }
        assertEquals(doctype, child);
        const scope = filters.find((f: unknown[]) =>
          f[0] === field
        )[2] as string[];
        if (parent !== "Warehouse") {
          assert(
            filters.some((f: unknown) =>
              JSON.stringify(f) === JSON.stringify(["parenttype", "=", parent])
            ),
          );
        }
        const key = JSON.stringify(scope);
        const offset = Number(url.searchParams.get("limit_start"));
        const limit = Number(url.searchParams.get("limit"));
        assertEquals(limit, 1000);
        assertEquals(
          url.searchParams.get("order_by"),
          "modified desc, name asc",
        );
        offsets.set(key, [...(offsets.get(key) ?? []), offset]);
        const rows = scope.flatMap((owner) =>
          Array.from(
            { length: 1001 },
            (_, i) => ({
              name: `${owners.indexOf(owner)}-${String(i).padStart(5, "0")}`,
              [field]: owner,
              parenttype: parent,
              modified: `2026-09-05 12:00:0${owners.indexOf(owner)}`,
              actual_qty: 1,
            }),
          )
        );
        rows.sort((a, b) =>
          a.modified < b.modified
            ? 1
            : a.modified > b.modified
            ? -1
            : a.name.localeCompare(b.name)
        );
        return Response.json({ data: rows.slice(offset, offset + limit) });
      };
      try {
        const context = await resolveAnalyticsContext({
          client: new FrappeClient({
            baseUrl: "https://fixture.invalid",
            apiKey: "fixture",
            apiSecret: "fixture",
            retries: 0,
          }),
        }, { company: "Vietnam Company" });
        const result = parent === "Warehouse"
          ? await context.listAllBins({ fields: ["actual_qty"] })
          : await context.listAllItems(parent, {
            fields: ["actual_qty"],
            filters: [["docstatus", "=", 1]],
          });
        assertEquals(result.length, 3003);
        assertEquals(new Set(result.map((row) => row.name)).size, 3003);
        assertEquals(result[0].modified, "2026-09-05 12:00:02");
        assertEquals(result.at(-1)!.modified, "2026-09-05 12:00:00");
        if (unicode) assert(offsets.size > 1);
        for (const [key, pages] of offsets) {
          const count = JSON.parse(key).length * 1001;
          assertEquals(
            pages,
            Array.from(
              { length: Math.floor(count / 1000) + 1 },
              (_, i) => i * 1000,
            ),
          );
        }
      } finally {
        globalThis.fetch = original;
      }
    });
  }
}

for (
  const failure of [
    "permission",
    "wrong-owner",
    "wrong-parenttype",
    "repeat",
    "missing-name",
  ]
) {
  Deno.test(`complete child reads reject later ${failure} rather than returning partial aggregates`, async () => {
    const denied = new Error("Child page permission denied");
    let pages = 0;
    const context = await resolveAnalyticsContext(
      fixture({
        list: async (doctype, options) => {
          if (doctype === "Sales Order") return [{ name: "SO-1" }];
          pages++;
          if (pages > 1) {
            if (failure === "permission") {
              throw denied;
            }
            return [{
              name: failure === "repeat"
                ? "ROW-0"
                : failure === "missing-name"
                ? ""
                : "LATER",
              parent: failure === "wrong-owner" ? "FOREIGN" : "SO-1",
              parenttype: failure === "wrong-parenttype"
                ? "Sales Invoice"
                : "Sales Order",
            }];
          }
          assertEquals(options?.limit, 1000);
          return Array.from(
            { length: 1000 },
            (_, i) => ({
              name: `ROW-${i}`,
              parent: "SO-1",
              parenttype: "Sales Order",
            }),
          );
        },
      }),
      { company: "Vietnam Company" },
    );
    const error = await assertRejects(() =>
      context.listAllItems("Sales Order", { fields: ["base_amount"] })
    );
    if (failure === "permission") assertEquals(error, denied);
    assertEquals(pages, 2);
  });
}

for (const source of ["Sales Order", "Sales Invoice", "Warehouse"] as const) {
  for (const total of [0, 1000, 1001, 2000]) {
    Deno.test(`ownership discovery ${source} exhausts ${total} names before global top N`, async () => {
      const names = Array.from(
        { length: total },
        (_, i) => `DOC-${String(i).padStart(5, "0")}`,
      );
      const offsets: number[] = [];
      const bin = source === "Warehouse";
      let childReads = 0;
      const context = await resolveAnalyticsContext(
        fixture({
          list: async (doctype, options) => {
            if (doctype === source) {
              const offset = options?.limit_start ?? 0;
              offsets.push(offset);
              assertEquals(options?.order_by, "name asc");
              assertEquals(options?.limit, 1000);
              assertEquals(options?.filters, [
                ...(bin
                  ? []
                  : [["docstatus", "!=", 2] as [string, string, number]]),
                ["company", "=", "Vietnam Company"],
              ]);
              return names.slice(offset, offset + 1000).map((name) => ({
                name,
              }));
            }
            childReads++;
            assertEquals(offsets.at(-1), Math.floor(total / 1000) * 1000);
            const field = bin ? "warehouse" : "parent";
            const chunk = options!.filters!.find((f) =>
              f[0] === field
            )![2] as string[];
            return chunk.map((name) => ({
              name,
              [field]: name,
              parenttype: source,
              base_amount: names.indexOf(name),
              stock_value: names.indexOf(name),
            })).sort((a, b) => b.base_amount - a.base_amount).slice(0, 2);
          },
        }),
        { company: "Vietnam Company" },
      );
      const read = () =>
        bin
          ? context.listBins({ limit: 2, order_by: "stock_value desc" })
          : context.listItems(source, {
            limit: 2,
            order_by: "base_amount desc",
            filters: [["docstatus", "!=", 2]],
          });
      assertEquals(
        (await read()).map((row) => row.name),
        names.slice(-2).reverse(),
      );
      assertEquals(
        offsets,
        Array.from(
          { length: Math.floor(total / 1000) + 1 },
          (_, i) => i * 1000,
        ),
      );
      if (total === 0) assertEquals(childReads, 0);
      if (bin) {
        await read();
        assertEquals(offsets.length, Math.floor(total / 1000) + 1);
      }
    });
  }

  for (const failure of ["error", "repeat", "missing", "blank", "wrong-type"]) {
    Deno.test(`ownership discovery ${source} rejects later ${failure} without partial rows`, async () => {
      let childReads = 0;
      let pages = 0;
      const denied = new Error("Ownership page denied");
      const context = await resolveAnalyticsContext(
        fixture({
          list: async (doctype) => {
            if (doctype !== source) {
              childReads++;
              return [];
            }
            if (++pages === 1 || failure === "repeat") {
              return Array.from(
                { length: 1000 },
                (_, i) => ({ name: `DOC-${i}` }),
              );
            }
            if (failure === "error") throw denied;
            return [{
              name: failure === "blank"
                ? "  "
                : failure === "wrong-type"
                ? 42
                : undefined,
            }] as unknown as FrappeDoc[];
          },
        }),
        { company: "Vietnam Company" },
      );
      const error = await assertRejects(() =>
        source === "Warehouse"
          ? context.listBins({})
          : context.listItems(source, {})
      );
      if (failure === "error") assertEquals(error, denied);
      assertEquals(pages, 2);
      assertEquals(childReads, 0);
    });
  }
}

Deno.test("analytics context resolves the only visible VND company", async () => {
  const result = await resolveAnalyticsContext(fixture(), {});
  assertEquals(result.company, "Vietnam Company");
  assertEquals(result.currency, "VND");
});

Deno.test("ownership discovery fails explicitly at its resource guard instead of returning partial scope", async () => {
  let pages = 0;
  let childReads = 0;
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype, options) => {
        if (doctype !== "Warehouse") {
          childReads++;
          return [];
        }
        pages++;
        const offset = options!.limit_start!;
        return Array.from(
          { length: offset === 100000 ? 1 : 1000 },
          (_, i) => ({ name: `WH-${offset + i}` }),
        );
      },
    }),
    { company: "Vietnam Company" },
  );
  await assertRejects(
    () => context.listBins({}),
    Error,
    "100000 name safety limit",
  );
  await assertRejects(
    () => context.listBins({}),
    Error,
    "100000 name safety limit",
  );
  assertEquals(pages, 101);
  assertEquals(childReads, 0);
});

Deno.test("ownership discovery rejects oversized pages and duplicate names within one page", async () => {
  for (const oversized of [false, true]) {
    const context = await resolveAnalyticsContext(
      fixture({
        list: async (doctype) => {
          assertEquals(doctype, "Sales Invoice");
          return oversized
            ? Array.from({ length: 1001 }, (_, i) => ({ name: `INV-${i}` }))
            : [{ name: "INV-1" }, { name: "INV-1" }];
        },
      }),
      { company: "Vietnam Company" },
    );
    await assertRejects(
      () => context.listItems("Sales Invoice", {}),
      Error,
      oversized ? "requested size" : "unique progress",
    );
  }
});

Deno.test("Item units lookup deduplicates requested IDs and skips an empty set", async () => {
  let reads = 0;
  const ctx = fixture({
    list: async (doctype, options) => {
      reads++;
      assertEquals(doctype, "Item");
      assertEquals(options, {
        fields: ["name", "stock_uom"],
        filters: [["name", "in", ["ITEM-1"]]],
        limit: 1,
        order_by: "name asc",
      });
      return [{ name: "ITEM-1", stock_uom: "Unit" }];
    },
  });
  assertEquals(await listAnalyticsItemUnits(ctx, []), []);
  assertEquals(await listAnalyticsItemUnits(ctx, ["ITEM-1", "ITEM-1"]), [{
    name: "ITEM-1",
    stock_uom: "Unit",
  }]);
  assertEquals(reads, 1);
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
    Deno.test(`analytics scope URI - ${source} preserves global top N with ${longNames ? "long Unicode" : "1001"} names`, async () => {
      const names = Array.from(
        { length: longNames ? 40 : 1001 },
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
          const offset = Number(url.searchParams.get("limit_start") ?? 0);
          return Response.json({
            data: names.slice(offset, offset + 1000).map((name) => ({ name })),
          });
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
              return names.slice(
                options?.limit_start ?? 0,
                (options?.limit_start ?? 0) + 1000,
              ).map((name) => ({ name }));
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
          return names.slice(
            options?.limit_start ?? 0,
            (options?.limit_start ?? 0) + 1000,
          ).map((name) => ({ name }));
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

Deno.test("complete scope enforces one shared 1000 request budget across 1001 empty chunks", async () => {
  const names = Array.from(
    { length: 1001 },
    (_, i) => `WH-${i}-${"東京".repeat(250)}`,
  );
  let ownershipReads = 0;
  let binReads = 0;
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype, options) => {
        if (doctype === "Warehouse") {
          ownershipReads++;
          const offset = options!.limit_start!;
          return names.slice(offset, offset + options!.limit!).map((name) => ({
            name,
          }));
        }
        assertEquals(doctype, "Bin");
        binReads++;
        return [];
      },
    }),
    { company: "Vietnam Company" },
  );
  await assertRejects(
    () => context.listAllBins({ fields: ["actual_qty"] }),
    Error,
    "1000 request safety limit",
  );
  assertEquals(ownershipReads, 2);
  assertEquals(binReads, 1000);
});

Deno.test("Item UOM rejects 1001 encoded chunks before sending any lookup", async () => {
  let reads = 0;
  const names = Array.from(
    { length: 1001 },
    (_, i) => `ITEM-${i}-${"東京".repeat(250)}`,
  );
  await assertRejects(
    () =>
      listAnalyticsItemUnits(
        fixture({
          list: async () => {
            reads++;
            return [];
          },
        }),
        names,
      ),
    Error,
    "safety budget",
  );
  assertEquals(reads, 0);
});

Deno.test("complete scoped rows reject duplicate identities across disjoint warehouse chunks", async () => {
  const names = ["WH-A", "WH-B"].map((name) => `${name}-${"東京".repeat(250)}`);
  const context = await resolveAnalyticsContext(
    fixture({
      list: async (doctype, options) => {
        if (doctype === "Warehouse") return names.map((name) => ({ name }));
        const chunk = options!.filters!.find((filter) =>
          filter[0] === "warehouse"
        )![2] as string[];
        assertEquals(chunk.length, 1);
        return [{
          name: "DUPLICATE",
          warehouse: chunk[0],
          modified: "2026-09-05 12:00:00",
        }];
      },
    }),
    { company: "Vietnam Company" },
  );
  await assertRejects(
    () => context.listAllBins({}),
    Error,
    "duplicate row across scope chunks",
  );
});
