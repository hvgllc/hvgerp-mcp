/**
 * Khoá hợp đồng MCP Events: file JSON, hash ghi trong tài liệu và danh sách từ khoá schema.
 *
 * @module lib/erpnext/src/events/contract_test
 */

import { assert, assertEquals } from "@std/assert";
import { collectKeywords, SUPPORTED_KEYWORDS } from "./json-schema.ts";
import contract from "./contract/meeting-events.v1.json" with { type: "json" };

const CONTRACT_URL = new URL(
  "./contract/meeting-events.v1.json",
  import.meta.url,
);
const DOC_URL = new URL("../../docs/mcp-events-meetings.md", import.meta.url);

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("the SHA-256 recorded in docs/mcp-events-meetings.md matches the contract file", async () => {
  const actual = await sha256Hex(await Deno.readFile(CONTRACT_URL));
  const doc = await Deno.readTextFile(DOC_URL);
  const match = /SHA-256 of the contract file:\s+`([0-9a-f]{64})`/.exec(doc);
  assert(match, "the documentation must record the contract hash");
  assertEquals(match[1], actual);
});

Deno.test("the contract names itself and declares three events", () => {
  assertEquals(contract.contract, "meeting-events.v1");
  assertEquals(contract.protocolVersion, "2026-07-28");
  assertEquals(contract.events.map((event) => event.name), [
    "meeting.created",
    "meeting.updated",
    "meeting.cancelled",
  ]);
});

Deno.test("the contract only uses JSON Schema keywords the validator understands", () => {
  const used = collectKeywords(
    contract.inputSchema,
    collectKeywords(contract.payloadSchema),
  );
  const unsupported = [...used].filter((keyword) =>
    !SUPPORTED_KEYWORDS.includes(keyword)
  );
  assertEquals(unsupported, []);
});
