// deno-lint-ignore-file no-process-global
/**
 * Claude Code stdio compatibility shim.
 *
 * Claude Code's MCP client (as of 2026-08) requires the full spec-2026-07-28
 * result envelope — `resultType`, and for cacheable list/read methods also
 * `ttlMs` + `cacheScope` (SEP-2549) — even though stdio here negotiates the
 * earlier 2025-11-25 revision, where none of those fields exist and a
 * missing `resultType` means `"complete"` per spec (the "absent-means-
 * complete" bridge Claude Code's own error message names, but does not
 * honor). `@casys/mcp-server` correctly omits the envelope on stdio — see
 * `stampResult()` / `withCacheHints()` in its `mcp-app.ts`, both gated on a
 * negotiated `2026-07-28` that stdio never reaches.
 *
 * This module rewrites the stdio wire format after the SDK has already
 * serialized it, so Claude Code connects without touching the SDK's
 * spec-correct behavior. Drop this once Claude Code honors the bridge
 * itself.
 */

/** Methods where the spec (SEP-2549) also requires `ttlMs` + `cacheScope`. */
const CACHE_HINT_METHODS = new Set([
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
]);

export interface CacheHints {
  readonly ttlMs: number;
  readonly cacheScope: "public" | "private";
}

/**
 * Adds the missing spec-2026-07-28 envelope fields to a serialized JSON-RPC
 * response line: `resultType: "complete"` on any result that lacks it, plus
 * `ttlMs` / `cacheScope` when `method` is one of the cache-hint methods.
 * Error responses, notifications, requests, results that already carry
 * `resultType`, and non-JSON-RPC lines pass through unchanged.
 *
 * `method` is the originating request's method, looked up by response `id`
 * by the caller — unknown here, since a bare response carries no method of
 * its own.
 */
export function stampSpecFields(
  line: string,
  method: string | undefined,
  cacheHints: CacheHints,
): string {
  const hasTrailingNewline = line.endsWith("\n");
  const trimmed = hasTrailingNewline ? line.slice(0, -1) : line;

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return line;
  }

  if (!message || typeof message !== "object" || !("result" in message)) {
    return line;
  }

  const result = (message as { result: unknown }).result;
  if (
    !result || typeof result !== "object" || Array.isArray(result) ||
    "resultType" in result
  ) {
    return line;
  }

  const record = result as Record<string, unknown>;
  record.resultType = "complete";
  if (method && CACHE_HINT_METHODS.has(method)) {
    record.ttlMs = cacheHints.ttlMs;
    record.cacheScope = cacheHints.cacheScope;
  }

  return JSON.stringify(message) + (hasTrailingNewline ? "\n" : "");
}

/**
 * Wires {@link stampSpecFields} into the live stdio streams: a passive
 * `stdin` listener (alongside the SDK's own) tracks each request's `id ->
 * method`, and a `stdout.write` wrapper stamps outgoing responses using
 * that map. Idempotent — safe to call more than once (later calls are
 * no-ops).
 */
export function installClaudeCodeStdioCompat(cacheHints: CacheHints): void {
  const stdout = process.stdout as unknown as {
    write: (...args: unknown[]) => boolean;
    __claudeCodeStdioCompatInstalled?: boolean;
  };
  if (stdout.__claudeCodeStdioCompatInstalled) return;
  stdout.__claudeCodeStdioCompatInstalled = true;

  const pendingMethods = new Map<string | number, string>();
  let stdinBuffer = "";
  process.stdin.on("data", (chunk: unknown) => {
    stdinBuffer += String(chunk);
    let newlineIndex: number;
    while ((newlineIndex = stdinBuffer.indexOf("\n")) >= 0) {
      const requestLine = stdinBuffer.slice(0, newlineIndex);
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      if (!requestLine.trim()) continue;
      try {
        const request = JSON.parse(requestLine);
        if (
          request && typeof request === "object" && "id" in request &&
          typeof (request as { method?: unknown }).method === "string"
        ) {
          pendingMethods.set(
            (request as { id: string | number }).id,
            (request as { method: string }).method,
          );
        }
      } catch {
        // Not JSON on its own line — the SDK's own reader handles framing;
        // this side channel only degrades to "method unknown" on a miss.
      }
    }
  });

  const originalWrite = stdout.write.bind(stdout);
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      let id: string | number | undefined;
      try {
        id = JSON.parse(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk)?.id;
      } catch {
        // Non-JSON write (e.g. a log line) — stampSpecFields no-ops on it.
      }
      const method = id === undefined ? undefined : pendingMethods.get(id);
      if (id !== undefined) pendingMethods.delete(id);
      chunk = stampSpecFields(chunk, method, cacheHints);
    }
    return originalWrite(chunk, ...rest);
  };
}
