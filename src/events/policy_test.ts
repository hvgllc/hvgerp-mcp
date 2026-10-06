/**
 * Test cho cổng cấu hình của MCP Events: cờ tính năng, chính sách khởi động và quy tắc danh tính
 * dùng chung giữa middleware của tool và adapter Events.
 *
 * @module lib/erpnext/src/events/policy_test
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertEventsPolicy,
  type AuthConfig,
  EVENTS_FLAG_ENV,
  eventsFlagEnabled,
} from "../auth/config.ts";
import {
  bearerTokenFromHeaders,
  resolveCallerIdentity,
} from "../auth/caller-middleware.ts";

function withFlag(value: string | undefined, fn: () => void): void {
  const original = Deno.env.get(EVENTS_FLAG_ENV);
  if (value === undefined) Deno.env.delete(EVENTS_FLAG_ENV);
  else Deno.env.set(EVENTS_FLAG_ENV, value);
  try {
    fn();
  } finally {
    if (original === undefined) Deno.env.delete(EVENTS_FLAG_ENV);
    else Deno.env.set(EVENTS_FLAG_ENV, original);
  }
}

// ── Cờ tính năng ────────────────────────────────────────────────────────────

Deno.test("the events flag name is MCP_EVENTS_ENABLED", () => {
  assertEquals(EVENTS_FLAG_ENV, "MCP_EVENTS_ENABLED");
});

Deno.test("the events flag defaults to OFF when unset, empty or blank", () => {
  for (const value of [undefined, "", "   "]) {
    withFlag(value, () => assertEquals(eventsFlagEnabled(), false));
  }
});

Deno.test("the events flag accepts the documented on and off spellings", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
    withFlag(value, () => assertEquals(eventsFlagEnabled(), true));
  }
  for (const value of ["0", "false", "no", "OFF"]) {
    withFlag(value, () => assertEquals(eventsFlagEnabled(), false));
  }
});

Deno.test("an unknown flag value fails startup instead of guessing", () => {
  for (const value of ["maybe-later", "7331", "ttrruuee"]) {
    withFlag(value, () => {
      const error = assertThrows(
        () => eventsFlagEnabled(),
        Error,
        "MCP_EVENTS_ENABLED",
      );
      assertEquals(
        error.message.includes(value),
        false,
        "must not echo the value",
      );
    });
  }
});

// ── Chính sách khởi động ────────────────────────────────────────────────────

const OIDC: AuthConfig = {
  tokens: new Set(),
  resource: "https://mcp.example.com",
  jwksUrl: "https://auth.example.com/jwks.json",
  audience: "hvgerp-mcp",
  issuer: "https://auth.example.com",
};

Deno.test("events policy passes with required identity and OIDC", () => {
  assertEquals(
    assertEventsPolicy({ callerIdentity: "required", authConfig: OIDC }),
    [],
  );
});

Deno.test("events policy refuses any identity mode but required", () => {
  for (const callerIdentity of ["optional", "off"] as const) {
    assertThrows(
      () => assertEventsPolicy({ callerIdentity, authConfig: OIDC }),
      Error,
      "MCP_CALLER_IDENTITY",
    );
  }
});

Deno.test("events policy refuses a missing auth config or one without OIDC", () => {
  assertThrows(
    () => assertEventsPolicy({ callerIdentity: "required", authConfig: null }),
    Error,
    "OAuth",
  );
  assertThrows(
    () =>
      assertEventsPolicy({
        callerIdentity: "required",
        authConfig: { tokens: new Set(["static"]) },
      }),
    Error,
    "OAuth",
  );
});

Deno.test("events policy warns, without failing, when static tokens sit beside OIDC", () => {
  const warnings = assertEventsPolicy({
    callerIdentity: "required",
    authConfig: { ...OIDC, tokens: new Set(["static-secret"]) },
  });
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("static-secret"), false);
});

// ── Danh tính dùng chung ────────────────────────────────────────────────────

Deno.test("bearerTokenFromHeaders reads only a well-formed Bearer header", () => {
  assertEquals(bearerTokenFromHeaders(undefined), undefined);
  assertEquals(bearerTokenFromHeaders(new Headers()), undefined);
  assertEquals(
    bearerTokenFromHeaders(new Headers({ authorization: "Bearer abc" })),
    "abc",
  );
  assertEquals(
    bearerTokenFromHeaders(new Headers({ authorization: "bearer   abc " })),
    "abc",
  );
  assertEquals(
    bearerTokenFromHeaders(new Headers({ authorization: "Basic abc" })),
    undefined,
  );
  assertEquals(
    bearerTokenFromHeaders(new Headers({ authorization: "Bearer a b" })),
    undefined,
  );
  assertEquals(
    bearerTokenFromHeaders(new Headers({ authorization: "Bearer" })),
    undefined,
  );
});

Deno.test("resolveCallerIdentity needs a bearer AND an email principal", () => {
  const headers = new Headers({ authorization: "Bearer jwt-1" });
  assertEquals(
    resolveCallerIdentity(
      { claims: { email: "Khoa.Do@HaviGroup.llc" } },
      headers,
    ),
    { accessToken: "jwt-1", principal: "khoa.do@havigroup.llc" },
  );
  assertEquals(
    resolveCallerIdentity({
      claims: { preferred_username: "khoa@havigroup.llc" },
    }, headers),
    { accessToken: "jwt-1", principal: "khoa@havigroup.llc" },
  );
  // Bearer tĩnh: có token nhưng không có claim, nên không có danh tính.
  assertEquals(
    resolveCallerIdentity({ subject: "static" }, headers),
    undefined,
  );
  assertEquals(resolveCallerIdentity(undefined, headers), undefined);
  // `sub` không bao giờ thay cho email.
  assertEquals(
    resolveCallerIdentity({ claims: { sub: "u1" } }, headers),
    undefined,
  );
  // Có claim nhưng không có bearer.
  assertEquals(
    resolveCallerIdentity({ claims: { email: "a@b.c" } }, new Headers()),
    undefined,
  );
  assertEquals(
    resolveCallerIdentity({ claims: { email: "a@b.c" } }, undefined),
    undefined,
  );
});
