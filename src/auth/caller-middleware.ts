/**
 * Middleware that binds each tool call to the end user who made it.
 *
 * Runs after the framework's auth middleware, so `ctx.authInfo` is the *verified* result of JWT
 * validation — the raw `Authorization` header is read only to recover the token string itself, never
 * to decide who the caller is. Everything identity-related comes from `authInfo.claims`.
 *
 * @module lib/erpnext/src/auth/caller-middleware
 */

import type { Middleware, MiddlewareContext } from "@casys/mcp-server";
import { type CallerIdentity, runWithCaller } from "../api/caller-context.ts";
import { env } from "../runtime.ts";

const BEARER_PATTERN = /^bearer[ \t]+(\S+)$/i;

interface VerifiedAuth {
  subject?: string;
  claims?: Record<string, unknown>;
}

function claimString(
  claims: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = claims?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The caller's stable identity key.
 *
 * `email` first because that is the claim Frappe maps to a `User` — keying the cache on anything
 * else could let two Frappe identities share one cache entry. `preferred_username` is accepted only
 * when it looks like an email for the same reason. `sub` is deliberately NOT a fallback: it would
 * produce a principal that maps to no Frappe user, which is worse than failing outright.
 */
export function callerPrincipal(
  authInfo: VerifiedAuth | undefined,
): string | undefined {
  const email = claimString(authInfo?.claims, "email");
  if (email?.includes("@")) return email.toLowerCase();
  const username = claimString(authInfo?.claims, "preferred_username");
  if (username?.includes("@")) return username.toLowerCase();
  return undefined;
}

function bearerToken(ctx: MiddlewareContext): string | undefined {
  const header = ctx.request?.headers.get("authorization")?.trim();
  if (!header) return undefined;
  return BEARER_PATTERN.exec(header)?.[1];
}

export interface CallerIdentityMiddlewareOptions {
  /**
   * When true, a tool call that carries no usable identity is refused instead of falling through.
   *
   * This is the switch that makes the shared-service-account path unreachable in production. Left
   * false, a deployment that misconfigures its OIDC claims would quietly go on serving every caller
   * under the server's own credentials — the exact failure this whole module exists to remove.
   */
  required: boolean;
}

export function createCallerIdentityMiddleware(
  options: CallerIdentityMiddlewareOptions,
): Middleware {
  // `async` khong phai de trang tri: kieu `Middleware` khai bao tra ve `Promise<MiddlewareResult>`,
  // nen nhanh tu choi ben duoi phai la mot promise BI TU CHOI chu khong phai mot cu nem dong bo.
  // Ham dong bo nem loi thi moi ben goi lam `mw(ctx, next).catch(...)` deu vo, va chinh test cua
  // module nay da do vi dieu do.
  return async (ctx, next) => {
    const token = bearerToken(ctx);
    const principal = callerPrincipal(ctx.authInfo as VerifiedAuth | undefined);

    if (!token || !principal) {
      if (options.required) {
        throw new Error(
          "[hvgerp-mcp] refusing to run: this server acts as the calling user, and this request " +
            "carries no user identity. The access token must be a Keycloak user token whose " +
            "`email` claim matches an enabled ERPNext System User.",
        );
      }
      return next();
    }

    const identity: CallerIdentity = { accessToken: token, principal };
    return runWithCaller(identity, next);
  };
}

/** How strictly this process binds tool calls to the identity of whoever made them. */
export type CallerIdentityMode = "required" | "optional" | "off";

const MODES: readonly CallerIdentityMode[] = ["required", "optional", "off"];

/**
 * Decide the caller-identity mode for an HTTP run.
 *
 * `MCP_CALLER_IDENTITY` wins when set. The default is deliberately conditional rather than a fixed
 * value: a deployment that still carries `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` has an operator who
 * chose the shared-account behaviour, and silently switching it to per-user would break it on
 * upgrade. Drop those two variables and identity becomes required, because at that point there is
 * no other credential the server could act with.
 */
export function resolveCallerIdentityMode(): CallerIdentityMode {
  const raw = env("MCP_CALLER_IDENTITY")?.trim().toLowerCase();
  if (raw) {
    if (!MODES.includes(raw as CallerIdentityMode)) {
      throw new Error(
        `[hvgerp-mcp] MCP_CALLER_IDENTITY must be one of ${MODES.join(", ")} ` +
          `(got ${JSON.stringify(raw)}).`,
      );
    }
    return raw as CallerIdentityMode;
  }
  const hasStaticCredentials = Boolean(
    env("ERPNEXT_API_KEY") && env("ERPNEXT_API_SECRET"),
  );
  return hasStaticCredentials ? "off" : "required";
}
