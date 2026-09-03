import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildServerInstructions } from "./instructions.ts";
import { allTools } from "./tools/mod.ts";

const EVERY_TOOL = allTools.map((candidate) => candidate.name);

/** Mặc định của các test cũ: máy chủ nạp trọn bộ tool, không lọc category. */
function instructions(
  mode: Parameters<typeof buildServerInstructions>[0],
  loaded: readonly string[] = EVERY_TOOL,
): string {
  return buildServerInstructions(mode, loaded);
}

/** Name endings that already tell the model a tool writes. */
const WRITE_SUFFIXES = [
  "_create",
  "_update",
  "_submit",
  "_cancel",
  "_delete",
  "_move",
];

/** Tools that write but whose name gives no sign of it. */
function silentWrites(): string[] {
  return allTools
    .filter((candidate) => candidate.annotations?.readOnlyHint === false)
    .map((candidate) => candidate.name)
    .filter((name) => !WRITE_SUFFIXES.some((suffix) => name.endsWith(suffix)));
}

/** The promise only one of the three modes can actually keep. */
const PER_CALLER_PROMISE =
  "Every call runs under the caller's own ERPNext permissions";

Deno.test("buildServerInstructions promises per-caller permissions only in required mode", () => {
  assertStringIncludes(instructions("required"), PER_CALLER_PROMISE);

  // Under `off` - the default whenever static ERPNext credentials are configured -
  // every call runs as the deployment's service account, so that sentence turns the
  // account's refusals into "you do not have permission" and misreports the person's
  // own access.
  const off = instructions("off");
  assert(
    !off.includes(PER_CALLER_PROMISE),
    "instructions for `off` must not claim the caller's own permissions apply",
  );
  assertStringIncludes(off, "one shared ERPNext service account");

  // `optional` is the mixed case: both outcomes are live, so the text has to say how
  // to tell them apart rather than pick one.
  const optional = instructions("optional");
  assert(
    !optional.includes(PER_CALLER_PROMISE),
    "instructions for `optional` must not claim per-caller permissions unconditionally",
  );
  assertStringIncludes(optional, "erpnext_whoami");
  assertStringIncludes(optional, "shared-service-account");
});

Deno.test("buildServerInstructions keeps the shared sections in every mode", () => {
  for (const mode of ["required", "optional", "off"] as const) {
    const text = instructions(mode);
    assertStringIncludes(text, "WHO IS ASKING");
    assertStringIncludes(text, "PERMISSIONS");
    assertStringIncludes(text, "WRITES");
  }
});

Deno.test("every tool declares readOnlyHint explicitly", () => {
  const undeclared = allTools
    .filter((candidate) => candidate.annotations?.readOnlyHint === undefined)
    .map((candidate) => candidate.name);

  // The WRITES section tells the model to read `readOnlyHint` rather than the name. MCP
  // defaults a missing hint to false, so leaving the key out happens to mean "write" - but
  // it never reaches `tools/list`, and a client that can only see the keys that are there
  // cannot tell a write apart from a tool nobody got around to annotating.
  assertEquals(undeclared, []);
});

Deno.test("the WRITES section names every write whose name does not signal one", () => {
  const silent = silentWrites();

  // If this ever empties out, the guarantee below became untestable rather than true.
  assert(silent.length > 0, "expected at least one write with a neutral name");
  for (const mode of ["required", "optional", "off"] as const) {
    const text = instructions(mode);
    for (const name of silent) {
      assertStringIncludes(text, name);
    }
  }
});

Deno.test("the WRITES section does not reduce writes to a list of name suffixes", () => {
  const text = instructions("required");

  // The old wording said writes are exactly the tools whose name ends in one of six
  // suffixes. `erpnext_method_call` reaches any allowlisted business method and ends in
  // none of them, so a model that believed the sentence called it without confirming.
  assertStringIncludes(text, "readOnlyHint");
  assert(
    !/whose name ends in _create/.test(text),
    "the name-suffix rule was false for five tools; do not restore it",
  );
});

Deno.test("WHO IS ASKING only advertises tools the server actually loaded", () => {
  // `--categories=project` giữ `erpnext_whoami` (nó là cửa duy nhất biến "my" thành một id)
  // nhưng KHÔNG giữ `erpnext_my_work`, thứ đọc thêm bốn doctype ngoài phạm vi được yêu cầu.
  // Dòng chỉ dẫn giới thiệu nó phải biến mất theo, nếu không mô hình đi gọi một tool vắng mặt.
  const filtered = instructions("required", [
    "erpnext_whoami",
    "erpnext_task_list",
  ]);
  assert(
    !filtered.includes("erpnext_my_work"),
    "a tool absent from tools/list must not be advertised in the instructions",
  );
  assertStringIncludes(filtered, "erpnext_whoami");

  // Quy tắc không gắn với tool nào thì luôn còn.
  assertStringIncludes(
    filtered,
    "the literal string `me` resolves to the caller",
  );

  // Và khi nạp đủ thì dòng đó phải có mặt - nếu không, phép đo trên chỉ đang đo một chuỗi
  // không bao giờ tồn tại.
  assertStringIncludes(instructions("required"), "erpnext_my_work");
});

Deno.test("WHO IS ASKING drops the whoami lines when whoami itself is absent", () => {
  // Không mode nào hiện loại `erpnext_whoami`, nhưng lời hứa "gọi nó TRƯỚC mọi tool khác" chỉ
  // đúng khi nó có trong `tools/list`; buộc nó vào `requires` để một bộ lọc tương lai không
  // lặng lẽ để lại chỉ dẫn trỏ vào hư không.
  const withoutWhoami = instructions("required", ["erpnext_task_list"]);
  assert(
    !withoutWhoami.includes("erpnext_whoami"),
    "the whoami bullets must not survive when the tool is not loaded",
  );
  assertStringIncludes(withoutWhoami, "WHO IS ASKING");
});

Deno.test("the WRITES section only names writes the server actually loaded", () => {
  // Cùng lý do với WHO IS ASKING: `--categories` loại được một tool khỏi `tools/list`, và
  // một cảnh báo còn gọi tên nó là chỉ mô hình đi tìm thứ không có. Quy tắc "đọc
  // `readOnlyHint`, đừng đọc tên" thì không gắn với tool nào nên phải sống sót.
  const filtered = instructions("required", [
    "erpnext_whoami",
    "erpnext_doc_assign",
  ]);

  assertStringIncludes(filtered, "erpnext_doc_assign");
  assert(
    !filtered.includes("erpnext_method_call"),
    "a write absent from tools/list must not be named in WRITES",
  );
  assert(
    !filtered.includes("erpnext_attendance_day_fix"),
    "the cancellation warning must not survive without the tool it describes",
  );
  assertStringIncludes(filtered, "readOnlyHint");

  // Không nạp tool ghi nào thì phần WRITES chỉ còn quy tắc chung, và nó vẫn phải còn:
  // `erpnext_method_call` không phải cửa ghi duy nhất của server.
  const readOnly = instructions("required", ["erpnext_whoami"]);
  assertStringIncludes(readOnly, "WRITES");
  assertStringIncludes(readOnly, "readOnlyHint");
});
