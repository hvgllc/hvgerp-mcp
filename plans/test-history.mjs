import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historicalBrokenHead = "24425057594124b5b8485c900e555c66834c342a";
const definitionSnapshot = "b9d6d02a9692c3efff11836b97d8cfbc69da1ec7";
const boundDefinitionFixture = "db2f31fa0b332a7919e02b48f227ae1a6adf9b9e";
const missingReviewedHeads = [
  "bb78ace761b7ae9b26900c8c80faad699a9adfa6",
  "ecc1b69d7d0f3c7a3310a5696097e2497b482a29",
  "0c0d93c380220e36da53fafdc55841b568a277ef",
  "1aae3db9532ab6af2d332849e20c374d75984c6b",
  "9fb89c707dc7b2478cfa98e40ba6fbd678907b4a",
  "306a8aea336dad45697d9c670b784ed201468687",
];

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return result;
}
function git(cwd, args) {
  const result = run(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function isolated(check) {
  const directory = mkdtempSync(join(tmpdir(), "hvgerp-plan-history-"));
  try {
    check(directory);
  } finally {
    // Chỉ xóa thư mục tạm vừa tạo, không đụng repository nguồn hoặc worktree.
    rmSync(directory, { recursive: true, force: true });
  }
}
function clone(source, destination) {
  git(repoRoot, [
    "clone",
    "--no-local",
    "--single-branch",
    "--no-tags",
    source,
    destination,
  ]);
}
function validate(directory) {
  return run(directory, process.execPath, ["plans/validate-plans.mjs"]);
}

test("committed plan provenance survives a clean single-branch clone", () => {
  assert.equal(
    git(repoRoot, ["rev-parse", "--is-shallow-repository"]),
    "false",
    "Full Git history is required; unshallow the checkout before this gate",
  );
  git(repoRoot, ["ls-files", "--error-unmatch", "plans/validate-plans.mjs"]);
  git(repoRoot, ["diff", "--exit-code", "HEAD", "--", "plans/"]);
  assert.equal(
    git(repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "plans/",
    ]),
    "",
    "Commit plan changes before testing the committed checkout",
  );
  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  isolated((directory) => {
    const checkout = join(directory, "clean");
    clone(repoRoot, checkout);
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), head);
    const result = validate(checkout);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(
      readFileSync(join(checkout, "plans/manifest.json"), "utf8"),
    );
    const references = new Set();
    for (const entry of manifest) {
      for (const evidence of entry.evidence) references.add(evidence.sourceRef);
      const body = readFileSync(join(checkout, "plans", entry.file), "utf8");
      if (!body.includes("Trạng thái thực thi: `DONE`")) continue;
      const id = String(entry.id).padStart(3, "0");
      const report = readFileSync(
        join(checkout, "plans/evidence/" + id + ".md"),
        "utf8",
      );
      for (
        const key of [
          "reviewed_commit",
          "completed_commit",
          "definition_commit",
        ]
      ) {
        const ref = report.match(new RegExp("^" + key + ": (.+)$", "m"))?.[1];
        assert(ref, "Validated DONE evidence must contain " + key);
        references.add(ref);
      }
    }
    for (const ref of references) {
      git(checkout, ["merge-base", "--is-ancestor", ref, "HEAD"]);
    }
  });
});

test("historical squashed approval references fail in a real isolated checkout", () => {
  isolated((directory) => {
    const seed = join(directory, "historical.git");
    git(repoRoot, ["init", "--bare", "--initial-branch=regression", seed]);
    // Fetch riêng revision thật trước sửa để không nhận objects của HEAD mới.
    git(seed, [
      "fetch",
      "--no-tags",
      repoRoot,
      historicalBrokenHead + ":refs/heads/regression",
    ]);
    const checkout = join(directory, "historical");
    clone(seed, checkout);
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), historicalBrokenHead);
    for (const ref of missingReviewedHeads) {
      assert.equal(run(checkout, "git", ["cat-file", "-t", ref]).status, 128);
    }
    const result = validate(checkout);
    assert.equal(result.status, 1);
    const failures = result.stderr.trim().split("\n");
    assert.equal(
      failures.length,
      13,
      "Failure must be limited to missing approval history",
    );
    for (const ref of missingReviewedHeads) {
      assert(failures.includes("Cannot read Git commit tree: " + ref));
    }
    for (const id of ["001", "003", "004", "007", "008", "009", "024"]) {
      assert(failures.some((line) =>
        line.startsWith(id + "-") &&
        line.endsWith(": DONE requires reviewer approval evidence")
      ));
    }
  });
});

test("a real clone missing the approved definition ref fails until that ref is fetched", () => {
  isolated((directory) => {
    const seed = join(directory, "definition.git");
    git(repoRoot, ["init", "--bare", "--initial-branch=regression", seed]);
    const before = git(repoRoot, ["rev-parse", definitionSnapshot + "^"]);
    git(seed, [
      "fetch",
      "--no-tags",
      repoRoot,
      before + ":refs/heads/regression",
    ]);
    const checkout = join(directory, "definition");
    clone(seed, checkout);
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), before);
    assert.equal(git(checkout, ["status", "--porcelain"]), "");
    assert.equal(
      run(checkout, "git", ["cat-file", "-t", definitionSnapshot]).status,
      128,
    );

    // Chép nguyên snapshot đã commit và đã có approval thật, không tạo Git object.
    // Chỉ validator lấy bản hiện tại để regression luôn kiểm implementation mới.
    const archive = execFileSync("git", [
      "archive",
      "--format=tar",
      boundDefinitionFixture,
      "plans",
    ], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
    });
    const unpacked = spawnSync("tar", ["-xf", "-", "-C", checkout], {
      input: archive,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.ifError(unpacked.error);
    assert.equal(unpacked.status, 0, unpacked.stderr);
    writeFileSync(
      join(checkout, "plans/validate-plans.mjs"),
      execFileSync("git", [
        "show",
        definitionSnapshot + ":plans/validate-plans.mjs",
      ], { cwd: repoRoot }),
    );
    const beforeGuard = validate(checkout);
    assert.equal(
      beforeGuard.status,
      0,
      beforeGuard.stderr || beforeGuard.stdout,
    );
    copyFileSync(
      join(repoRoot, "plans/validate-plans.mjs"),
      join(checkout, "plans/validate-plans.mjs"),
    );
    assert.equal(
      run(checkout, "git", ["cat-file", "-t", definitionSnapshot]).status,
      128,
    );
    const result = validate(checkout);
    assert.equal(result.status, 1);
    const failures = result.stderr.trim().split("\n");
    const expected = ["Cannot read Git commit tree: " + definitionSnapshot];
    const manifest = JSON.parse(
      readFileSync(join(checkout, "plans/manifest.json"), "utf8"),
    );
    for (const entry of manifest) {
      const body = readFileSync(join(checkout, "plans", entry.file), "utf8");
      if (!body.includes("Trạng thái thực thi: `DONE`")) continue;
      expected.push(
        entry.file + ": DONE requires approved definition snapshot",
      );
      expected.push(entry.file + ": DONE requires reviewer approval evidence");
    }
    assert.equal(expected.length, 27);
    assert.deepEqual(failures, expected);
    git(checkout, [
      "fetch",
      "--no-tags",
      repoRoot,
      definitionSnapshot + ":refs/heads/approved-definition",
    ]);
    const restored = validate(checkout);
    assert.equal(restored.status, 0, restored.stderr || restored.stdout);
    assert.equal(git(checkout, ["rev-parse", "HEAD"]), before);
  });
});
