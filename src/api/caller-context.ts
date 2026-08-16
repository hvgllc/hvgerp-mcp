/**
 * Per-request caller identity.
 *
 * The MCP endpoint used to act in ERPNext under a single shared service account: `getFrappeClient()`
 * was a process-wide singleton holding one API key/secret pair, so every authenticated caller had
 * exactly the same reach regardless of who they were. This module carries the *end user's* identity
 * from the HTTP boundary down to the Frappe client without threading a parameter through all 125
 * tool handlers.
 *
 * `AsyncLocalStorage` is the mechanism because the alternative — a module-level "current caller"
 * variable — is silently wrong under concurrency: two overlapping requests would clobber each
 * other's identity and one caller would act as the other. The store is entered once per tool call by
 * `createCallerIdentityMiddleware` and is invisible to anything outside that call's async tree.
 *
 * @module lib/erpnext/src/api/caller-context
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface CallerIdentity {
  /**
   * The end user's access token, forwarded verbatim to Frappe so Frappe can verify it itself.
   * A secret: never log it, never put it in an error message, never use it as a cache key.
   */
  readonly accessToken: string;

  /**
   * Stable, non-secret key identifying the caller (their email claim). Used only to keep one
   * caller's cached reads out of another caller's client.
   */
  readonly principal: string;
}

const callerStorage = new AsyncLocalStorage<CallerIdentity>();

/** Run `fn` with `identity` visible to `currentCaller()` anywhere in its async tree. */
export function runWithCaller<T>(identity: CallerIdentity, fn: () => T): T {
  return callerStorage.run(identity, fn);
}

/** The identity of the request currently being served, or `undefined` outside one. */
export function currentCaller(): CallerIdentity | undefined {
  return callerStorage.getStore();
}
