import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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

function run(replacements = {}, hidden = [], filesystem = {}, gitOutput) {
  const messages = [], historicalReads = [];
  const state = { exitCode: 0 };
  let thrown;
  try {
    runInNewContext(source, {
      existsSync: (path) =>
        !hidden.includes(relative(repoRoot, path)) &&
        (Object.hasOwn(filesystem, relative(repoRoot, path)) ||
          existsSync(path)),
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
        const output = execFileSync(command, args, {
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return gitOutput ? gitOutput(args, output) : output;
      },
      dirname,
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
  return { exitCode: state.exitCode, messages, historicalReads, thrown };
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
test("an unchecked checklist outside completion does not block DONE", () => {
  const result = run({
    [fileFor(24)]: (text) =>
      text + "\n## Future work\n\n- [ ] Not an acceptance criterion\n",
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
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
    invalid(status(6, next), /006.*prerequisite 005.*DONE/);
  });
}
test("historical baseline requires sourceRef on every record", () => {
  invalid({
    "plans/manifest.json": editManifest((entries) =>
      delete entries[0].evidence[0].sourceRef
    ),
  }, /001.*sourceRef/);
});
test("historical evidence fails when Git object is missing", () => {
  const result = run({
    "plans/manifest.json": editManifest((entries) => {
      entries[0].evidence[0].sourceRef = "deadbee";
    }),
  });
  assert.equal(result.exitCode, 1);
  assert(result.historicalReads.includes("deadbee:src/auth/config.ts"));
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
test("refreshed baseline remains stable across TODO to DONE", () => {
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
    assert.equal(result.exitCode, 0, next + ": " + result.messages.join("\n"));
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
test("dependency sets allow whitespace backticks and different order", () => {
  const result = run({
    [fileFor(13)]: (text) =>
      planDependencies(text, "  " + tick + "006" + tick + " , 005  "),
    "plans/README.md": (text) =>
      indexDependencies(text, 13, " 006 , " + tick + "005" + tick + " "),
    [fileFor(5)]: (text) =>
      planDependencies(text, "  " + tick + "không" + tick + "  "),
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
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
      entries.find((entry) => entry.id === 2).evidence[0].sourceRef = "deadbee";
    }),
  }, /Cannot read historical source deadbee:/);
});
test("unrelated prose does not affect source dependency or scope invariants", () => {
  const result = run({
    [fileFor(15)]: (text) => text + "\nGhi chú trình bày bổ sung.\n",
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
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
  const result = run({
    [fileFor(5)]: (text) =>
      text.replace("(tạo mới)", "(tạo\n  mới; thêm test tương ứng)") +
      "\nGhi chú: (tạo mới) chỉ phân loại trong scope.\n",
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
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
test("audit prose outside declarations does not change metadata", () => {
  const result = run({
    [fileFor(5)]: (text) =>
      text + "\nGhi chú: Mục audit: 6 không phải metadata.\n",
  });
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
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
  const result = run(scopePath("src/untracked-plan-fixture.ts", true));
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("prerequisite-created scope can be absent in current source", () => {
  const result = run({}, ["src/ui/testing/host.ts"]);
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
});
test("tracked directory scope is accepted", () => {
  const result = run(scopePath("src/tools/"));
  assert.equal(result.exitCode, 0, result.messages.join("\n"));
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
