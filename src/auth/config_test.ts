import { assertEquals, assertThrows } from "@std/assert";
import { StaticTokenAuthProvider } from "@casys/mcp-server";
import { buildAuthProvider, loadAuthConfig } from "./config.ts";
import { CompositeAuthProvider } from "./composite-provider.ts";

// ── loadAuthConfig ────────────────────────────────────────────────────────────

Deno.test("loadAuthConfig: returns null when no env vars set", () => {
  using _ = withEnv({});
  assertEquals(loadAuthConfig(), null);
});

Deno.test("loadAuthConfig: reads single MCP_AUTH_TOKEN", () => {
  using _ = withEnv({ MCP_AUTH_TOKEN: "my-token" });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.has("my-token"), true);
  assertEquals(config?.tokens.size, 1);
});

Deno.test("loadAuthConfig: reads MCP_AUTH_TOKENS comma-separated list", () => {
  using _ = withEnv({ MCP_AUTH_TOKENS: "token-a, token-b , token-c" });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.has("token-a"), true);
  assertEquals(config?.tokens.has("token-b"), true);
  assertEquals(config?.tokens.has("token-c"), true);
  assertEquals(config?.tokens.size, 3);
});

Deno.test("loadAuthConfig: merges MCP_AUTH_TOKEN and MCP_AUTH_TOKENS", () => {
  using _ = withEnv({
    MCP_AUTH_TOKEN: "single",
    MCP_AUTH_TOKENS: "multi-1,multi-2",
  });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.size, 3);
});

Deno.test("loadAuthConfig: reads OAuth JWKS config plus MCP_AUTH_RESOURCE", () => {
  using _ = withEnv({
    MCP_OAUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
    MCP_OAUTH_AUDIENCE: "hvgerp-mcp",
    MCP_OAUTH_ISSUER: "https://auth.example.com",
    MCP_AUTH_RESOURCE: "https://mcp.example.com",
  });
  const config = loadAuthConfig();
  assertEquals(
    config?.jwksUrl,
    "https://auth.example.com/.well-known/jwks.json",
  );
  assertEquals(config?.audience, "hvgerp-mcp");
  assertEquals(config?.issuer, "https://auth.example.com");
  assertEquals(config?.resource, "https://mcp.example.com");
});

Deno.test("loadAuthConfig: ignores blank tokens in list", () => {
  using _ = withEnv({ MCP_AUTH_TOKENS: "tok,,  ,tok2" });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.size, 2);
});

Deno.test("loadAuthConfig: strips surrounding double quotes from MCP_AUTH_TOKEN", () => {
  // Regression: Docker Compose's env_file quote-handling is inconsistent
  // across versions — a value quoted in .env (MCP_AUTH_TOKEN="abc") must not
  // silently become part of the token itself.
  using _ = withEnv({ MCP_AUTH_TOKEN: '"abc123"' });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.has("abc123"), true);
  assertEquals(config?.tokens.has('"abc123"'), false);
});

Deno.test("loadAuthConfig: preserves whitespace inside a quoted non-empty token", () => {
  using _ = withEnv({ MCP_AUTH_TOKEN: '" abc123 "' });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.has(" abc123 "), true);
});

Deno.test("loadAuthConfig: strips surrounding single quotes from MCP_AUTH_TOKENS entries", () => {
  using _ = withEnv({ MCP_AUTH_TOKENS: "'tok-a','tok-b'" });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.has("tok-a"), true);
  assertEquals(config?.tokens.has("tok-b"), true);
  assertEquals(config?.tokens.size, 2);
});

Deno.test("loadAuthConfig: strips quotes from OAuth config values", () => {
  using _ = withEnv({
    MCP_OAUTH_JWKS_URL: '"https://auth.example.com/.well-known/jwks.json"',
    MCP_AUTH_RESOURCE: '"https://mcp.example.com"',
    MCP_OAUTH_AUDIENCE: '"hvgerp-mcp"',
    MCP_OAUTH_ISSUER: '"https://auth.example.com"',
  });
  const config = loadAuthConfig();
  assertEquals(
    config?.jwksUrl,
    "https://auth.example.com/.well-known/jwks.json",
  );
  assertEquals(config?.resource, "https://mcp.example.com");
  assertEquals(config?.audience, "hvgerp-mcp");
  assertEquals(config?.issuer, "https://auth.example.com");
});

const completeOAuthEnv = {
  MCP_OAUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
  MCP_OAUTH_AUDIENCE: "hvgerp-mcp",
  MCP_OAUTH_ISSUER: "https://auth.example.com",
  MCP_AUTH_RESOURCE: "https://mcp.example.com",
};

for (const staticToken of [false, true]) {
  const mode = staticToken ? "with a static token" : "without a static token";

  for (
    const missing of [
      "MCP_OAUTH_JWKS_URL",
      "MCP_OAUTH_AUDIENCE",
      "MCP_OAUTH_ISSUER",
      "MCP_AUTH_RESOURCE",
    ] as const
  ) {
    Deno.test(`loadAuthConfig: rejects OAuth missing ${missing} ${mode}`, () => {
      const vars: Record<string, string> = { ...completeOAuthEnv };
      delete vars[missing];
      if (staticToken) vars.MCP_AUTH_TOKEN = "static-token";

      using _ = withEnv(vars);
      assertThrows(() => loadAuthConfig(), Error, missing);
    });
  }

  Deno.test(`loadAuthConfig: rejects issuer-only OAuth ${mode}`, () => {
    using _ = withEnv({
      MCP_OAUTH_ISSUER: "https://auth.example.com",
      ...(staticToken ? { MCP_AUTH_TOKEN: "static-token" } : {}),
    });
    assertThrows(() => loadAuthConfig(), Error, "MCP_OAUTH_JWKS_URL");
  });

  Deno.test(`loadAuthConfig: rejects audience-only OAuth ${mode}`, () => {
    using _ = withEnv({
      MCP_OAUTH_AUDIENCE: "hvgerp-mcp",
      ...(staticToken ? { MCP_AUTH_TOKEN: "static-token" } : {}),
    });
    assertThrows(() => loadAuthConfig(), Error, "MCP_OAUTH_JWKS_URL");
  });

  Deno.test(`loadAuthConfig: rejects issuer and audience without JWKS ${mode}`, () => {
    using _ = withEnv({
      MCP_OAUTH_ISSUER: "https://auth.example.com",
      MCP_OAUTH_AUDIENCE: "hvgerp-mcp",
      ...(staticToken ? { MCP_AUTH_TOKEN: "static-token" } : {}),
    });
    assertThrows(() => loadAuthConfig(), Error, "MCP_OAUTH_JWKS_URL");
  });
}

for (const staticToken of [false, true]) {
  const mode = staticToken ? "with a static token" : "without a static token";
  for (
    const field of [
      "MCP_OAUTH_JWKS_URL",
      "MCP_OAUTH_AUDIENCE",
      "MCP_OAUTH_ISSUER",
    ] as const
  ) {
    for (
      const [form, value] of [
        ["empty", ""],
        ["whitespace", "   "],
        ["quoted empty", '""'],
        ["quoted whitespace", "'   '"],
      ] as const
    ) {
      Deno.test(`loadAuthConfig: treats ${form} ${field} as missing ${mode}`, () => {
        using _ = withEnv({
          ...completeOAuthEnv,
          [field]: value,
          ...(staticToken ? { MCP_AUTH_TOKEN: "static-token" } : {}),
        });
        assertThrows(() => loadAuthConfig(), Error, field);
      });
    }
  }
}

Deno.test("loadAuthConfig: returns null when all OAuth values normalize to empty", () => {
  using _ = withEnv({
    MCP_OAUTH_JWKS_URL: '""',
    MCP_OAUTH_AUDIENCE: "   ",
    MCP_OAUTH_ISSUER: "'   '",
  });
  assertEquals(loadAuthConfig(), null);
});

Deno.test("loadAuthConfig: keeps static-only auth when all OAuth values normalize to empty", () => {
  using _ = withEnv({
    MCP_AUTH_TOKEN: "static-token",
    MCP_AUTH_RESOURCE: "https://mcp.example.com",
    MCP_OAUTH_JWKS_URL: '""',
    MCP_OAUTH_AUDIENCE: "   ",
    MCP_OAUTH_ISSUER: "'   '",
  });
  const config = loadAuthConfig();
  assertEquals(config?.tokens.has("static-token"), true);
  assertEquals(config?.jwksUrl, undefined);
  assertEquals(config?.audience, undefined);
  assertEquals(config?.issuer, undefined);
});

Deno.test("loadAuthConfig: rejects resource-only auth when all OAuth values normalize to empty", () => {
  using _ = withEnv({
    MCP_AUTH_RESOURCE: "https://mcp.example.com",
    MCP_OAUTH_JWKS_URL: '""',
    MCP_OAUTH_AUDIENCE: "   ",
    MCP_OAUTH_ISSUER: "'   '",
  });
  assertThrows(() => loadAuthConfig(), Error, "MCP_AUTH_RESOURCE");
});

Deno.test("loadAuthConfig: rejects MCP_AUTH_RESOURCE without an auth mode", () => {
  using _ = withEnv({ MCP_AUTH_RESOURCE: "https://mcp.example.com" });
  assertThrows(() => loadAuthConfig(), Error, "MCP_AUTH_RESOURCE");
});

// ── buildAuthProvider ─────────────────────────────────────────────────────────

Deno.test("buildAuthProvider: static tokens alone build a StaticTokenAuthProvider", async () => {
  const provider = buildAuthProvider({
    tokens: new Set(["secret-1"]),
    resource: "https://mcp.example.com",
  });
  assertEquals(provider instanceof StaticTokenAuthProvider, true);
  assertEquals(await provider.verifyToken("secret-1") !== null, true);
  assertEquals(await provider.verifyToken("wrong"), null);
});

Deno.test("buildAuthProvider: throws when static tokens are set without MCP_AUTH_RESOURCE", () => {
  assertThrows(
    () => buildAuthProvider({ tokens: new Set(["secret-1"]) }),
    Error,
    "MCP_AUTH_RESOURCE is required alongside MCP_AUTH_TOKEN",
  );
});

Deno.test("buildAuthProvider: throws when JWKS URL is set without an issuer", () => {
  assertThrows(
    () =>
      buildAuthProvider({
        tokens: new Set(),
        jwksUrl: "https://auth.example.com/.well-known/jwks.json",
        audience: "hvgerp-mcp",
        resource: "https://mcp.example.com",
      }),
    Error,
    "MCP_OAUTH_ISSUER is required",
  );
});

Deno.test("buildAuthProvider: throws when JWKS URL is set without an audience", () => {
  assertThrows(
    () =>
      buildAuthProvider({
        tokens: new Set(),
        jwksUrl: "https://auth.example.com/.well-known/jwks.json",
        issuer: "https://auth.example.com",
        resource: "https://mcp.example.com",
      }),
    Error,
    "MCP_OAUTH_AUDIENCE is required",
  );
});

Deno.test("buildAuthProvider: throws when JWKS URL is set without MCP_AUTH_RESOURCE", () => {
  assertThrows(
    () =>
      buildAuthProvider({
        tokens: new Set(),
        jwksUrl: "https://auth.example.com/.well-known/jwks.json",
        issuer: "https://auth.example.com",
        audience: "hvgerp-mcp",
      }),
    Error,
    "MCP_AUTH_RESOURCE is required",
  );
});

Deno.test("buildAuthProvider: combines static tokens and OAuth into a CompositeAuthProvider", () => {
  const provider = buildAuthProvider({
    tokens: new Set(["secret-1"]),
    jwksUrl: "https://auth.example.com/.well-known/jwks.json",
    issuer: "https://auth.example.com",
    audience: "hvgerp-mcp",
    resource: "https://mcp.example.com",
  });
  assertEquals(provider instanceof CompositeAuthProvider, true);
});

Deno.test("buildAuthProvider: composite advertises the OIDC authorization server", () => {
  const provider = buildAuthProvider({
    tokens: new Set(["secret-1"]),
    jwksUrl: "https://auth.example.com/.well-known/jwks.json",
    issuer: "https://auth.example.com",
    audience: "hvgerp-mcp",
    resource: "https://mcp.example.com",
  });

  assertEquals(provider.getResourceMetadata().authorization_servers, [
    "https://auth.example.com/",
  ]);
});

Deno.test("buildAuthProvider: composite accepts a valid static token without touching the network", async () => {
  const provider = buildAuthProvider({
    tokens: new Set(["secret-1"]),
    jwksUrl: "https://auth.example.com/.well-known/jwks.json",
    issuer: "https://auth.example.com",
    audience: "hvgerp-mcp",
    resource: "https://mcp.example.com",
  });
  const info = await provider.verifyToken("secret-1");
  assertEquals(info !== null, true);
});

Deno.test("buildAuthProvider: composite rejects an unknown token (falls through to OAuth, which also rejects it)", async () => {
  const provider = buildAuthProvider({
    tokens: new Set(["secret-1"]),
    jwksUrl: "https://auth.example.com/.well-known/jwks.json",
    issuer: "https://auth.example.com",
    audience: "hvgerp-mcp",
    resource: "https://mcp.example.com",
  });
  // Malformed JWT fails signature-structure parsing before any JWKS fetch,
  // so this stays fully offline.
  const info = await provider.verifyToken("not-a-jwt");
  assertEquals(info, null);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Temporarily override Deno env vars for the duration of the test block.
function withEnv(vars: Record<string, string>): Disposable {
  const saved: Record<string, string | undefined> = {};
  const relevantKeys = [
    "MCP_AUTH_TOKEN",
    "MCP_AUTH_TOKENS",
    "MCP_AUTH_RESOURCE",
    "MCP_OAUTH_JWKS_URL",
    "MCP_OAUTH_AUDIENCE",
    "MCP_OAUTH_ISSUER",
  ];
  for (const key of relevantKeys) {
    saved[key] = Deno.env.get(key);
    Deno.env.delete(key);
  }
  for (const [k, v] of Object.entries(vars)) {
    Deno.env.set(k, v);
  }
  return {
    [Symbol.dispose]() {
      for (const key of relevantKeys) {
        Deno.env.delete(key);
        if (saved[key] !== undefined) Deno.env.set(key, saved[key]!);
      }
    },
  };
}
