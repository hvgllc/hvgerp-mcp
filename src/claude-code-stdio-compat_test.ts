/**
 * Tests for the Claude Code stdio compatibility shim.
 *
 * @module src/claude-code-stdio-compat_test
 */

import { assertEquals } from "@std/assert";
import {
  type CacheHints,
  stampSpecFields,
} from "./claude-code-stdio-compat.ts";

const HINTS: CacheHints = { ttlMs: 3_600_000, cacheScope: "public" };

Deno.test("stamps resultType + cache hints on a tools/list result", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [{ name: "erpnext_ping" }] },
  }) + "\n";

  const out = JSON.parse(stampSpecFields(line, "tools/list", HINTS));
  assertEquals(out.result.resultType, "complete");
  assertEquals(out.result.ttlMs, 3_600_000);
  assertEquals(out.result.cacheScope, "public");
  assertEquals(out.result.tools.length, 1);
});

Deno.test("stamps resultType + cache hints on a resources/list result", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: { resources: [] },
  }) + "\n";

  const out = JSON.parse(stampSpecFields(line, "resources/list", HINTS));
  assertEquals(out.result.resultType, "complete");
  assertEquals(out.result.ttlMs, 3_600_000);
  assertEquals(out.result.cacheScope, "public");
});

Deno.test("stamps resultType + cache hints on a resources/templates/list result", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 5,
    result: { resourceTemplates: [] },
  }) + "\n";

  const out = JSON.parse(
    stampSpecFields(line, "resources/templates/list", HINTS),
  );
  assertEquals(out.result.resultType, "complete");
  assertEquals(out.result.ttlMs, 3_600_000);
  assertEquals(out.result.cacheScope, "public");
});

Deno.test("stamps resultType + cache hints on a resources/read result", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 6,
    result: { contents: [{ uri: "ui://hvgerp-mcp/foo", text: "<html/>" }] },
  }) + "\n";

  const out = JSON.parse(stampSpecFields(line, "resources/read", HINTS));
  assertEquals(out.result.resultType, "complete");
  assertEquals(out.result.ttlMs, 3_600_000);
  assertEquals(out.result.cacheScope, "public");
});

Deno.test("stamps resultType + cache hints on a prompts/list result", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: { prompts: [] },
  }) + "\n";

  const out = JSON.parse(stampSpecFields(line, "prompts/list", HINTS));
  assertEquals(out.result.resultType, "complete");
  assertEquals(out.result.ttlMs, 3_600_000);
  assertEquals(out.result.cacheScope, "public");
});

Deno.test("stamps only resultType (no cache hints) when method is not cache-hint eligible", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    result: { content: [{ type: "text", text: "ok" }] },
  }) + "\n";

  const out = JSON.parse(stampSpecFields(line, "tools/call", HINTS));
  assertEquals(out.result.resultType, "complete");
  assertEquals("ttlMs" in out.result, false);
  assertEquals("cacheScope" in out.result, false);
});

Deno.test("stamps only resultType when the originating method is unknown", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [{ name: "erpnext_ping" }] },
  }) + "\n";

  const out = JSON.parse(stampSpecFields(line, undefined, HINTS));
  assertEquals(out.result.resultType, "complete");
  assertEquals("ttlMs" in out.result, false);
  assertEquals("cacheScope" in out.result, false);
});

Deno.test("leaves a result that already has resultType untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [], resultType: "complete" },
  }) + "\n";

  assertEquals(stampSpecFields(line, "tools/list", HINTS), line);
});

Deno.test("leaves an error response untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Method not found" },
  }) + "\n";

  assertEquals(stampSpecFields(line, "tools/list", HINTS), line);
});

Deno.test("leaves a notification (no result field) untouched", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed",
  }) + "\n";

  assertEquals(stampSpecFields(line, undefined, HINTS), line);
});

Deno.test("leaves a non-JSON line untouched", () => {
  const line = "[hvgerp-mcp] Server started\n";
  assertEquals(stampSpecFields(line, undefined, HINTS), line);
});

Deno.test("preserves absence of trailing newline", () => {
  const line = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [] },
  });

  const out = stampSpecFields(line, "tools/list", HINTS);
  assertEquals(out.endsWith("\n"), false);
  const parsed = JSON.parse(out);
  assertEquals(parsed.result.resultType, "complete");
  assertEquals(parsed.result.ttlMs, 3_600_000);
});
