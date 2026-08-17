/**
 * Link Resolution Tests
 *
 * @module lib/erpnext/tests/api/resolve_test
 */

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  AmbiguousLinkError,
  resolveDynamicLink,
  resolveEmployee,
  resolveLink,
} from "./resolve.ts";
import { FrappeAPIError, type FrappeClient } from "./frappe-client.ts";
import { clearCallerProfileCache } from "./identity.ts";
import { setCache } from "../cache/cache.ts";
import { MemoryCache } from "../cache/memory.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    get: async () => {
      throw new FrappeAPIError("not found", 404, null);
    },
    list: async () => [],
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

Deno.test("resolveLink - fast path: identifier is already a valid ID", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    get: async (_doctype: string, name: string) => ({ name }),
  });
  const result = await resolveLink(
    client,
    "Employee",
    "HR-EMP-00001",
    "employee_name",
  );
  assertEquals(result, "HR-EMP-00001");
});

Deno.test("resolveLink - falls back to exact match on search field", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      const [field, op] = (options.filters?.[0] as [string, string, string]) ??
        [];
      if (field === "employee_name" && op === "=") {
        return [{ name: "HR-EMP-00002" }];
      }
      return [];
    },
  });
  const result = await resolveEmployee(client, "John Doe");
  assertEquals(result, "HR-EMP-00002");
});

Deno.test("resolveLink - throws with candidate list when the exact match is ambiguous", async () => {
  // customer_name/employee_name/etc. aren't unique keys in ERPNext — two
  // Employees can share the exact same employee_name.
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      const [field, op] = (options.filters?.[0] as [string, string, string]) ??
        [];
      if (field === "employee_name" && op === "=") {
        return [
          { name: "HR-EMP-00002", employee_name: "John Doe" },
          { name: "HR-EMP-00009", employee_name: "John Doe" },
        ];
      }
      return [];
    },
  });
  const error = await assertRejects(() =>
    resolveEmployee(client, "John Doe", { inputPath: "employee" })
  );
  assertInstanceOf(error, AmbiguousLinkError);
  assertEquals(error.message.includes("Ambiguous Employee identifier"), true);
  assertEquals(error.doctype, "Employee");
  assertEquals(error.identifier, "John Doe");
  assertEquals(error.inputPath, "employee");
  assertEquals(error.candidates, [
    { id: "HR-EMP-00002", label: "John Doe" },
    { id: "HR-EMP-00009", label: "John Doe" },
  ]);
  assertEquals(error.truncated, true);
});

Deno.test("resolveLink - exact-match ambiguity still throws when allowPartialMatch is false", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      const [field, op] = (options.filters?.[0] as [string, string, string]) ??
        [];
      if (field === "employee_name" && op === "=") {
        return [
          { name: "HR-EMP-00002", employee_name: "John Doe" },
          { name: "HR-EMP-00009", employee_name: "John Doe" },
        ];
      }
      return [];
    },
  });
  await assertRejects(
    () =>
      resolveLink(client, "Employee", "John Doe", "employee_name", {
        allowPartialMatch: false,
      }),
    Error,
    "Ambiguous Employee identifier",
  );
});

Deno.test("resolveLink - falls back to partial match when exact match misses", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      const [, op] = (options.filters?.[0] as [string, string, string]) ?? [];
      if (op === "like") return [{ name: "HR-EMP-00003" }];
      return [];
    },
  });
  const result = await resolveEmployee(client, "John");
  assertEquals(result, "HR-EMP-00003");
});

Deno.test("resolveLink - throws with candidate list when partial match is ambiguous", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      const [, op] = (options.filters?.[0] as [string, string, string]) ?? [];
      if (op === "like") {
        return [
          { name: "HR-EMP-00003", employee_name: "John Doe" },
          { name: "HR-EMP-00004", employee_name: "Johnny Smith" },
        ];
      }
      return [];
    },
  });
  await assertRejects(
    () => resolveEmployee(client, "John"),
    Error,
    "Ambiguous Employee identifier",
  );
});

Deno.test("resolveLink - skips partial match entirely when allowPartialMatch is false", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      const [, op] = (options.filters?.[0] as [string, string, string]) ?? [];
      if (op === "like") return [{ name: "HR-EMP-00003" }];
      return [];
    },
  });
  await assertRejects(
    () =>
      resolveLink(client, "Employee", "John", "employee_name", {
        allowPartialMatch: false,
      }),
    Error,
    'No Employee found matching "John"',
  );
});

Deno.test("resolveLink - throws when nothing matches", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient();
  await assertRejects(
    () => resolveEmployee(client, "Nobody"),
    Error,
    'No Employee found matching "Nobody"',
  );
});

Deno.test("resolveLink - rethrows non-404 errors from the fast-path get", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    get: async () => {
      throw new FrappeAPIError("server error", 500, null);
    },
  });
  await assertRejects(
    () => resolveEmployee(client, "HR-EMP-00001"),
    FrappeAPIError,
  );
});

Deno.test("resolveLink - caches a confirmed 404 so repeat calls skip the get() probe", async () => {
  setCache(new MemoryCache());
  let getCount = 0;
  let listCount = 0;
  const client = makeMockClient({
    get: async () => {
      getCount++;
      throw new FrappeAPIError("not found", 404, null);
    },
    list: async (_doctype: string, options: { filters?: unknown[] }) => {
      listCount++;
      const [field, op] = (options.filters?.[0] as [string, string, string]) ??
        [];
      if (field === "employee_name" && op === "=") {
        return [{ name: "HR-EMP-00002" }];
      }
      return [];
    },
  });

  await resolveEmployee(client, "John Doe");
  await resolveEmployee(client, "John Doe");

  assertEquals(
    getCount,
    1,
    "second call should skip the fast-path get() probe",
  );
  assertEquals(
    listCount,
    2,
    "list() fallback still runs each call (not memoized itself)",
  );
});

Deno.test("resolveDynamicLink - resolves against the target doctype's search field", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    list: async (doctype: string, options: { filters?: unknown[] }) => {
      const [field, , value] =
        (options.filters?.[0] as [string, string, string]) ?? [];
      if (
        doctype === "Supplier" && field === "supplier_name" &&
        value === "Acme Supplies"
      ) {
        return [{ name: "SUPP-00042" }];
      }
      return [];
    },
  });
  const result = await resolveDynamicLink(client, "Supplier", "Acme Supplies");
  assertEquals(result, "SUPP-00042");
});

Deno.test("resolveDynamicLink - passes identifier through unresolved for an unsupported target doctype", async () => {
  const client = makeMockClient();
  const result = await resolveDynamicLink(
    client,
    "Not A Real Doctype",
    "whatever",
  );
  assertEquals(result, "whatever");
});

Deno.test("resolveDynamicLink - supports Customer, Employee, and Lead targets", async () => {
  setCache(new MemoryCache());
  const searchFieldByDoctype: Record<string, string> = {
    Customer: "customer_name",
    Employee: "employee_name",
    Lead: "lead_name",
  };
  for (const [doctype, searchField] of Object.entries(searchFieldByDoctype)) {
    const client = makeMockClient({
      list: async (dt: string, options: { filters?: unknown[] }) => {
        const [field] = (options.filters?.[0] as [string, string, string]) ??
          [];
        if (dt === doctype && field === searchField) {
          return [{ name: `${doctype}-ID` }];
        }
        return [];
      },
    });
    const result = await resolveDynamicLink(client, doctype, "some name");
    assertEquals(result, `${doctype}-ID`);
  }
});

Deno.test("resolveLink - answers `me` on the paths that never call resolveEmployee", async () => {
  setCache(new MemoryCache());
  clearCallerProfileCache();
  let lookups = 0;
  const client = makeMockClient({
    callMethod: async () => "khoa.do@havigroup.com",
    get: async (_doctype: string, name: string) => ({
      name,
      enabled: 1,
      user_type: "System User",
      roles: [],
    }),
    list: async (doctype: string) => {
      if (doctype === "Employee") {
        lookups++;
        return [{ name: "HR-EMP-00044", employee_name: "Do Khoa" }];
      }
      return [];
    },
  });

  // `erpnext_employee_get` and the Leave Application / Expense Claim create handlers call
  // `resolveLink(..., "Employee", ...)` straight, and `resolveDynamicLink` re-enters this
  // very function. None of them pass through `resolveEmployee`, so a guard living on that
  // wrapper left `me` to be searched as a literal employee name on every one of them.
  assertEquals(
    await resolveLink(client, "Employee", "me", "employee_name"),
    "HR-EMP-00044",
  );
  assertEquals(
    await resolveDynamicLink(client, "Employee", "myself"),
    "HR-EMP-00044",
  );
  // The self lookup is the caller-profile query, never a name search: one query for two
  // calls, and the second is served from the profile cache.
  assertEquals(lookups, 1);
});

Deno.test("resolveLink - answers `me` for user-typed inputs too", async () => {
  setCache(new MemoryCache());
  clearCallerProfileCache();
  const client = makeMockClient({
    callMethod: async () => "khoa.do@havigroup.com",
  });

  assertEquals(
    await resolveLink(client, "User", "@me", "full_name"),
    "khoa.do@havigroup.com",
  );
});

Deno.test("resolveLink - leaves `me` alone for doctypes that are not people", async () => {
  setCache(new MemoryCache());
  const client = makeMockClient({
    get: async (_doctype: string, name: string) => ({ name }),
  });

  // Control: the self-reference table is keyed by doctype, so a Customer literally named
  // "me" still resolves as a name. Without this, the fix would silently hijack every
  // doctype that ever receives the string.
  assertEquals(
    await resolveLink(client, "Customer", "me", "customer_name"),
    "me",
  );
});
