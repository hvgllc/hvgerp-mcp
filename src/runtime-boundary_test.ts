/**
 * The dual-runtime boundary, asserted instead of merely documented.
 *
 * AGENTS.md ("Dual-runtime design"): *All source code imports `from "./runtime.ts"` - never import
 * Deno or Node APIs directly.* That rule had no gate, so `src/api/caller-context.ts` could reach
 * straight for `node:async_hooks` and stay green on Deno - the npm bundle only breaks later, at the
 * build or at a user's install. The two adapter files are the whole exception list: they exist
 * precisely to hold the platform imports.
 *
 * @module lib/erpnext/src/runtime-boundary_test
 */

import { assertEquals } from "@std/assert";

/** The only modules allowed to import a platform API directly. */
const ADAPTERS = new Set([
  "src/runtime.deno.ts",
  "src/runtime.node.ts",
]);

/**
 * A real import of a `node:` builtin, static or dynamic.
 *
 * Both patterns are anchored to the start of a line so that prose mentioning a builtin inside a
 * block comment (every line of which begins with `*`) is not mistaken for an import - which is
 * exactly what this gate did to its own docstring on the first run.
 */
const NODE_IMPORTS = [
  /^\s*import[^\n]*["']node:/m,
  /^\s*(?:const|let|var|return|await)[^\n]*\bimport\s*\(\s*["']node:/m,
];

/** Walk `dir` for `.ts` files, skipping vendored trees. */
async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* sourceFiles(path);
    } else if (entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

Deno.test("only the runtime adapters import Node APIs directly", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];

  for await (const path of sourceFiles(`${root}/src`)) {
    const relative = path.slice(root.length + 1);
    if (ADAPTERS.has(relative)) continue;
    const source = await Deno.readTextFile(path);
    if (NODE_IMPORTS.some((pattern) => pattern.test(source))) {
      offenders.push(relative);
    }
  }

  assertEquals(
    offenders,
    [],
    "these modules bypass the runtime adapter and would break the npm build; move the platform " +
      "API behind a RuntimePort member and import it from ./runtime.ts instead",
  );
});
