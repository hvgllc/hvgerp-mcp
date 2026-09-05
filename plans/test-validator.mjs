import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const planRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(planRoot, "..");
const validator = readFileSync(resolve(planRoot, "validate-plans.mjs"), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("dirname(fileURLToPath(import.meta.url))", "injectedPlanRoot");

function run(name, replacements, expectedExit, expectedError) {
  const messages = [];
  const historicalReads = [];
  const state = { exitCode: 0 };
  let thrown;
  const sandbox = {
    existsSync,
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
    resolve,
    injectedPlanRoot: planRoot,
    process: state,
    console: {
      log: (message) => messages.push(message),
      error: (message) => messages.push(message),
    },
  };
  try {
    runInNewContext(validator, sandbox);
  } catch (error) {
    thrown = error;
    state.exitCode = 1;
  }
  assert.equal(state.exitCode, expectedExit, `${name}: ${messages.join("\n")}`);
  if (expectedError) assert.match(messages.join("\n"), expectedError, name);
  console.log(`${name}: expected exit ${expectedExit}`);
  return { historicalReads, thrown };
}

const baseline = run("DONE uses historical source", {}, 0);
assert.equal(baseline.thrown, undefined);
assert(baseline.historicalReads.includes("d2c5305:src/auth/config.ts"));
assert(
  !readFileSync(resolve(repoRoot, "src/auth/config.ts"), "utf8").includes(
    "if (tokens.size === 0 && !jwksUrl) return null;",
  ),
);

const fence = "```typescript\n";
const wrongExcerpt = (text) =>
  text.replace(fence, `${fence}MUTATED_INVALID_EVIDENCE;\n`);
run(
  "TODO rejects wrong excerpt",
  {
    "plans/003-assignment-cache-invalidation.md": wrongExcerpt,
  },
  1,
  /003.*trích đoạn không khớp/,
);
run(
  "DONE rejects wrong excerpt",
  {
    "plans/001-reject-partial-oauth.md": wrongExcerpt,
  },
  1,
  /001.*trích đoạn không khớp/,
);
run(
  "DONE rejects missing approval",
  {
    "plans/evidence/001.md": (text) => text.replaceAll("APPROVE", "PENDING"),
  },
  1,
  /001.*DONE requires reviewer approval evidence/,
);
run(
  "DONE rejects missing historical label",
  {
    "plans/024-setup-readiness-design.md": (text) =>
      text.replace("Mốc soạn:", "Mốc lỗi:"),
  },
  1,
  /024.*DONE requires a valid historical source reference/,
);
const missingObject = run("DONE rejects missing Git object", {
  "plans/024-setup-readiness-design.md": (text) =>
    text.replace("Mốc soạn: `d2c5305`", "Mốc soạn: `deadbee`") +
    "\nHistorical source: `d2c5305`\n",
}, 1);
assert(missingObject.historicalReads.includes("deadbee:docs/ROADMAP.md"));
assert.match(String(missingObject.thrown), /git show deadbee:docs\/ROADMAP.md/);
console.log("Passed: 6 validator checks; no files changed");
