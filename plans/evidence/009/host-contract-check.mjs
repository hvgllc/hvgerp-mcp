import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Kiểm trực tiếp hàm host mà không khởi tạo DOM/AppBridge hoặc nhập alias UI.
const source = readFileSync(
  new URL("../../../src/ui/testing/host.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("function detailMutation(");
const end = source.indexOf("\nfunction responseFor(", start);
assert.ok(start >= 0 && end > start, "Expected detailMutation source boundary");
let saved = { doctype: "Task", name: "A", _assign: '["x@example.test"]' };
const detailMutation = runInNewContext(
  `(${stripTypeScriptTypes(source.slice(start, end))})`,
  {
    details: {
      get: () => structuredClone(saved),
      set: (_doctype, _name, doc) => {
        saved = structuredClone(doc);
      },
    },
    boards: [],
    result: (payload) =>
      JSON.parse(JSON.stringify({ isError: false, payload })),
    failure: (message) => ({ isError: true, message }),
  },
);

const args = { doctype: "Task", name: "A", assign_to: "y@example.test" };
const preview = detailMutation("erpnext_doc_assign", args);
assert.deepEqual(preview.payload.assignment.assignees, ["y@example.test"]);
assert.deepEqual(JSON.parse(preview.payload.data._assign), [
  "x@example.test",
  "y@example.test",
]);
assert.deepEqual(JSON.parse(saved._assign), ["x@example.test"]);

const applied = detailMutation("erpnext_doc_assign", args, true);
assert.deepEqual(applied.payload.assignment.assignees, ["y@example.test"]);
assert.deepEqual(JSON.parse(applied.payload.data._assign), [
  "x@example.test",
  "y@example.test",
]);
assert.deepEqual(JSON.parse(saved._assign), [
  "x@example.test",
  "y@example.test",
]);
assert.equal(applied.payload.assignment.notify_user, true);
console.log(
  "Host assignment contract OK: request [Y], document [X,Y], preview does not mutate",
);
