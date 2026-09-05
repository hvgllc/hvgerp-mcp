import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const planRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(planRoot, "..");
const manifest = JSON.parse(
  readFileSync(resolve(planRoot, "manifest.json"), "utf8"),
);
const failures = [];
const fail = (message) => failures.push(message);
const normalized = (value) => value.replace(/\s+/g, "");
function evidenceSource(sourcePath, historicalRef) {
  return historicalRef
    ? execFileSync("git", ["show", `${historicalRef}:${sourcePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
    })
    : readFileSync(resolve(repoRoot, sourcePath), "utf8");
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
  for (const heading of headings) {
    if (!body.includes(`## ${heading}\n`)) {
      fail(`${entry.file}: thiếu ${heading}`);
    }
  }
  if (!body.includes("`d2c5305`")) fail(`${entry.file}: thiếu SHA`);
  const executionStatus = body.match(
    /Trạng thái thực thi:\s*`(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)`/,
  )?.[1];
  if (!executionStatus) fail(`${entry.file}: missing valid execution status`);
  const historicalRef = executionStatus === "DONE"
    ? body.match(/Mốc soạn:\s*`([0-9a-f]{7,40})`/)?.[1]
    : undefined;
  if (executionStatus === "DONE" && !historicalRef) {
    fail(`${entry.file}: DONE requires a valid historical source reference`);
    continue;
  }
  if (executionStatus === "DONE") {
    const evidencePath = resolve(
      planRoot,
      "evidence",
      `${String(entry.id).padStart(3, "0")}.md`,
    );
    if (
      !existsSync(evidencePath) ||
      !readFileSync(evidencePath, "utf8").includes("APPROVE")
    ) {
      fail(`${entry.file}: DONE requires reviewer approval evidence`);
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
      /<!-- evidence: ([^\n]+) -->\s*```[^\n]*\n([\s\S]*?)\n```/g,
    ),
  ];
  for (const evidence of entry.evidence) {
    const source = evidenceSource(evidence.path, historicalRef);
    const suffix = source.split("\n").slice(evidence.line - 1).join("\n");
    if (!normalized(suffix).startsWith(normalized(evidence.code))) {
      fail(`${entry.file}: sai dòng ${evidence.path}:${evidence.line}`);
    }
    if (!body.includes(`\`${evidence.path}:${evidence.line}\``)) {
      fail(`${entry.file}: thiếu tham chiếu dòng chứng cứ`);
    }
  }
  if (blocks.length !== entry.evidence.length) {
    fail(`${entry.file}: số trích đoạn không khớp`);
  }
  for (const [, sourcePath, code] of blocks) {
    if (!existsSync(resolve(repoRoot, sourcePath))) {
      fail(`Thiếu nguồn ${sourcePath}`);
      continue;
    }
    const source = evidenceSource(sourcePath, historicalRef);
    if (!normalized(source).includes(normalized(code))) {
      fail(`${entry.file}: trích đoạn không khớp ${sourcePath}`);
    }
  }
}
for (
  const file of readdirSync(planRoot).filter((name) =>
    /\.(md|json|mjs)$/.test(name)
  )
) {
  const body = readFileSync(resolve(planRoot, file), "utf8");
  if (body.includes(String.fromCharCode(0x2014))) fail(`${file}: chứa U+2014`);
  if (file.endsWith(".md")) {
    for (const [, target] of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      const clean = target.split("#")[0];
      if (clean && !existsSync(resolve(planRoot, clean))) {
        fail(`${file}: link hỏng ${target}`);
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
