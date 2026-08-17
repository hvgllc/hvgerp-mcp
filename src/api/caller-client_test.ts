/**
 * Per-caller client selection, cache backend, and cross-caller invalidation.
 *
 * Every test here goes red on the code as it stood before the fixes, which is the point: the three
 * defects they cover were all invisible to the existing suite because they only appear when a
 * service-account call and an identity-carrying call meet in the SAME process (`optional` mode).
 *
 * @module lib/erpnext/src/api/caller-client_test
 */

import { assert, assertEquals } from "@std/assert";
import { getFrappeClient, setFrappeClient } from "./frappe-client.ts";
import { runWithCaller } from "./caller-context.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

interface Recorded {
  url: string;
  authorization: string | null;
}

/** Replace `fetch` with a recorder answering every request with `body`. */
function recordFetch(body: (call: number) => unknown): {
  calls: Recorded[];
  restore: () => void;
} {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get("authorization"),
    });
    return Promise.resolve(
      new Response(JSON.stringify(body(calls.length - 1)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Run `fn` with `vars` applied to the process env, restoring the previous values afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  // Drop any client left over from an earlier test, so the singletons under test start empty.
  setFrappeClient(null);
  try {
    await fn();
  } finally {
    setFrappeClient(null);
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const STATIC_ENV = {
  ERPNEXT_URL: "http://localhost:8000",
  ERPNEXT_API_KEY: "static-key",
  ERPNEXT_API_SECRET: "static-secret",
};

const listBody = () => ({ data: [{ name: "TASK-001", subject: "First" }] });

// ── Client selection ──────────────────────────────────────────────────────────

Deno.test("getFrappeClient() - a caller in scope outranks the service-account singleton", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch(listBody);
    try {
      // An anonymous call first: this is what `MCP_CALLER_IDENTITY=optional` allows, and what a
      // startup cache warm does. It builds the process-wide service-account client.
      await getFrappeClient().list("Task");
      assertEquals(calls[0].authorization, "token static-key:static-secret");

      // Now a call that DOES carry an identity. It must be served as that user.
      await runWithCaller(
        { accessToken: "tok-anh", principal: "anh.le@havigroup.com" },
        () => getFrappeClient().list("Project"),
      );

      assertEquals(
        calls[1].authorization,
        "HVGKeycloak tok-anh",
        "the forwarded identity must win over the service account; when the two roles shared one " +
          "variable, every OAuth call after the first anonymous one ran under the shared API key",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("getFrappeClient() - an injected client still outranks a caller", async () => {
  await withEnv(STATIC_ENV, async () => {
    const injected = getFrappeClient();
    setFrappeClient(injected);
    try {
      const seen = runWithCaller(
        { accessToken: "tok-khoa", principal: "khoa.do@havigroup.com" },
        () => getFrappeClient(),
      );
      assert(
        seen === injected,
        "dependency injection is the outermost override; a test that installs a client must not " +
          "have it bypassed by whatever identity happens to be in scope",
      );
    } finally {
      setFrappeClient(null);
    }
  });
});

// ── Cache backend ─────────────────────────────────────────────────────────────

Deno.test("caller client - honours MCP_CACHE_ENABLED=false", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: "false" }, async () => {
    const { calls, restore } = recordFetch(listBody);
    try {
      const caller = {
        accessToken: "tok-chi",
        principal: "chi.mai@havigroup.com",
      };
      await runWithCaller(caller, () => getFrappeClient().list("Task"));
      await runWithCaller(caller, () => getFrappeClient().list("Task"));

      assertEquals(
        calls.length,
        2,
        "caching is off, so the second identical read must reach the network; hard-coding a " +
          "MemoryCache for caller clients made the operator's switch apply to only some caches",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("caller client - caches reads when caching is left enabled (control)", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch(listBody);
    try {
      const caller = {
        accessToken: "tok-chi",
        principal: "chi.mai@havigroup.com",
      };
      await runWithCaller(caller, () => getFrappeClient().list("Task"));
      await runWithCaller(caller, () => getFrappeClient().list("Task"));

      assertEquals(
        calls.length,
        1,
        "with caching on, the second read is served from the caller's own cache",
      );
    } finally {
      restore();
    }
  });
});

// ── Cross-caller invalidation ─────────────────────────────────────────────────

Deno.test("caller clients - a write by one caller invalidates the others' cached reads", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch((call) =>
      call === 2
        ? { data: { name: "TASK-002", subject: "Written" } }
        : listBody()
    );
    try {
      const anh = { accessToken: "tok-anh", principal: "anh.le@havigroup.com" };
      const khoa = {
        accessToken: "tok-khoa",
        principal: "khoa.do@havigroup.com",
      };

      await runWithCaller(anh, () => getFrappeClient().list("Task")); // call 0
      await runWithCaller(khoa, () => getFrappeClient().list("Task")); // call 1
      assertEquals(calls.length, 2, "each caller reads through their own cache");

      await runWithCaller(
        anh,
        () => getFrappeClient().create("Task", { subject: "Written" }),
      ); // call 2
      assertEquals(calls.length, 3);

      await runWithCaller(khoa, () => getFrappeClient().list("Task"));

      assertEquals(
        calls.length,
        4,
        "the other caller must re-read after the write; per-caller caches isolate VALUES, but a " +
          "mutation still has to clear the matching keys everywhere, which the single shared " +
          "cache used to do for free",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("caller clients - invalidation crosses caches without sharing values (control)", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch(() => ({
      data: [{ name: "TASK-001", subject: `read-${Math.random()}` }],
    }));
    try {
      const anh = { accessToken: "tok-anh", principal: "anh.le@havigroup.com" };
      const khoa = {
        accessToken: "tok-khoa",
        principal: "khoa.do@havigroup.com",
      };

      const first = await runWithCaller(
        anh,
        () => getFrappeClient().list("Task"),
      );
      const second = await runWithCaller(
        khoa,
        () => getFrappeClient().list("Task"),
      );

      assertEquals(calls.length, 2);
      assert(
        first[0].subject !== second[0].subject,
        "the second caller must get their OWN read, not the first caller's cached rows - " +
          "invalidation is allowed to cross the boundary, values are not",
      );
    } finally {
      restore();
    }
  });
});
