import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FrappeClient } from "../api/frappe-client.ts";
import { MemoryCache } from "../cache/memory.ts";
import { operationsTools } from "./operations.ts";
import {
  applyAssignment,
  assignedToFilter,
  fetchDocAfterAssignment,
  prepareAssignment,
  removeAssignment,
  resolveAssignees,
  validateAssignees,
} from "./assignment.ts";
import { clearCallerProfileCache } from "../api/identity.ts";
import type { ErpNextToolContext } from "./types.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

function makeCtx(overrides: Record<string, AnyFn> = {}): ErpNextToolContext {
  const client = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "TEST-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    invalidate: () => {},
    ...overrides,
  } as unknown as FrappeClient;
  return { client };
}

Deno.test("prepareAssignment returns undefined without assign_to", () => {
  assertEquals(prepareAssignment({}, "tool"), undefined);
});

for (const action of ["assign", "unassign"] as const) {
  for (const warm of [false, true]) {
    Deno.test(`native ${action} refreshes document and related caches (${warm ? "warm" : "cold"})`, async () => {
      const originalFetch = globalThis.fetch;
      const caches = [new MemoryCache(), new MemoryCache()];
      const [client, peer] = caches.map((cache) =>
        new FrappeClient({
          baseUrl: "https://assignment.example.test",
          apiKey: "test-key",
          apiSecret: "test-secret",
          retries: 0,
          cache,
          cachePeers: () => caches,
        })
      );
      const reads = new Map<string, number>();
      let mutations = 0;
      const before = action === "assign" ? "[]" : '["user@example.com"]';
      const after = action === "assign" ? '["user@example.com"]' : "[]";
      const currentDoc = () => ({
        name: "TASK-001",
        _assign: mutations ? after : before,
      });
      globalThis.fetch = (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === "POST") {
          assertEquals(
            path,
            `/api/method/frappe.desk.form.assign_to.${
              action === "assign" ? "add" : "remove"
            }`,
          );
          mutations++;
          return Promise.resolve(
            Response.json({
              message: [{ owner: "other@example.com", name: "TODO-KNOWN" }],
            }),
          );
        }
        reads.set(path, (reads.get(path) ?? 0) + 1);
        const data = path === "/api/resource/Task/TASK-001"
          ? currentDoc()
          : path === "/api/resource/Task"
          ? [currentDoc()]
          : path === "/api/resource/ToDo"
          ? [{ name: "TODO-KNOWN", revision: mutations }]
          : path === "/api/resource/User"
          ? [{ name: "user@example.com", enabled: 1 }]
          : { name: path.split("/").at(-1), revision: mutations };
        return Promise.resolve(Response.json({ data }));
      };
      try {
        for (const reader of [client, peer]) {
          await reader.get("Project", "UNRELATED");
          await reader.get("ToDo", "TODO-UNRETURNED");
          if (warm) {
            await reader.get("Task", "TASK-001");
            await reader.list("Task");
            await reader.list("ToDo");
            await reader.get("ToDo", "TODO-KNOWN");
          }
        }
        const beforeReads = new Map(reads);
        const tool = operationsTools.find((tool) =>
          tool.name === `erpnext_doc_${action}`
        )!;
        const result = await tool.handler({
          doctype: "Task",
          name: "TASK-001",
          assign_to: "user@example.com",
        }, { client }) as { data: Record<string, unknown> };
        assertEquals(
          result.data._assign,
          after,
          "the response must not reuse the pre-mutation document",
        );
        assertEquals(
          mutations,
          1,
          "cache refresh must not repeat the native mutation",
        );
        const targetReadsAfterMutation = warm ? 3 : action === "assign" ? 2 : 1;
        assertEquals(
          reads.get("/api/resource/Task/TASK-001"),
          targetReadsAfterMutation,
        );
        for (const reader of [client, peer]) {
          assertEquals((await reader.get("Task", "TASK-001"))._assign, after);
          assertEquals((await reader.list("Task"))[0]._assign, after);
          assertEquals((await reader.list("ToDo"))[0].revision, 1);
          assertEquals((await reader.get("ToDo", "TODO-KNOWN")).revision, 1);
          assertEquals((await reader.get("Project", "UNRELATED")).revision, 0);
          assertEquals(
            (await reader.get("ToDo", "TODO-UNRETURNED")).revision,
            0,
          );
        }
        for (
          const path of [
            "/api/resource/Task",
            "/api/resource/ToDo",
            "/api/resource/ToDo/TODO-KNOWN",
          ]
        ) {
          assertEquals(
            reads.get(path),
            (beforeReads.get(path) ?? 0) + 2,
            `${path} must reach the network for both callers`,
          );
        }
        assertEquals(
          reads.get("/api/resource/Task/TASK-001"),
          targetReadsAfterMutation + 1,
        );
        assertEquals(reads.get("/api/resource/Project/UNRELATED"), 2);
        assertEquals(reads.get("/api/resource/ToDo/TODO-UNRETURNED"), 2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
}

Deno.test("fetchDocAfterAssignment explicitly bypasses an already populated cache", async () => {
  const originalFetch = globalThis.fetch;
  const client = new FrappeClient({
    baseUrl: "https://assignment.example.test",
    apiKey: "test-key",
    apiSecret: "test-secret",
    cache: new MemoryCache(),
  });
  let reads = 0;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({ data: { name: "TASK-001", revision: ++reads } }),
    );
  try {
    await client.get("Task", "TASK-001");
    assertEquals(
      (await fetchDocAfterAssignment("Task", "TASK-001", { client }, "test"))
        .revision,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const action of ["assign", "unassign"] as const) {
  Deno.test(`native ${action} invalidates only after successful mutation`, async () => {
    const events: unknown[] = [];
    const original = new Error("native rejected");
    const ctx = makeCtx({
      callMethod: async () => {
        events.push("mutation");
        throw original;
      },
      invalidate: (...args: unknown[]) => events.push(args),
    });
    const run = () =>
      action === "assign"
        ? applyAssignment(
          "Task",
          "TASK-001",
          { assignees: ["user@example.com"], args: {} },
          ctx,
          "assignment failed",
        )
        : removeAssignment(
          "Task",
          "TASK-001",
          "user@example.com",
          ctx,
          "assignment failed",
        );
    const error = await assertRejects(
      run,
      Error,
      "assignment failed: native rejected",
    );
    assertEquals(error.cause, original);
    assertEquals(events, ["mutation"]);
  });

  for (const nativeResult of [null, [], [{ owner: "user@example.com" }]]) {
    Deno.test(`native ${action} without ToDo IDs still invalidates target and lists (${JSON.stringify(nativeResult)})`, async () => {
      const invalidations: unknown[][] = [];
      const ctx = makeCtx({
        callMethod: async () => nativeResult,
        invalidate: (...args: unknown[]) => invalidations.push(args),
      });
      if (action === "assign") {
        await applyAssignment(
          "Task",
          "TASK-001",
          { assignees: ["user@example.com"], args: {} },
          ctx,
          "assignment failed",
        );
      } else {
        await removeAssignment(
          "Task",
          "TASK-001",
          "user@example.com",
          ctx,
          "unassignment failed",
        );
      }
      assertEquals(invalidations, [["Task", "TASK-001"], ["ToDo"]]);
    });
  }
}

Deno.test("prepareAssignment trims and deduplicates assignees", () => {
  const prepared = prepareAssignment(
    { assign_to: [" a@example.com ", "a@example.com", "b@example.com"] },
    "tool",
  );
  assertEquals(prepared?.assignees, ["a@example.com", "b@example.com"]);
});

Deno.test("prepareAssignment caps the number of distinct assignees", () => {
  const assignees = Array.from(
    { length: 51 },
    (_, i) => `user${i}@example.com`,
  );
  assertThrows(
    () => prepareAssignment({ assign_to: assignees }, "tool"),
    Error,
    "at most 50 distinct users per call (got 51)",
  );
});

Deno.test("prepareAssignment accepts exactly 50 distinct assignees", () => {
  const assignees = Array.from(
    { length: 50 },
    (_, i) => `user${i}@example.com`,
  );
  const prepared = prepareAssignment({ assign_to: assignees }, "tool");
  assertEquals(prepared?.assignees.length, 50);
});

Deno.test("validateAssignees reports the first missing user", async () => {
  await assertRejects(
    () =>
      validateAssignees(
        ["a@example.com", "b@example.com"],
        "tool",
        makeCtx({ list: async () => [{ name: "b@example.com", enabled: 1 }] }),
      ),
    Error,
    "User 'a@example.com' does not exist",
  );
});

Deno.test("fetchDocAfterAssignment marks re-fetch failures as post-assignment", async () => {
  const original = new Error("HTTP 502 Bad Gateway");
  const ctx = makeCtx({
    get: async () => {
      throw original;
    },
  });
  const rejection = await assertRejects(
    () =>
      fetchDocAfterAssignment("Task", "TASK-001", ctx, "erpnext_task_update"),
    Error,
    "Task TASK-001 assignment succeeded, but re-fetching the document failed: HTTP 502 Bad Gateway",
  );
  assertEquals((rejection as Error).cause, original);
});

// -- assignedToFilter ---------------------------------------------------------

/**
 * The escaped pattern is asserted against MariaDB semantics, not against a hunch. Measured on the
 * stack's own MariaDB 11.8, comparing a raw pattern with an escaped one:
 *
 * | pattern                            | `["john_doe@x.com"]` | `["johnXdoe@x.com"]` |
 * |---|---|---|
 * | `%"john_doe@x.com"%` (raw)         | 1                    | **1** <- another person |
 * | `%"john\_doe@x.com"%` (escaped)    | 1                    | 0                    |
 *
 * `@@sql_mode` carries no `NO_BACKSLASH_ESCAPES`, so the backslash really is the escape character
 * on this deployment.
 */
Deno.test("assignedToFilter escapes the wildcards a User id may contain", () => {
  assertEquals(
    assignedToFilter("john_doe@example.com"),
    ["_assign", "like", '%"john\\_doe@example.com"%'],
    "an unescaped `_` matches ANY character, so the filter would also return work assigned to " +
      "john-doe@example.com and johnXdoe@example.com",
  );
  assertEquals(
    assignedToFilter("a%b@example.com"),
    ["_assign", "like", '%"a\\%b@example.com"%'],
    "an unescaped `%` matches any run of characters - the same leak with a wider blast radius",
  );
  assertEquals(
    assignedToFilter("back\\slash@example.com"),
    ["_assign", "like", '%"back\\\\slash@example.com"%'],
    "the backslash must be escaped first, or it would escape the escapes added after it",
  );
});

Deno.test("assignedToFilter leaves an ordinary id untouched (control)", () => {
  assertEquals(
    assignedToFilter("tu.pham@havigroup.com"),
    ["_assign", "like", '%"tu.pham@havigroup.com"%'],
    "a dot is not a LIKE wildcard; escaping must not turn every real id into a different string",
  );
});

Deno.test("resolveAssignees translates `@me` instead of passing it through as an ID", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({ callMethod: async () => "khoa.do@havigroup.com" });

  // `@me` and `@self` are both self-references AND both carry an at-sign, so the
  // "already an address, nothing to resolve" shortcut claimed them first and
  // `validateAssignees` answered `User '@me' does not exist` - which reads as a missing
  // colleague rather than as an input the server was supposed to translate.
  const resolved = await resolveAssignees(
    { assignees: ["@me"], args: {} },
    ctx,
  );
  assertEquals(resolved.assignees, ["khoa.do@havigroup.com"]);
  assertEquals(resolved.args.assign_to, ["khoa.do@havigroup.com"]);
});

Deno.test("resolveAssignees still passes a real address through untouched", async () => {
  let lookups = 0;
  const ctx = makeCtx({
    list: async () => {
      lookups++;
      return [];
    },
  });

  // Control: the shortcut is what keeps the common case free of a lookup per assignee.
  const resolved = await resolveAssignees(
    { assignees: ["huong.ngo@havigroup.com"], args: {} },
    ctx,
  );
  assertEquals(resolved.assignees, ["huong.ngo@havigroup.com"]);
  assertEquals(lookups, 0);
});
