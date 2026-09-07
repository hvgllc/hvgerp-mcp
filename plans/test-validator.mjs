import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const planRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(planRoot, "..");
const tick = String.fromCharCode(96);
const source = readFileSync(resolve(planRoot, "validate-plans.mjs"), "utf8")
  .replace(/^import [^;]*;\n/gm, "")
  .replace("dirname(fileURLToPath(import.meta.url))", "injectedPlanRoot");
const manifest = JSON.parse(
  readFileSync(resolve(planRoot, "manifest.json"), "utf8"),
);
const fileFor = (id) =>
  "plans/" + manifest.find((entry) => entry.id === id).file;
const gitFixtureCache = new Map();
function readGitFixture(
  command,
  args,
  options,
  execute,
  cache = gitFixtureCache,
) {
  // Chỉ object ID đầy đủ là bất biến; HEAD, refs và filesystem luôn được đọc lại.
  const immutable = command === "git" && (
    (args.length === 2 && args[0] === "show" &&
      /^[0-9a-f]{40}:.+$/.test(args[1])) ||
    (args.length === 3 && args[0] === "cat-file" && args[1] === "-t" &&
      /^[0-9a-f]{40}$/.test(args[2])) ||
    (args.length === 6 &&
      args.slice(0, 5).join(" ") === "ls-tree -r -t -z --full-tree" &&
      /^[0-9a-f]{40}$/.test(args[5]))
  );
  const key = JSON.stringify([
    command,
    args,
    options.cwd,
    options.encoding ?? null,
  ]);
  const copy = (output) =>
    Buffer.isBuffer(output) ? Buffer.from(output) : output;
  if (immutable && cache.has(key)) return copy(cache.get(key));
  const output = execute(command, args, options);
  if (immutable && (typeof output === "string" || Buffer.isBuffer(output))) {
    cache.set(key, copy(output));
  }
  return output;
}

// Fixture filesystem nhận cả chuỗi loại lẫn object mô tả thêm realpath.
const kindOf = (entry) => typeof entry === "string" ? entry : entry?.kind;

function run(replacements = {}, hidden = [], filesystem = {}, gitOutput) {
  const messages = [], historicalReads = [], existenceChecks = [];
  let gitSubprocesses = 0;
  // Một mục của filesystem ảo đại diện cho artifact có thật trong repo, nên nó
  // phải xuất hiện trong chỉ mục Git y như trên đĩa. Mục khai "tracked": false
  // mô tả file chỉ có trong cây làm việc, đúng thứ mà gate đích link phải bác.
  const virtualIndex = Object.entries(filesystem)
    .filter(([, entry]) =>
      kindOf(entry) === "file" &&
      (typeof entry === "string" || entry.tracked !== false)
    )
    .map(([key]) => "100644 " + "0".repeat(40) + " 0\t" + key + "\0")
    .join("");
  // argv của một lần chạy thường: không cờ nào, nên chế độ liệt kê provenance
  // không bật và các test đọc messages vẫn chỉ thấy output của gate.
  const state = { exitCode: 0, argv: [] };
  let thrown;
  try {
    runInNewContext(source, {
      existsSync: (path) => {
        existenceChecks.push(path);
        return !hidden.includes(relative(repoRoot, path)) &&
          (Object.hasOwn(filesystem, relative(repoRoot, path)) ||
            existsSync(path));
      },
      lstatSync: (path) => {
        const kind = kindOf(filesystem[relative(repoRoot, path)]);
        return kind
          ? {
            isFile: () => kind === "file",
            isDirectory: () => kind === "directory",
          }
          : lstatSync(path);
      },
      // Một fixture mô tả symlink bằng khoá "realpath": chuỗi rỗng nghĩa là
      // realpath ném lỗi, như khi link tự vòng. Đường dẫn chỉ tồn tại trong
      // fixture thì realpath là chính nó, vì realpath thật sẽ báo ENOENT.
      realpathSync: (path) => {
        const key = relative(repoRoot, path);
        if (!Object.hasOwn(filesystem, key)) return realpathSync(path);
        const entry = filesystem[key];
        const target = typeof entry === "string" ? undefined : entry?.realpath;
        if (target === "") throw new Error("ELOOP");
        return target ?? resolve(realpathSync(repoRoot), key);
      },
      // Fixture là một filesystem ảo, nên readdir của nó phải liệt kê cả các
      // mục ảo: kiểm hoa thường đọc tên thật trong thư mục cha, và một file chỉ
      // có trong fixture sẽ không bao giờ xuất hiện nếu chỉ đọc đĩa. Chỉ hợp
      // nhất cho lời gọi một tham số; nhánh withFileTypes là đường quét file kế
      // hoạch, nơi mục ảo không được phép trở thành một kế hoạch mới.
      readdirSync(path, options) {
        if (options) return readdirSync(path, options);
        const parent = relative(repoRoot, path);
        const underParent = (key) =>
          parent ? key.startsWith(parent + "/") : true;
        let names;
        try {
          names = new Set(readdirSync(path));
        } catch (error) {
          // Một thư mục chỉ tồn tại trong fixture thì đĩa thật ném ENOENT. Nuốt
          // lỗi đúng trường hợp đó, còn đường dẫn không có mục ảo nào vẫn để
          // lỗi thoát ra như khi chạy thật.
          if (!Object.keys(filesystem).some(underParent)) throw error;
          names = new Set();
        }
        for (const key of Object.keys(filesystem)) {
          if (!underParent(key)) continue;
          const rest = parent ? key.slice(parent.length + 1) : key;
          if (rest) names.add(rest.split("/")[0]);
        }
        for (const key of hidden) {
          if (!underParent(key)) continue;
          const rest = parent ? key.slice(parent.length + 1) : key;
          if (rest && !rest.includes("/")) names.delete(rest);
        }
        return [...names];
      },
      readFileSync(path, encoding) {
        // Một mục fixture khai "content" là file chỉ sống trong filesystem ảo,
        // nên đĩa thật không có gì để đọc. Trả thẳng nội dung đó, nếu không
        // mọi gate đọc nội dung của một file ảo đều vấp ENOENT.
        const entry = filesystem[relative(repoRoot, path)];
        if (entry && typeof entry === "object" && "content" in entry) {
          return entry.content;
        }
        const text = readFileSync(path, encoding);
        const replace = replacements[relative(repoRoot, path)];
        return replace ? replace(text) : text;
      },
      execFileSync(command, args, options) {
        historicalReads.push(args[1]);
        const settings = {
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        };
        const execute = (...params) => {
          gitSubprocesses++;
          return execFileSync(...params);
        };
        // Callback lỗi/biến đổi output phải thấy Git thật, không đọc hoặc ghi cache.
        const output = gitOutput
          ? gitOutput(args, execute(command, args, settings))
          : readGitFixture(command, args, settings, execute);
        return args[0] === "ls-files" && args.includes("--stage")
          ? output + virtualIndex
          : output;
      },
      dirname,
      isAbsolute,
      Buffer,
      createHash,
      relative,
      resolve,
      injectedPlanRoot: planRoot,
      process: state,
      console: {
        log: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
    });
  } catch (error) {
    thrown = error;
    state.exitCode = 1;
  }
  return {
    exitCode: state.exitCode,
    messages,
    historicalReads,
    thrown,
    gitSubprocesses,
    existenceChecks,
  };
}

function invalid(replacements, pattern, hidden, filesystem, gitOutput) {
  const result = run(replacements, hidden, filesystem, gitOutput);
  assert.equal(result.exitCode, 1, "Validator accepted invalid evidence");
  assert.equal(
    result.thrown,
    undefined,
    "Validation failed for an unrelated exception",
  );
  assert.match(result.messages.join("\n"), pattern);
  return result;
}

for (const marker of [tick.repeat(3), "~~~", "   " + tick.repeat(4)]) {
  for (
    const example of [
      "[Example](missing-code-example.md)",
      "[example]: /etc/passwd",
      "[example]: <unfinished",
    ]
  ) {
    test(`Markdown code fence ignores example ${JSON.stringify(marker)} ${example}`, () => {
      const result = run({
        "plans/evidence/backlog-review.md": (text) =>
          text +
          `\n${marker}markdown\n${example}\n${marker.trim()}\n`,
      });
      assert.equal(result.thrown, undefined);
      assert.equal(result.exitCode, 0, result.messages.join("\n"));
    });
  }
}
for (const delimiter of [tick, tick.repeat(2), tick.repeat(3)]) {
  test(`Markdown inline code ignores link and definition examples ${delimiter.length}`, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\nExample ${delimiter}[Example](missing-code-example.md)${delimiter}.\n` +
        `${delimiter}\n[example]: /etc/passwd\n${delimiter}\n`,
    });
    assert.equal(result.thrown, undefined);
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
for (const marker of [tick.repeat(3), "~~~"]) {
  test(`Markdown required heading cannot come from fenced example ${marker}`, () => {
    const setup = stale(21, "Heading fixture explicitly uses non-DONE state");
    invalid(
      compose(setup, {
        [fileFor(21)]: (text) =>
          text.replace("## Bảo trì\n", "## Notes\n") +
          `\n${marker}markdown\n## Bảo trì\n${marker}\n`,
      }),
      /021.*thiếu Bảo trì/,
    );
  });
}
for (
  const line of [
    "### Bảo trì",
    "Example ## Bảo trì",
    tick + "## Bảo trì" + tick,
  ]
) {
  test(`Markdown required heading must be structural ${line}`, () => {
    invalid(
      compose(stale(21), {
        [fileFor(21)]: (text) => text.replace("## Bảo trì\n", line + "\n"),
      }),
      /021.*thiếu Bảo trì/,
    );
  });
}

for (const marker of [tick.repeat(3), "~~~"]) {
  for (const target of ["missing-after-code.md", "/etc/passwd"]) {
    test(`Markdown live target after closed fence remains checked ${marker} ${target}`, () => {
      invalid(
        {
          "plans/evidence/backlog-review.md": (text) =>
            text +
            `\n${marker}md\n[example]: missing-inside.md\n${marker}\n[Live](${target})\n`,
        },
        new RegExp(
          target === "/etc/passwd"
            ? "unsafe Markdown link"
            : "link hỏng missing-after-code",
        ),
      );
    });
  }
  test(`Markdown fenced reference definition remains inert with live usage ${marker}`, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\n[Example][sample]\n${marker}\n[sample]: /etc/passwd\n${marker}\n`,
    });
    assert.equal(result.thrown, undefined);
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
  test(`Markdown unclosed fence masks examples through EOF ${marker}`, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\n${marker}md\n[Example](missing-example.md)\n[sample]: /etc/passwd\n`,
    });
    assert.equal(result.thrown, undefined);
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
    invalid(
      compose(stale(21), {
        [fileFor(21)]: (text) =>
          text.replace("## Bảo trì\n", `${marker}\n## Bảo trì\n`),
      }),
      /021.*thiếu Bảo trì/,
    );
  });
}
for (
  const [open, falseClose, close] of [
    [tick.repeat(4), tick.repeat(3), tick.repeat(5)],
    ["~~~~", "~~~", "~~~~~"],
    [tick.repeat(3), "~~~", tick.repeat(3)],
    ["~~~", tick.repeat(3), "~~~"],
    [tick.repeat(3), tick.repeat(3) + " text", tick.repeat(3)],
  ]
) {
  test(`Markdown fence requires matching marker and length ${open} ${falseClose}`, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\n${open}\n${falseClose}\n[Example](missing-example.md)\n${close}\n`,
    });
    assert.equal(result.thrown, undefined);
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("Markdown invalid backtick info is not a fence opener", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n" + tick.repeat(3) + " info" + tick +
      "invalid\n\n[Live](missing-live.md)\n",
  }, /link hỏng missing-live.md/);
});
for (const prefix of ["Example " + tick, "Example \\" + tick]) {
  test(`Markdown unmatched or escaped inline tick cannot mask live link ${prefix}`, () => {
    invalid({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\n${prefix}[Live](missing-live.md)\n`,
    }, /link hỏng missing-live.md/);
  });
}
test("Markdown inline code keeps live links and definitions outside spans", () => {
  const result = invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      // Definition đứng sau một dòng trống: CommonMark không cho nó ngắt đoạn,
      // nên viết nối ngay dưới dòng văn xuôi thì nó là văn bản literal và phép
      // kiểm này không còn nói về inline code nữa.
      "\n" + tick + "[Example](missing-example.md)" + tick +
      " [Live](missing-live.md)\n\n[live]: missing-definition.md\n",
  }, /link hỏng missing-live.md/);
  assert.deepEqual(result.messages, [
    "evidence/backlog-review.md: link hỏng missing-live.md",
    "evidence/backlog-review.md: link hỏng missing-definition.md",
  ]);
});
test("Markdown link label with a nested bracket still exposes its destination", () => {
  // Regex phẳng cũ dừng ở ] đầu tiên trong label nên bỏ sót cả link, khiến
  // destination hỏng lọt qua gate; label lồng ngoặc vuông phải vẫn bị bắt.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[outer [inner]](missing-nested.md)\n",
  }, /link hỏng missing-nested\.md/);
});
test("Markdown inline link title is not part of the destination", () => {
  // Title tùy chọn sau destination bị ghép nguyên vào đường dẫn ở bản cũ nên một
  // link tới file có thật vẫn bị báo hỏng; tách title ra thì link này hợp lệ.
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[readme](../../README.md "Repository readme")\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("Markdown image with an empty alt still exposes its destination", () => {
  // ![](...) có label rỗng nhưng ảnh vẫn render, nên destination phải tồn tại
  // thật; bản cũ bỏ qua mọi cặp ngoặc rỗng và để link hỏng lọt qua gate.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n![](missing-diagram.png)\n",
  }, /link hỏng missing-diagram\.png/);
});
test("Markdown even backslash run leaves the bracket live", () => {
  // Hai backslash là một backslash literal rồi mới tới [, nên link vẫn sống.
  // Bản cũ chỉ nhìn một ký tự liền trước nên coi là escape và bỏ sót.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n\\\\[Live](missing-even-escape.md)\n",
  }, /link hỏng missing-even-escape\.md/);
});
test("Markdown heading outside a closed example satisfies the requirement", () => {
  const setup = stale(21);
  const before = run(setup);
  const after = run(compose(setup, {
    [fileFor(21)]: (text) =>
      text.replace(
        "## Bảo trì\n",
        tick.repeat(4) + "md\n## Example\n" + tick.repeat(4) +
          "\n   ## Bảo trì ###\n",
      ),
  }));
  assert.equal(after.thrown, undefined);
  assert.deepEqual(after.messages, before.messages);
});

test("Markdown inline code pairs exact backtick runs and keeps internal unmatched ticks", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\nExample " + tick.repeat(2) + "inside " + tick +
      " [Example](missing-example.md) " + tick.repeat(2) + " end.\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
for (const newline of ["\n", "\r\n"]) {
  test(`Markdown inline code cannot span blank paragraphs ${JSON.stringify(newline)}`, () => {
    invalid({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        newline + "Example " + tick + newline.repeat(2) +
        "[Live](missing-live.md)" + newline + tick + newline,
    }, /link hỏng missing-live.md/);
  });
}

for (
  const block of ["## Section [Live](missing-live.md)", "- [Live](/etc/passwd)"]
) {
  test(`Markdown inline code cannot cross a structural block ${block}`, () => {
    invalid({
      "plans/evidence/backlog-review.md": (text) =>
        text + "\nExample " + tick + "\n" + block + "\n" + tick + "\n",
    }, /link hỏng missing-live.md|unsafe Markdown link \/etc\/passwd/);
  });
}
test("Markdown inline code retains multiline spans within the same paragraph", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\nExample " + tick +
      "first line\n[Example](missing-example.md)\nlast line" + tick + ".\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

for (
  const boundary of [
    "+ Item",
    "* Item",
    "1. Item",
    "1) Item",
    "2. Item",
    "42) Item",
    "> Quote",
    "***",
    "---",
    "===",
  ]
) {
  test(`Markdown inline span ends before block boundary ${boundary}`, () => {
    invalid({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        "\nExample " + tick + "\n" + boundary +
        "\n[Live](missing-live.md)\n" + tick + "\n",
    }, /link hỏng missing-live.md/);
  });
}
test("Markdown heading inline opener cannot mask the following paragraph", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n## Section " + tick + "\n[Live](missing-live.md)\n" + tick + "\n",
  }, /link hỏng missing-live.md/);
});

for (const indent of ["    ", "      ", "\t"]) {
  test(`PR25 indented code ignores examples ${JSON.stringify(indent)}`, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\n\n${indent}[Example](missing-code.md)\n${indent}[ref]: /etc/passwd\n`,
    });
    assert.equal(result.thrown, undefined);
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("PR25 live target after indented code remains checked", () => {
  const result = invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n\n    [Example](missing-code.md)\n\n[Live](missing-live.md)\n",
  }, /link hỏng missing-live.md/);
  assert.deepEqual(result.messages, [
    "evidence/backlog-review.md: link hỏng missing-live.md",
  ]);
});
test("PR25 indentation cannot interrupt a paragraph or hide list continuation", () => {
  for (const prefix of ["Paragraph\n", "- Item\n", "- Item\n\n"]) {
    invalid({
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n\n" + prefix + "    [Live](/etc/passwd)\n",
    }, /unsafe Markdown link/);
  }
});
for (const prefix of ["> ", ">> ", "> > ", "   > "]) {
  for (
    const target of [
      "/etc/passwd",
      "../../../../outside.md",
      "missing-quote.md",
    ]
  ) {
    test(`PR25 quoted reference validates ${prefix} ${target}`, () => {
      const result = invalid({
        "plans/evidence/backlog-review.md": (text) =>
          text + `\n${prefix}[ref]: ${target}\n`,
      }, /unsafe Markdown link|link hỏng missing-quote.md/);
      assert(!result.existenceChecks.includes("/etc/passwd"));
    });
  }
}
test("PR25 quoted reference keeps valid targets and resolves a continuation", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n> [local]: ../README.md "Title"\n> [web]: https://example.com\n>> [anchor]: #phạm-vi\n',
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
  // Destination trên dòng kế là definition hợp lệ theo CommonMark, nên nó phải
  // được phân giải chứ không bị gạt sang "không hỗ trợ"; đích nguy hiểm vẫn bị
  // chặn, chỉ bằng đúng lý do của nó.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> [ref]:\n> /etc/passwd\n",
  }, /unsafe Markdown link \/etc\/passwd/);
});
test("PR25 quoted code is inert but container exit restores live targets", () => {
  const result = invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      `\n> ${
        tick.repeat(3)
      }md\n> [example]: /etc/passwd\n[Live](missing-live.md)\n`,
  }, /link hỏng missing-live.md/);
  assert.deepEqual(result.messages, [
    "evidence/backlog-review.md: link hỏng missing-live.md",
  ]);
});
for (const prefix of ["", "> ", ">> "]) {
  test(`PR25 quote-looking text inside a fence stays inert ${JSON.stringify(prefix)}`, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text +
        `\n${prefix}${
          tick.repeat(3)
        }md\n${prefix}> [example]: /etc/passwd\n${prefix}${tick.repeat(3)}\n`,
    });
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("PR25 quoted multiline inline code and indented examples stay inert", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      `\n> Example ${tick}first\n> [example]: /etc/passwd\n> last${tick}\n>\n>     [example]: /etc/passwd\n`,
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
for (const marker of [tick.repeat(3), "~~~"]) {
  test(`PR25 execution steps in fenced examples cannot satisfy gates ${marker}`, () => {
    invalid(
      compose(stale(21), {
        [fileFor(21)]: (text) =>
          text.replace(/^### Bước (\d+):/gm, "### Example $1:") +
          `\n${marker}md\n` +
          [...text.matchAll(/^### Bước \d+:.*$/gm)].map((match) => match[0])
            .join("\n") +
          `\n${marker}\n`,
      }),
      /021.*bước\/gate không khớp/,
    );
  });
  test(`PR25 example checks do not inflate structural gates ${marker}`, () => {
    const result = run(compose(stale(21), {
      [fileFor(21)]: (text) =>
        text + `\n${marker}md\n**Kiểm tra:**\n${marker}\n`,
    }));
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("PR25 inline check examples do not count as execution gates", () => {
  const result = run(compose(stale(21), {
    [fileFor(21)]: (text) =>
      text + "\nExample " + tick + "**Kiểm tra:**" + tick + ".\n",
  }));
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("PR25 dependency declaration outside metadata cannot replace missing field", () => {
  invalid(
    compose(stale(21), {
      [fileFor(21)]: (text) =>
        text.replace(/^- Phụ thuộc:.*\n/m, "") + "\n- Phụ thuộc: không.\n",
    }),
    /021.*plan and manifest dependencies differ/,
  );
});
test("PR25 dependency prose outside metadata does not duplicate the real field", () => {
  const result = run(compose(stale(21), {
    [fileFor(21)]: (text) => text + "\n- Phụ thuộc: 001.\n",
  }));
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("PR25 dependency metadata requires exactly one live declaration", () => {
  for (
    const replacement of [
      "- Phụ thuộc: không.\n- Phụ thuộc: không.",
      "```md\n- Phụ thuộc: không.\n```",
      "- Phụ thuộc:\nkhông.",
    ]
  ) {
    invalid(
      compose(stale(21), {
        [fileFor(21)]: (text) => text.replace(/^- Phụ thuộc:.*$/m, replacement),
      }),
      /021.*plan and manifest dependencies differ/,
    );
  }
});
for (const language of ["typescript", "", "text extra"]) {
  test(`PR25 evidence language matches an explicit manifest language ${JSON.stringify(language)}`, () => {
    invalid(
      compose(stale(21), {
        "plans/manifest.json": editManifest((entries) => {
          entries.find((entry) => entry.id === 21).evidence[0].lang = "text";
        }),
        [fileFor(21)]: (text) =>
          text.replace("```text\n", "```" + language + "\n"),
      }),
      /021.*evidence language mismatch/,
    );
  });
}
for (const language of ["text", "typescript", ""]) {
  test(`PR25 absent evidence language preserves existing fence semantics ${JSON.stringify(language)}`, () => {
    const result = run(compose(stale(21), {
      "plans/manifest.json": editManifest((entries) => {
        delete entries.find((entry) => entry.id === 21).evidence[0].lang;
      }),
      [fileFor(21)]: (text) =>
        text.replace("```text\n", "```" + language + "\n"),
    }));
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("PR25 explicit matching evidence language passes", () => {
  const result = run(compose(stale(21), {
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 21).evidence[0].lang = "text";
    }),
  }));
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("PR25 explicit empty language requires an unlabelled fence", () => {
  const setup = compose(stale(21), {
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 21).evidence[0].lang = "";
    }),
  });
  invalid(setup, /021.*evidence language mismatch/);
  const result = run(compose(setup, {
    [fileFor(21)]: (text) => text.replace("```text\n", "```\n"),
  }));
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("PR25 evidence language rejects malformed manifest types", () => {
  for (const value of [null, 42, [], {}]) {
    invalid(
      compose(stale(21), {
        "plans/manifest.json": editManifest((entries) => {
          entries.find((entry) => entry.id === 21).evidence[0].lang = value;
        }),
      }),
      /021.*evidence language mismatch/,
    );
  }
});

function firstEvidenceExample(text) {
  const record = manifest.find((entry) => entry.id === 21).evidence[0];
  const start = text.indexOf(`${tick}${record.path}:${record.line}${tick}:`);
  assert(start >= 0);
  const block = text.slice(start).match(
    /^[\s\S]*?<!-- evidence: [^\n]+ -->\s*(?:<!-- deno-fmt-ignore -->\s*)?```[^\n]*\n[\s\S]*?\n```/,
  );
  assert(block);
  return block[0];
}
for (const marker of [tick.repeat(4), tick.repeat(5), "~~~", "   ~~~~"]) {
  test(`PR25 outer fence cannot supply a missing evidence block ${marker}`, () => {
    invalid(
      compose(stale(21), {
        [fileFor(21)]: (text) => {
          const example = firstEvidenceExample(text);
          return text.replace(
            example,
            `${marker}md\n${example}\n${marker.trim()}`,
          );
        },
      }),
      /021.*evidence excerpt count mismatch/,
    );
  });
  test(`PR25 outer fenced evidence example does not duplicate live evidence ${marker}`, () => {
    const result = run(compose(stale(21), {
      [fileFor(21)]: (text) =>
        text +
        `\n${marker}md\n${firstEvidenceExample(text)}\n${marker.trim()}\n`,
    }));
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("PR25 live evidence after a fenced annotation remains validated", () => {
  const setup = compose(stale(21), {
    [fileFor(21)]: (text) => {
      const example = firstEvidenceExample(text);
      return text.replace(
        example,
        `${tick.repeat(4)}md\n<!-- evidence: fake.ts -->\n${
          tick.repeat(3)
        }text\nExample\n${tick.repeat(4)}\n\n${example}`,
      );
    },
  });
  const result = run(setup);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
  invalid(
    compose(setup, {
      [fileFor(21)]: (text) =>
        text.replace("node_modules/\ndeno.lock", "CHANGED/\ndeno.lock"),
    }),
    /021.*excerpt mismatch/,
  );
});
test("PR25 unclosed outer fence cannot supply evidence through EOF", () => {
  invalid(
    compose(stale(21), {
      [fileFor(21)]: (text) => {
        const example = firstEvidenceExample(text);
        return text.replace(example, "") +
          `\n${tick.repeat(4)}md\n${example}\n`;
      },
    }),
    /021.*evidence excerpt count mismatch/,
  );
});
for (const marker of [tick.repeat(4), "~~~"]) {
  test(`PR25 fenced scope list cannot replace live scope ${marker}`, () => {
    invalid(
      compose(stale(21), {
        [fileFor(21)]: (text) =>
          text.replace(
            /(## Phạm vi và Git\n)([\s\S]*?)(\nNgoài phạm vi:)/,
            `$1\n${marker}md\n$2\n${marker}\n$3`,
          ),
      }),
      /021.*plan and manifest scope differ/,
    );
  });
  test(`PR25 fenced scope bullets and terminators cannot change live scope ${marker}`, () => {
    const result = run(compose(stale(21), {
      [fileFor(21)]: (text) =>
        text.replace(
          "## Phạm vi và Git\n",
          `## Phạm vi và Git\n\n${marker}md\n- ${tick}fake.ts${tick}\nNgoài phạm vi:\n${marker}\n`,
        ),
    }));
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
  test(`PR25 fenced scope heading before the live section is ignored ${marker}`, () => {
    const result = run(compose(stale(21), {
      [fileFor(21)]: (text) =>
        text.replace(
          "## Phạm vi và Git\n",
          `${marker}md\n## Phạm vi và Git\n- ${tick}fake.ts${tick}\nNgoài phạm vi:\n${marker}\n\n## Phạm vi và Git\n`,
        ),
    }));
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
test("PR25 fenced scope cannot hide live scope mismatch", () => {
  invalid(
    compose(stale(21), {
      [fileFor(21)]: (text) =>
        text.replace("- `.gitignore`\n", "") +
        `\n${
          tick.repeat(4)
        }md\n## Phạm vi và Git\n- ${tick}.gitignore${tick}\nNgoài phạm vi:\n${
          tick.repeat(4)
        }\n`,
    }),
    /021.*plan and manifest scope differ/,
  );
});

function editManifest(edit) {
  return (text) => {
    const entries = JSON.parse(text);
    edit(entries);
    return JSON.stringify(entries);
  };
}

function status(id, next) {
  return {
    [fileFor(id)]: (text) =>
      text.replace(
        /Trạng thái thực thi:\s*.[A-Z_]+./,
        "Trạng thái thực thi: " + tick + next + tick,
      ),
    "plans/README.md": (text) =>
      text.split("\n").map((line) =>
        line.startsWith("| " + String(id).padStart(3, "0") + " ")
          ? line.replace(
            /\|\s*(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)\s*\|$/,
            "| " + next + " |",
          )
          : line
      ).join("\n"),
  };
}
function stale(
  id,
  reason = "Source changed; refresh evidence before execution",
) {
  const replacements = status(id, "STALE");
  const change = replacements[fileFor(id)];
  replacements[fileFor(id)] = (text) =>
    change(text).replace(
      "## Trạng thái và mục tiêu\n",
      "## Trạng thái và mục tiêu\n\n- stale_reason: " + JSON.stringify(reason) +
        "\n",
    );
  return replacements;
}

// Báo cáo của một kế hoạch BLOCKED phải nói nó thuộc kế hoạch nào, tự khai
// trạng thái, và giữ lệnh đã chạy; ba thứ đó là những gì cổng đo được.
function blockedReportFor(id) {
  return "# Bằng chứng " + String(id).padStart(3, "0") +
    "\n\nTrạng thái: BLOCKED\n\n" +
    tick.repeat(3) + "bash\ndeno test\n" + tick.repeat(3) + "\n";
}

function blocked(id, reason = "Waiting on a framework contract decision") {
  const replacements = status(id, "BLOCKED");
  const change = replacements[fileFor(id)];
  replacements[fileFor(id)] = (text) =>
    change(text).replace(
      "## Trạng thái và mục tiêu\n",
      "## Trạng thái và mục tiêu\n\n- blocked_reason: " +
        JSON.stringify(reason) + "\n",
    );
  return replacements;
}

const definitionRef = "b9d6d02a9692c3efff11836b97d8cfbc69da1ec7";
const definitionFields = [
  "definition_review_verdict",
  "definition_commit",
  "definition_plan_blob",
  "definition_manifest_blob",
  "definition_approval_commit",
  "definition_approval_blob",
];
const definitionFailures = (id) => [
  fileFor(id).slice("plans/".length) +
  ": DONE requires approved definition snapshot",
  fileFor(id).slice("plans/".length) +
  ": DONE requires reviewer approval evidence",
];
function definitionField(key, value) {
  return {
    "plans/evidence/001.md": (text) =>
      text.replace(
        new RegExp("^" + key + ":.*$", "m"),
        value === undefined ? "" : key + ": " + value,
      ),
  };
}
function assertAdditionalFailure(replacements, pattern, gitOutput) {
  const before = run();
  const after = run(replacements, [], {}, gitOutput);
  assert.equal(before.thrown, undefined);
  assert.equal(after.thrown, undefined);
  const added = after.messages.filter((message) =>
    !before.messages.includes(message)
  );
  assert.match(added.join("\n"), pattern);
  return after;
}
for (
  const path of [
    ".git",
    ".git/",
    ".git/config",
    ".git/hooks/pre-commit",
    ".GIT/config",
    ".GiT/hooks/pre-commit",
    "src/.git/config",
    "src/.GIT/hooks/pre-commit",
  ]
) {
  test(
    "Git metadata namespace is forbidden before new-file exemptions: " + path,
    () => {
      const setup = stale(
        15,
        "Namespace fixture explicitly uses non-DONE state",
      );
      const before = run(setup);
      const after = run(compose(setup, scopePath(path, true)));
      assert.equal(before.thrown, undefined);
      assert.equal(after.thrown, undefined);
      assert.deepEqual(
        after.messages.filter((message) => !before.messages.includes(message)),
        [
          fileFor(15).slice(6) + ": invalid repo-relative scope path: " +
          JSON.stringify(path),
          fileFor(15).slice(6) + ": invalid repo-relative newFiles path: " +
          JSON.stringify(path),
        ],
      );
    },
  );
}
for (
  const [path, fresh] of [
    [".github/fixture.yml", true],
    // Tên này có thật trong repository nên phải vào nhóm file sẵn có: khai là
    // tạo mới sẽ bị cổng phân loại từ chối vì lý do không dính tới namespace.
    [".gitignore", false],
    ["src/git/config.ts", true],
    ["src/.git-fixture.ts", true],
  ]
) {
  test("Git namespace guard preserves unrelated names: " + path, () => {
    const setup = stale(15, "Namespace control explicitly uses non-DONE state");
    const before = run(setup);
    const after = run(compose(setup, scopePath(path, fresh)));
    assert.equal(before.thrown, undefined);
    assert.equal(after.thrown, undefined);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.exitCode, before.exitCode);
  });
}
for (const id of [1, 3]) {
  for (
    const change of [
      "swapped",
      "missing with unrelated copy",
      "separated by prose",
      "stale with unrelated correct copy",
    ]
  ) {
    test(
      "evidence citation must bind its adjacent block: " + id + " " + change,
      () => {
        const entry = manifest.find((item) => item.id === id);
        const [first, second] = entry.evidence.map((evidence) =>
          tick + evidence.path + ":" + evidence.line + tick + ":"
        );
        const setup = stale(
          id,
          "Citation fixture explicitly uses non-DONE state",
        );
        const before = run(setup);
        const after = run(compose(setup, {
          [fileFor(id)]: (text) => {
            if (change === "swapped") {
              return text.replace(first, "CITATION_SWAP").replace(second, first)
                .replace("CITATION_SWAP", second);
            }
            if (change === "separated by prose") {
              return text.replace(
                first,
                first + "\n\nUnrelated explanatory paragraph.",
              );
            }
            return text.replace(
              first,
              change === "missing with unrelated copy"
                ? ""
                : tick + entry.evidence[0].path + ":99999" + tick + ":",
            ) + "\n\nUnrelated citation: " + first + "\n";
          },
        }));
        assert.equal(before.thrown, undefined);
        assert.equal(after.thrown, undefined);
        const expected =
          (change === "swapped" ? entry.evidence : entry.evidence.slice(0, 1))
            .map((evidence) =>
              entry.file + ": missing adjacent evidence line citation " +
              evidence.path + ":" + evidence.line
            );
        assert.deepEqual(
          after.messages.filter((message) =>
            !before.messages.includes(message)
          ),
          expected,
        );
      },
    );
  }
}
test("adjacent citations retain blank lines formatter markers and unrelated prose elsewhere", () => {
  const setup = stale(1, "Citation control explicitly uses non-DONE state");
  const before = run(setup);
  const after = run(compose(setup, {
    [fileFor(1)]: (text) =>
      text.replaceAll("<!-- evidence:", "\n\n<!-- evidence:") +
      "\nUnrelated prose after all evidence.\n",
  }));
  assert.equal(before.thrown, undefined);
  assert.equal(after.thrown, undefined);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.exitCode, before.exitCode);
});
test("PR25 approval cannot be retargeted to the real definition commit and report", () => {
  const report = "plans/evidence/001.md";
  const blob = execFileSync(
    "git",
    ["rev-parse", definitionRef + ":" + report],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  ).trim();
  assertAdditionalFailure({
    [report]: (text) =>
      text
        .replace(/^reviewed_commit:.*$/m, "reviewed_commit: " + definitionRef)
        .replace(/^completed_commit:.*$/m, "completed_commit: " + definitionRef)
        .replace(
          /^reviewed_evidence_blob:.*$/m,
          "reviewed_evidence_blob: " + blob,
        )
        .replace(
          /^completed_evidence_blob:.*$/m,
          "completed_evidence_blob: " + blob,
        ),
  }, /001.*reviewer approval evidence/);
});
test("PR25 artifact directory rejects a newly tracked file", () => {
  const blob = execFileSync(
    "git",
    ["rev-parse", "HEAD:plans/evidence/007.md"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  ).trim();
  assertAdditionalFailure(
    {},
    /007.*reviewer approval evidence/,
    (args, output) => {
      if (args[0] === "ls-files") {
        return output + "100644 " + blob + " 0\tplans/evidence/007/extra.txt\0";
      }
      return output;
    },
  );
});
for (
  const key of [
    "review_verdict",
    "plan_id",
    "reviewed_commit",
    "completed_commit",
    "reviewed_evidence_blob",
    "completed_evidence_blob",
  ]
) {
  for (const change of ["missing", "duplicate"]) {
    test(
      "PR25 immutable implementation field " + key + " rejects " + change,
      () => {
        assertAdditionalFailure({
          "plans/evidence/001.md": (text) =>
            text.replace(
              new RegExp("^(" + key + ":.*)$", "m"),
              change === "missing" ? "" : "$1\n$1",
            ),
        }, /001.*reviewer approval evidence/);
      },
    );
  }
}
test("PR25 approval reads the immutable definition report and verifies its blob", () => {
  let read = false;
  assertAdditionalFailure(
    {},
    /001.*reviewer approval evidence/,
    (args, output) => {
      if (
        args[0] === "show" &&
        args[1] === definitionRef + ":plans/evidence/001.md"
      ) {
        read = true;
        return output + "\nUnapproved historical report edit\n";
      }
      return output;
    },
  );
  assert(read);
});
test("PR25 artifact index failure is not a successful completion check", () => {
  assertAdditionalFailure({}, /Cannot read Git index/, (args, output) => {
    if (args[0] === "ls-files") throw new Error("Index read denied");
    return output;
  });
});
for (
  const bullet of [
    "- src/tools/analytics.ts",
    "* src/tools/analytics.ts",
    "  - src/tools/analytics.ts",
    "1. src/tools/analytics.ts",
    "- `src/tools/analytics.ts",
    "- `src/tools/analytics.ts` unparenthesized qualifier",
  ]
) {
  test("PR25 scope rejects malformed file bullet: " + bullet, () => {
    const setup = stale(
      20,
      "Scope parser fixture explicitly uses non-DONE state",
    );
    const path = manifest.find((entry) => entry.id === 20).scope[0];
    const before = run(setup);
    const after = run(compose(setup, {
      [fileFor(20)]: (text) => text.replace("- " + tick + path + tick, bullet),
      "plans/manifest.json": editManifest((entries) => {
        const entry = entries.find((item) => item.id === 20);
        entry.scope = entry.scope.filter((value) => value !== path);
        entry.newFiles = entry.newFiles.filter((value) => value !== path);
      }),
    }));
    assert.equal(before.thrown, undefined);
    assert.equal(after.thrown, undefined);
    assert.match(
      after.messages.filter((message) => !before.messages.includes(message))
        .join("\n"),
      /020.*malformed scope file bullet/,
    );
  });
}
test("DONE definition rejects synchronized scope removal", () => {
  invalid({
    [fileFor(1)]: (text) => text.replace("- `src/auth/config.ts`\n", ""),
    "plans/manifest.json": editManifest((entries) => {
      entries[0].scope = entries[0].scope.filter((path) =>
        path !== "src/auth/config.ts"
      );
    }),
  }, /001.*definition/);
});
test("DONE definition rejects synchronized prerequisite removal", () => {
  invalid({
    [fileFor(8)]: (text) => planDependencies(text, "không"),
    "plans/README.md": (text) => indexDependencies(text, 8, "không"),
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 8).depends = [];
    }),
  }, /008.*definition/);
});
test("DONE definition rejects removal of one checked acceptance criterion", () => {
  invalid({
    [fileFor(24)]: (text) => text.replace(/^- \[x\][^\n]*\n/m, ""),
  }, /024.*definition/);
});
test("DONE definition rejects prose-only edits", () => {
  invalid({
    [fileFor(1)]: (text) => text + "\nGhi chú mới chưa được review.\n",
  }, /001.*definition/);
});
for (const key of definitionFields) {
  test("DONE definition requires " + key, () => {
    invalid(definitionField(key, undefined), /001.*definition/);
  });
  test("DONE definition rejects duplicate " + key, () => {
    invalid({
      "plans/evidence/001.md": (text) =>
        text.replace(
          new RegExp("^(" + key + ":.*)$", "m"),
          "$1\n$1",
        ),
    }, /001.*definition/);
  });
}
for (const verdict of ["NOT APPROVED", "REVISE", "APPROVE with findings"]) {
  test("DONE definition rejects verdict " + verdict, () => {
    invalid(
      definitionField("definition_review_verdict", verdict),
      /001.*definition/,
    );
  });
}
for (const key of definitionFields.slice(1)) {
  for (
    const value of ["0".repeat(40), definitionRef.slice(0, 7), "g".repeat(40)]
  ) {
    test("DONE definition rejects invalid " + key + " " + value, () => {
      invalid(definitionField(key, value), /001.*definition/);
    });
  }
}
test("DONE definition rejects blob used as commit", () => {
  const report = readFileSync(resolve(planRoot, "evidence/001.md"), "utf8");
  const blob = report.match(/^definition_plan_blob: (.+)$/m)[1];
  invalid(
    definitionField("definition_commit", blob),
    /Cannot read Git commit tree/,
  );
});
test("DONE definition rejects real commit without plan snapshot", () => {
  const report = readFileSync(resolve(planRoot, "evidence/001.md"), "utf8");
  const ref = report.match(/^reviewed_commit: (.+)$/m)[1];
  invalid(definitionField("definition_commit", ref), /001.*definition/);
});
test("DONE definition rejects an approval record without definition fields", () => {
  // Bản duyệt trỏ tới một commit lịch sử có đúng file báo cáo nhưng bản đó chưa
  // hề mang verdict và bộ hash định nghĩa. Nếu chỉ tin verdict đọc từ working
  // tree, người commit tự cấp duyệt được bằng cách trỏ vào một commit bất kỳ.
  const blob = execFileSync(
    "git",
    ["rev-parse", definitionRef + ":plans/evidence/001.md"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  invalid({
    "plans/evidence/001.md": (text) =>
      text
        .replace(
          /^definition_approval_commit:.*$/m,
          "definition_approval_commit: " + definitionRef,
        )
        .replace(
          /^definition_approval_blob:.*$/m,
          "definition_approval_blob: " + blob,
        ),
  }, /001.*definition/);
});
test("DONE definition rejects an approval blob that is not the recorded report", () => {
  // Giữ nguyên commit duyệt thật nhưng đổi blob sang một blob hợp lệ khác: cây
  // của commit đó không chứa blob này nên bản duyệt phải bị từ chối.
  const blob = execFileSync(
    "git",
    ["rev-parse", definitionRef + ":plans/evidence/001.md"],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  invalid(
    definitionField("definition_approval_blob", blob),
    /001.*definition/,
  );
});
test("DONE definition compares only the matching manifest record", () => {
  assertNonDoneSemantic("unrelated manifest record");
});
test("DONE definition canonicalizes object keys but preserves array contents", () => {
  const result = run({
    "plans/manifest.json": editManifest((entries) => {
      entries[0] = Object.fromEntries(Object.entries(entries[0]).reverse());
      entries[0].evidence[0] = Object.fromEntries(
        Object.entries(entries[0].evidence[0]).reverse(),
      );
    }),
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
  invalid({
    "plans/manifest.json": editManifest((entries) => {
      entries[0].scope.reverse();
    }),
  }, /001.*definition/);
});
test("DONE definition requires a readable historical manifest with one matching record", () => {
  for (
    const mutate of [() => "not JSON", () => "{}", (output) => {
      const entries = JSON.parse(output);
      entries.push(entries[0]);
      return JSON.stringify(entries);
    }]
  ) {
    invalid(
      {},
      /001.*definition/,
      [],
      {},
      (args, output) =>
        args[0] === "show" && args[1] === definitionRef + ":plans/manifest.json"
          ? mutate(output)
          : output,
    );
  }
});

test("baseline preserves historical auth evidence", () => {
  const result = run();
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
  assert.equal(result.thrown, undefined);
  assert(
    result.historicalReads.some((entry) =>
      entry.endsWith(":src/auth/config.ts")
    ),
  );
  assert(
    !readFileSync(resolve(repoRoot, "src/auth/config.ts"), "utf8").includes(
      "if (tokens.size === 0 && !jwksUrl) return null;",
    ),
  );
});
test("DONE rejects unchecked completion checklist", () => {
  invalid(
    { [fileFor(24)]: (text) => text.replace(/- \[[xX]\]/g, "- [ ]") },
    /024.*unchecked completion/,
  );
});
test("DONE requires a completion checklist", () => {
  invalid(
    { [fileFor(24)]: (text) => text.replace(/- \[[ xX]\]/g, "-") },
    /024.*completion checklist/,
  );
});
test("DONE completion checklist cannot come from a fenced example", () => {
  // Xóa hết mục checklist sống rồi để lại đúng một ví dụ trong khối code: ví dụ
  // literal không được phép tự đứng ra chứng minh kế hoạch đã hoàn tất.
  invalid({
    [fileFor(24)]: (text) =>
      text.replace(/- \[[ xX]\]/g, "-").replace(
        "## Tiêu chí hoàn tất\n",
        "## Tiêu chí hoàn tất\n\n" + tick.repeat(3) +
          "md\n- [x] Example only\n" +
          tick.repeat(3) + "\n",
      ),
  }, /024.*completion checklist/);
});
for (const marker of ["1.", "1)", "  12.", "42)"]) {
  test("DONE ordered completion rejects an unchecked item: " + marker, () => {
    invalid({
      [fileFor(24)]: (text) =>
        text.replace(
          "## Tiêu chí hoàn tất\n",
          `## Tiêu chí hoàn tất\n\n${marker} [ ] Pending release gate\n`,
        ),
    }, /024.*unchecked completion/);
  });
  test(
    "DONE ordered completion accepts checked syntax but retains definition binding: " +
      marker,
    () => {
      const result = run({
        [fileFor(24)]: (text) => text.replace(/- \[[xX]\]/g, marker + " [X]"),
      });
      assert.equal(result.thrown, undefined);
      assert.deepEqual(result.messages, definitionFailures(24));
    },
  );
}
test("DONE ordered completion ignores unchecked work in another section", () => {
  const result = run({
    [fileFor(24)]: (text) => text + "\n## Future work\n\n1. [ ] Future gate\n",
  });
  assert.equal(result.thrown, undefined);
  assert.deepEqual(result.messages, definitionFailures(24));
});
test("an unchecked checklist outside completion only invalidates the DONE definition", () => {
  const result = run({
    [fileFor(24)]: (text) =>
      text + "\n## Future work\n\n- [ ] Not an acceptance criterion\n",
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.messages, definitionFailures(24));
});
for (
  const verdict of [
    "NOT APPROVED",
    "do not APPROVE",
    "APPROVE with unresolved findings",
    "REVISE",
    "BLOCK",
  ]
) {
  test("DONE rejects verdict " + verdict, () => {
    invalid({
      "plans/evidence/001.md": () =>
        "---\nreview_verdict: " + verdict +
        "\n---\n\nAPPROVE appears in historical prose only.\n",
    }, /001.*reviewer approval evidence/);
  });
}
test("DONE rejects narrative approval without dedicated verdict", () => {
  invalid(
    { "plans/evidence/001.md": () => "# Evidence\n\nVerdict: APPROVE\n" },
    /001.*reviewer approval evidence/,
  );
});
test("DONE rejects duplicate verdict fields", () => {
  invalid({
    "plans/evidence/001.md": () =>
      "---\nreview_verdict: APPROVE\nreview_verdict: REVISE\n---\n",
  }, /001.*reviewer approval evidence/);
});
for (const next of ["IN_PROGRESS", "DONE"]) {
  test(next + " requires completed prerequisites", () => {
    assertUnfinishedPrerequisite(next);
  });
}
function compose(...fixtures) {
  const result = {};
  for (const fixture of fixtures) {
    for (const [path, change] of Object.entries(fixture)) {
      const previous = result[path];
      result[path] = (text) => change(previous ? previous(text) : text);
    }
  }
  return result;
}
function semanticFixtureCases() {
  return [
    ["unrelated manifest record", [21], {
      "plans/manifest.json": editManifest((entries) => {
        entries.find((entry) => entry.id === 21).maintenanceNote =
          "Unrelated plan progress";
      }),
    }],
    ["dependency presentation", [13, 21], {
      [fileFor(13)]: (text) =>
        planDependencies(text, "  " + tick + "006" + tick + " , 005  "),
      "plans/README.md": (text) =>
        indexDependencies(text, 13, " 006 , " + tick + "005" + tick + " "),
      [fileFor(21)]: (text) =>
        planDependencies(text, "  " + tick + "không" + tick + "  "),
    }],
    ["unrelated prose", [15], {
      [fileFor(15)]: (text) => text + "\nGhi chú trình bày bổ sung.\n",
    }],
    ["wrapped new-file marker", [15], {
      [fileFor(15)]: (text) =>
        text.replace("(tạo mới)", "(tạo\n  mới; thêm test tương ứng)") +
        "\nGhi chú: (tạo mới) chỉ phân loại trong scope.\n",
    }],
    ["audit prose", [15], {
      [fileFor(15)]: (text) =>
        text + "\nGhi chú: Mục audit: 6 không phải metadata.\n",
    }],
    [
      "new artifact directory",
      [15],
      scopePath("plans/evidence/new-artifact-fixture/", true),
    ],
    ["new absent file", [15], scopePath("src/untracked-plan-fixture.ts", true)],
    ["tracked directory", [15], scopePath("src/tools/")],
  ];
}
function assertNonDoneSemantic(name, base = {}) {
  const [, ids, changes] = semanticFixtureCases().find(([candidate]) =>
    candidate === name
  );
  // Trạng thái chỉ là fixture trong bộ nhớ; không tạo approval cho DONE giả lập.
  const setup = compose(
    base,
    ...ids.map((id) =>
      compose({
        [fileFor(id)]: (text) => text.replace(/^- stale_reason:.*\n/gm, ""),
      }, stale(id, "Semantic fixture explicitly uses non-DONE state"))
    ),
  );
  for (const id of ids) {
    const path = fileFor(id);
    const original = readFileSync(resolve(repoRoot, path), "utf8");
    const prepared = setup[path] ? setup[path](original) : original;
    assert(
      prepared.includes("Trạng thái thực thi: `STALE`"),
      "Positive fixture must explicitly establish non-DONE: " + id,
    );
  }
  const before = run(setup);
  const edited = compose(setup, changes);
  assert(
    Object.keys(changes).some((path) => {
      const original = readFileSync(resolve(repoRoot, path), "utf8");
      return edited[path](original) !==
        (setup[path] ? setup[path](original) : original);
    }),
    "Semantic fixture must perform a real edit",
  );
  const after = run(edited);
  assert.equal(before.thrown, undefined);
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    before.messages.filter((message) =>
      ids.some((id) =>
        message.startsWith(fileFor(id).slice("plans/".length) + ":")
      )
    ),
    [],
    "Non-DONE targets must have a valid fixture baseline",
  );
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.exitCode, before.exitCode);
  for (const id of ids) {
    for (const evidence of manifest.find((entry) => entry.id === id).evidence) {
      assert(
        after.historicalReads.includes(
          evidence.sourceRef + ":" + evidence.path,
        ),
      );
    }
  }
}
for (
  const name of [
    "unrelated manifest record",
    "dependency presentation",
    "unrelated prose",
    "wrapped new-file marker",
    "audit prose",
    "new artifact directory",
    "new absent file",
    "tracked directory",
  ]
) {
  test("positive semantic fixture survives all plans DONE: " + name, () => {
    const allDone = compose(
      ...manifest.map((entry) => status(entry.id, "DONE")),
    );
    for (const entry of manifest) {
      assert(
        allDone[fileFor(entry.id)](
          readFileSync(resolve(planRoot, entry.file), "utf8"),
        ).includes("Trạng thái thực thi: `DONE`"),
      );
    }
    assertNonDoneSemantic(name, allDone);
  });
}
function assertUnfinishedPrerequisite(next, base = {}) {
  // STALE giữ chứng cứ Git thật, không cần dựng approval giả hoặc đổi source hiện tại.
  const fixture = compose(
    base,
    stale(5, "Prerequisite fixture is not complete"),
    status(6, next),
  );
  const result = invalid(fixture, /006.*prerequisite 005.*DONE/);
  const prerequisite = (messages) =>
    messages.filter((message) => /006.*prerequisite 005.*DONE/.test(message));
  assert.deepEqual(prerequisite(result.messages), [
    fileFor(6).slice("plans/".length) + ": prerequisite 005 must be DONE",
  ]);
  assert(result.historicalReads.includes(
    manifest.find((entry) => entry.id === 5).evidence[0].sourceRef + ":" +
      manifest.find((entry) => entry.id === 5).evidence[0].path,
  ));
  const restored = run(compose(base, status(5, "DONE"), status(6, next)));
  assert.equal(restored.thrown, undefined);
  assert.deepEqual(prerequisite(restored.messages), []);
}
for (const next of ["IN_PROGRESS", "DONE"]) {
  test(
    next +
      " prerequisite fixture survives all future plans marked DONE and unrelated status changes",
    () => {
      const futureDone = compose(
        ...manifest.map((entry) => status(entry.id, "DONE")),
      );
      assertUnfinishedPrerequisite(next, futureDone);
      assertUnfinishedPrerequisite(next, compose(futureDone, stale(21)));
    },
  );
}
test("historical baseline requires sourceRef on every record", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) =>
      delete entries[0].evidence[0].sourceRef
    ),
  }, /001.*sourceRef/);
});
test("historical evidence fails when Git object is missing", () => {
  const missing = "deadbee".padEnd(40, "0");
  const result = run({
    "plans/manifest.json": editManifest((entries) => {
      entries[0].evidence[0].sourceRef = missing;
    }),
  });
  assert.equal(result.exitCode, 1);
  assert(result.historicalReads.includes(missing + ":src/auth/config.ts"));
  assert.match(result.messages.join("\n") + String(result.thrown), /deadbee/);
});
// Tự dựng TODO từ Git HEAD, không lấy trạng thái backlog thật làm tiền đề.
function assertCurrentSourceDrift(base = {}, filesystem = {}) {
  const entry = manifest.find((item) => item.id === 1);
  assert(entry);
  const sourceRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const evidences = entry.evidence.map((original) => {
    const current = execFileSync("git", [
      "show",
      sourceRef + ":" + original.path,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const lines = current.split("\n");
    const line = lines.findIndex((value) => value.trim().length > 0) + 1;
    assert(line > 0);
    return { path: original.path, line, code: lines[line - 1], sourceRef };
  });
  const evidence = evidences[0];
  const fixture = status(entry.id, "TODO");
  const changeStatus = fixture[fileFor(entry.id)];
  fixture[fileFor(entry.id)] = (text) => {
    let changed = changeStatus(text).replace(/- \[[xX]\]/g, "- [ ]");
    for (const [index, original] of entry.evidence.entries()) {
      changed = changed.replace(
        tick + original.path + ":" + original.line + tick,
        tick + evidences[index].path + ":" + evidences[index].line + tick,
      );
    }
    let index = 0;
    return changed.replace(
      /<!-- evidence: ([^\n]+) -->\s*(?:<!-- deno-fmt-ignore -->\s*)?[\u0060]{3}[^\n]*\n[\s\S]*?\n[\u0060]{3}/g,
      (_block, path) => {
        const excerpt = evidences[index++];
        assert.equal(path, excerpt.path);
        return "<!-- evidence: " + path + " -->\n\n" + tick.repeat(3) +
          "text\n" + excerpt.code + "\n" + tick.repeat(3);
      },
    );
  };
  fixture["plans/manifest.json"] = editManifest((entries) => {
    entries.find((item) => item.id === entry.id).evidence = evidences;
  });
  const replacements = { ...base };
  for (const [path, change] of Object.entries(fixture)) {
    replacements[path] = (text) => change(base[path] ? base[path](text) : text);
  }
  const baseline = run(replacements, [], filesystem);
  assert.equal(baseline.exitCode, 0, baseline.messages.join("\n"));
  assert.equal(baseline.thrown, undefined);
  assert(baseline.historicalReads.includes(sourceRef + ":" + evidence.path));
  const result = invalid(
    {
      ...replacements,
      [evidence.path]: (text) => {
        const lines = text.split("\n");
        lines[evidence.line - 1] += " INVALID_CURRENT_SOURCE";
        return lines.join("\n");
      },
    },
    new RegExp(String(entry.id).padStart(3, "0") + ".*current source drift"),
    [],
    filesystem,
  );
  assert.deepEqual(result.messages, [
    entry.file + ": current source drift " + evidence.path + ":" +
    evidence.line,
  ]);
  assert(result.historicalReads.includes(sourceRef + ":" + evidence.path));
}
test("TODO detects current source drift independently of historical source", () => {
  assertCurrentSourceDrift();
});
test("current source drift regression works without TODO plans in the backlog", () => {
  const base = {
    "plans/README.md": (text) =>
      text.replace(/\|\s*TODO\s*\|$/gm, "| BLOCKED |"),
  };
  // BLOCKED phải trả giá bằng lý do và báo cáo, nên chuyển trạng thái thì cũng
  // phải dựng đủ hai thứ đó; nếu không, test đo trạng thái khác chứ không còn đo
  // drift. Báo cáo chỉ tồn tại trong fixture, không ghi ra đĩa.
  const reports = {};
  for (const entry of manifest) {
    const original = readFileSync(resolve(planRoot, entry.file), "utf8");
    const wasTodo = original.includes(
      "Trạng thái thực thi: " + tick + "TODO" + tick,
    );
    if (wasTodo) {
      reports["plans/evidence/" + String(entry.id).padStart(3, "0") + ".md"] = {
        kind: "file",
        content: blockedReportFor(entry.id),
      };
    }
    base[fileFor(entry.id)] = (text) => {
      const changed = text.replace(
        "Trạng thái thực thi: " + tick + "TODO" + tick,
        "Trạng thái thực thi: " + tick + "BLOCKED" + tick,
      );
      return wasTodo
        ? changed.replace(
          "## Trạng thái và mục tiêu\n",
          "## Trạng thái và mục tiêu\n\n- blocked_reason: " +
            JSON.stringify("Waiting on a decision recorded in the report") +
            "\n",
        )
        : changed;
    };
    assert(
      !base[fileFor(entry.id)](original).includes(
        "Trạng thái thực thi: " + tick + "TODO" + tick,
      ),
    );
  }
  const baseline = run(base, [], reports);
  assert.equal(baseline.exitCode, 0, baseline.messages.join("\n"));
  assert.equal(baseline.thrown, undefined);
  assertCurrentSourceDrift(base, reports);
});
test("DONE still verifies exact historical source", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) => {
      entries[0].evidence[0].code += "\nINVALID_EVIDENCE";
    }),
  }, /001.*historical source mismatch/);
});
test("DONE rejects a changed fenced excerpt", () => {
  invalid({
    [fileFor(1)]: (text) =>
      text.replace("tokens.size === 0", "tokens.size === 1"),
  }, /001.*excerpt mismatch/);
});
test("draft metadata must retain a valid historical label", () => {
  invalid({
    [fileFor(24)]: (text) => text.replace("Mốc soạn:", "Mốc lỗi:"),
  }, /024.*missing valid drafting reference/);
});
for (const replacement of ["SalesInvoice", "Sales  Invoice"]) {
  test("literal whitespace remains significant: " + replacement, () => {
    invalid({
      [fileFor(5)]: (text) => text.replace("Sales Invoice", replacement),
    }, /005.*excerpt mismatch/);
  });
}
test("token boundaries remain significant", () => {
  invalid({
    [fileFor(3)]: (text) => text.replace("nativeResult", "native Result"),
  }, /003.*excerpt mismatch/);
});
test("template literal whitespace remains significant", () => {
  invalid({
    [fileFor(12)]: (text) =>
      text.replace("list:" + "$" + "{doctype}:", "list: " + "$" + "{doctype}:"),
  }, /012.*excerpt mismatch/);
});
test("nested Markdown rejects a broken relative link", () => {
  invalid({}, /001.*link hỏng.*001-executor-local/, [
    "plans/evidence/001-executor-local.md",
  ]);
});
test("nested Markdown resolves links from its containing directory", () => {
  const result = run();
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
for (
  const target of [
    "/etc/passwd",
    "../../../outside-plan.md",
    "../../../backlog-sibling/outside-plan.md",
    "../../src/../../../outside-plan.md",
    "C:/Windows/win.ini",
    "C:outside-plan.md",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\outside-plan.md",
    "..\\..\\..\\outside-plan.md",
    // "//server/share/..." không còn ở đây: nó là network-path reference, tức
    // một URL mượn scheme của trang, chứ không phải đường dẫn trong repo. Dạng
    // UNC thật viết bằng backslash và vẫn nằm trong danh sách này.
    "///etc/passwd",
  ]
) {
  test(
    "Markdown repository boundary rejects before filesystem lookup: " + target,
    () => {
      const report = "plans/evidence/backlog-review.md";
      const resolved = resolve(repoRoot, dirname(report), target);
      const result = run(
        {
          [report]: (text) => text + `\n[Boundary fixture](${target})\n`,
        },
        [],
        { [relative(repoRoot, resolved)]: "file" },
      );
      assert.equal(result.thrown, undefined);
      assert.equal(
        result.exitCode,
        1,
        "Validator accepted an existing unsafe link",
      );
      assert.deepEqual(result.messages, [
        "evidence/backlog-review.md: unsafe Markdown link " + target,
      ]);
      assert.equal(result.existenceChecks.includes(resolved), false);
    },
  );
}
for (
  const target of [
    "../../README.md",
    "../../src/../README.md",
    "./../evidence/../../README.md#documentation",
    "https://example.test/../outside-plan.md#overview",
    "http://example.test/document",
    "#phạm-vi",
  ]
) {
  test("Markdown repository boundary preserves valid target: " + target, () => {
    const result = run({
      "plans/evidence/backlog-review.md": (text) =>
        text + `\n[Boundary fixture](${target})\n`,
    });
    assert.equal(result.thrown, undefined);
    assert.equal(result.exitCode, 0, result.messages.join("\n"));
  });
}
for (const usage of ["[executor][report]", "[report][]", "[report]"]) {
  test(
    "Markdown reference rejects a missing nested destination: " + usage,
    () => {
      invalid({
        "plans/evidence/backlog-review.md": (text) =>
          text + `\n${usage}\n\n[report]: missing-reference.md\n`,
      }, /backlog-review.*link hỏng missing-reference.md/);
    },
  );
}
for (
  const target of [
    "/etc/passwd",
    "../../../outside-plan.md",
    "C:/Windows/win.ini",
    "..\\..\\outside-plan.md",
  ]
) {
  test(
    "Markdown reference rejects unsafe destination before lookup: " + target,
    () => {
      const report = "plans/evidence/backlog-review.md";
      const resolved = resolve(repoRoot, dirname(report), target);
      const result = run(
        {
          [report]: (text) =>
            text + `\n[executor][report]\n\n[report]: ${target}\n`,
        },
        [],
        { [relative(repoRoot, resolved)]: "file" },
      );
      assert.equal(result.thrown, undefined);
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.messages, [
        "evidence/backlog-review.md: unsafe Markdown link " + target,
      ]);
      assert.equal(result.existenceChecks.includes(resolved), false);
    },
  );
}
for (
  const destination of [
    "../../README.md",
    '<../../README.md#documentation> "Repository"',
    "../../src/../README.md 'Repository'",
    "https://example.test/report",
    "#phạm-vi",
  ]
) {
  test(
    "Markdown reference preserves valid nested destination: " + destination,
    () => {
      const result = run({
        "plans/evidence/backlog-review.md": (text) =>
          text + `\n[executor][REPORT]\n\n[report]: ${destination}\n`,
      });
      assert.equal(result.thrown, undefined);
      assert.equal(result.exitCode, 0, result.messages.join("\n"));
    },
  );
}
test("Markdown reference resolves the same relative name from its own directory", () => {
  const result = run({
    "plans/execution-notes.md": (text) =>
      text + "\n[executor][report]\n\n[report]: README.md\n",
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[executor][report]\n\n[report]: ../README.md\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
for (const label of ["report", "report\\]suffix"]) {
  for (
    const title of [
      '"Title [inner]: #local-anchor"',
      "'Title [inner]: #local-anchor'",
      "(Title [inner]: #local-anchor)",
    ]
  ) {
    for (
      const target of [
        "/etc/passwd",
        "../../../outside-plan.md",
        "missing-reference.md",
        "../../README.md",
      ]
    ) {
      test(`Markdown reference title boundary ${label} ${target} ${title}`, () => {
        const report = "plans/evidence/backlog-review.md";
        const resolved = resolve(repoRoot, dirname(report), target);
        const missing = target === "missing-reference.md";
        const valid = target === "../../README.md";
        const result = run(
          {
            [report]: (text) =>
              text +
              `\n[executor][${label}]\n\n[${label}]: ${target} ${title}\n`,
          },
          missing ? [relative(repoRoot, resolved)] : [],
          valid || missing ? {} : { [relative(repoRoot, resolved)]: "file" },
        );
        assert.equal(result.thrown, undefined);
        if (valid) {
          assert.equal(result.exitCode, 0, result.messages.join("\n"));
          assert.equal(result.existenceChecks.includes(resolved), true);
        } else {
          assert.equal(
            result.exitCode,
            1,
            "Validator accepted the title instead of the destination",
          );
          assert.deepEqual(result.messages, [
            `evidence/backlog-review.md: ${
              missing ? "link hỏng" : "unsafe Markdown link"
            } ${target}`,
          ]);
          assert.equal(result.existenceChecks.includes(resolved), missing);
        }
      });
    }
  }
}
test("Markdown reference resolves a destination on the next line", () => {
  // CommonMark cho phép destination nằm ở dòng ngay sau "]:"; nó vẫn phải đi qua
  // gate link chứ không bị từ chối như cú pháp không hỗ trợ.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[executor][report]\n\n[report]:\n  missing-reference.md\n",
  }, /backlog-review.*link hỏng missing-reference.md/);
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[executor][report]\n\n[report]:\n  ../../README.md\n",
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
for (
  const definition of [
    "[report]: <../../README.md",
    "[report]: ../../README.md unsupported title",
  ]
) {
  test(
    "Markdown reference rejects unsupported definition: " +
      JSON.stringify(definition),
    () => {
      invalid({
        "plans/evidence/backlog-review.md": (text) =>
          text + `\n[executor][report]\n\n${definition}\n`,
      }, /backlog-review.*unsupported Markdown reference definition/);
    },
  );
}
test("refreshed baseline retains historical source but DONE requires definition re-review", () => {
  const ref = "013a1cfda64d41b3e62658ff16f7e25be0b3b4c7";
  const current = execFileSync("git", ["show", ref + ":src/auth/config.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const lines = current.split("\n");
  const line =
    lines.findIndex((value) => value.includes("function optionalEnvValue(")) +
    1;
  assert(line > 0);
  const code = lines[line - 1];
  for (const next of ["TODO", "DONE"]) {
    const replacements = status(1, next);
    const changeStatus = replacements[fileFor(1)];
    replacements[fileFor(1)] = (text) =>
      changeStatus(text)
        .replace(
          "Mốc soạn: " + tick + "d2c5305" + tick,
          "Mốc soạn: " + tick + ref + tick,
        )
        .replace("src/auth/config.ts:81", "src/auth/config.ts:" + line)
        .replace(
          /<!-- evidence: src\/auth\/config\.ts -->\s*(?:<!-- deno-fmt-ignore -->\s*)?[\u0060]{3}[^\n]*\n[\s\S]*?\n[\u0060]{3}/,
          "<!-- evidence: src/auth/config.ts -->\n\n" + tick.repeat(3) +
            "text\n" + code + "\n" + tick.repeat(3),
        );
    replacements["plans/manifest.json"] = editManifest((entries) => {
      entries[0].evidence[0] = {
        path: "src/auth/config.ts",
        line,
        code,
        sourceRef: ref,
      };
    });
    const result = run(replacements);
    assert.equal(
      result.exitCode,
      next === "DONE" ? 1 : 0,
      next + ": " + result.messages.join("\n"),
    );
    if (next === "DONE") {
      assert.deepEqual(result.messages, definitionFailures(1));
    }
    assert.equal(result.thrown, undefined);
    assert(result.historicalReads.includes(ref + ":src/auth/config.ts"));
  }
});
test("007 specifies real TypeScript include and test exclude globs", () => {
  const text = readFileSync(resolve(repoRoot, fileFor(7)), "utf8");
  const config = JSON.parse(
    readFileSync(resolve(repoRoot, "src/ui/tsconfig.json"), "utf8"),
  );
  for (const glob of [...config.include, ...config.exclude]) {
    assert(
      text.includes(tick + glob + tick),
      "Missing tsconfig-relative glob: " + glob,
    );
  }
  assert(!text.includes(tick + "src/**/*.ts" + tick));
  assert(!text.includes(tick + "src/**/*.tsx" + tick));
  assert(!text.includes("src/**/_.ts"));
  assert(!text.includes("**/__test.ts"));
});

function sameStatusPair() {
  const groups = new Map();
  for (const entry of manifest) {
    const body = readFileSync(resolve(planRoot, entry.file), "utf8");
    const state = body.match(/Trạng thái thực thi:\s*`([A-Z_]+)`/)?.[1];
    const first = groups.get(state);
    if (first) return [first.id, entry.id];
    groups.set(state, entry);
  }
  throw new Error("Expected two plans with the same execution status");
}

const duplicateFile = editManifest((entries) => {
  const [firstId, secondId] = sameStatusPair();
  const first = entries.find((entry) => entry.id === firstId);
  const second = entries.find((entry) => entry.id === secondId);
  second.file = first.file;
  second.evidence = first.evidence;
});

test("manifest rejects duplicate plan filenames", () => {
  invalid({ "plans/manifest.json": duplicateFile }, /Duplicate manifest file:/);
});
test("manifest requires each filename prefix to match its ID", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) => {
      const [firstId, secondId] = sameStatusPair();
      const first = entries.find((entry) => entry.id === firstId);
      const second = entries.find((entry) => entry.id === secondId);
      [first.file, second.file] = [second.file, first.file];
      [first.evidence, second.evidence] = [second.evidence, first.evidence];
    }),
  }, /Manifest file prefix does not match ID:/);
});
test("manifest covers every physical numbered plan file", () => {
  invalid(
    { "plans/manifest.json": duplicateFile },
    /Numbered plan file missing from manifest:/,
  );
});
function planDependencies(text, value) {
  return text.replace(/^- Phụ thuộc:.*$/m, "- Phụ thuộc: " + value + ".");
}
function indexDependencies(text, id, value) {
  return text.split("\n").map((line) => {
    const cells = line.split("|");
    if (cells[1]?.trim() === String(id).padStart(3, "0")) cells[5] = value;
    return cells.join("|");
  }).join("\n");
}
for (const [id, value] of [[6, "không"], [5, "007"]]) {
  test("plan dependency mismatch in either direction: " + id, () => {
    invalid(
      { [fileFor(id)]: (text) => planDependencies(text, value) },
      /plan and manifest dependencies differ/,
    );
  });
  test("index dependency mismatch in either direction: " + id, () => {
    invalid(
      { "plans/README.md": (text) => indexDependencies(text, id, value) },
      /index and manifest dependencies differ/,
    );
  });
}
test("removing manifest prerequisite cannot bypass active plan docs", () => {
  invalid({
    ...status(6, "IN_PROGRESS"),
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 6).depends = [];
    }),
  }, /plan and manifest dependencies differ/);
});
test("adding manifest prerequisite requires matching docs", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 5).depends = [7];
    }),
  }, /plan and manifest dependencies differ/);
});
test("dependency sets allow whitespace backticks and different order outside approved DONE definitions", () => {
  assertNonDoneSemantic("dependency presentation");
});
for (const direction of ["remove", "add"]) {
  test("scope must match plan file list: " + direction, () => {
    invalid({
      "plans/manifest.json": editManifest((entries) => {
        const entry = entries.find((entry) => entry.id === 15);
        if (direction === "remove") entry.scope.shift();
        else entry.scope.push("src/runtime.ts");
      }),
    }, /plan and manifest scope differ/);
  });
}
const blockedDrift = {
  "src/mrtr/link-disambiguation.ts": (text) =>
    text.replace(
      "result: await options.execute",
      "result: await options.changedExecute",
    ),
};
test("BLOCKED detects current source drift", () => {
  invalid(
    { ...status(2, "BLOCKED"), ...blockedDrift },
    /002.*current source drift/,
  );
});
test("explicit STALE accepts current drift but still reads historical source", () => {
  const result = run({ ...stale(2), ...blockedDrift });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
  assert(
    result.historicalReads.some((path) =>
      path.endsWith(":src/mrtr/link-disambiguation.ts")
    ),
  );
});
test("STALE rejects invalid historical evidence", () => {
  invalid({
    ...stale(2),
    ...blockedDrift,
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 2).evidence[0].code += "INVALID";
    }),
  }, /002.*historical source mismatch/);
});
test("STALE rejects unreadable historical Git source", () => {
  invalid({
    ...stale(2),
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 2).evidence[0].sourceRef = "deadbee"
        .padEnd(40, "0");
    }),
  }, /Cannot read historical source deadbee[0-9a-f]{33}:/);
});
test("unrelated prose does not affect source dependency or scope invariants", () => {
  assertNonDoneSemantic("unrelated prose");
});
function assertInventoryPlan(text, entry) {
  for (
    const required of [
      "erpnext_stock_ledger_list",
      'categories: ["inventory"]',
      'required: ["item_code", "warehouse"]',
      "readOnlyHint: true",
    ]
  ) {
    assert(
      text.includes(required),
      "Missing inventory-only contract: " + required,
    );
  }
  for (
    const path of [
      "src/tools/inventory.ts",
      "src/tools/inventory_test.ts",
      "src/client_test.ts",
      "src/ui/testing/host.ts",
    ]
  ) {
    assert(entry.scope.includes(path), "Missing inventory-only scope: " + path);
  }
  assert(!entry.scope.includes("src/tools/operations_test.ts"));
}
test("015 keeps movements available for inventory-only clients", () => {
  assertInventoryPlan(
    readFileSync(resolve(repoRoot, fileFor(15)), "utf8"),
    manifest.find((entry) => entry.id === 15),
  );
});
test("015 contract rejects operations tool as its requested ledger tool", () => {
  const text = readFileSync(resolve(repoRoot, fileFor(15)), "utf8").replaceAll(
    "erpnext_stock_ledger_list",
    "erpnext_doc_list",
  );
  assert.throws(
    () => assertInventoryPlan(text, manifest.find((entry) => entry.id === 15)),
    /Missing inventory-only contract: erpnext_stock_ledger_list/,
  );
});
test("015 includes public tool catalog updates", () => {
  const entry = manifest.find((entry) => entry.id === 15);
  const text = readFileSync(resolve(repoRoot, fileFor(15)), "utf8");
  for (
    const path of ["README.md", "docs/coverage.md", "docs/architecture.md"]
  ) {
    assert(entry.scope.includes(path), "Missing catalog scope: " + path);
    assert(
      text.includes(tick + path + tick),
      "Missing catalog requirement: " + path,
    );
  }
});
for (
  const suffix of [
    "- Trạng thái thực thi: `DONE`.\n",
    "- Trạng thái thực thi: `BROKEN`.\n",
  ]
) {
  test(
    "execution status rejects duplicate declaration: " + suffix.trim(),
    () => {
      invalid(
        { [fileFor(15)]: (text) => text + "\n" + suffix },
        /015.*missing valid execution status/,
      );
    },
  );
}
test("execution status cannot be supplied by prose outside metadata", () => {
  invalid({
    [fileFor(15)]: (text) =>
      text.replace("Trạng thái thực thi:", "Trạng thái cũ:") +
      "\nTrạng thái thực thi: `TODO`.\n",
  }, /015.*missing valid execution status/);
});
test("execution status rejects malformed first declaration followed by valid metadata", () => {
  invalid({
    [fileFor(15)]: (text) => "Trạng thái thực thi: `BROKEN`.\n" + text,
  }, /015.*missing valid execution status/);
});
test("STALE requires a dedicated reason before bypassing current drift", () => {
  invalid(
    { ...status(2, "STALE"), ...blockedDrift },
    /002.*STALE requires one nonempty stale_reason/,
  );
});
for (const reason of ["", "  "]) {
  test(
    "STALE rejects empty or whitespace reason: " + JSON.stringify(reason),
    () => {
      invalid(
        { ...stale(2, reason), ...blockedDrift },
        /002.*STALE requires one nonempty stale_reason/,
      );
    },
  );
}
test("STALE rejects duplicate reason", () => {
  const replacements = stale(2);
  const change = replacements[fileFor(2)];
  replacements[fileFor(2)] = (text) =>
    change(text) + '\n- stale_reason: "Another reason"\n';
  invalid(replacements, /002.*STALE requires one nonempty stale_reason/);
});
test("README links are bound to their row IDs", () => {
  invalid({
    "plans/README.md": (text) =>
      text.replaceAll(manifest[4].file, "SWAP_FILE").replaceAll(
        manifest[5].file,
        manifest[4].file,
      ).replaceAll("SWAP_FILE", manifest[5].file),
  }, /README row file does not match ID/);
});
test("README rejects duplicate row IDs", () => {
  invalid({
    "plans/README.md": (text) =>
      text + "\n" + text.split("\n").find((line) => line.startsWith("| 005 ")),
  }, /README requires exactly one row for ID 005/);
});
function scopePath(path, fresh = false) {
  const first = manifest.find((entry) => entry.id === 15).scope[0];
  return {
    [fileFor(15)]: (text) =>
      text.replace(
        "- " + tick + first + tick,
        "- " + tick + path + tick + (fresh ? " (tạo mới)" : ""),
      ),
    "plans/manifest.json": editManifest((entries) => {
      const entry = entries.find((entry) => entry.id === 15);
      entry.scope[0] = path;
      if (fresh) entry.newFiles.push(path);
    }),
  };
}

for (
  const path of [
    "../outside-plan.ts",
    "/outside-plan.ts",
    "C:/outside-plan.ts",
    "C:\\outside-plan.ts",
    "src\\outside.ts",
    "./outside.ts",
    "src/../outside.ts",
    "src/./outside.ts",
    "src//outside.ts",
    "src///",
    "",
    null,
  ]
) {
  test(
    "scope paths reject noncanonical new-file exemption: " +
      JSON.stringify(path),
    () => {
      invalid(scopePath(path, true), /015.*invalid repo-relative scope path/);
    },
  );
}
test("newFiles validates invalid paths even outside scope", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 15).newFiles.push(
        "../outside-plan.ts",
      );
    }),
  }, /015.*invalid repo-relative newFiles path/);
});
test("new artifact directory retains a canonical trailing slash", () => {
  assertNonDoneSemantic("new artifact directory");
});
for (const size of [7, 39, 41]) {
  test("sourceRef rejects non-full commit ID length " + size, () => {
    const original = manifest[0].evidence[0].sourceRef;
    const ref = size < 40 ? original.slice(0, size) : original + "0";
    if (size < 40) {
      assert.equal(
        execFileSync("git", ["rev-parse", ref], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim(),
        original,
      );
    }
    invalid({
      "plans/manifest.json": editManifest((entries) => {
        entries[0].evidence[0].sourceRef = ref;
      }),
    }, /001.*valid sourceRef/);
  });
}
test("sourceRef rejects nonhex while retaining real full commit IDs", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) => {
      entries[0].evidence[0].sourceRef = "g".repeat(40);
    }),
  }, /001.*valid sourceRef/);
  const valid = run();
  assert.equal(valid.exitCode, 0, valid.messages.join("\n"));
});
test("immutable Git fixtures reuse subprocess output across validator runs", (t) => {
  gitFixtureCache.clear();
  const first = run(), second = run();
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.deepEqual(second.messages, first.messages);
  assert.deepEqual(second.historicalReads, first.historicalReads);
  assert(
    second.gitSubprocesses < first.gitSubprocesses,
    "Immutable Git reads must not spawn again",
  );
  t.diagnostic(
    JSON.stringify({
      coldGitSubprocesses: first.gitSubprocesses,
      warmGitSubprocesses: second.gitSubprocesses,
      historicalReads: second.historicalReads.length,
    }),
  );
});
test("Git fixture cache isolates buffers and keys by command arguments cwd and encoding", () => {
  const cache = new Map();
  const ref = manifest[0].evidence[0].sourceRef;
  const args = ["show", ref + ":src/auth/config.ts"];
  const settings = { cwd: repoRoot };
  let calls = 0;
  const execute = () => {
    calls++;
    return Buffer.from("original");
  };
  const read = (command = "git", commandArgs = args, options = settings) =>
    readGitFixture(command, commandArgs, options, execute, cache);
  const first = read();
  first.fill(0);
  const second = read();
  assert.equal(second.toString(), "original");
  second.fill(1);
  assert.equal(read().toString(), "original");
  assert.equal(calls, 1);
  read("git", ["show", ref + ":src/runtime.ts"]);
  read("git", ["show", "0".repeat(40) + ":src/auth/config.ts"]);
  read("git", args, { cwd: planRoot });
  read("git", args, { ...settings, encoding: "utf8" });
  read("other", args);
  read("other", args);
  assert.equal(calls, 7);
});
test("Git fixture cache never retains failures unknown reads or mutable refs", () => {
  const cache = new Map();
  const ref = manifest[0].evidence[0].sourceRef;
  let calls = 0;
  const failure = new Error("Git fixture read failure");
  const fail = () => {
    calls++;
    throw failure;
  };
  for (let i = 0; i < 2; i++) {
    assert.throws(() =>
      readGitFixture(
        "git",
        ["show", ref + ":missing.ts"],
        { cwd: repoRoot },
        fail,
        cache,
      ), (error) => error === failure);
  }
  assert.equal(calls, 2);
  assert.equal(cache.size, 0);
  const execute = () => {
    calls++;
    return "current";
  };
  for (
    const args of [["status", "--short"], ["show", "HEAD:src/runtime.ts"], [
      "cat-file",
      "-t",
      "HEAD",
    ], ["ls-tree", "-r", "-t", "-z", "--full-tree", "HEAD"]]
  ) {
    readGitFixture("git", args, { cwd: repoRoot }, execute, cache);
    readGitFixture("git", args, { cwd: repoRoot }, execute, cache);
  }
  assert.equal(calls, 10);
  assert.equal(cache.size, 0);
});
test("Git output callbacks bypass warm fixtures and cannot poison later runs", () => {
  const baseline = run();
  let callbacks = 0;
  const result = invalid(
    {},
    /Cannot read historical source/,
    [],
    {},
    (args, output) => {
      callbacks++;
      if (args[0] === "show") {
        throw new Error(
          "Injected historical read failure",
        );
      }
      return output;
    },
  );
  assert(callbacks > 0);
  assert.equal(result.gitSubprocesses, callbacks);
  let malformed = false;
  invalid({}, /historical source mismatch/, [], {}, (args, output) => {
    if (args[0] !== "show") return output;
    malformed = true;
    return "Malformed historical fixture";
  });
  assert(malformed);
  const restored = run();
  assert.equal(restored.exitCode, 0, restored.messages.join("\n"));
  assert.deepEqual(restored.historicalReads, baseline.historicalReads);
});
test("canonical scope validation precedes dependency-created exemptions", () => {
  const host = "src/ui/testing/host.ts", traversal = "../outside-plan.ts";
  invalid({
    [fileFor(7)]: (text) => text.replaceAll(host, traversal),
    [fileFor(17)]: (text) => text.replaceAll(host, traversal),
    "plans/manifest.json": editManifest((entries) => {
      for (const id of [7, 17]) {
        const entry = entries.find((item) => item.id === id);
        entry.scope = entry.scope.map((path) =>
          path === host ? traversal : path
        );
        entry.newFiles = entry.newFiles.map((path) =>
          path === host ? traversal : path
        );
      }
    }),
  }, /017.*invalid repo-relative scope path/);
});

test("newFiles cannot exempt an existing scope path without the plan marker", () => {
  const entry = manifest.find((item) =>
    item.scope.includes("docs/concepts.md")
  );
  assert(entry);
  const result = invalid(
    {
      "plans/manifest.json": editManifest((entries) =>
        entries.find((item) => item.id === entry.id).newFiles.push(
          "docs/concepts.md",
        )
      ),
    },
    /plan and manifest new-file classifications differ/,
    ["docs/concepts.md"],
  );
  assert.deepEqual(result.messages, [
    entry.file + ": plan and manifest new-file classifications differ",
    ...definitionFailures(entry.id),
    // File đã có từ trước mốc soạn nên nhãn tạo mới sai trên hai cơ sở độc lập:
    // lệch với thân kế hoạch, và lệch với chính lịch sử Git.
    entry.file + ": new file already exists at the drafting reference: " +
    "docs/concepts.md",
  ]);
});
test("newFiles must be a subset of scope", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) =>
      entries[4].newFiles.push("src/outside-scope.ts")
    ),
  }, /newFiles contains paths outside scope/);
});
test("a plan new-file marker requires the manifest exemption", () => {
  const entry = manifest.find((item) => item.id === 7);
  const result = invalid({
    "plans/manifest.json": editManifest((entries) => {
      const changed = entries.find((item) => item.id === 7);
      changed.newFiles = changed.newFiles.filter((path) =>
        path !== "src/ui/testing/host.ts"
      );
    }),
  }, /007.*plan and manifest new-file classifications differ/);
  assert.deepEqual(result.messages, [
    entry.file + ": plan and manifest new-file classifications differ",
    ...definitionFailures(entry.id),
  ]);
});
test("dependency-created scope still requires consistent new-file classification", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) =>
      entries.find((item) => item.id === 17).newFiles.push(
        "src/ui/testing/host.ts",
      )
    ),
  }, /017.*plan and manifest new-file classifications differ/);
});
test("a dependency-created plan marker cannot bypass classification in the other direction", () => {
  invalid({
    [fileFor(17)]: (text) =>
      text.replace(
        "- " + tick + "src/ui/testing/host.ts" + tick,
        "- " + tick + "src/ui/testing/host.ts" + tick + " (tạo mới)",
      ),
  }, /017.*plan and manifest new-file classifications differ/);
});
test("historical new-file markers remain valid after their files are tracked", () => {
  assert(
    manifest.find((entry) => entry.id === 7).newFiles.includes(
      "src/ui/testing/host.ts",
    ),
  );
  execFileSync(
    "git",
    ["ls-files", "--error-unmatch", "src/ui/testing/host.ts"],
    { cwd: repoRoot },
  );
  const result = run();
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("new-file marker accepts wrapped explanations but ignores unrelated prose", () => {
  assertNonDoneSemantic("wrapped new-file marker");
});
function auditLabel(text, value) {
  return text.replace(/(^- Mục audit: )[^;]+/m, "$1" + value);
}
test("audit metadata must match the manifest for all numeric and direction plans", () => {
  for (
    const entry of [
      manifest.find((item) => item.id === 5),
      ...manifest.filter((item) => item.id !== 5),
    ]
  ) {
    const changed = entry.id <= 22
      ? String(entry.id === 22 ? 1 : entry.id + 1)
      : `Hướng phát triển ${entry.id === 25 ? 1 : entry.id - 21}`;
    const result = invalid({
      [fileFor(entry.id)]: (text) => auditLabel(text, changed),
    }, /plan and manifest audit mappings differ/);
    assert.deepEqual(result.messages, [
      ...(readFileSync(resolve(planRoot, entry.file), "utf8").includes(
          "Trạng thái thực thi: `DONE`",
        )
        ? definitionFailures(entry.id)
        : []),
      entry.file + ": plan and manifest audit mappings differ",
    ]);
  }
});
for (
  const [name, change] of [
    ["missing", (text) => text.replace(/^- Mục audit:.*\n/m, "")],
    ["duplicate", (text) => text + "\n- Mục audit: 5; loại: `bug`.\n"],
    ["malformed duplicate", (text) => text + "\n- Mục audit = 5\n"],
    [
      "missing delimiter",
      (text) => text.replace("Mục audit: 5;", "Mục audit: 5"),
    ],
    [
      "wrong field punctuation",
      (text) => text.replace("Mục audit:", "Mục audit ="),
    ],
    ["outside metadata", (text) =>
      text.replace(/^- Mục audit:.*\n/m, "") +
      "\n- Mục audit: 5; loại: `bug`.\n"],
    ["out-of-range numeric", (text) => auditLabel(text, "23")],
    [
      "out-of-range direction",
      (text) => auditLabel(text, "Hướng phát triển 4"),
    ],
  ]
) {
  test("audit metadata rejects " + name, () => {
    invalid(
      { [fileFor(5)]: change },
      /005.*plan and manifest audit mappings differ/,
    );
  });
}
test("audit prose outside declarations does not change non-DONE metadata", () => {
  assertNonDoneSemantic("audit prose");
});
for (
  const [path, kind] of [["src/untracked-plan-fixture.ts", "file"], [
    "src/untracked-plan-fixture/",
    "directory",
  ]]
) {
  test("existing scope rejects untracked placeholder: " + kind, () => {
    invalid(scopePath(path), /existing scope is not tracked/, [], {
      [path.replace(/\/$/, "")]: kind,
    });
  });
}
test("existing scope rejects tracked filename replaced by directory", () => {
  invalid(scopePath("src/runtime.ts"), /existing scope type mismatch/, [], {
    "src/runtime.ts": "directory",
  });
});
test("existing directory scope requires a path boundary", () => {
  invalid(scopePath("src/tool/"), /existing scope is not tracked/, [], {
    "src/tool": "directory",
  });
});
test("explicit new file may be absent from tracked tree", () => {
  assertNonDoneSemantic("new absent file");
});
test("prerequisite-created scope can be absent in current source", () => {
  const result = run({}, ["src/ui/testing/host.ts"]);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("tracked directory scope is accepted", () => {
  assertNonDoneSemantic("tracked directory");
});
test("DONE rejects bare approval metadata", () => {
  invalid({
    "plans/evidence/001.md": () => "---\nreview_verdict: APPROVE\n---\n",
  }, /001.*reviewer approval evidence/);
});
test("DONE rejects copied approval evidence from another plan", () => {
  invalid({
    "plans/evidence/001.md": () =>
      readFileSync(resolve(planRoot, "evidence/004.md"), "utf8"),
  }, /001.*reviewer approval evidence/);
});
for (const revision of ["not-a-ref", "deadbee".padEnd(40, "0")]) {
  test("DONE rejects invalid reviewed revision: " + revision, () => {
    invalid({
      "plans/evidence/001.md": (text) =>
        text.replace(/^reviewed_commit:.*$/m, "reviewed_commit: " + revision),
    }, /001.*reviewer approval evidence/);
  });
}
test("DONE rejects duplicate reviewed revision", () => {
  invalid({
    "plans/evidence/001.md": (text) =>
      text.replace(
        "reviewed_commit:",
        "reviewed_commit: 495cd989\nreviewed_commit:",
      ),
  }, /001.*reviewer approval evidence/);
});
test("DONE rejects a Git blob used as reviewed commit", () => {
  const report = readFileSync(resolve(planRoot, "evidence/001.md"), "utf8");
  const blob = report.match(/^reviewed_evidence_blob: (.+)$/m)[1];
  invalid({
    "plans/evidence/001.md": (text) =>
      text.replace(/^reviewed_commit:.*$/m, "reviewed_commit: " + blob),
  }, /Cannot read Git commit tree/);
});
test("DONE rejects incorrect plan ID and historical evidence blob", () => {
  for (
    const [key, value] of [["plan_id", "004"], [
      "reviewed_evidence_blob",
      "0".repeat(40),
    ], ["completed_evidence_blob", "0".repeat(40)]]
  ) {
    invalid({
      "plans/evidence/001.md": (text) =>
        text.replace(new RegExp("^" + key + ":.*$", "m"), key + ": " + value),
    }, /001.*reviewer approval evidence/);
  }
});
test("DONE rejects unreadable completed commit", () => {
  invalid({
    "plans/evidence/001.md": (text) =>
      text.replace(
        /^completed_commit:.*$/m,
        "completed_commit: " + "deadbee".padEnd(40, "0"),
      ),
  }, /Cannot read Git commit tree/);
});
test("DONE rejects source object drift between review and completion", () => {
  let changed = false;
  const ref = readFileSync(resolve(planRoot, "evidence/001.md"), "utf8").match(
    /^completed_commit: (.+)$/m,
  )[1];
  invalid({}, /001.*reviewer approval evidence/, [], {}, (args, output) => {
    if (args[0] !== "ls-tree" || args.at(-1) !== ref) return output;
    return output.split("\0").map((line) => {
      if (!line.endsWith("\tsrc/auth/config.ts")) return line;
      changed = true;
      return line.replace(/[0-9a-f]{40}\t/, "0".repeat(40) + "\t");
    }).join("\0");
  });
  assert(changed, "Expected the scoped source object fixture to change");
});
for (
  const [id, path] of [[8, "plans/evidence/008.csv"], [
    7,
    "plans/evidence/007/browser/01-invoice.png",
  ]]
) {
  test("DONE artifact bytes remain bound to completion: " + id, () => {
    const artifact = id === 7
      ? "plans/evidence/007/browser/" +
        readdirSync(resolve(planRoot, "evidence/007/browser")).find((file) =>
          file.endsWith(".png")
        )
      : path;
    invalid(
      { [artifact]: (bytes) => Buffer.concat([bytes, Buffer.from("CHANGED")]) },
      new RegExp(String(id).padStart(3, "0") + ".*reviewer approval evidence"),
    );
  });
}
test("existing scope rejects Git tree read failure", () => {
  invalid({}, /Cannot read Git commit tree: HEAD/, [], {}, (args, output) => {
    if (args[0] === "ls-tree" && args.at(-1) === "HEAD") {
      throw new Error("Git tree unavailable");
    }
    return output;
  });
});
test("prerequisite-created source may be absent from Git HEAD and filesystem", () => {
  const result = run(
    {},
    ["src/ui/testing/host.ts"],
    {},
    (args, output) =>
      args[0] === "ls-tree" && args.at(-1) === "HEAD"
        ? output.split("\0").filter((line) =>
          !line.endsWith("\tsrc/ui/testing/host.ts")
        ).join("\0")
        : output,
  );
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("STALE rejects non-string reason and reason outside metadata", () => {
  for (
    const replacement of ["- stale_reason: 42", '- stale_reason: "Valid prose"']
  ) {
    const changes = status(2, "STALE");
    const change = changes[fileFor(2)];
    changes[fileFor(2)] = (text) =>
      replacement.endsWith("42")
        ? change(text).replace(
          "## Trạng thái và mục tiêu\n",
          "## Trạng thái và mục tiêu\n\n" + replacement + "\n",
        )
        : change(text) + "\n" + replacement + "\n";
    invalid(changes, /002.*STALE requires one nonempty stale_reason/);
  }
});
test("021 requires both explicit Node runtime paths", () => {
  const text = readFileSync(resolve(repoRoot, fileFor(21)), "utf8");
  assert(text.includes("--node20"));
  assert(text.includes("--node22"));
  assert(!text.includes("mặc định process.execPath"));
});
test("011 requires actual shim container verification and source label", () => {
  const text = readFileSync(resolve(repoRoot, fileFor(11)), "utf8");
  assert(text.includes("docker build -f Dockerfile.shim --build-arg VCS_REF="));
  assert(text.includes("docker run"));
  assert(text.includes("org.opencontainers.image.revision"));
  assert(!text.includes("không dựng\nDocker"));
});
test("011 proves both staged and unstaged build sources match HEAD", () => {
  const text = readFileSync(resolve(repoRoot, fileFor(11)), "utf8");
  assert(text.includes(
    "git diff --exit-code HEAD -- shim.ts src/compat/legacy-shim.ts Dockerfile.shim",
  ));
});

test("step and gate counting only reads the steps section", () => {
  const setup = stale(15, "Section fixture explicitly uses non-DONE state");
  const before = run(setup);
  assert.equal(before.thrown, undefined);
  // Đổi chỗ hai heading: các bước vẫn nằm nguyên trong tài liệu nhưng đã thuộc
  // section "Bảo trì", còn section "Các bước" chỉ còn văn xuôi bảo trì.
  const after = run(compose(setup, {
    [fileFor(15)]: (text) =>
      text
        .replace(/^## Các bước[ \t]*$/m, "## Section fixture placeholder")
        .replace(/^## Bảo trì[ \t]*$/m, "## Các bước")
        .replace(/^## Section fixture placeholder[ \t]*$/m, "## Bảo trì"),
  }));
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [fileFor(15).slice(6) + ": bước/gate không khớp"],
  );
});

test("a new-file classification cannot name a path that already existed", () => {
  const setup = stale(
    15,
    "Classification fixture explicitly uses non-DONE state",
  );
  const before = run(setup);
  assert.equal(before.thrown, undefined);
  // AGENTS.md đã có từ trước mốc soạn của kế hoạch 015, nên nhãn tạo mới ở đây
  // là khai sai và phải bị chặn thay vì được miễn mọi kiểm tra scope.
  const after = run(compose(setup, scopePath("AGENTS.md", true)));
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [
      fileFor(15).slice(6) +
      ": new file already exists at the drafting reference: AGENTS.md",
    ],
  );
});

test("evidence sourceRef must be a commit, not a tree with the same content", () => {
  const entry = manifest.find((item) => item.id === 2);
  const tree = execFileSync("git", [
    "rev-parse",
    entry.evidence[0].sourceRef + "^{tree}",
  ], { cwd: repoRoot, encoding: "utf8" }).trim();
  assert.match(tree, /^[0-9a-f]{40}$/);
  const setup = stale(2, "Source fixture explicitly uses non-DONE state");
  const before = run(setup);
  assert.equal(before.thrown, undefined);
  // "git show <tree>:<path>" đọc được nên trích đoạn vẫn khớp, nhưng một tree
  // không neo vào lịch sử nào cả: không có commit để đối chiếu thời điểm.
  const after = run(compose(setup, {
    "plans/manifest.json": editManifest((entries) => {
      entries.find((item) => item.id === 2).evidence[0].sourceRef = tree;
    }),
  }));
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [fileFor(2).slice(6) + ": evidence sourceRef must be a commit: " + tree],
  );
});

test("a prose drafting mention cannot displace the metadata one", () => {
  const root = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim().split("\n").at(-1);
  assert.match(root, /^[0-9a-f]{40}$/);
  const setup = stale(15, "Drafting fixture explicitly uses non-DONE state");
  const before = run(setup);
  assert.equal(before.thrown, undefined);
  // Mốc giả cắm vào văn xuôi trước metadata trỏ về commit gốc, nơi chưa có file
  // nào của repository hiện tại, nên nếu nó được dùng làm mốc đối chiếu thì mọi
  // nhãn "(tạo mới)" đều lọt. Kế hoạch có hai mốc phải bị chặn ngay từ khâu đọc.
  const after = run(compose(setup, scopePath("AGENTS.md", true), {
    [fileFor(15)]: (text) =>
      text.replace(
        "\n## Trạng thái và mục tiêu\n",
        "\nMốc soạn: " + tick + root + tick + "\n\n## Trạng thái và mục tiêu\n",
      ),
  }));
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [fileFor(15).slice(6) + ": missing valid drafting reference"],
  );
});

test("a reference definition inside a list item is still checked", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Theo Markdown, "- [report]: missing.md" vẫn định nghĩa reference thật. Nếu
  // marker list làm definition biến mất khỏi gate thì đích hỏng đi qua yên lặng.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- [executor][report]\n- [report]: missing.md\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    ["evidence/backlog-review.md: link hỏng missing.md"],
  );
});

test("README cannot advertise plan IDs outside the manifest", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Ánh xạ một-một chỉ được kiểm theo chiều manifest sang README, nên một dòng
  // danh mục mang ID lạ không bị ai hỏi tới dù nó quảng cáo thêm một kế hoạch.
  const after = run({
    "plans/README.md": (text) =>
      text +
      "| 026 | [Kế hoạch ngoài manifest](README.md) | P3 | S / LOW | không | TODO |\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    ["README lists plan IDs outside the manifest: 026"],
  );
});

test("metadata inside a fenced example cannot stand in for the real section", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Một fence ví dụ đứng trước section thật cũng mang chuỗi heading, nên phép
  // cắt thô sẽ đọc trọn metadata từ văn bản không render, còn section thật
  // thiếu trường vẫn qua gate.
  const fields = [
    "- Mục audit: 22; loại: " + tick + "docs" + tick + ".",
    "- Phụ thuộc: " + tick + "021" + tick + ".",
    "- Mốc soạn: " + tick + "d2c5305" + tick +
    ", 2026-09-05. Trạng thái thực thi: " + tick + "TODO" + tick + ".",
  ];
  const after = run({
    [fileFor(22)]: (text) => {
      const stripped = fields.reduce(
        (body, field) => body.replace(field + "\n", ""),
        text,
      );
      return stripped.replace(
        "\n## Trạng thái và mục tiêu\n",
        "\n" + tick.repeat(3) + "markdown\n## Trạng thái và mục tiêu\n\n" +
          fields.join("\n") + "\n" + tick.repeat(3) +
          "\n\n## Trạng thái và mục tiêu\n",
      );
    },
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [
      fileFor(22).slice(6) + ": plan and manifest dependencies differ",
      fileFor(22).slice(6) + ": missing valid drafting reference",
      fileFor(22).slice(6) + ": missing valid execution status",
      fileFor(22).slice(6) + ": plan and manifest audit mappings differ",
      fileFor(22).slice(6) + ": index and plan status differ",
    ],
  );
});

test("an indented example nested in a list item stays code", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Trong list item, code block bắt đầu ở content indent cộng bốn. Nếu nhận
  // diện code bị tắt suốt list thì ví dụ thụt đúng chuẩn hóa thành văn xuôi và
  // link giả bên trong bị báo hỏng, chặn gate tài liệu bằng lỗi giả.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- Ví dụ code lồng trong list item:\n\n" +
      "      [Literal](missing-list-code.md)\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("execution steps must be numbered 1..N without repeats", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Đếm suông không phân biệt bước nhân đôi với bước bị bỏ: hai "Bước 1" và
  // không có "Bước 2" vẫn ra đúng hạn mức, nên một kế hoạch thiếu bước đi qua.
  const after = run({
    [fileFor(22)]: (text) => text.replace("### Bước 2:", "### Bước 1:"),
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [fileFor(22).slice(6) + ": bước/gate không khớp"],
  );
});

test("a fenced metadata example is not a second declaration", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Kiểm duy nhất phải đếm trên Markdown cấu trúc. Một fence ví dụ mang đúng
  // khuôn metadata là tài liệu hợp lệ, không phải lần khai thứ hai, nên đếm
  // trên body thô sẽ từ chối kế hoạch đúng.
  const after = run({
    [fileFor(22)]: (text) =>
      text + "\nVí dụ khuôn metadata:\n\n" + tick.repeat(3) + "text\n" +
      "- Mốc soạn: " + tick + "abc1234" + tick +
      ", 2026-01-01. Trạng thái thực thi: " + tick + "TODO" + tick + ".\n" +
      tick.repeat(3) + "\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a link inside an HTML comment is not resolved", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // HTML comment không render, nên ghi chú bảo trì chứa link literal không phải
  // link sống; phân giải nó biến một tài liệu đúng thành lỗi giả.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<!-- [literal note](missing-comment.md) -->\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a fenced audit declaration is not a second mapping", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Ánh xạ audit phải đọc trên Markdown cấu trúc. Một fence ví dụ mang đúng khuôn
  // "Mục audit" là tài liệu hợp lệ, không phải lần khai thứ hai; lọc trên body
  // thô đếm nó và bác bỏ kế hoạch đúng.
  const after = run({
    [fileFor(22)]: (text) =>
      text + "\nVí dụ khuôn audit:\n\n" + tick.repeat(3) + "text\n" +
      "- Mục audit: 22; loại: " + tick + "docs" + tick + ".\n" +
      tick.repeat(3) + "\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("metadata hidden in an HTML comment does not satisfy the gate", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Comment không render: một kế hoạch có section metadata hiển thị trống không
  // được qua gate chỉ vì các trường còn nằm trong ghi chú bảo trì.
  const after = run({
    [fileFor(22)]: (text) =>
      text.replace(
        "- Mốc soạn: " + tick + "d2c5305" + tick +
          ", 2026-09-05. Trạng thái thực thi: " + tick + "TODO" + tick + ".",
        "<!--\n- Mốc soạn: " + tick + "d2c5305" + tick +
          ", 2026-09-05. Trạng thái thực thi: " + tick + "TODO" + tick +
          ".\n-->",
      ),
  });
  assert.equal(after.thrown, undefined);
  assert.ok(
    after.messages.some((message) =>
      message.includes("missing valid execution status")
    ),
    after.messages.join("\n"),
  );
});

test("a non-HTTP URI scheme is not resolved as a repository path", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // mailto: là địa chỉ ngoài cây làm việc y như https:; phân giải nó thành đường
  // dẫn tương đối biến một link đúng chuẩn thành lỗi giả.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[Security contact](mailto:security@example.com)\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("each execution step needs its own validation check", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Chỉ so tổng số marker với tổng số bước thì một bước mất gate còn bước kế
  // mang hai gate vẫn ra đúng tổng và lọt cổng.
  const after = run({
    [fileFor(22)]: (text) => {
      const moved = text.replace("**Kiểm tra:**", "**Xác minh:**");
      return moved.replace(
        "### Bước 2: Sửa hướng dẫn có thể làm theo\n",
        "### Bước 2: Sửa hướng dẫn có thể làm theo\n\n**Kiểm tra:** thừa.\n",
      );
    },
  });
  assert.equal(after.thrown, undefined);
  assert.ok(
    after.messages.some((message) => message.includes("bước/gate không khớp")),
    after.messages.join("\n"),
  );
});

test("a longer evidence fence delimiter is parsed completely", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Ghim cứng ba backtick thì backtick thứ tư rơi vào group ngôn ngữ và gate
  // ngôn ngữ báo lệch ở một trích dẫn đúng chuẩn.
  const after = run({
    [fileFor(22)]: (text) =>
      text.replace(
        tick.repeat(3) + "text\n1. Update the version in ",
        tick.repeat(4) + "text\n1. Update the version in ",
      ).replace(
        "plus " + tick + "CHANGELOG.md" + tick + ".\n" + tick.repeat(3) + "\n",
        "plus " + tick + "CHANGELOG.md" + tick + ".\n" + tick.repeat(4) + "\n",
      ),
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an unclosed HTML comment hides the rest of the document", () => {
  // CommonMark đóng comment ở "-->" hoặc ở hết tài liệu. Đòi delimiter đóng thì
  // mọi section sau một "<!--" bỏ quên vẫn được đọc như nội dung sống và một kế
  // hoạch không còn hiển thị phạm vi, bước hay tiêu chí nào vẫn qua gate.
  invalid({
    [fileFor(22)]: (text) =>
      text.replace("## Quy ước cần giữ", "<!--\n\n## Quy ước cần giữ"),
  }, /thiếu Phạm vi và Git/);
});

test("an evidence fence may close with a longer delimiter", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  const after = run({
    [fileFor(22)]: (text) =>
      text.replace(
        "plus " + tick + "CHANGELOG.md" + tick + ".\n" + tick.repeat(3) + "\n",
        "plus " + tick + "CHANGELOG.md" + tick + ".\n" + tick.repeat(4) + "\n",
      ),
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a percent-encoded local link is decoded before resolution", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  const after = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[Encoded target](link%20target.md)\n",
    },
    [],
    { "plans/evidence/link target.md": "file" },
  );
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an encoded traversal cannot slip past the boundary check", () => {
  // Giải mã trước khi kiểm an toàn, nếu không "%2e%2e%2f" luồn qua nhánh unsafe.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[Escape](%2e%2e%2f%2e%2e%2f%2e%2e%2foutside.md)\n",
  }, /unsafe Markdown link/);
});

test("a fence nested in a list item is code", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Fence trong list item mở ở content indent của item, không ở cột 3 tuyệt đối.
  const after = run({
    [fileFor(22)]: (text) =>
      text + "\n- Ví dụ trong list:\n\n    " + tick.repeat(3) + "text\n" +
      "    - Mục audit: 22; loại: " + tick + "docs" + tick + ".\n    " +
      tick.repeat(3) + "\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a link with empty text still has its destination checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[](missing-empty-label.md)\n",
  }, /link hỏng missing-empty-label.md/);
});

test("scope parsing accepts a heading with closing markers", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Gate heading bắt buộc đã chấp nhận closing marker ATX, nên nơi cắt phạm vi
  // phải hiểu cùng một dạng heading.
  const after = run({
    [fileFor(22)]: (text) =>
      text.replace("## Phạm vi và Git\n", "## Phạm vi và Git ##\n"),
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a fenced catalog example does not advertise another plan", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  const after = run({
    "plans/README.md": (text) =>
      text + "\nVí dụ:\n\n" + tick.repeat(3) +
      "text\n| 026 | Example only |\n" +
      tick.repeat(3) + "\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an escaped comment opener does not hide a link", () => {
  // "\<!--" render ra dấu literal, nên link sau nó vẫn sống và vẫn phải kiểm.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n\\<!-- [live](khong-ton-tai.md) -->\n",
  }, /link hỏng khong-ton-tai.md/);
});

test("an escaped destination is unescaped before resolution", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  const after = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[target](link\\(target\\).md)\n",
    },
    [],
    { "plans/evidence/link(target).md": "file" },
  );
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an escaped hash stays part of the file name", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Cắt fragment trước khi gỡ escape thì "a\#b.md" bị xẻ đôi thành "a\" và rơi
  // xuống nhánh unsafe, dù nó trỏ tới một file có thật.
  const after = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[target](a\\#b.md)\n",
    },
    [],
    { "plans/evidence/a#b.md": "file" },
  );
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an evidence annotation inside an outer comment is not live", () => {
  // "-->" của annotation đóng luôn comment mở trước đó, nên cả citation lẫn
  // annotation đều không render và không được mở block trích đoạn.
  invalid({
    [fileFor(22)]: (text) =>
      text.replace(
        "`CONTRIBUTING.md:81`:\n\n<!-- evidence: CONTRIBUTING.md -->",
        "<!--\n\n`CONTRIBUTING.md:81`:\n\n<!-- evidence: CONTRIBUTING.md -->",
      ),
  }, /evidence excerpt count mismatch/);
});

test("parentheses inside an angle-bracket destination stay balanced", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[target](<khong-ton-tai(angle.md>)\n",
  }, /link hỏng khong-ton-tai\(angle\.md/);
});

test("a raw HTML block is not scanned for Markdown links", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // CommonMark không phân giải inline Markdown trong block HTML, nên chuỗi
  // trong <script> chỉ là văn bản thô và không được đem đi phân giải.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<script>\nvar sample = '[x](khong-ton-tai.md)';\n</script>\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a blank line ends an HTML block so the link stays live", () => {
  // Dòng trống đóng block dạng 6, nên link sau nó lại là link sống. Chạy tới
  // thẻ đóng thì một link hỏng thật nằm giữa hai thẻ không còn ai hỏi tới.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<div>\n\n[live](khong-ton-tai.md)\n\n</div>\n",
  }, /link hỏng khong-ton-tai\.md/);
});

test("a lone tag does not interrupt an open paragraph", () => {
  // Block HTML dạng 7 không cắt ngang một đoạn văn, nên dòng sau nó vẫn thuộc
  // đoạn văn đang mở và link trong đó vẫn phải kiểm.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nMột đoạn văn\n<custom-tag>\n[live](khong-ton-tai.md)\n",
  }, /link hỏng khong-ton-tai\.md/);
});

test("an HTML tag inside an inline code span opens no block", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nVăn bản " + tick + "mã\n<div>\nthêm" + tick +
      " [live](khong-ton-tai.md)\n",
  }, /link hỏng khong-ton-tai\.md/);
});

test("a duplicate required section is rejected", () => {
  // Mọi gate section cắt ở lần xuất hiện đầu, nên bản trùng phía sau hiển thị
  // mà không gate nào kiểm và có thể cho phép file ngoài manifest.
  invalid({
    [fileFor(22)]: (text) => text + "\n## Phạm vi và Git\n\n- `server.ts`\n",
  }, /duplicate section Phạm vi và Git/);
});

test("metadata hidden in a raw HTML block is not live", () => {
  // Section bọc trong <script type="text/plain"> không render heading hay
  // trường nào, nên gate ánh xạ bắt buộc không được coi nó là nội dung sống.
  invalid({
    [fileFor(22)]: (text) =>
      text.replace(
        "## Trạng thái và mục tiêu",
        '<script type="text/plain">\n## Trạng thái và mục tiêu\n</script>',
      ),
  }, /thiếu Trạng thái và mục tiêu/);
});

test("an evidence record inside a raw HTML block is not live", () => {
  invalid({
    [fileFor(22)]: (text) => {
      const start = text.indexOf(tick + "CONTRIBUTING.md:81" + tick + ":");
      const end = text.indexOf("\n" + tick.repeat(3) + "\n", start) + 5;
      return text.slice(0, start) + '<script type="text/plain">\n' +
        text.slice(start, end) + "</script>\n" + text.slice(end);
    },
  }, /evidence excerpt count mismatch/);
});

test("a fence opened first keeps an HTML tag inert", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Một "<div>" viết trong ví dụ không được mở block và nuốt hồ sơ chứng cứ
  // sống đứng sau nó.
  const after = run({
    [fileFor(22)]: (text) =>
      text.replace(
        tick + "CONTRIBUTING.md:81" + tick + ":",
        tick.repeat(3) + "text\n<div>\n" + tick.repeat(3) + "\n\n" + tick +
          "CONTRIBUTING.md:81" + tick + ":",
      ),
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an indented scope bullet is accepted", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Thụt một khoảng trắng vẫn là Markdown hợp lệ và render y hệt, nên nó không
  // được làm gate phạm vi báo malformed.
  const after = run({
    [fileFor(22)]: (text) => {
      const start = text.indexOf("## Phạm vi và Git");
      const bullet = text.indexOf("\n- " + tick, start);
      return text.slice(0, bullet) + "\n - " + tick + text.slice(bullet + 4);
    },
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an audit category outside the mapping is rejected", () => {
  invalid({
    [fileFor(22)]: (text) =>
      text.replace(
        "loại: " + tick + "docs" + tick,
        "loại: " + tick + "banana" + tick,
      ),
  }, /plan audit category differs from the audit mapping/);
});

// Vòng 16.
test("a field declared inside a raw HTML block does not count", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Một ví dụ HTML thô nhắc "Trạng thái thực thi:" render thành văn bản, không
  // thành lần khai thứ hai, nên nó không được làm trường trạng thái mất giá trị.
  const after = run({
    [fileFor(22)]: (text) =>
      text +
      '\n<script type="text/plain">\nTrạng thái thực thi: giả\n</script>\n',
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a raw HTML block under a list item is not code", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // Dưới một list item có content indent bốn, "    <script>" là HTML thô ở cột 0
  // của container, nên link bên trong nó không phải link sống.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n-   embedded sample\n\n    <script>\n" +
      "    [not live](missing-list-html.md)\n    </script>\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a character reference in a link destination is decoded", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  const after = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[entity target](link&amp;target.md)\n",
    },
    [],
    { "plans/evidence/link&target.md": "file" },
  );
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an inline link title may wrap to the next line", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[multiline title](../../README.md\n  "Repository title")\n',
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("a symlink leaving the repository is rejected", () => {
  invalid(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[outside](outside-link/probe-target.md)\n",
    },
    /unsafe Markdown link outside-link\/probe-target\.md/,
    [],
    {
      "plans/evidence/outside-link/probe-target.md": {
        kind: "file",
        realpath: "/private/tmp/outside-of-repo/probe-target.md",
      },
    },
  );
});

test("an unreadable link target is rejected", () => {
  invalid(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[loop](looping-link.md)\n",
    },
    /unsafe Markdown link looping-link\.md/,
    [],
    {
      "plans/evidence/looping-link.md": { kind: "file", realpath: "" },
    },
  );
});

test("an escaped pipe does not shift README columns", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // "\|" là một ký tự thật trong ô, không phải ranh giới ô: tách thô làm mọi ô
  // sau nó lệch một bậc và README đúng bị báo hỏng.
  const after = run({
    "plans/README.md": (text) =>
      text.replace(
        "[Từ chối cấu hình OAuth chưa đầy đủ]",
        "[Từ chối cấu hình OAuth \\| chưa đầy đủ]",
      ),
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

// Vòng 17.
test("an inline link title may open right after the line break", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[x](missing-title-paren.md\n"title (")\n',
  }, /link hỏng missing-title-paren\.md/);
});

test("a raw HTML block may open on the list marker line", () => {
  const before = run();
  assert.equal(before.thrown, undefined);
  // "- <div>" mở block ngay trong item, nên link bên trong không phải link sống.
  const after = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- <div>\n  [not live](missing-list-marker.md)\n  </div>\n",
  });
  assert.equal(after.thrown, undefined);
  assert.deepEqual(
    after.messages.filter((message) => !before.messages.includes(message)),
    [],
  );
});

test("an image nested in a link label is checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[![alt](missing-nested-image.png)](../../README.md)\n",
  }, /link hỏng missing-nested-image\.png/);
});

test("a link into the Git directory is rejected", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[git config](../../.git/config)\n",
  }, /unsafe Markdown link \.\.\/\.\.\/\.git\/config/);
});

test("a fence inside a deeply nested list is still code", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- một\n  - hai\n    - ba\n      - bốn\n" +
      "        văn xuôi mở đoạn\n        ~~~text\n" +
      "        [not live](missing-nested-fence.md)\n        ~~~\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a destination in raw HTML is checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="missing-html-link.md">missing</a>\n',
  }, /link hỏng missing-html-link\.md/);
});

test("an image source in raw HTML is checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img src="missing-html-image.png" alt="x">\n',
  }, /link hỏng missing-html-image\.png/);
});

test("a raw HTML destination inside a fence is not live", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n" + tick.repeat(3) + "html\n" +
      '<a href="missing-fenced-html.md">x</a>\n' + tick.repeat(3) + "\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a GFM footnote is not a reference definition", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nVăn bản có chú thích[^note].\n\n[^note]: Nội dung chú thích.\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a broken link inside a footnote is still checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\nCó chú thích[^b].\n\n[^b]: xem [đây](missing-in-footnote.md).\n",
  }, /link hỏng missing-in-footnote\.md/);
});

test("a scheme-relative destination is left to the browser", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[cdn](//example.com/asset)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

// Vòng 19.
test("a Latin-1 character reference in a destination is decoded", () => {
  const result = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[entity](link&copy;target.md)\n",
    },
    [],
    { "plans/evidence/link©target.md": "file" },
  );
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a destination in a multi-line HTML tag is checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a\n  href="missing-multiline-html.md">missing</a>\n',
  }, /link hỏng missing-multiline-html\.md/);
});

test("a blank line ends an HTML tag before its attributes", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a\n\nhref="missing-blank-line-html.md">x</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a string that looks like a tag inside a script is not a link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<script>\nconst example = '<a href=\"missing-script-literal" +
      ".md\">';\n</script>\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("the source of a script element itself is checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<script src="missing-script-source.js"></script>\n',
  }, /link hỏng missing-script-source\.js/);
});

test("a lone tag right below a heading opens an HTML block", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe heading\n<custom-widget>\n" +
      "[not live](missing-after-heading.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a lone tag right below a thematic break opens an HTML block", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n---\n<custom-widget>\n[not live](missing-after-break.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a lone tag continuing a paragraph opens no HTML block", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nMột đoạn văn đang mở\n<custom-widget>\n" +
      "[live](missing-after-paragraph.md)\n",
  }, /link hỏng missing-after-paragraph\.md/);
});

test("a character reference ends a destination at its fragment", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[encoded fragment](../../README.md&num;documentation)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

// Backslash escape và character reference đi hai đường khác nhau: "a\#b.md"
// giữ dấu # làm ký tự thật trong tên file, còn "a&#35;b.md" được giải mã thành
// dấu # nguyên bản rồi ghi thẳng vào href, nên trình duyệt đọc nó là ranh giới
// fragment. Test kề trên giữ đường thứ nhất, test này giữ đường thứ hai.
test("a character reference for a hash splits the destination", () => {
  invalid(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[entity hash](a&#35;b.md)\n",
    },
    /link hỏng a&#35;b\.md/,
    [],
    { "plans/evidence/a#b.md": "file" },
  );
});

test("a link differing only in case is broken", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[case](../readme.md)\n",
  }, /link hỏng \.\.\/readme\.md/);
});

test("a directory component differing only in case is broken", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[case](../Evidence/backlog-review.md)\n",
  }, /link hỏng \.\.\/Evidence\/backlog-review\.md/);
});

test("a bracket inside an HTML attribute does not close a label", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n[<span title="]">target</span>](missing-inline-html-label.md)\n',
  }, /link hỏng missing-inline-html-label\.md/);
});

test("a bracket inside an autolink does not close a label", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[<https://example.com/a]b>](missing-autolink-label.md)\n",
  }, /link hỏng missing-autolink-label\.md/);
});

test("a fragment-only destination must name a real anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[missing section](#definitely-not-a-heading)\n",
  }, /anchor hỏng #definitely-not-a-heading/);
});

test("a fragment-only destination resolves against its own headings", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe anchor target\n\n[here](#probe-anchor-target)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a repeated heading gets the numbered anchor suffix", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe twice\n\n## Probe twice\n\n[second](#probe-twice-1)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an explicit id attribute counts as an anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<a id="probe-explicit-id"></a>\n\n[there](#probe-explicit-id)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a cross-file fragment must name a real anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[gone](../README.md#definitely-not-a-heading)\n",
  }, /anchor hỏng \.\.\/README\.md#definitely-not-a-heading/);
});

test("a fragment on a source file is not checked as an anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[line](../validate-plans.mjs#L1)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a bracket inside an inline HTML attribute opens no link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\nThẻ <span title="[sample](missing-attribute.md)">nhãn</span> trong văn xuôi.\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a broken link right after an inline HTML tag is still caught", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<span>nhãn</span> [gone](missing-after-tag.md)\n",
  }, /link hỏng missing-after-tag\.md/);
});

test("an id inside a fenced example is not an anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n```html\n<a id="ghost-anchor"></a>\n```\n\n[ghost](#ghost-anchor)\n',
  }, /anchor hỏng #ghost-anchor/);
});

test("an id inside an HTML comment is not an anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<!-- <a id="commented-anchor"></a> -->\n\n[gone](#commented-anchor)\n',
  }, /anchor hỏng #commented-anchor/);
});

test("an id written as prose is not an anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\nViết id="prose-anchor" trong câu văn.\n\n[gone](#prose-anchor)\n',
  }, /anchor hỏng #prose-anchor/);
});

test("a name attribute in a real tag still counts as an anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<a name="probe-named-anchor"></a>\n\n[there](#probe-named-anchor)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an out-of-scope line in prose does not truncate the scope list", () => {
  invalid({
    [fileFor(22)]: (text) =>
      text.replace(
        "Các file được sửa khi thực thi:",
        "Ngoài phạm vi: phần dưới liệt kê file thật.\n\n" +
          "Các file được sửa khi thực thi:",
      ),
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 22).scope = [];
    }),
  }, /scope needs exactly one out-of-scope declaration/);
});

test("an inline mention of the out-of-scope label keeps the scope list", () => {
  const result = run({
    [fileFor(22)]: (text) =>
      text.replace(
        "Các file được sửa khi thực thi:",
        "Ghi chú thêm về Ngoài phạm vi: đọc đoạn cuối mục này.\n\n" +
          "Các file được sửa khi thực thi:",
      ),
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a plan without any evidence record is rejected", () => {
  invalid({
    [fileFor(22)]: (text) =>
      text.replace(
        /<!-- evidence: [^\n]+ -->\n\n<!-- deno-fmt-ignore -->\n```[\s\S]*?\n```\n/g,
        "",
      ),
    "plans/manifest.json": editManifest((entries) => {
      entries.find((entry) => entry.id === 22).evidence = [];
    }),
  }, /requires at least one evidence record/);
});

test("BLOCKED without a blocked_reason is rejected", () => {
  invalid(
    status(22, "BLOCKED"),
    /BLOCKED requires one nonempty blocked_reason and an evidence report/,
  );
});

test("BLOCKED with a reason but no evidence report is rejected", () => {
  invalid(
    blocked(22),
    /BLOCKED requires one nonempty blocked_reason and an evidence report/,
  );
});

const blockedReport = blockedReportFor(22);

test("BLOCKED with a reason and an evidence report is accepted", () => {
  const result = run(blocked(22), [], {
    "plans/evidence/022.md": { kind: "file", content: blockedReport },
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an emptied BLOCKED evidence report is rejected", () => {
  invalid(
    blocked(22),
    /evidence\/022\.md: BLOCKED evidence report is missing the plan id 022, the BLOCKED status, a command block/,
    [],
    { "plans/evidence/022.md": { kind: "file", content: "# empty\n" } },
  );
});

for (
  const [label, report, pattern] of [
    [
      "the plan id",
      blockedReport.replace("022", "999"),
      /is missing the plan id 022$/m,
    ],
    [
      "the status",
      blockedReport.replace("BLOCKED", "TODO"),
      /is missing the BLOCKED status$/m,
    ],
    [
      "a command block",
      blockedReport.slice(0, blockedReport.indexOf(tick)) + "deno test\n",
      /is missing a command block$/m,
    ],
  ]
) {
  test(`a BLOCKED evidence report without ${label} is rejected`, () => {
    invalid(blocked(22), pattern, [], {
      "plans/evidence/022.md": { kind: "file", content: report },
    });
  });
}

test("an empty blocked_reason does not satisfy BLOCKED", () => {
  invalid(
    blocked(22, "   "),
    /BLOCKED requires one nonempty blocked_reason and an evidence report/,
    [],
    { "plans/evidence/022.md": "file" },
  );
});

test("a comment-like literal inside a script hides nothing after it", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<script>const value = "<!--";</script>\n\n' +
      '<a href="missing-after-script.md">anchor</a>\n',
  }, /link hỏng missing-after-script\.md/);
});

test("a script tag written inside a comment stays commented out", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<!-- <script> -->\n\n" +
      '<a href="missing-after-comment.md">anchor</a>\n',
  }, /link hỏng missing-after-comment\.md/);
});

test("a C1 numeric reference decodes to its windows-1252 character", () => {
  const result = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[c1](link&#x80;target.md)\n",
    },
    [],
    { "plans/evidence/link€target.md": "file" },
  );
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a numeric reference outside C1 keeps its own code point", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[readme](../READM&#x45;.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a heading with a character reference gets the rendered anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe &amp; heading\n\n[ok](#probe--heading)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a heading anchor is not built from the entity name", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe &amp; heading\n\n[broken](#probe-amp-heading)\n",
  }, /anchor hỏng #probe-amp-heading/);
});

test("an escaped ampersand in a heading stays literal", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe \\&amp; heading\n\n[ok](#probe-amp-heading)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a code span survives a lazy blockquote continuation", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> `quoted code begins\n[not live](missing-lazy-quote.md)`\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a link on a lazy continuation line is still checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> quoted paragraph\n[live](missing-lazy-link.md)\n",
  }, /link hỏng missing-lazy-link\.md/);
});

test("a line that opens its own block is not a lazy continuation", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> `quoted code begins\n- [live](missing-lazy-bullet.md)`\n",
  }, /link hỏng missing-lazy-bullet\.md/);
});

test("a link label does not span a blank line", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nĐoạn kết thúc bằng [\n\n](missing-across-blank.md) đoạn sau.\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a label broken across two lines is still one label", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[label spanning\ntwo lines](missing-two-line-label.md)\n",
  }, /link hỏng missing-two-line-label\.md/);
});

test("a generated anchor suffix skips an id already taken", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Collision probe\n\n## Collision probe-1\n\n" +
      "## Collision probe\n\n[third](#collision-probe-2)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("repeated headings still number in order when nothing collides", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe thrice\n\n## Probe thrice\n\n## Probe thrice\n\n" +
      "[third](#probe-thrice-2)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a comment literal in inline code does not hide later headings", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nVăn xuôi có `<!--` trong backtick.\n\n## Masked probe\n\n" +
      "[ok](#masked-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a stray backtick inside a comment does not hide its terminator", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<!-- ghi chú ` bỏ quên --> còn ` đây\n\n" +
      "## After comment probe\n\n[ok](#after-comment-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a character reference inside a heading code span stays literal", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe `&amp;` code\n\n[ok](#probe-amp-code)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a heading inside a blockquote still creates its anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> ## Quoted anchor probe\n\n[ok](#quoted-anchor-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a heading inside a list item still creates its anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- ## Listed anchor probe\n\n[ok](#listed-anchor-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("content indented five spaces after a marker is code, not a heading", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n-     ## Indented anchor probe\n\n[broken](#indented-anchor-probe)\n",
  }, /anchor hỏng #indented-anchor-probe/);
});

test("content indented four spaces after a marker is still a heading", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n-    ## Spaced anchor probe\n\n[ok](#spaced-anchor-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("content indented five spaces after an ordered marker is code", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n1.     ## Ordered anchor probe\n\n[broken](#ordered-anchor-probe)\n",
  }, /anchor hỏng #ordered-anchor-probe/);
});

test("a heading nested in two list markers still creates its anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n- - ## Nested list anchor probe\n\n[ok](#nested-list-anchor-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a list item followed by a thematic break is not a Setext heading", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- Ghost list item\n---\n\n[broken](#ghost-list-item)\n",
  }, /anchor hỏng #ghost-list-item/);
});

test("a Setext heading inside a blockquote still creates its anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> Quoted setext probe\n> ---\n\n[ok](#quoted-setext-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an autolink in a heading keeps its displayed URL", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## See <https://example.com>\n\n[ok](#see-httpsexamplecom)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an email autolink in a heading keeps its displayed address", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Mail <a@example.com>\n\n[ok](#mail-aexamplecom)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a real tag in a heading is still stripped from the anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Tag <em>probe</em>\n\n[ok](#tag-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("character references in an id attribute are decoded", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="probe&amp;anchor"></a>\n\n[ok](#probe%26anchor)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an href inside another attribute value is not a live link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n<span title=\"href='missing-nested-attribute.md'\">p</span>\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a link title may contain escaped quotes", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[ok](../../README.md "a \\"quoted\\" title")\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a parenthesized link title may contain escaped parentheses", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[ok](../../README.md (a \\(paren\\) title))\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an escaped scheme is still classified as an external address", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[ok](https\\://example.com/path)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a backslash does not escape a comment opener inside an HTML block", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div>\n\\<!-- <a href="missing-in-html.md">hidden</a> -->\n' +
      "</div>\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a backslash still escapes a comment opener outside an HTML block", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\nvăn xuôi \\<!-- <a href="missing-live.md">shown</a> -->\n',
  }, /link hỏng missing-live\.md/);
});

test("an undefined reference label stays literal in a heading anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## [Ghost][undefined-ref]\n\n[ok](#ghostundefined-ref)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an undefined reference label does not collapse to a shorter anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## [Ghost][undefined-ref]\n\n[broken](#ghost)\n",
  }, /anchor hỏng #ghost/);
});

test("a defined reference label still collapses in a heading anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[live-ref]: ../../README.md\n\n## [Ghost live][live-ref]\n" +
      "\n[ok](#ghost-live)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a multiline Setext heading keeps every one of its lines", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nMultiline setext\nheading probe\n---\n" +
      "\n[ok](#multiline-setext-heading-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a multiline Setext heading does not record only its last line", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\nMultiline setext\nheading probe\n---\n\n[broken](#heading-probe)\n",
  }, /anchor hỏng #heading-probe/);
});

test("an ATX heading ends a link label", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph ends here [\n# Boundary heading probe\n" +
      "](missing-atx.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a thematic break ends a link label", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph ends here [\n***\n](missing-break.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a list item ends a link label", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph ends here [\n- new item\n](missing-list.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a link label still spans lines inside a blockquote", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> [a real\n> multiline label](missing-inquote.md)\n",
  }, /link hỏng missing-inquote\.md/);
});

test("a link label still spans lines inside a list item", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- [a real\n  indented label](missing-inlist.md)\n",
  }, /link hỏng missing-inlist\.md/);
});

test("a heading on a list continuation line creates its anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n123. list item\n\n     ## Continued list heading\n" +
      "\n[ok](#continued-list-heading)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an indented heading outside any list stays code", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nPlain paragraph before.\n\n     ## Not a heading probe\n" +
      "\n[broken](#not-a-heading-probe)\n",
  }, /anchor hỏng #not-a-heading-probe/);
});

test("a Setext underline inside a list item still creates its anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- Setext in item\n  ---\n\n[ok](#setext-in-item)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an escaped opening tag is not an HTML link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\nText probe \\<a href="missing-escaped.md">x\\</a> end.\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an escaped opening tag hides no src either", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\nText probe \\<img src="missing-escaped.png"> end.\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a real opening tag still contributes its href", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="missing-real.md">x</a>\n',
  }, /link hỏng missing-real\.md/);
});

test("a backslash inside an HTML block escapes nothing", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div>\n\\<a href="missing-inblock.md">x</a>\n</div>\n',
  }, /link hỏng missing-inblock\.md/);
});

test("a Windows drive path stays unsafe", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[broken](c:\\temp\\file.md)\n",
  }, /unsafe Markdown link/);
});

test("a Windows drive path with slashes stays unsafe", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[broken](c:/temp/file.md)\n",
  }, /unsafe Markdown link/);
});

test("underscore emphasis leaves no character in a heading slug", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## _Emphasized_ probe\n\n[ok](#emphasized-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("strong underscore emphasis leaves no character either", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## __Strong__ probe\n\n[ok](#strong-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an intra-word underscore stays in the heading slug", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## snake_case probe\n\n[ok](#snake_case-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an escaped underscore opens no emphasis in a heading", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## \\_Escaped\\_ probe\n\n[ok](#_escaped_-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a nested link makes the outer opener inert", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[outer [inner](../../README.md)](missing-inert.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an inert outer link still contributes the inner target", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[outer [inner](missing-inner.md)](missing-inert2.md)\n",
  }, /link hỏng missing-inner\.md/);
});

test("a nested image leaves the outer link alive", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[![alt](../../README.md)](missing-image-outer.md)\n",
  }, /link hỏng missing-image-outer\.md/);
});

test("a tab indented continuation line stays inside its item", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n1.\ttab item\n\n\t## Tab continued heading\n" +
      "\n[ok](#tab-continued-heading)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a tab indented line past the item content stays code", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- deep item\n\n\t\t## Tab code in item\n" +
      "\n[broken](#tab-code-in-item)\n",
  }, /anchor hỏng #tab-code-in-item/);
});

test("href on an element that carries no URL is not a link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div href="missing-div.md">x</div>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("src on an element that carries no URL is not a link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div src="missing-divsrc.png">x</div>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("href on an anchor element is still resolved", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="missing-anchor.md">x</a>\n',
  }, /link hỏng missing-anchor\.md/);
});

test("src on an image element is still resolved", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img src="missing-image.png">\n',
  }, /link hỏng missing-image\.png/);
});

test("href on an SVG use element is still resolved", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<svg><use href="missing-use.svg"></use></svg>\n',
  }, /link hỏng missing-use\.svg/);
});

test("backtick runs of different lengths open no code span", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## A `x &amp;`` B\n\n[ok](#a-x--b)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an unmatched backtick run leaves no verbatim slug behind", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## A `x &amp;`` B\n\n[broken](#a-x-amp-b)\n",
  }, /anchor hỏng #a-x-amp-b/);
});

test("a balanced code span still renders verbatim", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Probe `&amp;` code\n\n[ok](#probe-amp-code)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a heading link label with nested brackets collapses to its text", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## [Outer [inner]](../../README.md)\n\n[ok](#outer-inner)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a nested label heading keeps no destination in its slug", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## [Outer [inner]](../../README.md)\n" +
      "\n[broken](#outer-innerreadmemd)\n",
  }, /anchor hỏng #outer-innerreadmemd/);
});

test("a reference definition inside a blockquote still defines", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n> [probe-ref]: ../../README.md\n\n## [Reference text][probe-ref]\n" +
      "\n[ok](#reference-text)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an inline tag with a greater-than sign in an attribute vanishes", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n## A <span title=">Ghost">B</span> C\n\n[ok](#a-b-c)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an attribute value never leaks into a heading slug", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n## A <span title=">Ghost">B</span> C\n\n[broken](#a-ghostb-c)\n',
  }, /anchor hỏng #a-ghostb-c/);
});

test("a link destination does not span a paragraph boundary", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nText probe [literal](\n\nmissing-destination.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a title past a blank line does not revive an inline link", () => {
  // Destination và title của một inline link không chứa được dòng trống, nên cả
  // cụm là văn bản literal và không có link nào để hỏng.
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[y](missing-double-break.md\n\n"title (")\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a definition line cannot interrupt a running paragraph", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\nOrdinary paragraph probe\n[not-a-definition]: missing-inert-def.md\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a definition after a blank line still defines its label", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[live-def]: ../../README.md\n\n## [Def text][live-def]\n" +
      "\n[ok](#def-text)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a broken definition after a blank line is still caught", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph probe.\n\n[broken-def]: missing-real-def.md\n",
  }, /link hỏng missing-real-def\.md/);
});

test("a link inside an image description renders no destination", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n![alt [nested](missing-nested-in-image.md)](../../README.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an image inside a link label still loads its source", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[outer ![alt](missing-image-in-link.png)](../../README.md)\n",
  }, /link hỏng missing-image-in-link\.png/);
});

test("a padded code span drops one space at each end", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## A " + tick + " foo " + tick + " B\n\n[ok](#a-foo-b)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a code span slug keeps no padding of its own", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## A " + tick + " foo " + tick + " B\n\n[broken](#a--foo--b)\n",
  }, /anchor hỏng #a--foo--b/);
});

test("a named reference outside Latin-1 still decodes", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Rights &alpha; marker\n\n[ok](#rights-α-marker)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an entity name never reaches a heading slug verbatim", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Rights &alpha; marker\n\n[broken](#rights-alpha-marker)\n",
  }, /anchor hỏng #rights-alpha-marker/);
});

test("a backslash inside an attribute value is ordinary data", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="\\&amp;"></a>\n\n[ok](#%5C%26)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a fence opens on a blockquote marker line", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> ~~~\n> ## Ghost quoted fence\n> ~~~\n" +
      "\n[broken](#ghost-quoted-fence)\n",
  }, /anchor hỏng #ghost-quoted-fence/);
});

test("a fence opens on a list marker line", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- ~~~\n  [not live](missing-list-fence.md)\n  ~~~\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a closer indented past three columns closes no fence", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n   ~~~\n   fence body\n      ~~~\n" +
      "   [not live](missing-after-fence.md)\n\n   ~~~\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a closer within three columns still closes its fence", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n   ~~~\n   fence body\n   ~~~\n" +
      "\n[live](missing-past-fence.md)\n",
  }, /link hỏng missing-past-fence\.md/);
});

test("an angle destination does not span a line break", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nText probe [literal](<missing-angle\nline.md>)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an angle destination on one line is still checked", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nText probe [literal](<missing-angle-line.md>)\n",
  }, /link hỏng missing-angle-line\.md/);
});

test("an xlink:href on an SVG element is a real target", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<svg><use xlink:href="missing-xlink.svg"></use></svg>\n',
  }, /link hỏng missing-xlink\.svg/);
});

test("a repeated attribute name keeps only its first value", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="real-anchor" id="ghost-anchor"></a>\n' +
      "\n[broken](#ghost-anchor)\n",
  }, /anchor hỏng #ghost-anchor/);
});

test("the first value of a repeated attribute is still an anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="real-anchor" id="ghost-anchor"></a>\n' +
      "\n[ok](#real-anchor)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a comment opener inside an attribute opens no comment", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a title="<!--" href="missing-comment-attr.md">live</a>\n',
  }, /link hỏng missing-comment-attr\.md/);
});

test("a real comment still hides the link inside it", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<!-- <a href="missing-in-comment.md">dead</a> -->\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an HTML block inside a blockquote hides its heading", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> <div>\n> ## Ghost quoted HTML\n> </div>\n" +
      "\n[broken](#ghost-quoted-html)\n",
  }, /anchor hỏng #ghost-quoted-html/);
});

test("a definition continuation line must stay in the same block", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[not-a-definition]:\n- missing-list-dest.md\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a definition continuation inside the block still defines", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[wrapped-def]:\nmissing-wrapped-dest.md\n",
  }, /link hỏng missing-wrapped-dest\.md/);
});

test("a quoted title alone is read as the destination", () => {
  // CommonMark đọc chính chuỗi có dấu nháy làm destination khi không có
  // destination nào đứng trước nó, nên "[home]( "x")" trỏ tới "%22x%22".
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[home]( "missing-tooltip.md")\n',
  }, /link hỏng "missing-tooltip\.md"/);
});

test("a spaced thematic break does not turn text into a heading", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nBreak probe text\n- - -\n\n[broken](#break-probe-text)\n",
  }, /anchor hỏng #break-probe-text/);
});

test("a name attribute on a plain element is not an anchor", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div name="ghost-name"></div>\n\n[broken](#ghost-name)\n',
  }, /anchor hỏng #ghost-name/);
});

test("a name attribute on an anchor element still creates an anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a name="real-name"></a>\n\n[ok](#real-name)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an id attribute on a plain element still creates an anchor", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div id="real-id"></div>\n\n[ok](#real-id)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a link target outside the Git index is rejected", () => {
  invalid(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[local](local-only.md)\n",
    },
    /chưa được Git theo dõi local-only\.md/,
    [],
    { "plans/evidence/local-only.md": { kind: "file", tracked: false } },
  );
});

test("a tracked link target still resolves", () => {
  const result = run(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[tracked](tracked-only.md)\n",
    },
    [],
    { "plans/evidence/tracked-only.md": "file" },
  );
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a directory link resolves through the files tracked under it", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[evidence](../evidence)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a directory link with nothing tracked under it is rejected", () => {
  invalid(
    {
      "plans/evidence/backlog-review.md": (text) =>
        text + "\n[ghost](ghost-dir)\n",
    },
    /chưa được Git theo dõi ghost-dir/,
    [],
    { "plans/evidence/ghost-dir": "directory" },
  );
});

test("a drafting reference must resolve without any new files", () => {
  invalid({
    [fileFor(22)]: (text) =>
      text.replace(
        /^- Mốc soạn: `[0-9a-f]{7,40}`/m,
        "- Mốc soạn: `deadbee`",
      ),
  }, /Cannot read Git commit tree: deadbee/);
});

test("an img srcset candidate is a real target", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img src="../../README.md" srcset="missing-srcset.png 2x">\n',
  }, /link hỏng missing-srcset\.png/);
});

test("a source srcset candidate is a real target", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<picture><source srcset="missing-source-set.png"></picture>\n',
  }, /link hỏng missing-source-set\.png/);
});

test("srcset descriptors are not read as paths", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<img src="../../README.md" srcset="../../README.md 1x, ' +
      '../../README.md 2x">\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("srcset on an element without it is not a target", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div srcset="missing-div-srcset.png"></div>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an ordered marker other than 1 does not interrupt a paragraph", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph probe f2\n2. ## Ghost ordered\n\n" +
      "[f2](#ghost-ordered)\n",
  }, /anchor hỏng #ghost-ordered/);
});

test("an ordered marker of 1 still interrupts a paragraph", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph probe f2b\n1. ## Real ordered\n\n" +
      "[f2b](#real-ordered)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an ordered marker other than 1 still opens a list after a blank line", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n2. ## Standalone ordered\n\n[f2c](#standalone-ordered)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an empty list item does not interrupt a paragraph", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph probe g1\n* \nGhost setext\n---\n\n" +
      "[g1](#ghost-setext)\n",
  }, /anchor hỏng #ghost-setext/);
});

test("the setext slug keeps every line across an empty marker", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph probe g1b\n* \nGhost setext b\n---\n\n" +
      "[g1b](#paragraph-probe-g1b--ghost-setext-b)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a blockquote still interrupts a paragraph", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nParagraph probe g4\n> ## Quoted heading g4\n\n" +
      "[g4](#quoted-heading-g4)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a later ordered marker still opens an item in the same list", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n1. ## Item one g5\n2. ## Item two g5\n\n[g5](#item-two-g5)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a reference definition title is not an inline link", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n[f3ref]: ../../README.md "Title [hidden](missing-ref-title.md)"\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a definition with an unclosed title is still rejected", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n[f3b]: ../../README.md "unclosed [hidden](missing-real-link.md)\n',
  }, /unsupported Markdown reference definition/);
});

test("a heading link tail must match the destination grammar", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## [Ghost](https://example.com bad)\n\n[f4](#ghost)\n",
  }, /anchor hỏng #ghost/);
});

test("a well formed heading link tail still yields the label slug", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## [Real f4b](https://example.com)\n\n[f4b](#real-f4b)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a reference definition above a setext heading stays out of the slug", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f5ref]: ../../README.md\nActual heading probe\n---\n\n" +
      "[f5](#actual-heading-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("the slug merging a definition into a setext heading does not exist", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f5bref]: ../../README.md\nActual heading probe b\n---\n\n" +
      "[f5b](#f5bref-readmemd-actual-heading-probe-b)\n",
  }, /anchor hỏng #f5bref-readmemd-actual-heading-probe-b/);
});

test("a reference definition label spanning two lines is parsed", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f6 multi\nline label]: missing-multiline-label.md\n\n" +
      "[f6 visible][f6 multi line label]\n",
  }, /link hỏng missing-multiline-label\.md/);
});

test("a multiline definition label still resolves a live destination", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f6b multi\nline label]: ../../README.md\n\n" +
      "[f6b visible][f6b multi line label]\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

// Dòng trống kết thúc đoạn, nên nhãn không bắc qua nó: cụm dưới đây không định
// nghĩa nhãn nào và cũng không có đích nào để đem đi phân giải.
test("a blank line inside a label ends the definition", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f6c multi\n\nline label]: missing-blank-label.md\n\n" +
      "[f6c visible][f6c multi line label]\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a definition label cannot span a heading", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f6d multi\n## Not a label f6d\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a link to the repository root is tracked", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f7 root](../../)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a README ID outside the three digit shape is still compared", () => {
  invalid({
    "plans/README.md": (text) =>
      text +
      "| 1000 | [Kế hoạch ngoài manifest](README.md) | P3 | S / LOW | không | TODO |\n",
  }, /README lists plan IDs outside the manifest: 1000/);
});

test("a definition title on its own line is not scanned for links", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n[g1ref]: ../../README.md\n  "Title [hidden](missing-g1.md)"\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a continuation that is not a title stays ordinary paragraph text", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[g1bref]: ../../README.md\n[live](missing-g1b.md) văn xuôi\n",
  }, /link hỏng missing-g1b\.md/);
});

test("a video poster is a real resource", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<video poster="missing-poster.png"></video>\n',
  }, /link hỏng missing-poster\.png/);
});

test("a poster on another element is not a target", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div poster="missing-div-poster.png"></div>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a label of 1000 characters is not a definition", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[" + "a".repeat(1000) + "]: missing-g3.md\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a label of 999 characters is still a definition", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[" + "a".repeat(999) + "]: missing-g3b.md\n",
  }, /link hỏng missing-g3b\.md/);
});

test("a ten digit ordered marker does not open a list", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n1234567890. ~~~\n\n[live](missing-g4.md)\n",
  }, /link hỏng missing-g4\.md/);
});

test("a nine digit ordered marker still opens a list", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n123456789. ~~~\n  văn bản trong fence\n  ~~~\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a fence opened inside a list item closes when text leaves the item", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- ~~~\n\n[live](missing-g4c.md)\n",
  }, /link hỏng missing-g4c\.md/);
});

test("an unclosed fence outside a list still hides the rest", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n~~~\n[live](missing-g4d.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("reference labels are compared with Unicode case folding", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n[Σ]: ../../README.md\n\n## [Visible g5][ς]\n\n[g5](#visible-g5)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("labels that really differ still do not match", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      "\n[g5b alpha]: ../../README.md\n\n## [Visible g5b][g5b beta]\n\n" +
      "[g5b](#visible-g5b)\n",
  }, /anchor hỏng #visible-g5b/);
});

test("a comma without whitespace separates srcset candidates", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img srcset="../../README.md 1x,missing-h1.png 2x">\n',
  }, /link hỏng missing-h1\.png/);
});

test("a comma inside a srcset URL does not separate candidates", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img srcset="missing-h1b.png,missing-h1c.png">\n',
  }, /link hỏng missing-h1b\.png,missing-h1c\.png/);
});

test("a comma inside srcset descriptor parentheses is hidden", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img srcset="missing-h1d.png (1,5)x">\n',
  }, /link hỏng missing-h1d\.png$/m);
});

test("an object data resource is a real target", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<object data="missing-h2.pdf"></object>\n',
  }, /link hỏng missing-h2\.pdf/);
});

test("data on another element is not a target", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<div data="missing-h2b.pdf"></div>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("whitespace around an HTML URL attribute is trimmed", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href=" ../../README.md ">root</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a trimmed HTML URL attribute is still resolved", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href=" missing-h3.md ">x</a>\n',
  }, /link hỏng missing-h3\.md/);
});

test("an HTML URL attribute that is only whitespace is not a target", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="   ">x</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a destination nested past the parenthesis limit is literal text", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[x](" + "(".repeat(33) + "missing-h4.md" + ")".repeat(33) +
      ")\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a destination at the parenthesis limit is still a link", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[x](" + "(".repeat(32) + "missing-h4b.md" + ")".repeat(32) +
      ")\n",
  }, /link hỏng/);
});

test("an iframe body is still scanned for links", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<iframe><a href="missing-h5.md">fallback</a></iframe>\n',
  }, /link hỏng missing-h5\.md/);
});

test("a tab inside a heading is dropped from the slug", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Tab\theading probe\n\n[h6](#tabheading-probe)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a backslash in a raw HTML href is literal data", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="\\&amp;"></a>\n\n<a href="#\\&amp;">n1</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a raw HTML href keeps a backslash out of the slug", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n## Anchor i1\n\n<a href="#anchor\\-i1">x</a>\n',
  }, /anchor hỏng #anchor\\-i1/);
});

test("a Markdown destination still drops a backslash escape", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## Anchor i1b\n\n[i1b](#anchor\\-i1b)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("raw HTML inside an image description is not a resource", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n![<img src="missing-i2.png">](../../README.md)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("raw HTML outside an image description is still a resource", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<img src="missing-i2b.png">\n',
  }, /link hỏng missing-i2b\.png/);
});

test("a shortcut image label is still scanned for raw HTML", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n![<img src="missing-i2c.png">]\n',
  }, /link hỏng missing-i2c\.png/);
});

test("a label ending in a backslash before a heading is literal text", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[literal\\\n## Heading i3](missing-i3.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a label ending in a backslash inside a paragraph is still a link", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[literal\\\nnext line i3b](missing-i3b.md)\n",
  }, /link hỏng missing-i3b\.md/);
});

test("a destination ending in a backslash before a heading is literal text", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[i3c](missing-i3c.md\\\n## Heading i3c)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an entity in a raw HTML href is decoded before whitespace is stripped", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="../../&NewLine;README.md">root p1</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an entity splitting a srcset candidate makes two resources", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<img src="../README.md" srcset="../README.md 1x&#44;missing-p1b.png 2x">\n',
  }, /link hỏng missing-p1b\.png/);
});

test("a legacy entity without a semicolon decodes in an attribute", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="legacy&amp"></a>\n\n[p2](#legacy%26)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a legacy entity followed by a letter stays literal in an attribute", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="legacy&ampX"></a>\n\n[p2b](#legacy%26X)\n',
  }, /anchor hỏng #legacy%26X/);
});

test("a legacy entity followed by an equals sign stays literal", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="legacy&amp=tail"></a>\n\n[p2c](#legacy%26tail)\n',
  }, /anchor hỏng #legacy%26tail/);
});

test("a numeric entity without a semicolon decodes in an attribute", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="numeric&#38tail"></a>\n\n[p2d](#numeric%26tail)\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a non legacy entity without a semicolon stays literal", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a id="modern&zwj"></a>\n\n[p2e](#modern%E2%80%8D)\n',
  }, /anchor hỏng #modern%E2%80%8D/);
});

test("a Markdown destination still needs a semicolon on an entity", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[p2f](missing&amp-p2f.md)\n",
  }, /link hỏng missing&amp-p2f\.md/);
});

test("src on a text input is not a resource", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<input type="text" src="missing-p3.png">\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("src on an input without a type is not a resource", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<input src="missing-p3c.png">\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("src on an image input is still a resource", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<input type="IMAGE" src="missing-p3b.png">\n',
  }, /link hỏng missing-p3b\.png/);
});

test("an inline tag keeps an emphasis delimiter out of a word", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## a<span></span>_b_\n\n[p4](#ab)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an underscore inside a word is still literal in a heading", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n## a_b_ p4b\n\n[p4b](#ab-p4b)\n",
  }, /anchor hỏng #ab-p4b/);
});

test("a non breaking space stays part of a link target", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="\u00a0../../README.md\u00a0">q1</a>\n',
  }, /link hỏng \u00a0\.\.\/\.\.\/README\.md/);
});

test("an ASCII control character around a link target is stripped", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<a href="\u0001../../README.md\u0001">q1b</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an overlong ordered marker does not open a completion checklist", () => {
  invalid({
    [fileFor(24)]: (text) => text.replace(/- \[[xX]\]/g, "1234567890. [X]"),
  }, /024.*completion checklist/);
});

test("a nine digit ordered marker still opens a completion checklist", () => {
  const result = run({
    [fileFor(24)]: (text) => text.replace(/- \[[xX]\]/g, "123456789. [X]"),
  });
  assert.equal(result.thrown, undefined);
  assert.deepEqual(result.messages, definitionFailures(24));
});

test("an indented line inside a blockquote is code", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> Ghi chú q3:\n>\n>     [q3](missing-q3.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an unindented line inside a blockquote is still live text", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> Ghi chú q3b:\n>\n> [q3b](missing-q3b.md)\n",
  }, /link hỏng missing-q3b\.md/);
});

test("a blockquote interrupts a paragraph before indented code", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nĐoạn văn q3c.\n>     [q3c](missing-q3c.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a padded input type is not an image control", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<input type=" image " src="missing-r1.png">\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a broken form action is a broken link", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<form action="missing-r2-target">x</form>\n',
  }, /link hỏng missing-r2-target/);
});

test("a broken submit formaction is a broken link", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<form action="../../README.md"><button formaction="missing-r2b">go</button></form>\n',
  }, /link hỏng missing-r2b/);
});

test("formaction on a control that cannot submit is not a target", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<input type="text" formaction="missing-r2c">\n' +
      '\n<form action="../../README.md"><button type="button" formaction="missing-r2d">x</button></form>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a base element does not change how a target resolves", () => {
  // GitHub xóa hẳn thẻ base khi render và giữ nguyên đích tương đối, nên đích
  // vẫn phân giải theo thư mục của chính file. Tôn trọng base ở đây là để gate
  // bỏ sót đúng những link mà renderer thật vẫn phân giải thành đường dẫn hỏng.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<base href="../../">\n\n[root](README.md)\n',
  }, /link hỏng README\.md/);
});

test("a tabbed list marker measures its content indent in columns", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n-\t```\n  [r4](missing-r4.md)\n",
  }, /link hỏng missing-r4\.md/);
});

test("a spaced list marker keeps the following line inside the fence", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- ```\n  [r4b](missing-r4b.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an escaped angle bracket is allowed in a bracketed destination", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[r5](<https://example.com/a\\>b>)\n" +
      "\n[r5b](<../../README\\.md>)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("an unescaped angle bracket still breaks a bracketed destination", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) => text + "\n[r5c](<a<b>)\n",
  }, /link hỏng <a<b>/);
});

test("a ten digit ordered marker keeps a code span open", () => {
  // Dấu mười chữ số không mở list ở bất kỳ ngữ cảnh nào, nên dòng đó vẫn nằm
  // trong đoạn và code span mở ở dòng trước vẫn đóng được ở dòng sau.
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nText `start\n1234567890. [inert](missing-f1.md)\nend` done.\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a nine digit ordered marker still ends the paragraph", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\nText `start\n123456789. [live](missing-f1b.md)\nend` done.\n",
  }, /link hỏng missing-f1b\.md/);
});

test("a line that opens no html block stays a lazy continuation", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> [visible\n<not-a-real-tag\n> ](missing-f2.md)\n",
  }, /link hỏng missing-f2\.md/);
});

test("a real html block start ends the blockquote paragraph", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n> [visible\n<div\n> ](missing-f2b.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a whitespace only reference label is not a definition", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[   ]: missing-f3.md\n\n[\t]: missing-f3c.md\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("a reference label with content is still a definition", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[ x ]: missing-f3b.md\n",
  }, /link hỏng missing-f3b\.md/);
});

test("an html attribute decodes a numeric reference of any length", () => {
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<a id="longnumeric&#000000065;"></a><a href="#longnumericA">f4</a>\n' +
      '\n<a id="longhex&#x000000041;"></a><a href="#longhexA">f4b</a>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("markdown keeps the seven digit cap on numeric references", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n[f4c](missing&#000000065;.md)\n",
  }, /link hỏng missing&#000000065;\.md/);
});

test("an invalid button type still submits its formaction", () => {
  // "type" của <button> có invalid value default là trạng thái submit, nên
  // Chrome trả button.type === "submit" cho type="bogus" và formaction của nút
  // đó vẫn là đích điều hướng thật.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<form action="../../README.md"><button type="bogus" formaction="missing-f1">go</button></form>\n',
  }, /link hỏng missing-f1$/m);
});

test("a button that cannot submit does not resolve its formaction", () => {
  // Chỉ đúng hai keyword "button" và "reset" tước quyền submit của <button>.
  // <input> thì ngược lại: invalid value default của nó là trạng thái text.
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text +
      '\n<form action="../../README.md"><button type="reset" formaction="missing-f1b">x</button></form>\n' +
      '\n<form action="../../README.md"><input type="bogus" formaction="missing-f1c"></form>\n',
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("nested list markers open a fence on the same line", () => {
  // Hai dấu container chung một dòng mở hai list lồng nhau, và nội dung của
  // item chỉ bắt đầu sau dấu trong cùng, nên fence mở thật và dòng dưới là code.
  const result = run({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- - ~~~text\n    [inert](missing-f2.md)\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});

test("nested list markers without a fence keep the content live", () => {
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + "\n- - text\n    [live](missing-f2b.md)\n",
  }, /link hỏng missing-f2b\.md/);
});

test("an image inside a title element is still a resource", () => {
  // Chrome đọc thân <title> là văn bản, nhưng GitHub chỉ xóa cặp thẻ title và
  // giữ nguyên thẻ img bên trong: ảnh đó render thật và hỏng thật. Tài liệu
  // trong plans/ được đọc trên GitHub, nên che thân title là để một tài nguyên
  // hỏng thật đi qua cổng.
  invalid({
    "plans/evidence/backlog-review.md": (text) =>
      text + '\n<title><img src="missing-f3.png"></title>\n',
  }, /link hỏng missing-f3\.png/);
});

test("a command block hidden in a comment does not satisfy BLOCKED evidence", () => {
  invalid(
    blocked(22),
    /evidence\/022\.md: BLOCKED evidence report is missing a command block$/m,
    [],
    {
      "plans/evidence/022.md": {
        kind: "file",
        content: "# Bằng chứng 022\n\nTrạng thái: BLOCKED\n\n<!--\n" +
          tick.repeat(3) + "bash\ndeno test\n" + tick.repeat(3) + "\n-->\n",
      },
    },
  );
});

test("a hidden id and status do not satisfy BLOCKED evidence", () => {
  invalid(
    blocked(22),
    /evidence\/022\.md: BLOCKED evidence report is missing the plan id 022, the BLOCKED status$/m,
    [],
    {
      "plans/evidence/022.md": {
        kind: "file",
        content: "# Bằng chứng\n\n<!-- 022 và BLOCKED -->\n\n" +
          tick.repeat(3) + "bash\ndeno test\n" + tick.repeat(3) + "\n",
      },
    },
  );
});

test("a catalog row wrapped in a code span does not list a plan", () => {
  // GitHub render cụm ba dòng đó thành đúng một thẻ <code>: không hàng bảng nào
  // và không link nào, nên kế hoạch biến mất khỏi danh mục trước mắt người đọc.
  const file = manifest.find((entry) => entry.id === 1).file;
  invalid({
    "plans/README.md": (text) => {
      const lines = text.split("\n");
      const row = lines.find((line) => line.startsWith("| 001 |"));
      return [
        ...lines.filter((line) => line !== row),
        "",
        tick,
        row,
        tick,
        "",
      ].join("\n");
    },
  }, new RegExp("README thiếu " + file.replace(/\./g, "\\.")));
});

test("inline code elsewhere in the catalog does not hide a plan row", () => {
  const result = run({
    "plans/README.md": (text) =>
      text + "\nGhi chú: chạy " + tick + "deno test" + tick + " trước.\n",
  });
  assert.equal(result.thrown, undefined);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
