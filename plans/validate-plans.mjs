import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const planRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(planRoot, "..");
const manifest = JSON.parse(
  readFileSync(resolve(planRoot, "manifest.json"), "utf8"),
);
const failures = [];
const fail = (message) => failures.push(message);
const sameSet = (left, right) =>
  left.length === new Set(left).size && right.length === new Set(right).size &&
  left.length === right.length && left.every((item) => right.includes(item));
function dependencies(value) {
  if (value === undefined) return undefined;
  const text = value.replaceAll("`", "").trim().replace(/\.$/, "").trim();
  if (text === "không") return [];
  if (!/^\d{3}(?:\s*,\s*\d{3})*$/.test(text)) return undefined;
  return text.split(",").map((id) => Number(id.trim()));
}
const sourceCache = new Map();
function evidenceSource(sourcePath, sourceRef) {
  const key = sourceRef + ":" + sourcePath;
  if (!sourceCache.has(key)) {
    try {
      sourceCache.set(
        key,
        execFileSync("git", ["show", key], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {
      fail("Cannot read historical source " + key);
      sourceCache.set(key, undefined);
    }
  }
  return sourceCache.get(key);
}
const metadataSection = (body) =>
  body.split("\n## Trạng thái và mục tiêu\n")[1]?.split("\n## ")[0] ?? "";
function auditOf(body) {
  const fields = body.split("\n").filter((line) =>
    /^\s*-\s*Mục audit\b/.test(line)
  );
  if (
    fields.length !== 1 ||
    !metadataSection(body).split("\n").includes(fields[0])
  ) return undefined;
  return fields[0].match(
    /^- Mục audit: ([1-9]|1\d|2[0-2]|Hướng phát triển [1-3]); loại: `[^`]+`\.$/,
  )?.[1];
}
function statusOf(body) {
  if (body.split("Trạng thái thực thi:").length !== 2) return undefined;
  return metadataSection(body).match(
    /^- Mốc soạn: `[0-9a-f]{7,40}`, \d{4}-\d{2}-\d{2}\. Trạng thái thực thi: `(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)`\.$/m,
  )?.[1];
}
function staleReason(body) {
  const fields = body.split("\n").filter((line) =>
    /^\s*-\s*stale_reason\s*:/.test(line)
  );
  if (
    fields.length !== 1 ||
    !metadataSection(body).split("\n").includes(fields[0])
  ) return false;
  const value = fields[0].match(/^- stale_reason: (.+)$/)?.[1];
  try {
    const reason = JSON.parse(value ?? "null");
    return typeof reason === "string" && reason.trim().length > 0;
  } catch {
    return false;
  }
}
const statusById = new Map(manifest.map((entry) => {
  const path = resolve(planRoot, entry.file);
  return [
    entry.id,
    existsSync(path) ? statusOf(readFileSync(path, "utf8")) : undefined,
  ];
}));
function exactLines(source, evidence) {
  return source.split("\n").slice(
    evidence.line - 1,
    evidence.line - 1 + evidence.code.split("\n").length,
  ).join("\n") === evidence.code;
}
const treeCache = new Map();
function gitTree(ref) {
  if (!treeCache.has(ref)) {
    try {
      const options = {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (
        execFileSync("git", ["cat-file", "-t", ref], options).trim() !==
          "commit"
      ) {
        throw new Error("Expected a Git commit");
      }
      const output = execFileSync("git", [
        "ls-tree",
        "-r",
        "-t",
        "-z",
        "--full-tree",
        ref,
      ], options);
      treeCache.set(
        ref,
        new Map(
          output.split("\0").filter(Boolean).map((line) => {
            const [header, path] = line.split("\t");
            const [mode, type, oid] = header.split(" ");
            return [path, { mode, type, oid }];
          }),
        ),
      );
    } catch {
      fail("Cannot read Git commit tree: " + ref);
      treeCache.set(ref, undefined);
    }
  }
  return treeCache.get(ref);
}
function canonicalScopePath(path) {
  return typeof path === "string" && path.length > 0 &&
    !path.startsWith("/") && !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") && !path.includes("\0") &&
    !path.split("/").some((part, index, parts) =>
      part.toLowerCase() === ".git" || part === "." || part === ".." ||
      (!part && index !== parts.length - 1)
    );
}
function scopedObject(tree, path) {
  if (!canonicalScopePath(path)) return undefined;
  const object = tree?.get(path.replace(/\/$/, ""));
  const directory = path.endsWith("/");
  return object?.type === (directory ? "tree" : "blob") &&
      (directory || object.mode === "100644" || object.mode === "100755")
    ? object
    : undefined;
}
function blobId(data) {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  return createHash("sha1").update("blob " + bytes.length + "\0")
    .update(bytes).digest("hex");
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}
function definitionApproved(field, entry, planBody) {
  if (field("definition_review_verdict") !== "APPROVE") return false;
  const ref = field("definition_commit");
  const planBlob = field("definition_plan_blob");
  const manifestBlob = field("definition_manifest_blob");
  if (
    ![ref, planBlob, manifestBlob].every((value) =>
      /^[0-9a-f]{40}$/.test(value ?? "")
    )
  ) {
    return false;
  }
  const tree = gitTree(ref);
  if (!tree) return false;
  const planObject = scopedObject(tree, "plans/" + entry.file);
  const manifestObject = scopedObject(tree, "plans/manifest.json");
  if (
    !planObject || planObject.oid !== planBlob ||
    blobId(planBody) !== planBlob ||
    !manifestObject || manifestObject.oid !== manifestBlob
  ) return false;
  const historical = evidenceSource("plans/manifest.json", ref);
  if (historical === undefined || blobId(historical) !== manifestBlob) {
    return false;
  }
  try {
    const entries = JSON.parse(historical);
    if (!Array.isArray(entries)) return false;
    const matches = entries.filter((candidate) => candidate?.id === entry.id);
    return matches.length === 1 &&
      JSON.stringify(canonicalValue(matches[0])) ===
        JSON.stringify(canonicalValue(entry));
  } catch {
    return false;
  }
}
function reportFields(body) {
  const metadata = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return (key) => {
    const lines = metadata?.split(/\r?\n/).filter((line) =>
      new RegExp("^\\s*" + key + "\\s*:").test(line)
    );
    return lines?.length === 1
      ? lines[0].match(new RegExp("^" + key + ": (.+)$"))?.[1]
      : undefined;
  };
}
let indexCache;
function trackedArtifacts() {
  if (indexCache !== undefined) return indexCache;
  try {
    const output = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    indexCache = output.split("\0").filter(Boolean).map((line) => {
      const [header, path] = line.split("\t");
      const [mode, oid, stage] = header.split(" ");
      return [path, { mode, oid, stage }];
    });
  } catch {
    fail("Cannot read Git index for completion artifacts");
    indexCache = null;
  }
  return indexCache;
}
function unchangedArtifacts(path, artifacts) {
  const tracked = trackedArtifacts()?.filter(([name]) =>
    path.endsWith("/") ? name.startsWith(path) : name === path
  );
  if (!tracked || tracked.length !== artifacts.length) return false;
  const expected = new Map(artifacts);
  if (
    !tracked.every(([name, object]) => {
      const approved = expected.get(name);
      return object.stage === "0" && approved?.oid === object.oid &&
        approved.mode === object.mode;
    })
  ) return false;
  // Không nhận file thừa kể cả untracked/ignored; thư mục rỗng không phải Git artifact.
  function files(current) {
    const stat = lstatSync(resolve(repoRoot, current));
    if (!stat.isDirectory()) return [current];
    return readdirSync(resolve(repoRoot, current)).flatMap((name) =>
      files(current.replace(/\/$/, "") + "/" + name)
    );
  }
  try {
    const names = files(path);
    if (!sameSet(names, [...expected.keys()])) return false;
    return names.every((name) => {
      const current = resolve(repoRoot, name);
      const stat = lstatSync(current);
      const object = expected.get(name);
      return stat.isFile() &&
        (stat.mode & 0o111 ? "100755" : "100644") === object.mode &&
        blobId(readFileSync(current)) === object.oid;
    });
  } catch {
    return false;
  }
}
function approved(body, entry, planBody) {
  const field = reportFields(body);
  const id = String(entry.id).padStart(3, "0");
  const validDefinition = definitionApproved(field, entry, planBody);
  if (!validDefinition) {
    fail(entry.file + ": DONE requires approved definition snapshot");
  }
  if (field("review_verdict") !== "APPROVE" || field("plan_id") !== id) {
    return false;
  }
  const reviewed = field("reviewed_commit"),
    completed = field("completed_commit");
  if (![reviewed, completed].every((ref) => /^[0-9a-f]{40}$/.test(ref ?? ""))) {
    return false;
  }
  const reviewTree = gitTree(reviewed), completionTree = gitTree(completed);
  if (!reviewTree || !completionTree) return false;
  const reportPath = "plans/evidence/" + id + ".md";
  for (
    const [tree, key] of [[reviewTree, "reviewed_evidence_blob"], [
      completionTree,
      "completed_evidence_blob",
    ]]
  ) {
    const report = scopedObject(tree, reportPath);
    if (!report || report.oid !== field(key)) return false;
  }
  if (validDefinition) {
    const ref = field("definition_commit");
    const report = scopedObject(gitTree(ref), reportPath);
    const snapshot = report && evidenceSource(reportPath, ref);
    if (snapshot === undefined || !report || blobId(snapshot) !== report.oid) {
      return false;
    }
    const original = reportFields(snapshot);
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
      if (original(key) === undefined || original(key) !== field(key)) {
        return false;
      }
    }
  }
  for (const path of entry.scope) {
    const before = scopedObject(reviewTree, path),
      after = scopedObject(completionTree, path);
    if (
      !before || !after || before.oid !== after.oid ||
      before.mode !== after.mode
    ) return false;
    if (path.startsWith("plans/")) {
      const artifacts = path.endsWith("/")
        ? [...completionTree].filter(([name, object]) =>
          name.startsWith(path) && object.type === "blob"
        )
        : [[path, after]];
      if (!unchangedArtifacts(path, artifacts)) return false;
    }
  }
  return validDefinition;
}
function planFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return planFiles(path);
    return entry.isFile() && /\.(md|json|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const headings = [
  "Trạng thái và mục tiêu",
  "Hiện trạng và chứng cứ",
  "Quy ước cần giữ",
  "Phạm vi và Git",
  "Lệnh xác minh",
  "Các bước",
  "Kiểm thử",
  "Tiêu chí hoàn tất",
  "Điều kiện dừng",
  "Bảo trì",
];
const ids = new Set(manifest.map((entry) => entry.id));
if (manifest.length !== 25 || ids.size !== 25) {
  fail("Cần đúng 25 kế hoạch với ID duy nhất");
}
for (let id = 1; id <= 25; id++) if (!ids.has(id)) fail(`Thiếu ID ${id}`);
const files = readdirSync(planRoot).filter((name) =>
  /^\d{3}-.*\.md$/.test(name)
);
if (files.length !== 25) fail(`Có ${files.length} file kế hoạch thay vì 25`);
const manifestFiles = new Set();
for (const entry of manifest) {
  if (manifestFiles.has(entry.file)) {
    fail("Duplicate manifest file: " + entry.file);
  }
  manifestFiles.add(entry.file);
  const prefix = entry.file.match(/^(\d{3})-[^/\\]+\.md$/)?.[1];
  if (prefix !== String(entry.id).padStart(3, "0")) {
    fail("Manifest file prefix does not match ID: " + entry.file);
  }
}
for (const file of files) {
  if (!manifestFiles.has(file)) {
    fail("Numbered plan file missing from manifest: " + file);
  }
}
for (const file of manifestFiles) {
  if (!files.includes(file)) {
    fail("Manifest file is not a numbered plan file: " + file);
  }
}
const visiting = new Set();
const visited = new Set();
const order = [];
function visit(id) {
  if (visiting.has(id)) {
    fail(`Chu trình phụ thuộc tại ${id}`);
    return;
  }
  if (visited.has(id)) return;
  const entry = manifest.find((item) => item.id === id);
  if (!entry) {
    fail(`Phụ thuộc không tồn tại: ${id}`);
    return;
  }
  visiting.add(id);
  for (const dependency of entry.depends) visit(dependency);
  visiting.delete(id);
  visited.add(id);
  order.push(id);
}
for (const entry of manifest) {
  visit(entry.id);
  const path = resolve(planRoot, entry.file);
  if (!existsSync(path)) {
    fail(`Thiếu ${entry.file}`);
    continue;
  }
  const body = readFileSync(path, "utf8");
  const dependencyFields = [...body.matchAll(/^- Phụ thuộc:\s*(.*)$/gm)];
  const planDependencies = dependencies(dependencyFields[0]?.[1]);
  if (
    dependencyFields.length !== 1 || !planDependencies ||
    !sameSet(planDependencies, entry.depends)
  ) {
    fail(entry.file + ": plan and manifest dependencies differ");
  }
  const scopeSection = body.split("## Phạm vi và Git\n")[1]
    ?.split("Ngoài phạm vi:")[0] ?? "";
  const administrativeFiles = [
    "plans/README.md",
    "plans/evidence/" + String(entry.id).padStart(3, "0") + ".md",
  ];
  const scopeItems = [];
  const bulletStarts = [...scopeSection.matchAll(
    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+[^\n]*$/gm,
  )];
  if (bulletStarts.some(([line]) => !/^- `[^`\n]+`(?:[ \t]|$)/.test(line))) {
    fail(entry.file + ": malformed scope file bullet");
  }
  for (
    const bullet of scopeSection.matchAll(
      /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+[^\n]*(?:\n[ \t]+(?![-*+][ \t]|\d+[.)][ \t])[^\n]*)*/gm,
    )
  ) {
    const item = bullet[0].match(/^- `([^`\n]+)`(\s*\([\s\S]*\))?[ \t]*$/);
    if (!item) {
      fail(entry.file + ": malformed scope file bullet");
    } else if (!administrativeFiles.includes(item[1])) {
      scopeItems.push([item[0], item[1], item[2] ?? ""]);
    }
  }
  const planScope = scopeItems.map((match) => match[1]);
  const planNewFiles = scopeItems.filter((match) =>
    /^\s*\(tạo\s+mới(?:\)|;)/.test(match[2])
  ).map((match) => match[1]);
  for (
    const [label, paths] of [["scope", entry.scope], [
      "newFiles",
      entry.newFiles,
    ]]
  ) {
    for (const scoped of paths) {
      if (!canonicalScopePath(scoped)) {
        fail(
          entry.file + ": invalid repo-relative " + label + " path: " +
            JSON.stringify(scoped),
        );
      }
    }
  }
  if (!sameSet(planScope, entry.scope)) {
    fail(entry.file + ": plan and manifest scope differ");
  }
  if (entry.newFiles.some((file) => !entry.scope.includes(file))) {
    fail(entry.file + ": newFiles contains paths outside scope");
  }
  if (!sameSet(planNewFiles, entry.newFiles)) {
    fail(entry.file + ": plan and manifest new-file classifications differ");
  }
  for (const heading of headings) {
    if (!body.includes(`## ${heading}\n`)) {
      fail(`${entry.file}: thiếu ${heading}`);
    }
  }
  if (!body.match(/Mốc soạn:\s*`([0-9a-f]{7,40})`/)) {
    fail(entry.file + ": missing valid drafting reference");
  }
  const executionStatus = statusOf(body);
  if (!executionStatus) fail(entry.file + ": missing valid execution status");
  const validStale = executionStatus === "STALE" && staleReason(body);
  if (executionStatus === "STALE" && !validStale) {
    fail(entry.file + ": STALE requires one nonempty stale_reason in metadata");
  }
  if (executionStatus === "IN_PROGRESS" || executionStatus === "DONE") {
    for (const dependency of entry.depends) {
      if (statusById.get(dependency) !== "DONE") {
        fail(
          entry.file + ": prerequisite " + String(dependency).padStart(3, "0") +
            " must be DONE",
        );
      }
    }
  }
  if (executionStatus === "DONE") {
    const completion =
      body.split("\n## Tiêu chí hoàn tất\n")[1]?.split(/\n## /)[0] ?? "";
    const items = [
      ...completion.matchAll(/^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+\S/gm),
    ];
    if (!items.length) {
      fail(entry.file + ": DONE requires a completion checklist");
    }
    if (items.some((item) => item[1] === " ")) {
      fail(entry.file + ": DONE has unchecked completion criteria");
    }
    const evidencePath = resolve(
      planRoot,
      "evidence",
      String(entry.id).padStart(3, "0") + ".md",
    );
    if (
      !existsSync(evidencePath) ||
      !approved(readFileSync(evidencePath, "utf8"), entry, body)
    ) {
      fail(entry.file + ": DONE requires reviewer approval evidence");
    }
  }
  const steps = [...body.matchAll(/^### Bước \d+:/gm)].length;
  const checks = [...body.matchAll(/\*\*Kiểm tra:\*\*/g)].length;
  if (steps < 2 || steps !== checks) {
    fail(`${entry.file}: bước/gate không khớp`);
  }
  if (entry.id <= 22 && entry.audit !== String(entry.id)) {
    fail(`${entry.file}: sai ánh xạ audit`);
  }
  if (entry.id > 22 && entry.audit !== `Hướng phát triển ${entry.id - 22}`) {
    fail(`${entry.file}: sai hướng phát triển`);
  }
  if (auditOf(body) !== entry.audit) {
    fail(entry.file + ": plan and manifest audit mappings differ");
  }
  for (const scoped of entry.scope) {
    if (!canonicalScopePath(scoped)) continue;
    const dependencyCreates = (id, seen = new Set()) => {
      if (seen.has(id)) return false;
      seen.add(id);
      const dependency = manifest.find((item) => item.id === id);
      return dependency &&
        (dependency.newFiles.includes(scoped) ||
          dependency.depends.some((next) => dependencyCreates(next, seen)));
    };
    if (
      !entry.newFiles.includes(scoped) &&
      !entry.depends.some((id) => dependencyCreates(id))
    ) {
      if (!scopedObject(gitTree("HEAD"), scoped)) {
        fail(entry.file + ": existing scope is not tracked: " + scoped);
      }
      const current = resolve(repoRoot, scoped);
      if (!existsSync(current)) {
        fail(entry.file + ": existing scope is missing: " + scoped);
      } else {
        const stat = lstatSync(current);
        if (!(scoped.endsWith("/") ? stat.isDirectory() : stat.isFile())) {
          fail(entry.file + ": existing scope type mismatch: " + scoped);
        }
      }
    }
  }
  const blocks = [
    ...body.matchAll(
      /<!-- evidence: ([^\n]+) -->\s*(?:<!-- deno-fmt-ignore -->\s*)?```[^\n]*\n([\s\S]*?)\n```/g,
    ),
  ];
  if (blocks.length !== entry.evidence.length) {
    fail(entry.file + ": evidence excerpt count mismatch");
  }
  for (const [index, evidence] of entry.evidence.entries()) {
    if (!/^[0-9a-f]{40}$/.test(evidence.sourceRef ?? "")) {
      fail(entry.file + ": evidence requires a valid sourceRef");
      continue;
    }
    if (
      !Number.isInteger(evidence.line) || evidence.line < 1 ||
      typeof evidence.code !== "string" || !evidence.code.length
    ) {
      fail(entry.file + ": invalid evidence line or code");
      continue;
    }
    const source = evidenceSource(evidence.path, evidence.sourceRef);
    if (source === undefined) continue;
    if (!exactLines(source, evidence)) {
      fail(
        entry.file + ": historical source mismatch " + evidence.sourceRef +
          ":" + evidence.path + ":" + evidence.line,
      );
    }
    if (executionStatus !== "DONE" && !validStale) {
      const currentPath = resolve(repoRoot, evidence.path);
      if (
        !existsSync(currentPath) ||
        !exactLines(readFileSync(currentPath, "utf8"), evidence)
      ) {
        fail(
          entry.file + ": current source drift " + evidence.path + ":" +
            evidence.line,
        );
      }
    }
    const block = blocks[index];
    const citation = block && body.slice(0, block.index).trimEnd()
      .split(/\r?\n/).at(-1)?.trim();
    if (citation !== `\`${evidence.path}:${evidence.line}\`:`) {
      fail(
        entry.file + ": missing adjacent evidence line citation " +
          evidence.path + ":" + evidence.line,
      );
    }
    if (!block || block[1] !== evidence.path || block[2] !== evidence.code) {
      fail(entry.file + ": excerpt mismatch " + evidence.path);
    }
  }
}
for (const filePath of planFiles(planRoot)) {
  const file = relative(planRoot, filePath);
  const body = readFileSync(filePath, "utf8");
  if (body.includes(String.fromCharCode(0x2014))) {
    fail(file + ": contains U+2014");
  }
  if (file.endsWith(".md")) {
    for (const [, target] of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      const clean = target.split("#")[0];
      if (!clean) continue;
      if (isAbsolute(clean) || /^[a-z]:/i.test(clean) || clean.includes("\\")) {
        fail(file + ": unsafe Markdown link " + target);
        continue;
      }
      const resolved = resolve(dirname(filePath), clean);
      const scoped = relative(repoRoot, resolved);
      // Cho phép ../ trong repo, nhưng không hỏi filesystem về đường dẫn thoát repo.
      if (isAbsolute(scoped) || scoped.split(/[\\/]/)[0] === "..") {
        fail(file + ": unsafe Markdown link " + target);
        continue;
      }
      if (!existsSync(resolved)) {
        fail(file + ": link hỏng " + target);
      }
    }
  }
}

const indexPath = resolve(planRoot, "README.md");
if (!existsSync(indexPath)) fail("Thiếu README.md");
else {
  const index = readFileSync(indexPath, "utf8");
  for (const entry of manifest) {
    if (!index.includes(`](${entry.file})`)) {
      fail(`README thiếu ${entry.file}`);
    }
    const id = String(entry.id).padStart(3, "0");
    const rows = index.split("\n").filter((line) =>
      line.split("|")[1]?.trim() === id
    );
    if (rows.length !== 1) fail("README requires exactly one row for ID " + id);
    const row = rows[0];
    const target = row?.split("|")[2]?.trim().match(/^\[[^\]]+\]\(([^)]+)\)$/)
      ?.[1];
    if (target !== entry.file) fail("README row file does not match ID " + id);
    const rowStatus = row?.match(
      /\|\s*(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)\s*\|$/,
    )?.[1];
    const indexDependencies = dependencies(row?.split("|")[5]);
    if (!indexDependencies || !sameSet(indexDependencies, entry.depends)) {
      fail(entry.file + ": index and manifest dependencies differ");
    }
    const planStatus = statusById.get(entry.id);
    if (!rowStatus || rowStatus !== planStatus) {
      fail(`${entry.file}: index and plan status differ`);
    }
  }
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Đạt: 25 kế hoạch, đủ audit, scope, trích đoạn, links và phụ thuộc không chu trình.`,
  );
  console.log(
    `Thứ tự hợp lệ: ${
      order.map((id) => String(id).padStart(3, "0")).join(", ")
    }`,
  );
}
