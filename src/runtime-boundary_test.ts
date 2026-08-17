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

import { assert, assertEquals } from "@std/assert";

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

/**
 * Entry point ở gốc repo, nằm ngoài `src/`.
 *
 * Chúng là chỗ dễ vi phạm nhất chứ không phải chỗ ít rủi ro nhất: một entry point thường là nơi
 * người ta với tay sang `node:process` để đọc argv hay bắt tín hiệu. Vòng đầu của gate này chỉ đi
 * `src/`, nên đúng hai tệp quan trọng nhất lại là hai tệp không ai gác.
 */
const ROOT_ENTRYPOINTS = ["mod.ts", "server.ts"];

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

/** Mọi tệp mà luật ranh giới áp lên: cả cây `src` cộng hai entry point ở gốc. */
async function* scannedFiles(root: string): AsyncGenerator<string> {
  yield* sourceFiles(`${root}/src`);
  for (const entry of ROOT_ENTRYPOINTS) {
    yield `${root}/${entry}`;
  }
}

Deno.test("only the runtime adapters import Node APIs directly", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const offenders: string[] = [];

  for await (const path of scannedFiles(root)) {
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

Deno.test("the gate's scope covers the root entry points, not just src/", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const scanned = new Set<string>();
  for await (const path of scannedFiles(root)) {
    scanned.add(path.slice(root.length + 1));
  }

  for (const entry of ROOT_ENTRYPOINTS) {
    assert(
      scanned.has(entry),
      `${entry} nằm ngoài phạm vi của gate, nên một import \`node:\` đặt ở đó vẫn xanh trên Deno ` +
        `và chỉ vỡ về sau, lúc dựng bản npm hoặc lúc người dùng cài`,
    );
    // Tên tệp ghi cứng: nếu ai đó đổi tên entry point thì phải đổi cả ở đây, chứ không để gate
    // lặng lẽ quét một đường dẫn không còn tồn tại.
    const stat = await Deno.stat(`${root}/${entry}`);
    assert(
      stat.isFile,
      `${entry} không còn là một tệp; cập nhật ROOT_ENTRYPOINTS`,
    );
  }
});
