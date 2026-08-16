/**
 * Tests for per-caller identity: the HTTP endpoint acts as the calling user, not as a shared
 * ERPNext service account.
 *
 * @module lib/erpnext/tests/auth/caller-identity_test
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  callerPrincipal,
  createCallerIdentityMiddleware,
  resolveCallerIdentityMode,
} from "./caller-middleware.ts";
import { currentCaller, runWithCaller } from "../api/caller-context.ts";
import { getFrappeClient, setFrappeClient } from "../api/frappe-client.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

function withEnv(
  entries: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const originals = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    originals.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  const restore = () => {
    for (const [key, value] of originals) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

/** Minimal middleware context: only the fields the caller-identity middleware reads. */
interface TestContext {
  toolName: string;
  args: Record<string, unknown>;
  request?: Request;
  authInfo?: { subject: string; claims: Record<string, unknown> };
  [key: string]: unknown;
}

function makeCtx(
  authorization?: string,
  claims?: Record<string, unknown>,
): TestContext {
  return {
    toolName: "erpnext_account_list",
    args: {},
    request: authorization
      ? new Request("http://localhost/mcp", { headers: { authorization } })
      : undefined,
    authInfo: claims ? { subject: "sub-1", claims } : undefined,
  };
}

function captureAuthHeader(): {
  headers: () => Record<string, string>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let captured: Record<string, string> = {};
  globalThis.fetch = (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    captured = Object.fromEntries(new Headers(init?.headers).entries());
    return Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    headers: () => captured,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── callerPrincipal ───────────────────────────────────────────────────────────

Deno.test("callerPrincipal() - prefers the email claim and lowercases it", () => {
  assertEquals(
    callerPrincipal({ claims: { email: "Tu.Pham@Havigroup.LLC" } }),
    "tu.pham@havigroup.llc",
  );
});

Deno.test("callerPrincipal() - falls back to preferred_username only when it is an email", () => {
  assertEquals(
    callerPrincipal({
      claims: { preferred_username: "chi.mai@havigroup.llc" },
    }),
    "chi.mai@havigroup.llc",
  );
  assertEquals(
    callerPrincipal({ claims: { preferred_username: "chi.mai" } }),
    undefined,
  );
});

Deno.test("callerPrincipal() - never falls back to sub", () => {
  // A `sub` maps to no Frappe user, so accepting it would produce a principal that silently fails
  // at the ERPNext boundary instead of failing here where the reason is visible.
  assertEquals(
    callerPrincipal({ subject: "6f1c...", claims: { sub: "6f1c..." } }),
    undefined,
  );
  assertEquals(callerPrincipal(undefined), undefined);
});

// ── Middleware ────────────────────────────────────────────────────────────────

Deno.test("middleware - refuses a call with no identity when identity is required", async () => {
  const middleware = createCallerIdentityMiddleware({ required: true });
  let handlerRan = false;
  await assertRejects(
    () =>
      Promise.resolve(
        middleware(makeCtx("Bearer opaque-token"), () => {
          handlerRan = true;
          return Promise.resolve("ok");
        }),
      ),
    Error,
    "carries no user identity",
  );
  assertEquals(handlerRan, false);
});

Deno.test("middleware - lets an anonymous call through when identity is optional", async () => {
  const middleware = createCallerIdentityMiddleware({ required: false });
  const result = await middleware(makeCtx(), () => {
    assertEquals(currentCaller(), undefined);
    return Promise.resolve("ok");
  });
  assertEquals(result, "ok");
});

Deno.test("middleware - binds the verified email and the raw token to the call", async () => {
  const middleware = createCallerIdentityMiddleware({ required: true });
  const result = await middleware(
    makeCtx("Bearer jwt-abc", { email: "Khoa.Do@havigroup.llc" }),
    () => {
      const caller = currentCaller();
      assertEquals(caller?.principal, "khoa.do@havigroup.llc");
      assertEquals(caller?.accessToken, "jwt-abc");
      return Promise.resolve("ok");
    },
  );
  assertEquals(result, "ok");
});

Deno.test("middleware - keeps overlapping calls from seeing each other's identity", async () => {
  // The regression this guards: a module-level "current caller" variable would make whichever
  // request resumed last decide the identity of both.
  const middleware = createCallerIdentityMiddleware({ required: true });
  const seen: string[] = [];

  const call = (email: string, delayMs: number) =>
    middleware(makeCtx(`Bearer token-${email}`, { email }), async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      seen.push(`${email}:${currentCaller()?.principal}`);
      return currentCaller()?.accessToken;
    });

  const [first, second] = await Promise.all([
    call("anh.le@havigroup.llc", 20),
    call("chi.mai@havigroup.llc", 1),
  ]);

  assertEquals(first, "token-anh.le@havigroup.llc");
  assertEquals(second, "token-chi.mai@havigroup.llc");
  assertEquals(seen.sort(), [
    "anh.le@havigroup.llc:anh.le@havigroup.llc",
    "chi.mai@havigroup.llc:chi.mai@havigroup.llc",
  ]);
});

// ── Mode resolution ───────────────────────────────────────────────────────────

Deno.test("resolveCallerIdentityMode() - requires identity when there are no static credentials", () => {
  withEnv(
    {
      MCP_CALLER_IDENTITY: undefined,
      ERPNEXT_API_KEY: undefined,
      ERPNEXT_API_SECRET: undefined,
    },
    () => assertEquals(resolveCallerIdentityMode(), "required"),
  );
});

Deno.test("resolveCallerIdentityMode() - leaves an existing key/secret deployment alone", () => {
  withEnv(
    {
      MCP_CALLER_IDENTITY: undefined,
      ERPNEXT_API_KEY: "k",
      ERPNEXT_API_SECRET: "s",
    },
    () => assertEquals(resolveCallerIdentityMode(), "off"),
  );
});

Deno.test("resolveCallerIdentityMode() - an explicit value wins, a typo is fatal", () => {
  withEnv(
    {
      MCP_CALLER_IDENTITY: "required",
      ERPNEXT_API_KEY: "k",
      ERPNEXT_API_SECRET: "s",
    },
    () => assertEquals(resolveCallerIdentityMode(), "required"),
  );
  withEnv({ MCP_CALLER_IDENTITY: "requred" }, () => {
    let message = "";
    try {
      resolveCallerIdentityMode();
    } catch (error) {
      message = (error as Error).message;
    }
    assertEquals(message.includes("MCP_CALLER_IDENTITY"), true);
  });
});

// ── Client resolution ─────────────────────────────────────────────────────────

Deno.test("getFrappeClient() - forwards the caller's own token, not a shared API key", async () => {
  const capture = captureAuthHeader();
  try {
    await withEnv(
      {
        ERPNEXT_URL: "http://localhost:8000",
        ERPNEXT_API_KEY: undefined,
        ERPNEXT_API_SECRET: undefined,
      },
      async () => {
        setFrappeClient(null);
        await runWithCaller(
          { accessToken: "jwt-of-khoa", principal: "khoa.do@havigroup.llc" },
          () => getFrappeClient().list("Account", { limit: 1 }),
        );
        assertEquals(
          capture.headers()["authorization"],
          "HVGKeycloak jwt-of-khoa",
        );
      },
    );
  } finally {
    capture.restore();
    setFrappeClient(null);
  }
});

Deno.test("getFrappeClient() - gives each caller its own client and its own cache", async () => {
  const capture = captureAuthHeader();
  try {
    await withEnv(
      {
        ERPNEXT_URL: "http://localhost:8000",
        ERPNEXT_API_KEY: undefined,
        ERPNEXT_API_SECRET: undefined,
      },
      async () => {
        setFrappeClient(null);
        const forKhoa = runWithCaller(
          { accessToken: "a", principal: "khoa.do@havigroup.llc" },
          () => getFrappeClient(),
        );
        const forChi = runWithCaller(
          { accessToken: "b", principal: "chi.mai@havigroup.llc" },
          () => getFrappeClient(),
        );
        assertNotEquals(forKhoa, forChi);

        const again = runWithCaller(
          { accessToken: "a2", principal: "khoa.do@havigroup.llc" },
          () => getFrappeClient(),
        );
        assertEquals(again, forKhoa);

        // A refreshed token must reach the wire: the header is resolved per request, not frozen
        // when the client was built.
        await runWithCaller(
          { accessToken: "a2", principal: "khoa.do@havigroup.llc" },
          () => again.list("Account", { limit: 1 }),
        );
        assertEquals(capture.headers()["authorization"], "HVGKeycloak a2");
      },
    );
  } finally {
    capture.restore();
    setFrappeClient(null);
  }
});

Deno.test("getFrappeClient() - refuses to run unauthenticated with no identity and no credentials", () => {
  withEnv(
    {
      ERPNEXT_URL: "http://localhost:8000",
      ERPNEXT_API_KEY: undefined,
      ERPNEXT_API_SECRET: undefined,
    },
    () => {
      setFrappeClient(null);
      let message = "";
      try {
        getFrappeClient();
      } catch (error) {
        message = (error as Error).message;
      }
      // Frappe answers an unauthenticated request as Guest, which reads as "no data" rather than
      // as a failure — so this path must throw instead of returning a usable client.
      assertEquals(message.includes("no caller identity"), true);
    },
  );
});
