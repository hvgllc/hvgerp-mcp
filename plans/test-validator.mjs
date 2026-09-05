import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

function run(replacements = {}, hidden = []) {
  const messages = [], historicalReads = [];
  const state = { exitCode: 0 };
  let thrown;
  try {
    runInNewContext(source, {
      existsSync: (path) =>
        !hidden.includes(relative(repoRoot, path)) && existsSync(path),
      readdirSync,
      readFileSync(path, encoding) {
        const text = readFileSync(path, encoding);
        const replace = replacements[relative(repoRoot, path)];
        return replace ? replace(text) : text;
      },
      execFileSync(command, args, options) {
        historicalReads.push(args[1]);
        return execFileSync(command, args, {
          ...options,
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
      dirname,
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

function invalid(replacements, pattern, hidden) {
  const result = run(replacements, hidden);
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
test("TODO detects current source drift independently of historical source", () => {
  invalid({
    "src/kanban/adapters/task.ts": (text) =>
      text.replace("const currentTask = await", "const changedTask = await"),
  }, /010.*current source drift/);
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
  assert(text.includes(tick + "src/**/*.ts" + tick));
  assert(text.includes(tick + "**/*_test.ts" + tick));
  assert(!text.includes("src/**/_.ts"));
  assert(!text.includes("**/__test.ts"));
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
