/**
 * Test cho các từ khoá mà hợp đồng hiệu suất nhân sự cần thêm: `$ref` nội bộ, `$defs`, `maxItems`.
 *
 * Các từ khoá cũ đã có test trong `protocol_test.ts`; file này chỉ phủ phần mở rộng.
 *
 * @module lib/erpnext/src/events/json-schema_test
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  collectKeywords,
  SUPPORTED_KEYWORDS,
  validateJsonSchema,
} from "./json-schema.ts";

const ROOT = {
  $defs: {
    code: { type: "string", minLength: 1, maxLength: 5 },
    row: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: { code: { $ref: "#/$defs/code" } },
    },
  },
};

Deno.test("a local $ref validates against the definition it names", () => {
  const schema = { $ref: "#/$defs/row" };
  assertEquals(validateJsonSchema(schema, { code: "AB" }, ROOT), []);
  assertEquals(validateJsonSchema(schema, { code: "TOOLONG" }, ROOT), [
    "/code: longer than maxLength",
  ]);
  assertEquals(validateJsonSchema(schema, { other: 1 }, ROOT), [
    "/code: required",
    "/other: additional property",
  ]);
});

Deno.test("a $ref inside anyOf, not and if resolves against the same root", () => {
  const schema = {
    anyOf: [{ $ref: "#/$defs/code" }, { type: "null" }],
  };
  assertEquals(validateJsonSchema(schema, null, ROOT), []);
  assertEquals(validateJsonSchema(schema, "AB", ROOT), []);
  assertEquals(validateJsonSchema(schema, 7, ROOT), [
    ": no anyOf branch matched",
  ]);
  assertEquals(
    validateJsonSchema({ not: { $ref: "#/$defs/code" } }, "AB", ROOT),
    [": matched a forbidden shape"],
  );
});

Deno.test("without an explicit root, the schema itself is the root", () => {
  const schema = {
    $defs: { flag: { type: "boolean" } },
    type: "object",
    properties: { on: { $ref: "#/$defs/flag" } },
  };
  assertEquals(validateJsonSchema(schema, { on: true }), []);
  assertEquals(validateJsonSchema(schema, { on: "yes" }), [
    "/on: expected boolean",
  ]);
});

Deno.test("an unresolvable or non-local $ref is a schema bug and throws", () => {
  // Lỗi của chính schema, không phải của dữ liệu: im lặng bỏ qua thì mọi giá trị đều "hợp lệ".
  assertThrows(
    () => validateJsonSchema({ $ref: "#/$defs/missing" }, 1, ROOT),
    Error,
    "unresolved $ref",
  );
  assertThrows(
    () => validateJsonSchema({ $ref: "https://example.com/x.json" }, 1, ROOT),
    Error,
    "unsupported $ref",
  );
});

Deno.test("maxItems bounds an array and its error carries no value", () => {
  const schema = { type: "array", maxItems: 2, items: { type: "string" } };
  assertEquals(validateJsonSchema(schema, ["a", "b"]), []);
  assertEquals(validateJsonSchema(schema, ["secret-1", "b", "c"]), [
    ": more items than maxItems",
  ]);
});

Deno.test("names under $defs are not counted as keywords", () => {
  const used = collectKeywords(ROOT);
  assertEquals(used.has("code"), false);
  assertEquals(used.has("row"), false);
  for (const keyword of ["$defs", "$ref", "maxItems"]) {
    assertEquals(SUPPORTED_KEYWORDS.includes(keyword), true, keyword);
  }
});

Deno.test("a $ref cycle that never consumes the value throws instead of looping", () => {
  const root = {
    $defs: {
      a: { anyOf: [{ $ref: "#/$defs/b" }] },
      b: { $ref: "#/$defs/a" },
    },
  };
  assertThrows(
    () => validateJsonSchema({ $ref: "#/$defs/a" }, 1, root),
    Error,
    "circular $ref",
  );
  // Đệ quy có tiêu thụ giá trị (cây lồng nhau) là hợp lệ và dừng khi dữ liệu hết.
  const tree = {
    $defs: {
      node: {
        type: "object",
        properties: {
          children: { type: "array", items: { $ref: "#/$defs/node" } },
        },
      },
    },
  };
  assertEquals(
    validateJsonSchema(
      { $ref: "#/$defs/node" },
      { children: [{ children: [{}] }] },
      tree,
    ),
    [],
  );
});
