import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildServerInstructions } from "./instructions.ts";
import { allTools } from "./tools/mod.ts";

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
  assertStringIncludes(buildServerInstructions("required"), PER_CALLER_PROMISE);

  // Under `off` - the default whenever static ERPNext credentials are configured -
  // every call runs as the deployment's service account, so that sentence turns the
  // account's refusals into "you do not have permission" and misreports the person's
  // own access.
  const off = buildServerInstructions("off");
  assert(
    !off.includes(PER_CALLER_PROMISE),
    "instructions for `off` must not claim the caller's own permissions apply",
  );
  assertStringIncludes(off, "one shared ERPNext service account");

  // `optional` is the mixed case: both outcomes are live, so the text has to say how
  // to tell them apart rather than pick one.
  const optional = buildServerInstructions("optional");
  assert(
    !optional.includes(PER_CALLER_PROMISE),
    "instructions for `optional` must not claim per-caller permissions unconditionally",
  );
  assertStringIncludes(optional, "erpnext_whoami");
  assertStringIncludes(optional, "shared-service-account");
});

Deno.test("buildServerInstructions keeps the shared sections in every mode", () => {
  for (const mode of ["required", "optional", "off"] as const) {
    const text = buildServerInstructions(mode);
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
    const text = buildServerInstructions(mode);
    for (const name of silent) {
      assertStringIncludes(text, name);
    }
  }
});

Deno.test("the WRITES section does not reduce writes to a list of name suffixes", () => {
  const text = buildServerInstructions("required");

  // The old wording said writes are exactly the tools whose name ends in one of six
  // suffixes. `erpnext_method_call` reaches any allowlisted business method and ends in
  // none of them, so a model that believed the sentence called it without confirming.
  assertStringIncludes(text, "readOnlyHint");
  assert(
    !/whose name ends in _create/.test(text),
    "the name-suffix rule was false for five tools; do not restore it",
  );
});
