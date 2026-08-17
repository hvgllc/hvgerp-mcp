import { assert, assertStringIncludes } from "@std/assert";
import { buildServerInstructions } from "./instructions.ts";

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
