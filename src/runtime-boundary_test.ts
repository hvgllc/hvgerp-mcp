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
 * A real import of a `node:` builtin: static, re-exported, or dynamic.
 *
 * `export * from "node:fs"` and `export { readFile } from "node:fs"` are imports that never say
 * `import`, so a gate keyed on that one keyword stays green while the module it guards grows a
 * hard dependency on a Node builtin.
 *
 * Every pattern is anchored to the start of a line so that prose mentioning a builtin inside a
 * block comment (every line of which begins with `*`) is not mistaken for an import - which is
 * exactly what this gate did to its own docstring on the first run.
 */
const NODE_IMPORTS = [
  /^\s*import[^\n]*["']node:/m,
  /^\s*export[^\n]*\bfrom\s*["']node:/m,
  /^\s*(?:const|let|var|return|await)[^\n]*\bimport\s*\(\s*["']node:/m,
];

/**
 * Entry point ở gốc repo, nằm ngoài `src/`.
 *
 * Chúng là chỗ dễ vi phạm nhất chứ không phải chỗ ít rủi ro nhất: một entry point thường là nơi
 * người ta với tay sang `node:process` để đọc argv hay bắt tín hiệu. Vòng đầu của gate này chỉ đi
 * `src/`, nên đúng hai tệp quan trọng nhất lại là hai tệp không ai gác.
 */
const ROOT_ENTRYPOINTS = ["mod.ts", "server.ts", "shim.ts"];

/**
 * Entry point chỉ chạy trên Deno, được phép gọi thẳng `Deno.*`.
 *
 * `shim.ts` là một tiến trình phụ, không phải thư viện: `Dockerfile.shim` chép
 * đúng hai tệp (chính nó và `src/compat/legacy-shim.ts`) vào ảnh
 * `denoland/deno`, và bản npm không đóng gói nó. Kéo cổng runtime vào đây để
 * đọc hai biến môi trường sẽ thêm bốn tệp cùng một bộ chọn adapter vào một ảnh
 * vĩnh viễn không chạy Node. Ngoại lệ nằm ở ĐÚNG tệp entry point; phần thư
 * viện của shim thì không được miễn, và bài test bên dưới canh đúng chỗ đó.
 */
const DENO_ONLY_ENTRYPOINTS = new Set(["shim.ts"]);

/** Lời gọi `Deno.*` thật, sau khi đã bỏ comment. */
const DENO_GLOBAL = /\bDeno\s*\./;

/**
 * Bỏ comment trước khi dò.
 *
 * Cùng lý do với {@link NODE_IMPORTS}: một dòng văn xuôi nhắc tên API không
 * phải một lời gọi, và gate đầu tiên ở đây đã tự bắt chính docstring của nó.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

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

Deno.test("only the runtime adapters call Deno APIs directly", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  // Bộ chọn runtime dò `globalThis.Deno` để biết mình đang chạy ở đâu, nên nó
  // buộc phải nhắc tới nền tảng; nó là một phần của chính lớp adapter.
  const exempt = new Set([...ADAPTERS, "src/runtime.ts"]);
  const offenders: string[] = [];

  for await (const path of scannedFiles(root)) {
    const relative = path.slice(root.length + 1);
    // Test chạy dưới `deno test` nên `Deno.test` ở đó không nói gì về bản npm.
    if (exempt.has(relative) || relative.endsWith("_test.ts")) continue;
    if (DENO_ONLY_ENTRYPOINTS.has(relative)) continue;
    const source = stripComments(await Deno.readTextFile(path));
    if (DENO_GLOBAL.test(source)) offenders.push(relative);
  }

  assertEquals(
    offenders,
    [],
    "these modules call Deno.* directly and would break under Node; move the platform API " +
      "behind a RuntimePort member and import it from ./runtime.ts instead",
  );
});

Deno.test("phan thu vien cua shim khong duoc mien tru", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

  // `shim.ts` được miễn vì nó là tiến trình phụ chỉ chạy Deno. Phần nó gọi tới
  // thì nằm trong `src/` và đi cùng bản npm, nên phải sạch nền tảng: chỉ dùng
  // fetch, Request, Response, Headers, crypto - những thứ cả hai runtime đều có.
  const library = stripComments(
    await Deno.readTextFile(`${root}/src/compat/legacy-shim.ts`),
  );
  assert(
    !DENO_GLOBAL.test(library),
    "src/compat/legacy-shim.ts gọi thẳng Deno.*, nên bản npm sẽ vỡ; ngoại lệ chỉ dành cho shim.ts",
  );
  assert(
    !NODE_IMPORTS.some((pattern) => pattern.test(library)),
    "src/compat/legacy-shim.ts import một builtin `node:`, nên nó không còn chạy được trên Deno",
  );

  // Và ngoại lệ phải thật sự chỉ là một: nếu ai đó thêm entry point Deno-only
  // thứ hai thì phải viết ra lý do ở đây, chứ không lặng lẽ nới danh sách.
  assertEquals([...DENO_ONLY_ENTRYPOINTS], ["shim.ts"]);
});

Deno.test("the gate sees a Node builtin reached through a re-export", () => {
  const matches = (source: string) =>
    NODE_IMPORTS.some((pattern) => pattern.test(source));

  // Đây là hai câu lệnh import không hề chứa từ `import`. Gate khoá vào đúng
  // từ khoá đó thì một module mọc thêm phụ thuộc cứng vào builtin của Node mà
  // bộ test vẫn xanh, tức là cái nó gác không còn là ranh giới nữa.
  assert(matches('export * from "node:fs";'));
  assert(matches('export { readFile } from "node:fs";'));
  assert(matches('export type { Stats } from "node:fs";'));
  assert(matches('import { readFile } from "node:fs";'));
  assert(matches('const fs = await import("node:fs");'));

  // Văn xuôi nhắc tên builtin thì không: mọi dòng của block comment mở đầu
  // bằng `*`, và tên module chỉ nằm trong câu chữ.
  assert(!matches(' * Adapter này là chỗ duy nhất được nhập "node:fs".'));
  assert(!matches('// export the reader instead of touching "node:fs" here'));
});
