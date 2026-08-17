/**
 * List Result Tests
 *
 * Covers the total-count contract shared by every list tool: `count` is the
 * number of matching documents, not the size of the page that came back.
 *
 * @module lib/erpnext/tests/tools/list-result_test
 */

// deno-lint-ignore-file no-explicit-any

import { assertEquals } from "@std/assert";
import { listResult, resolveTotal } from "./list-result.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "NEW-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    callMethodRaw: async () => ({}),
    invalidate: () => {},
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

const rows = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ name: `DOC-${index}` }));

Deno.test("resolveTotal - a short page needs no count call", async () => {
  let called = 0;
  const client = makeMockClient({
    callMethod: async () => {
      called++;
      return 999;
    },
  });

  const total = await resolveTotal(makeCtx(client), "Account", [], 12, 50);

  assertEquals(total, 12);
  assertEquals(called, 0);
});

Deno.test("resolveTotal - a full page asks ERPNext for the real total", async () => {
  let seenMethod = "";
  let seenArgs: Record<string, unknown> = {};
  const client = makeMockClient({
    callMethod: async (method: string, args: Record<string, unknown>) => {
      seenMethod = method;
      seenArgs = args;
      return 97;
    },
  });

  const filters = [["root_type", "=", "Expense"]];
  const total = await resolveTotal(
    makeCtx(client),
    "Account",
    filters as any,
    50,
    50,
  );

  assertEquals(total, 97);
  assertEquals(seenMethod, "frappe.client.get_count");
  assertEquals(seenArgs.doctype, "Account");
  // The count must carry the same filters as the list, or it counts a different set.
  assertEquals(seenArgs.filters, filters);
});

Deno.test("resolveTotal - a total below the page in hand is rejected", async () => {
  const client = makeMockClient({ callMethod: async () => 3 });
  assertEquals(await resolveTotal(makeCtx(client), "Account", [], 50, 50), 50);
});

Deno.test("resolveTotal - an unparseable total falls back to the page length", async () => {
  const client = makeMockClient({ callMethod: async () => "not a number" });
  assertEquals(await resolveTotal(makeCtx(client), "Account", [], 50, 50), 50);
});

Deno.test("resolveTotal - a failing count call never breaks the list", async () => {
  const client = makeMockClient({
    callMethod: async () => {
      throw new Error("boom");
    },
  });
  assertEquals(await resolveTotal(makeCtx(client), "Account", [], 50, 50), 50);
});

Deno.test("listResult - a truncated page reports the total and flags has_more", async () => {
  const client = makeMockClient({ callMethod: async () => 97 });

  const result = await listResult(makeCtx(client), "Account", rows(50), {
    filters: [],
    limit: 50,
  });

  assertEquals(result.doctype, "Account");
  assertEquals(result.count, 97);
  assertEquals(result.returned, 50);
  assertEquals(result.has_more, true);
  assertEquals(result.data.length, 50);
});

Deno.test("listResult - a complete page is not flagged has_more", async () => {
  const result = await listResult(
    makeCtx(makeMockClient()),
    "Account",
    rows(4),
    {
      filters: [],
      limit: 50,
    },
  );

  assertEquals(result.count, 4);
  assertEquals(result.returned, 4);
  assertEquals(result.has_more, false);
});
