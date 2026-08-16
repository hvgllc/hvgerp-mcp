/**
 * Tests for the Claude Code stdio compatibility shim.
 *
 * @module src/claude-code-stdio-compat_test
 */

import { assertEquals } from "@std/assert";
import { stampMissingResultType } from "./claude-code-stdio-compat.ts";

Deno.test("stamps a tools/list result missing resultType", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [{ name: "erpnext_ping" }] },
  }) + "\n";

  const out = JSON.parse(stampMissingResultType(line));
  assertEquals(out.result.resultType, "complete");
  assertEquals(out.result.tools.length, 1);
});

Deno.test("stamps a resources/list result missing resultType", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { resources: [] },
  }) + "\n";

  const out = JSON.parse(stampMissingResultType(line));
  assertEquals(out.result.resultType, "complete");
});

Deno.test("stamps a prompts/list result missing resultType", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: { prompts: [] },
  }) + "\n";

  const out = JSON.parse(stampMissingResultType(line));
  assertEquals(out.result.resultType, "complete");
});

Deno.test("leaves a result that already has resultType untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [], resultType: "complete" },
  }) + "\n";

  assertEquals(stampMissingResultType(line), line);
});

Deno.test("leaves a non-list result (tools/call) untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "ok" }] },
  }) + "\n";

  assertEquals(stampMissingResultType(line), line);
});

Deno.test("leaves an error response untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Method not found" },
  }) + "\n";

  assertEquals(stampMissingResultType(line), line);
});

Deno.test("leaves a notification (no result field) untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed",
  }) + "\n";

  assertEquals(stampMissingResultType(line), line);
});

Deno.test("leaves a non-JSON line untouched", () => {
  const line = "[hvgerp-mcp] Server started\n";
  assertEquals(stampMissingResultType(line), line);
});

Deno.test("preserves absence of trailing newline", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [] },
  });

  const out = stampMissingResultType(line);
  assertEquals(out.endsWith("\n"), false);
  assertEquals(JSON.parse(out).result.resultType, "complete");
});
