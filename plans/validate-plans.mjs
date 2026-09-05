import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
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
const statusOf = (body) =>
  body.match(
    /Trạng thái thực thi:\s*`(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)`/,
  )?.[1];
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
function approved(body) {
  const metadata = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const verdicts = metadata?.split(/\r?\n/).filter((line) =>
    line.startsWith("review_verdict:")
  );
  return verdicts?.length === 1 && verdicts[0] === "review_verdict: APPROVE";
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
  const planScope = [...scopeSection.matchAll(/^- `([^`]+)`/gm)]
    .map((match) => match[1])
    .filter((file) => !administrativeFiles.includes(file));
  if (!sameSet(planScope, entry.scope)) {
    fail(entry.file + ": plan and manifest scope differ");
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
      !existsSync(evidencePath) || !approved(readFileSync(evidencePath, "utf8"))
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
  for (const scoped of entry.scope) {
    const dependencyCreates = (id, seen = new Set()) => {
      if (seen.has(id)) return false;
      seen.add(id);
      const dependency = manifest.find((item) => item.id === id);
      return dependency &&
        (dependency.newFiles.includes(scoped) ||
          dependency.depends.some((next) => dependencyCreates(next, seen)));
    };
    if (
      !existsSync(resolve(repoRoot, scoped)) &&
      !entry.newFiles.includes(scoped) && !entry.depends.some((id) =>
        dependencyCreates(id)
      )
    ) {
      fail(
        `${entry.file}: scope chưa tồn tại và chưa đánh dấu tạo mới: ${scoped}`,
      );
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
    if (!/^[0-9a-f]{7,40}$/.test(evidence.sourceRef ?? "")) {
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
    if (["TODO", "IN_PROGRESS", "BLOCKED"].includes(executionStatus)) {
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
    if (!body.includes(`\`${evidence.path}:${evidence.line}\``)) {
      fail(entry.file + ": missing evidence line citation");
    }
    const block = blocks[index];
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
      if (clean && !existsSync(resolve(dirname(filePath), clean))) {
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
    const row = index.split("\n").find((line) =>
      line.startsWith(`| ${String(entry.id).padStart(3, "0")} `)
    );
    const rowStatus = row?.match(
      /\|\s*(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)\s*\|$/,
    )?.[1];
    const indexDependencies = dependencies(row?.split("|")[5]);
    if (!indexDependencies || !sameSet(indexDependencies, entry.depends)) {
      fail(entry.file + ": index and manifest dependencies differ");
    }
    const planStatus = readFileSync(resolve(planRoot, entry.file), "utf8")
      .match(/Trạng thái thực thi:\s*`(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)`/)
      ?.[1];
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
