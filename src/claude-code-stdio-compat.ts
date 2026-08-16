// deno-lint-ignore-file no-process-global
/**
 * Claude Code stdio compatibility shim.
 *
 * Claude Code's MCP client (as of 2026-08) rejects `tools/list` /
 * `resources/list` / `prompts/list` results that lack a `resultType` field,
 * even when the negotiated protocol revision is earlier than 2026-07-28 —
 * where the spec defines a missing `resultType` as `"complete"` (the
 * "absent-means-complete" bridge Claude Code's own error message names, but
 * does not actually honor). `@casys/mcp-server` only stamps `resultType` on
 * the stateless/HTTP transport when it negotiates exactly 2026-07-28 —
 * correct per spec, since stdio here negotiates 2025-11-25. See
 * `stampResult()` in `@casys/mcp-server`'s `mcp-app.ts`.
 *
 * This module rewrites the stdio wire format after the SDK has already
 * serialized it, so Claude Code connects without touching the SDK's
 * spec-correct behavior. Drop this once Claude Code honors the bridge
 * itself.
 */

const LIST_RESULT_ARRAY_KEYS = ["tools", "resources", "prompts"] as const;

/**
 * Adds `resultType: "complete"` to a serialized JSON-RPC line when it is a
 * list result (tools/resources/prompts) missing that field. Non-list
 * results, error responses, notifications, and non-JSON-RPC lines pass
 * through unchanged.
 */
export function stampMissingResultType(line: string): string {
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
  const isListResult = LIST_RESULT_ARRAY_KEYS.some((key) =>
    Array.isArray(record[key])
  );
  if (!isListResult) return line;

  record.resultType = "complete";
  return JSON.stringify(message) + (hasTrailingNewline ? "\n" : "");
}

/**
 * Wraps `process.stdout.write` so every outgoing stdio JSON-RPC line runs
 * through `stampMissingResultType` first. Idempotent — safe to call more
 * than once (later calls are no-ops).
 */
export function installClaudeCodeStdioCompat(): void {
  const stdout = process.stdout as unknown as {
    write: (...args: unknown[]) => boolean;
    __claudeCodeStdioCompatInstalled?: boolean;
  };
  if (stdout.__claudeCodeStdioCompatInstalled) return;

  const originalWrite = stdout.write.bind(stdout);
  stdout.write = (chunk: unknown, ...rest: unknown[]) => {
    const patched = typeof chunk === "string"
      ? stampMissingResultType(chunk)
      : chunk;
    return originalWrite(patched, ...rest);
  };
  stdout.__claudeCodeStdioCompatInstalled = true;
}
