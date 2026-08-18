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
 * The specifier does not have to sit on the same line as the keyword: `deno fmt` breaks a longer
 * list across lines, so a line-bounded matcher misses `export {\n  readFile,\n} from "node:fs"`.
 * The patterns therefore span up to the statement's semicolon, and every source is run through
 * {@link stripNonCode} first - prose naming a builtin is not an import, and the gate's own
 * docstring was its first false positive.
 */
const NODE_IMPORTS = [
  /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']node:/m,
  /^\s*import\s*["']node:/m,
  /\bimport\s*\(\s*["']node:/,
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
 * Chuỗi được giữ nguyên đúng khi nó đứng ở vị trí định danh module.
 *
 * Chỉ ở đó nội dung của nó mới là một phụ thuộc; mọi chuỗi khác là văn xuôi.
 */
const SPECIFIER_CONTEXT = /(?:\bfrom|\bimport)\s*\(?\s*$/;

/**
 * Ký tự trước một `/` khi `/` mở đầu một regex chứ không phải phép chia.
 *
 * Cần phân biệt vì regex chứa dấu nháy - `["']` trong chính tệp này - và đọc
 * nó như một chuỗi làm bộ quét lệch pha suốt phần còn lại của tệp.
 */
const REGEX_POSITION =
  /(?:[=(,:[!&|?{};+\-*%~^<>]|\b(?:return|typeof|case|in|of|do|else|yield|await))\s*$/;

/** Từ khoá mở đầu một khối template: `${`. */
type ScanFrame =
  | { kind: "template"; keep: boolean }
  | { kind: "substitution"; braces: number };

/**
 * Chỉ giữ lại phần thật sự là mã: bỏ comment, làm rỗng chuỗi không phải định
 * danh module, giữ nguyên biểu thức bên trong `${...}` của template.
 *
 * Cùng một lý do cho hai vế đầu: văn xuôi nhắc tên API không phải một lời gọi
 * API. Gate đầu tiên ở đây tự bắt chính docstring của nó, gate thứ hai tự bắt
 * chính fixture của nó, và cả hai lần cách chữa sai là miễn trừ tệp - tức bỏ
 * gác đúng chỗ dễ sai nhất. Một câu báo lỗi nhắc `Deno.readTextFile` nằm trong
 * bất kỳ tệp nào bị quét cũng làm gate CI đỏ vì một chuỗi ký tự.
 *
 * Vế thứ ba là chiều ngược lại: `${...}` là mã chạy được nằm trong một chuỗi,
 * nên làm rỗng cả template là giấu đi đúng thứ gate phải bắt.
 *
 * Phải quét ký tự chứ không thay bằng regex, vì mọi lối tắt đều hỏng theo cách
 * riêng: chỉ gỡ comment chiếm trọn dòng thì `const x = 1; // import("node:fs")`
 * làm gate đỏ vì một câu văn, còn cắt mù mọi `//` thì `"https://example.com"`
 * bị xén mất một nửa.
 */
function stripNonCode(source: string): string {
  let out = "";
  let index = 0;
  const stack: ScanFrame[] = [];

  while (index < source.length) {
    const char = source[index];
    const frame = stack.at(-1);

    // Phần văn bản của một template: ở đây không có comment, và nội dung chỉ
    // được giữ khi cả template đứng ở vị trí định danh module.
    if (frame?.kind === "template") {
      if (char === "\\") {
        if (frame.keep) out += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (char === "`") {
        stack.pop();
        out += "`";
        index += 1;
        continue;
      }
      if (char === "$" && source[index + 1] === "{") {
        stack.push({ kind: "substitution", braces: 0 });
        out += "${";
        index += 2;
        continue;
      }
      if (frame.keep) out += char;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      // Chỉ cần đuôi của phần đã phát: `$` neo ở cuối nên phần đầu không đổi
      // kết quả, mà cắt ngắn thì phép thử không phải quét lại cả tệp.
      const keep = SPECIFIER_CONTEXT.test(out.slice(-32));
      let literal = char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === "\\") {
          literal += source.slice(index, index + 2);
          index += 2;
          continue;
        }
        literal += inner;
        index += 1;
        if (inner === char) break;
      }
      out += keep ? literal : `${char}${char}`;
      continue;
    }

    if (char === "`") {
      stack.push({
        kind: "template",
        keep: SPECIFIER_CONTEXT.test(out.slice(-32)),
      });
      out += "`";
      index += 1;
      continue;
    }

    if (char === "{" && frame?.kind === "substitution") {
      frame.braces += 1;
      out += char;
      index += 1;
      continue;
    }
    if (char === "}" && frame?.kind === "substitution") {
      if (frame.braces === 0) stack.pop();
      else frame.braces -= 1;
      out += char;
      index += 1;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) index += 1;
      index += 2;
      continue;
    }
    if (char === "/" && REGEX_POSITION.test(out.slice(-32))) {
      const closed = skipRegexLiteral(source, index);
      if (closed > 0) {
        // Nội dung regex không bao giờ là một phụ thuộc, nên chỉ cần một chỗ
        // giữ vị trí; điều quan trọng là bộ quét không đọc `["']` bên trong nó
        // như một dấu mở chuỗi.
        out += "/x/";
        index = closed;
        continue;
      }
    }

    out += char;
    index += 1;
  }
  return out;
}

/**
 * Vị trí ngay sau một regex literal bắt đầu ở `start`, hoặc `-1` nếu `/` đó
 * không mở một regex (không đóng trước khi hết dòng, tức nó là phép chia).
 */
function skipRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\n") return -1;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
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
    const source = stripNonCode(await Deno.readTextFile(path));
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
    const source = stripNonCode(await Deno.readTextFile(path));
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
  const library = stripNonCode(
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

/**
 * Chuỗi định danh module, ghép lại thay vì viết thẳng.
 *
 * Bài test bên dưới phải dựng đúng những câu lệnh mà gate cần bắt, mà gate thì
 * quét chính tệp này. Viết thẳng lời gọi `import()` kèm định danh vào một chuỗi
 * mẫu là làm gate đỏ vì một fixture chứ không phải vì một phụ thuộc, và cách
 * chữa sai là miễn trừ tệp này - tức là bỏ gác đúng chỗ dễ sai nhất.
 */
const NODE_MODULE = '"node:fs"';

Deno.test("the gate sees a Node builtin reached through a re-export", () => {
  const matches = (source: string) =>
    NODE_IMPORTS.some((pattern) => pattern.test(stripNonCode(source)));

  // Đây là những câu lệnh import không hề chứa từ `import`. Gate khoá vào đúng
  // từ khoá đó thì một module mọc thêm phụ thuộc cứng vào builtin của Node mà
  // bộ test vẫn xanh, tức là cái nó gác không còn là ranh giới nữa.
  assert(matches(`export * from ${NODE_MODULE};`));
  assert(matches(`export { readFile } from ${NODE_MODULE};`));
  assert(matches(`export type { Stats } from ${NODE_MODULE};`));
  assert(matches(`import { readFile } from ${NODE_MODULE};`));
  assert(matches(`import ${NODE_MODULE};`));
  assert(matches(`const fs = await import(${NODE_MODULE});`));

  // `deno fmt` bẻ danh sách dài xuống nhiều dòng, nên một matcher bó trong một
  // dòng bỏ lọt đúng hình dạng mà chính bộ format của repo sinh ra.
  assert(
    matches(`export {\n  readFile,\n  writeFile,\n} from ${NODE_MODULE};`),
  );
  assert(matches(`import {\n  readFile,\n} from ${NODE_MODULE};`));

  // Văn xuôi nhắc tên builtin thì không: comment bị gỡ trước khi dò, nên tên
  // module nằm trong câu chữ không bao giờ bị đọc thành một lời khai phụ thuộc.
  assert(
    !matches(
      `/**\n * Adapter này là chỗ duy nhất được nhập ${NODE_MODULE}.\n */`,
    ),
  );
  assert(!matches(`export const specifier = ${NODE_MODULE};`));
  assert(
    !matches(`// export the reader instead of touching ${NODE_MODULE} here`),
  );
});

Deno.test("dynamic import bi bat o moi vi tri, va comment khong lam gate do", () => {
  const matches = (source: string) =>
    NODE_IMPORTS.some((pattern) => pattern.test(stripNonCode(source)));

  // `import()` là biểu thức: nó đứng được ở bất kỳ đâu một biểu thức đứng
  // được, nên khoá vào vài tiền tố câu lệnh là để lọt phần còn lại.
  assert(matches(`modulePromise = import(${NODE_MODULE});`));
  assert(matches(`export default import(${NODE_MODULE});`));
  assert(matches(`register(() => import(${NODE_MODULE}));`));

  // Chiều ngược lại: một câu văn nhắc tới import không phải một phụ thuộc, và
  // gate cứng mà đỏ vì văn xuôi thì người ta sẽ gỡ chính cái gate.
  assert(!matches(`const mode = "portable"; // tránh import(${NODE_MODULE})`));

  // Và cắt comment không được đụng vào chuỗi: `//` trong một URL không được
  // đọc thành mở đầu của một comment, tức phần sau nó vẫn còn nguyên là mã.
  assertEquals(
    stripNonCode('const site = "https://example.com"; // ghi chú'),
    'const site = ""; \n',
  );
});

Deno.test("van xuoi trong chuoi thuong khong bi doc thanh phu thuoc", () => {
  const matches = (source: string) =>
    NODE_IMPORTS.some((pattern) => pattern.test(stripNonCode(source)));

  // Đây là chỗ gate còn đỏ vì một chuỗi ký tự: một câu báo lỗi nhắc tên API là
  // văn xuôi y như comment, chỉ khác chỗ đứng. Fixture ghép chuỗi ở bài trên
  // chỉ chữa được đúng tệp này, trong khi luật thì áp lên cả cây `src`.
  assert(!matches(`throw new Error("đừng gọi import(${NODE_MODULE}) ở đây");`));
  assert(
    !matches(`const hint = 'thay import(${NODE_MODULE}) bằng runtime.ts';`),
  );
  assert(
    !matches(`log(\`không được import(${NODE_MODULE}) trong \${name}\`);`),
  );

  // Chiều ngược lại phải còn nguyên: chuỗi đứng ở vị trí định danh module vẫn
  // là một phụ thuộc thật, và làm rỗng nó là bỏ gác.
  assert(matches(`import { readFile } from ${NODE_MODULE};`));
  assert(matches(`await import(${NODE_MODULE});`));

  // `Deno.*` trong một câu báo lỗi cũng vậy - và đây là cách chính tệp thư viện
  // của shim mô tả luật cho người đọc log.
  assert(
    !DENO_GLOBAL.test(stripNonCode(`fail("không được gọi Deno.env ở đây");`)),
  );
  assert(DENO_GLOBAL.test(stripNonCode(`const port = Deno.env.get("PORT");`)));
});

/**
 * Hai mảnh cú pháp ghép lại thay vì viết thẳng.
 *
 * Cùng lý do với {@link NODE_MODULE}: fixture phải dựng đúng hình dạng mà gate
 * cần bắt, mà gate thì quét chính tệp này.
 */
const SUBSTITUTION_OPEN = "${";
const BACKTICK = "`";

Deno.test("bieu thuc trong template van bi soi, van xuoi quanh no thi khong", () => {
  const matches = (source: string) =>
    NODE_IMPORTS.some((pattern) => pattern.test(stripNonCode(source)));

  // `${...}` là mã chạy được nằm trong một chuỗi. Làm rỗng cả template là giấu
  // đi đúng thứ gate phải bắt, và gate xanh trong khi phụ thuộc thì đã ở đó.
  assert(
    matches(
      `${BACKTICK}${SUBSTITUTION_OPEN}await import(${NODE_MODULE})}${BACKTICK}`,
    ),
  );
  assert(
    DENO_GLOBAL.test(
      stripNonCode(
        `${BACKTICK}port=${SUBSTITUTION_OPEN}Deno.env.get("PORT")}${BACKTICK}`,
      ),
    ),
  );

  // Phần văn bản của template vẫn là văn xuôi: chỉ biểu thức mới là mã.
  assert(
    !matches(`${BACKTICK}đừng import(${NODE_MODULE}) ở đây${BACKTICK}`),
  );
  assert(
    !DENO_GLOBAL.test(
      stripNonCode(`${BACKTICK}tránh Deno.env ở đây${BACKTICK}`),
    ),
  );

  // Template lồng trong chính substitution của nó phải về đúng lớp ngoài, nếu
  // không phần còn lại của tệp bị đọc lệch pha.
  const nested =
    `${BACKTICK}${SUBSTITUTION_OPEN}f(${BACKTICK}x${BACKTICK})}${BACKTICK}; import(${NODE_MODULE});`;
  assert(matches(nested));
});

Deno.test("regex literal khong lam bo quet lech pha", () => {
  const matches = (source: string) =>
    NODE_IMPORTS.some((pattern) => pattern.test(stripNonCode(source)));

  // Một regex chứa dấu nháy - như chính NODE_IMPORTS ở trên - bị đọc thành dấu
  // mở chuỗi thì mọi thứ sau nó lệch pha: chuỗi hoá thành mã, mã hoá thành
  // chuỗi, và một import thật nằm sau đó không còn được nhìn thấy.
  const afterRegex = `const quoted = /["']/;\nimport(${NODE_MODULE});`;
  assert(matches(afterRegex));

  // Và `/` của phép chia không được nuốt phần còn lại của dòng.
  assertEquals(
    stripNonCode("const half = total / 2;"),
    "const half = total / 2;",
  );
});
