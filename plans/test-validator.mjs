import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const planRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(planRoot, "..");
const tick = String.fromCharCode(96);
const source = readFileSync(resolve(planRoot, "validate-plans.mjs"), "utf8")
  .replace(/^import .*;\n/gm, "")
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

function run(replacements = {}, hidden = [], filesystem = {}, gitOutput) {
  const messages = [], historicalReads = [], existenceChecks = [];
  let gitSubprocesses = 0;
  const state = { exitCode: 0 };
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
        const kind = filesystem[relative(repoRoot, path)];
        return kind
          ? {
            isFile: () => kind === "file",
            isDirectory: () => kind === "directory",
          }
          : lstatSync(path);
      },
      readdirSync,
      readFileSync(path, encoding) {
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
        return gitOutput
          ? gitOutput(args, execute(command, args, settings))
          : readGitFixture(command, args, settings, execute);
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

const definitionRef = "b9d6d02a9692c3efff11836b97d8cfbc69da1ec7";
const definitionFields = [
  "definition_review_verdict",
  "definition_commit",
  "definition_plan_blob",
  "definition_manifest_blob",
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
  const path of [
    ".github/fixture.yml",
    ".gitignore",
    "src/git/config.ts",
    "src/.git-fixture.ts",
  ]
) {
  test("Git namespace guard preserves unrelated names: " + path, () => {
    const setup = stale(15, "Namespace control explicitly uses non-DONE state");
    const before = run(setup);
    const after = run(compose(setup, scopePath(path, true)));
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
function assertCurrentSourceDrift(base = {}) {
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
  const baseline = run(replacements);
  assert.equal(baseline.exitCode, 0, baseline.messages.join("\n"));
  assert.equal(baseline.thrown, undefined);
  assert(baseline.historicalReads.includes(sourceRef + ":" + evidence.path));
  const result = invalid({
    ...replacements,
    [evidence.path]: (text) => {
      const lines = text.split("\n");
      lines[evidence.line - 1] += " INVALID_CURRENT_SOURCE";
      return lines.join("\n");
    },
  }, new RegExp(String(entry.id).padStart(3, "0") + ".*current source drift"));
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
  for (const entry of manifest) {
    base[fileFor(entry.id)] = (text) =>
      text.replace(
        "Trạng thái thực thi: " + tick + "TODO" + tick,
        "Trạng thái thực thi: " + tick + "BLOCKED" + tick,
      );
    assert(
      !base[fileFor(entry.id)](
        readFileSync(resolve(planRoot, entry.file), "utf8"),
      ).includes("Trạng thái thực thi: " + tick + "TODO" + tick),
    );
  }
  const baseline = run(base);
  assert.equal(baseline.exitCode, 0, baseline.messages.join("\n"));
  assert.equal(baseline.thrown, undefined);
  assertCurrentSourceDrift(base);
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
    "//server/share/outside-plan.md",
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
    "./../evidence/../../README.md#overview",
    "https://example.test/../outside-plan.md#overview",
    "http://example.test/document",
    "#local-anchor",
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
    '<../../README.md#overview> "Repository"',
    "../../src/../README.md 'Repository'",
    "https://example.test/report",
    "#local-anchor",
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
for (
  const definition of [
    "[report]:\n  missing-reference.md",
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
