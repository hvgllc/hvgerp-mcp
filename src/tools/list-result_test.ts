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

  assertEquals(total.count, 12);
  assertEquals(total.error, undefined);
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

  assertEquals(total.count, 97);
  assertEquals(seenMethod, "frappe.client.get_count");
  assertEquals(seenArgs.doctype, "Account");
  // The count must carry the same filters as the list, or it counts a different set.
  assertEquals(seenArgs.filters, filters);
});

Deno.test("resolveTotal - a total below the page in hand is unknown, not the page length", async () => {
  const client = makeMockClient({ callMethod: async () => 3 });

  const total = await resolveTotal(makeCtx(client), "Account", [], 50, 50);

  // Reporting 50 here is exactly the lie this module exists to remove.
  assertEquals(total.count, null);
  assertEquals(typeof total.error, "string");
});

Deno.test("resolveTotal - an unparseable total is unknown, not the page length", async () => {
  const client = makeMockClient({ callMethod: async () => "not a number" });

  const total = await resolveTotal(makeCtx(client), "Account", [], 50, 50);

  assertEquals(total.count, null);
  assertEquals(typeof total.error, "string");
});

Deno.test("resolveTotal - a non-numeric count on an empty page is unknown, not zero", async () => {
  // `Number()` turns all of these into 0, and against an empty page that 0
  // clears the "below the page in hand" check and is reported as "no matching
  // documents" - a confident answer assembled from a response that carried no
  // count at all. The limit is unusable so the short-page shortcut cannot fire
  // and the count call is really made.
  for (const raw of [null, undefined, "", [], {}, false, true]) {
    const client = makeMockClient({ callMethod: async () => raw });

    const total = await resolveTotal(
      makeCtx(client),
      "Account",
      [],
      0,
      Number.NaN,
    );

    assertEquals(total.count, null);
    assertEquals(typeof total.error, "string");
  }
});

Deno.test("resolveTotal - a numeric string total is still accepted", async () => {
  const client = makeMockClient({ callMethod: async () => "97" });

  const total = await resolveTotal(makeCtx(client), "Account", [], 50, 50);

  assertEquals(total.count, 97);
});

Deno.test("resolveTotal - a failing count call yields an unknown total, not a throw", async () => {
  const client = makeMockClient({
    callMethod: async () => {
      throw new Error("boom");
    },
  });

  const total = await resolveTotal(makeCtx(client), "Account", [], 50, 50);

  assertEquals(total.count, null);
  // The reason travels with the result, so the failure is reported rather than hidden.
  assertEquals(total.error?.includes("boom"), true);
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
  assertEquals("count_error" in result, false);
});

Deno.test("listResult - an unresolvable total never claims the page is everything", async () => {
  const client = makeMockClient({
    callMethod: async () => {
      throw new Error("get_count exploded");
    },
  });

  const result = await listResult(makeCtx(client), "Account", rows(50), {
    filters: [],
    limit: 50,
  });

  assertEquals(result.count, null);
  assertEquals(result.returned, 50);
  // A consumer that only reads has_more must not conclude the list is complete.
  assertEquals(result.has_more, true);
  assertEquals(result.count_error?.includes("get_count exploded"), true);
  assertEquals(result.data.length, 50);
  // A full page with an unknown total MAY be the whole result set - 50 of 50 is
  // an ordinary outcome. Calling it incomplete states as fact something this
  // code cannot know, which is the same overreach as calling it complete.
  assertEquals(result.count_error?.includes("may not be the whole"), true);
  assertEquals(result.count_error?.includes("but incomplete"), false);
});

Deno.test("resolveTotal - a fractional limit never passes off a full page as the total", async () => {
  let calls = 0;
  const client = makeMockClient({
    callMethod: async () => {
      calls++;
      return 97;
    },
  });

  // Frappe truncates `limit: 2.5` to 2 rows. Comparing the page it returned
  // against the limit as typed reads 2 < 2.5 as "that is everything", which is
  // how a truncated list ends up reported as the whole result set.
  const total = await resolveTotal(
    makeCtx(client),
    "Account",
    undefined,
    2,
    2.5,
  );

  assertEquals(calls, 1);
  assertEquals(total.count, 97);
});

Deno.test("resolveTotal - an unusable limit falls back to the count instead of throwing", async () => {
  let calls = 0;
  const client = makeMockClient({
    callMethod: async () => {
      calls++;
      return 12;
    },
  });

  for (const limit of [Number.NaN, 0, -5]) {
    const total = await resolveTotal(
      makeCtx(client),
      "Account",
      undefined,
      3,
      limit,
    );
    assertEquals(total.count, 12);
  }
  // `normalizeLimit` throws on these, so the guard here has to be the
  // non-throwing predicate: this function resolves a total for documents the
  // caller is already holding, and throwing would destroy a successful list.
  assertEquals(calls, 3);
});
