/**
 * MCP HTTP Authentication Configuration
 *
 * Reads auth settings from environment variables and builds an
 * `@casys/mcp-server` `AuthProvider` — static bearer tokens, OAuth 2.0 JWT
 * (JWKS), or both combined via `CompositeAuthProvider`.
 *
 *   1. Static bearer tokens  — MCP_AUTH_TOKEN or MCP_AUTH_TOKENS (comma-separated)
 *   2. OAuth 2.0 JWT (JWKS) — MCP_OAUTH_JWKS_URL + MCP_OAUTH_AUDIENCE + MCP_OAUTH_ISSUER
 *
 * Both modes also require MCP_AUTH_RESOURCE (an absolute URL identifying this
 * server, per RFC 9728) — the framework's auth providers need it to emit
 * Protected Resource Metadata.
 *
 * @module lib/erpnext/src/auth/config
 */

import {
  type AuthProvider,
  createOIDCAuthProvider,
  createStaticTokenAuthProvider,
} from "@casys/mcp-server";
import { env } from "../runtime.ts";
import { CompositeAuthProvider } from "./composite-provider.ts";

// ── Config ───────────────────────────────────────────────────────────────────

export interface AuthConfig {
  /** Set of valid static bearer tokens. */
  tokens: Set<string>;
  /** RFC 9728 resource identifier for this server (its own public URL). */
  resource?: string;
  /** JWKS endpoint URL for OAuth JWT validation. */
  jwksUrl?: string;
  /** Expected `aud` claim value. */
  audience?: string;
  /** Expected `iss` claim value / OIDC issuer. */
  issuer?: string;
}

/**
 * Strip a single layer of matching surrounding quotes (single or double).
 * `env_file:` parsing is inconsistent across Docker Compose versions about
 * whether quotes in `KEY="value"` are stripped or kept as literal characters
 * — stripping them here ourselves makes auth config immune to that either way.
 */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function optionalEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const unquoted = unquote(trimmed);
  return unquoted.trim() ? unquoted : undefined;
}

/**
 * Read auth config from environment variables.
 * Returns null if no auth is configured (HTTP mode will warn).
 */
export function loadAuthConfig(): AuthConfig | null {
  const single = optionalEnvValue(env("MCP_AUTH_TOKEN"));
  const multi = env("MCP_AUTH_TOKENS");
  const jwksUrl = optionalEnvValue(env("MCP_OAUTH_JWKS_URL"));
  const audience = optionalEnvValue(env("MCP_OAUTH_AUDIENCE"));
  const issuer = optionalEnvValue(env("MCP_OAUTH_ISSUER"));
  const resource = optionalEnvValue(env("MCP_AUTH_RESOURCE"));

  const tokens = new Set<string>();
  if (single) tokens.add(single);
  if (multi) {
    for (const t of multi.split(",")) {
      const token = optionalEnvValue(t);
      if (token) tokens.add(token);
    }
  }

  const oauthConfigured = Boolean(jwksUrl || audience || issuer);
  if (oauthConfigured) {
    const requiredOAuthValues = [
      ["MCP_OAUTH_JWKS_URL", jwksUrl],
      ["MCP_OAUTH_AUDIENCE", audience],
      ["MCP_OAUTH_ISSUER", issuer],
      ["MCP_AUTH_RESOURCE", resource],
    ] as const;
    for (const [name, value] of requiredOAuthValues) {
      if (!value) {
        throw new Error(
          `[hvgerp-mcp] ${name} is required when OAuth configuration is present`,
        );
      }
    }
  }

  if (tokens.size === 0 && !oauthConfigured) {
    if (resource) {
      throw new Error(
        "[hvgerp-mcp] MCP_AUTH_RESOURCE requires a static token or OAuth configuration",
      );
    }
    return null;
  }

  return {
    tokens,
    resource,
    jwksUrl,
    audience,
    issuer,
  };
}

// ── Provider construction ────────────────────────────────────────────────────

/**
 * Build the `AuthProvider` `server.ts` passes to `McpApp`. Throws with a
 * targeted message if a mode is partially configured (e.g. a JWKS URL without
 * an issuer) rather than silently accepting requests it can't actually verify.
 */
export function buildAuthProvider(config: AuthConfig): AuthProvider {
  const providers: AuthProvider[] = [];

  if (config.tokens.size > 0) {
    if (!config.resource) {
      throw new Error(
        "[hvgerp-mcp] MCP_AUTH_RESOURCE is required alongside MCP_AUTH_TOKEN(S) " +
          "— set it to this server's public URL, e.g. https://mcp.example.com",
      );
    }
    providers.push(
      createStaticTokenAuthProvider([...config.tokens], {
        resource: config.resource,
      }),
    );
  }

  if (config.jwksUrl) {
    if (!config.issuer) {
      throw new Error(
        "[hvgerp-mcp] MCP_OAUTH_ISSUER is required alongside MCP_OAUTH_JWKS_URL",
      );
    }
    if (!config.audience) {
      throw new Error(
        "[hvgerp-mcp] MCP_OAUTH_AUDIENCE is required alongside MCP_OAUTH_JWKS_URL",
      );
    }
    if (!config.resource) {
      throw new Error(
        "[hvgerp-mcp] MCP_AUTH_RESOURCE is required alongside MCP_OAUTH_JWKS_URL",
      );
    }
    providers.push(
      createOIDCAuthProvider({
        issuer: config.issuer,
        audience: config.audience,
        jwksUri: config.jwksUrl,
        resource: config.resource,
      }),
    );
  }

  return providers.length === 1
    ? providers[0]
    : new CompositeAuthProvider(providers);
}

// ── MCP Events policy ────────────────────────────────────────────────────────

/** Tên biến môi trường của feature flag MCP Events. Mặc định TẮT khi không đặt. */
export const EVENTS_FLAG_ENV = "MCP_EVENTS_ENABLED";

const FLAG_TRUE = new Set(["1", "true", "yes", "on"]);
const FLAG_FALSE = new Set(["0", "false", "no", "off"]);

/**
 * Feature flag MCP Events. Không đặt hoặc rỗng nghĩa là TẮT. Giá trị lạ làm khởi động thất bại
 * thay vì đoán, vì một flag bảo mật mà gõ sai chữ không được phép lặng lẽ rơi về một trong hai phía.
 */
export function eventsFlagEnabled(): boolean {
  const raw = optionalEnvValue(env(EVENTS_FLAG_ENV))?.toLowerCase();
  if (raw === undefined) return false;
  if (FLAG_TRUE.has(raw)) return true;
  if (FLAG_FALSE.has(raw)) return false;
  throw new Error(
    `[hvgerp-mcp] ${EVENTS_FLAG_ENV} must be one of 1, true, yes, on, 0, false, no, off ` +
      `(got an unrecognised value).`,
  );
}

export interface EventsPolicyInput {
  callerIdentity: "required" | "optional" | "off";
  authConfig: AuthConfig | null;
}

/**
 * Kiểm cấu hình có đủ an toàn để bật Events không. Ném lỗi nếu không; trả về danh sách cảnh báo
 * (không chặn) nếu cấu hình dùng được nhưng còn dấu vết đáng chú ý.
 *
 * Events không bao giờ chạy với bearer tĩnh dùng chung hay tài khoản dịch vụ dự phòng, vì một
 * subscription gắn với MỘT người dùng ERP cụ thể. Hàm này chỉ ĐỌC cấu hình: nó không tạo scope,
 * client hay grant OAuth nào, và không đổi cấu hình của các tool cũ.
 */
export function assertEventsPolicy(input: EventsPolicyInput): string[] {
  if (input.callerIdentity !== "required") {
    throw new Error(
      `[hvgerp-mcp] ${EVENTS_FLAG_ENV} is on but MCP_CALLER_IDENTITY is not "required". ` +
        "Events subscriptions belong to one ERPNext user, so every request must carry a verified " +
        "user identity. Remove ERPNEXT_API_KEY/ERPNEXT_API_SECRET or set MCP_CALLER_IDENTITY=required.",
    );
  }
  if (!input.authConfig?.jwksUrl) {
    throw new Error(
      `[hvgerp-mcp] ${EVENTS_FLAG_ENV} is on but OAuth JWT verification is not configured. ` +
        "Set MCP_OAUTH_JWKS_URL, MCP_OAUTH_AUDIENCE, MCP_OAUTH_ISSUER and MCP_AUTH_RESOURCE.",
    );
  }
  const warnings: string[] = [];
  if (input.authConfig.tokens.size > 0) {
    warnings.push(
      "static bearer tokens are configured next to OAuth. They keep working for the existing " +
        "tools but carry no user identity, so every Events request made with one is refused.",
    );
  }
  return warnings;
}
