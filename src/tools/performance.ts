/**
 * ERPNext Staff Performance Tools
 *
 * Trả lời "đánh giá hiệu suất của [nhân sự]" bằng số liệu ERP đo được, theo đúng quyền xem
 * của người hỏi. Đợt này bọc báo cáo cá nhân `hvg_sdc_sync.personal_report` (khối lượng design
 * và fulfill trên dòng đơn hàng); Task, SKU, doanh số và tăng trưởng chờ endpoint ERP đợt sau và
 * được trả về dưới dạng phần "chưa có", không bao giờ ước lượng.
 *
 * @module lib/erpnext/tools/performance
 */

import { FrappeAPIError } from "../api/frappe-client.ts";
import { requireCallerClient } from "./caller-guard.ts";
import { callHvgWorkspace } from "./hvg-workspace.ts";
import {
  type PersonMatch,
  type ReportPerson,
  resolveReportPerson,
} from "./performance-resolve.ts";
import { siteToday } from "./site-date.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";

// ── Vì sao bọc báo cáo của ERP thay vì tự đếm ─────────────────────────────────
//
// Trang "Báo cáo cá nhân" trên SPA đã có luật riêng cho ba câu hỏi khó: ai được xem ai (mức
// `all` / `team` / `self`), một dòng design kéo dài nhiều ngày thì đếm mấy lần, và điểm design
// tính theo bảng điểm nào. Tự đếm lại từ `/api/resource` là có bản luật thứ hai, lệch với con số
// trưởng nhóm thấy trên SPA. Nên tool chỉ gọi đúng các hàm SPA gọi, bằng token của người hỏi.
//
// Mục đích đã chốt với người dùng ngày 02/11/2026: KÈM CẶP, không chấm điểm. Tool không gộp các
// thước đo thành một điểm, không xếp hạng, và tool nhóm xếp người theo tên chứ không theo điểm.

const REPORT = "hvg_sdc_sync.personal_report";

const EMPLOYEE_TOOL = "erpnext_employee_performance_get";
const TEAM_TOOL = "erpnext_team_performance_get";

/** Trần khoảng ngày của `_range` bên ERP; vượt là ERP ném lỗi tiếng Việt khó đọc. */
export const MAX_PERIOD_DAYS = 93;

/** Độ dài kỳ mặc định khi người hỏi không nói ngày. */
export const DEFAULT_PERIOD_DAYS = 30;

/** Trần của `detail_limit`. Chi tiết là để minh hoạ, tổng mới là số đo. */
const MAX_DETAIL_LIMIT = 50;
const DEFAULT_DETAIL_LIMIT = 10;

/** Số dòng chi tiết tối đa mỗi loại mà ERP trả (`MAX_DETAIL_ROWS`). */
const ERP_DETAIL_CAP = 2000;

const SECTION_KEYS = ["volume", "tasks", "sku", "quality"] as const;
type SectionKey = typeof SECTION_KEYS[number];

const COMPARE_MODES = ["previous_period", "none"] as const;
type CompareMode = typeof COMPARE_MODES[number];

const EMPLOYEE_KEYS = new Set([
  "employee",
  "from_date",
  "to_date",
  "compare",
  "sections",
  "detail_limit",
]);
const TEAM_KEYS = new Set(["from_date", "to_date"]);

const MISSING_APP =
  "Staff performance tools need the 'hvg_sdc_sync' app with its personal_report module " +
  "(the report behind the Personal Report page of the HVG workspace).";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Kiểu dữ liệu ERP ─────────────────────────────────────────────────────────

/** `_totals` của ERP. Bốn số, cùng nghĩa ở mọi chỗ xuất hiện. */
interface Totals {
  design_points: number;
  design_lines: number;
  fulfill_lines: number;
  orders: number;
}

const TOTAL_KEYS: (keyof Totals)[] = [
  "design_points",
  "design_lines",
  "fulfill_lines",
  "orders",
];

interface ReportContext {
  viewer: string;
  scope: string;
  can_view_others?: boolean;
  people?: ReportPerson[];
  sections?: string[];
}

/** Một bản ghi `_record` của ERP. */
interface DetailRecord {
  kind: "design" | "fulfill";
  user?: string;
  sales_order?: string | null;
  row_name?: string | null;
  source_order_id?: string | null;
  teams?: string[];
  item_code?: string | null;
  item_name?: string | null;
  at: string;
  date?: string;
  point?: number;
  seconds?: number;
  vendor?: string | null;
}

interface PersonalReport {
  user: string;
  full_name?: string;
  from_date: string;
  to_date: string;
  sections?: string[];
  summary: Totals;
  by_team?: unknown[];
  by_day?: unknown[];
  design?: DetailRecord[];
  fulfill?: DetailRecord[];
  truncated?: boolean;
}

interface TeamMember extends Totals {
  user: string;
  full_name?: string | null;
  designation?: string | null;
  department?: string | null;
}

interface TeamReport {
  from_date: string;
  to_date: string;
  scope: string;
  summary: Totals;
  members?: TeamMember[];
  by_team?: unknown[];
}

// ── Khoảng ngày ──────────────────────────────────────────────────────────────

/** Kỳ báo cáo đã kiểm, hai đầu đều tính. */
export interface Period {
  from_date: string;
  to_date: string;
  days: number;
}

function toUtc(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDays(iso: string, days: number): string {
  return new Date(toUtc(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

function inclusiveDays(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000) + 1;
}

/**
 * Đọc một ngày `YYYY-MM-DD` có thật, hoặc `undefined` khi bỏ trống.
 *
 * Đi vòng qua `Date.UTC` để bắt ngày không tồn tại: "2026-02-30" khớp mẫu chữ nhưng `Date` âm
 * thầm đẩy nó sang 02/03, và ERP cũng sẽ đọc ra một ngày khác ngày người hỏi nói.
 */
function readDate(
  input: Record<string, unknown>,
  key: string,
  tool: string,
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw new Error(`[${tool}] '${key}' must be a date written as YYYY-MM-DD`);
  }
  if (new Date(toUtc(value)).toISOString().slice(0, 10) !== value) {
    throw new Error(`[${tool}] '${key}' is not a real calendar date: ${value}`);
  }
  return value;
}

/**
 * Kỳ báo cáo từ đầu vào và ngày hôm nay của site.
 *
 * - Không có ngày nào: 30 ngày kết thúc HÔM QUA, để kỳ chỉ gồm ngày đã trọn và so được với kỳ
 *   trước cùng độ dài. Hôm nay mới qua nửa ngày mà so với một ngày trọn là so lệch.
 * - Chỉ có `to_date`: 30 ngày kết thúc ở ngày đó.
 * - Chỉ có `from_date`: từ ngày đó tới hôm nay ("từ đầu tháng tới giờ").
 *
 * Từ chối thay vì sửa giùm: ngày sau hôm nay, kỳ ngược (ERP tự đảo hai đầu, mà kỳ ngược thường là
 * mô hình đọc nhầm ngày người dùng nói), và kỳ dài quá trần của ERP.
 */
export function performancePeriod(
  input: Record<string, unknown>,
  today: string,
  tool: string,
): Period {
  const from = readDate(input, "from_date", tool);
  const to = readDate(input, "to_date", tool);

  let fromDate: string;
  let toDate: string;
  if (from === undefined && to === undefined) {
    toDate = addDays(today, -1);
    fromDate = addDays(toDate, -(DEFAULT_PERIOD_DAYS - 1));
  } else if (from === undefined) {
    toDate = to as string;
    fromDate = addDays(toDate, -(DEFAULT_PERIOD_DAYS - 1));
  } else {
    fromDate = from;
    toDate = to ?? today;
  }

  for (const [key, value] of [["from_date", fromDate], ["to_date", toDate]]) {
    if (value > today) {
      throw new Error(
        `[${tool}] '${key}' ${value} is after the site's today (${today}); ` +
          "there is no work to report for future dates.",
      );
    }
  }
  if (fromDate > toDate) {
    throw new Error(
      `[${tool}] 'from_date' ${fromDate} is after 'to_date' ${toDate}. ` +
        "Check which date the user meant instead of swapping them.",
    );
  }
  const days = inclusiveDays(fromDate, toDate);
  if (days > MAX_PERIOD_DAYS) {
    throw new Error(
      `[${tool}] the period ${fromDate}..${toDate} spans ${days} days, but the ERP report ` +
        `covers at most ${MAX_PERIOD_DAYS} days per call. Split it into shorter periods ` +
        "(for example by month) and report each one.",
    );
  }
  return { from_date: fromDate, to_date: toDate, days };
}

/** Kỳ liền trước, cùng độ dài, kết thúc ngay trước ngày đầu của kỳ đang xem. */
export function previousPeriod(period: Period): Period {
  const toDate = addDays(period.from_date, -1);
  return {
    from_date: addDays(period.from_date, -period.days),
    to_date: toDate,
    days: period.days,
  };
}

// ── Kiểm đầu vào ─────────────────────────────────────────────────────────────

/** Từ chối khoá lạ bằng một câu CỐ ĐỊNH: tên khoá do người gọi đặt, không phản chiếu lại. */
function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: Set<string>,
  tool: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(
        `[${tool}] unknown argument; accepted arguments are: ${
          [...allowed].join(", ")
        }`,
      );
    }
  }
}

function readEmployee(input: Record<string, unknown>): string {
  const value = input.employee;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `[${EMPLOYEE_TOOL}] 'employee' is required: a full name, an ERP email, or "me"`,
    );
  }
  if ([...value].length > 140) {
    throw new Error(
      `[${EMPLOYEE_TOOL}] 'employee' is longer than 140 characters`,
    );
  }
  return value;
}

function readCompare(input: Record<string, unknown>): CompareMode {
  const value = input.compare ?? "previous_period";
  if (!COMPARE_MODES.includes(value as CompareMode)) {
    throw new Error(
      `[${EMPLOYEE_TOOL}] 'compare' must be one of: ${
        COMPARE_MODES.join(", ")
      }`,
    );
  }
  return value as CompareMode;
}

function readSections(input: Record<string, unknown>): Set<SectionKey> {
  const value = input.sections;
  if (value === undefined || value === null) return new Set(SECTION_KEYS);
  if (
    !Array.isArray(value) || value.length === 0 ||
    value.some((entry) => !SECTION_KEYS.includes(entry as SectionKey)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `[${EMPLOYEE_TOOL}] 'sections' must be a non-empty list of distinct values from: ` +
        SECTION_KEYS.join(", "),
    );
  }
  return new Set(value as SectionKey[]);
}

function readDetailLimit(input: Record<string, unknown>): number {
  const value = input.detail_limit ?? DEFAULT_DETAIL_LIMIT;
  if (
    typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
    value > MAX_DETAIL_LIMIT
  ) {
    throw new Error(
      `[${EMPLOYEE_TOOL}] 'detail_limit' must be a whole number from 0 to ${MAX_DETAIL_LIMIT}`,
    );
  }
  return value;
}

// ── Gọi ERP ──────────────────────────────────────────────────────────────────

function callReport<T>(
  ctx: ErpNextToolContext,
  fn: string,
  args: Record<string, unknown>,
  tool: string,
): Promise<T> {
  // POST cho mọi hàm, kể cả hàm chỉ đọc: GET đưa email người được xem và khoảng ngày lên URL,
  // tức vào log truy cập của proxy, mà "ai đang bị xem hiệu suất" là thông tin nhân sự.
  return callHvgWorkspace<T>(
    ctx,
    `${REPORT}.${fn}`,
    args,
    tool,
    MISSING_APP,
    { httpMethod: "POST" },
  );
}

function isPermissionError(error: unknown): boolean {
  if (!(error instanceof FrappeAPIError)) return false;
  const body = error.body;
  return typeof body === "object" && body !== null &&
    (body as Record<string, unknown>).exc_type === "PermissionError";
}

// ── Dựng kết quả ─────────────────────────────────────────────────────────────

function readTotals(value: unknown): Totals {
  const source =
    (typeof value === "object" && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
  const totals = {} as Totals;
  for (const key of TOTAL_KEYS) {
    const number = source[key];
    totals[key] = typeof number === "number" && Number.isFinite(number)
      ? number
      : 0;
  }
  return totals;
}

function totalsChange(current: Totals, previous: Totals): Totals {
  const change = {} as Totals;
  for (const key of TOTAL_KEYS) {
    // Làm tròn để điểm lẻ (0.1 + 0.2) không thành 0.30000000000000004 trong câu trả lời.
    change[key] = Math.round((current[key] - previous[key]) * 1000) / 1000;
  }
  return change;
}

/**
 * Các dòng gần nhất của cả hai loại, mới nhất trước, đã bỏ trường thừa.
 *
 * Bỏ `user` (chính là người được xem) và `row_name` (mã nội bộ của dòng con, không giúp người
 * đọc); giữ mỗi loại đúng trường có nghĩa với nó: điểm và thời gian cho design, xưởng cho
 * fulfill.
 */
function recentRecords(report: PersonalReport, limit: number): unknown[] {
  if (limit === 0) return [];
  const merged = [...(report.design ?? []), ...(report.fulfill ?? [])];
  merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return merged.slice(0, limit).map((record) => {
    const base = {
      kind: record.kind,
      at: record.at,
      date: record.date,
      sales_order: record.sales_order,
      source_order_id: record.source_order_id,
      teams: record.teams,
      item_code: record.item_code,
      item_name: record.item_name,
    };
    return record.kind === "design"
      ? { ...base, point: record.point, seconds: record.seconds }
      : { ...base, vendor: record.vendor };
  });
}

const NOT_MEASURED_WARNING =
  "Task workload, SKU sales and SKU growth are not measured in this release: the ERP " +
  "endpoint for them is not available yet. Say so plainly; do not estimate them from the " +
  "volume figures or from other tools.";

const COACHING_RULE =
  "Coaching view, not an evaluation score: present each measure on its own. Do not combine " +
  "measures into a score or a grade, do not produce a ranking, and do not compare people " +
  "against each other.";

const VOLUME_RULE =
  "volume counts work on Sales Order lines: design_points uses ERP's design point rules, " +
  "design_lines and fulfill_lines count distinct order lines (a line worked over several days " +
  "counts once), orders counts distinct Sales Orders. These measure throughput, not quality.";

function unavailableSection(note: string) {
  return { status: "unavailable", reason: "erp_endpoint_missing", note };
}

const UNAVAILABLE_SECTIONS: Record<Exclude<SectionKey, "volume">, string> = {
  tasks:
    "Per-person Task workload (assigned, completed, overdue, time spent), keyed by each " +
    "task's SKU metadata, needs an ERP endpoint that is not available yet.",
  sku:
    "Which SKUs this person worked on, how many of them sold in the period and how many grew " +
    "against the previous period needs an ERP endpoint that is not available yet.",
  quality:
    "Quality signals (rework, returns, review outcomes) are not measured yet.",
};

function scopeWarning(scope: string): string {
  return `Your report scope is '${scope}': ERP counts other people's work only on orders ` +
    "within your own order scope. Work on orders outside it is not visible here, so a zero " +
    "or a low number may mean not visible rather than not done.";
}

// ── Tool cá nhân ─────────────────────────────────────────────────────────────

async function getEmployeePerformance(
  input: Record<string, unknown>,
  ctx: ErpNextToolContext,
): Promise<unknown> {
  requireCallerClient(ctx, EMPLOYEE_TOOL);
  rejectUnknownKeys(input, EMPLOYEE_KEYS, EMPLOYEE_TOOL);
  const employee = readEmployee(input);
  const compare = readCompare(input);
  const sections = readSections(input);
  const detailLimit = readDetailLimit(input);

  const period = performancePeriod(input, await siteToday(ctx), EMPLOYEE_TOOL);
  const previous = compare === "previous_period"
    ? previousPeriod(period)
    : null;

  const context = await callReport<ReportContext>(
    ctx,
    "get_report_context",
    {},
    EMPLOYEE_TOOL,
  );
  const resolved = resolveReportPerson({
    input: employee,
    viewer: context.viewer,
    people: context.people ?? [],
    tool: EMPLOYEE_TOOL,
    inputPath: "employee",
  });
  const person = resolved.person;
  const isSelf = person.user === context.viewer;

  // Hai kỳ gọi song song. Luôn gửi đủ hai ngày: ERP thiếu `from_date` thì lấy HÔM NAY, thiếu
  // `to_date` thì lấy đúng ngày bắt đầu, tức một lượt gọi thiếu ngày âm thầm thành báo cáo một
  // ngày. Quyền bị từ chối ở một kỳ làm hỏng cả lượt: đó là câu trả lời cho cả câu hỏi.
  let current: PersonalReport | null = null;
  let before: PersonalReport | null = null;
  if (sections.has("volume")) {
    const fetch = (range: Period) =>
      callReport<PersonalReport>(
        ctx,
        "get_personal_report",
        {
          user: person.user,
          from_date: range.from_date,
          to_date: range.to_date,
        },
        EMPLOYEE_TOOL,
      );
    [current, before] = await Promise.all([
      fetch(period),
      previous ? fetch(previous) : Promise.resolve(null),
    ]);
  }

  const filtered = context.scope !== "all" && !isSelf;
  const warnings: string[] = [];
  const rules = [COACHING_RULE];

  const output: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    if (!sections.has(key)) continue;
    if (key !== "volume") {
      output[key] = unavailableSection(UNAVAILABLE_SECTIONS[key]);
      continue;
    }
    const report = current as PersonalReport;
    const summary = readTotals(report.summary);
    const volume: Record<string, unknown> = {
      status: "ok",
      source: `${REPORT}.get_personal_report`,
      visibility: { filtered_to_viewer_order_scope: filtered },
      summary,
    };
    if (before) {
      const previousSummary = readTotals(before.summary);
      volume.previous = previousSummary;
      volume.change = totalsChange(summary, previousSummary);
    }
    volume.by_team = report.by_team ?? [];
    volume.by_day = report.by_day ?? [];
    volume.recent = recentRecords(report, detailLimit);
    volume.truncated = report.truncated === true;
    output.volume = volume;

    rules.push(VOLUME_RULE);
    if (before) {
      rules.push(
        "change is the current period minus the previous period of equal length, for the " +
          "same person and the same viewer scope.",
      );
    }
    if (filtered) warnings.push(scopeWarning(context.scope));
    if (report.truncated === true) {
      warnings.push(
        `ERP returns at most ${ERP_DETAIL_CAP} detail rows per kind. Totals, by_team and ` +
          `by_day are complete; only the rows behind 'recent' were cut.`,
      );
    }
    if (summary.design_lines === 0 && summary.fulfill_lines === 0) {
      warnings.push(
        "No design or fulfill lines in this period. This report only counts design and " +
          "fulfill work on order lines, so for a role that does neither (sales, accounting, " +
          "...) a zero says nothing about their workload.",
      );
    }
  }
  warnings.push(NOT_MEASURED_WARNING);

  return {
    contract_version: 1,
    subject: {
      user: person.user,
      full_name: person.full_name ?? null,
      designation: person.designation ?? null,
      department: person.department ?? null,
      match: resolved.match satisfies PersonMatch,
      report_sections: current?.sections ?? null,
    },
    viewer: { user: context.viewer, scope: context.scope, is_self: isSelf },
    period: {
      from_date: period.from_date,
      to_date: period.to_date,
      days: period.days,
      date_basis: "site_timezone",
      compare: previous
        ? {
          mode: "previous_period",
          from_date: previous.from_date,
          to_date: previous.to_date,
        }
        : { mode: "none" },
    },
    sections: output,
    data_quality: { rules, warnings },
  };
}

// ── Tool nhóm ────────────────────────────────────────────────────────────────

function memberName(member: TeamMember): string {
  return member.full_name || member.user;
}

async function getTeamPerformance(
  input: Record<string, unknown>,
  ctx: ErpNextToolContext,
): Promise<unknown> {
  requireCallerClient(ctx, TEAM_TOOL);
  rejectUnknownKeys(input, TEAM_KEYS, TEAM_TOOL);
  const period = performancePeriod(input, await siteToday(ctx), TEAM_TOOL);

  let report: TeamReport;
  try {
    report = await callReport<TeamReport>(
      ctx,
      "get_team_report",
      { from_date: period.from_date, to_date: period.to_date },
      TEAM_TOOL,
    );
  } catch (error) {
    // Hàm này chỉ tự ném PermissionError cho người có mức xem `self`. Câu tiếng Việt của ERP
    // không nói phải làm gì tiếp, nên đổi thành hướng dẫn cụ thể và giữ lỗi gốc ở `cause`.
    if (isPermissionError(error)) {
      throw new Error(
        `[${TEAM_TOOL}] your ERP report scope covers only yourself, so there is no team ` +
          `report to show. Use ${EMPLOYEE_TOOL} with employee "me" for your own figures.`,
        { cause: error },
      );
    }
    throw error;
  }

  // ERP xếp thành viên theo điểm design giảm dần, tức một bảng xếp hạng. Tool kèm cặp không
  // xếp hạng, nên xếp lại theo tên.
  const members = [...(report.members ?? [])]
    .sort((a, b) =>
      memberName(a).localeCompare(memberName(b), "vi") ||
      (a.user < b.user ? -1 : a.user > b.user ? 1 : 0)
    )
    .map((member) => ({
      user: member.user,
      full_name: member.full_name ?? null,
      designation: member.designation ?? null,
      department: member.department ?? null,
      ...readTotals(member),
    }));

  const warnings: string[] = [];
  if (report.scope !== "all") warnings.push(scopeWarning(report.scope));
  warnings.push(NOT_MEASURED_WARNING);

  return {
    contract_version: 1,
    viewer: { scope: report.scope },
    period: {
      from_date: period.from_date,
      to_date: period.to_date,
      days: period.days,
      date_basis: "site_timezone",
    },
    summary: readTotals(report.summary),
    members,
    by_team: report.by_team ?? [],
    data_quality: {
      rules: [
        COACHING_RULE,
        VOLUME_RULE,
        "members lists only people with at least one design or fulfill line in the period, " +
        "ordered by name. Someone missing from it did no counted work here, which is not the " +
        "same as doing no work.",
      ],
      warnings,
    },
  };
}

// ── Khai báo tool ────────────────────────────────────────────────────────────

const DATE_FIELDS = {
  from_date: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description:
      "First day of the period (YYYY-MM-DD, site time zone). Alone, the period runs to today.",
  },
  to_date: {
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    description:
      "Last day of the period, inclusive (YYYY-MM-DD). Alone, the period is the 30 days ending " +
      "on it. With neither date, the period is the 30 days ending yesterday.",
  },
};

export const performanceTools: ErpNextTool[] = [
  {
    name: EMPLOYEE_TOOL,
    description:
      "Staff performance review for one person, for questions like 'đánh giá hiệu suất của " +
      "[name]' or 'how is [name] doing this month'. Resolves the person by full name (with or " +
      "without Vietnamese marks), ERP email, or 'me', only among the people the caller may " +
      "view in the ERP Personal Report; namesakes or near matches come back as a list to ask " +
      "the user about, never a guess. Returns measured work volume on order lines (design " +
      "points, design and fulfill lines, orders) for the period and the previous period of " +
      "equal length, broken down by team and by day, plus the most recent lines. Task " +
      "workload, SKU sales, SKU growth and quality are returned as 'unavailable' in this " +
      "release. Coaching use: present each measure on its own, never as a score or a " +
      "ranking, and relay data_quality.warnings. Runs with the caller's own ERP permissions " +
      "(a team lead sees a team member's work only on their team's orders). Max " +
      `${MAX_PERIOD_DAYS} days per call.`,
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          minLength: 1,
          maxLength: 140,
          description:
            "Who to review: full name as the user wrote it, ERP email (login id), or 'me'. " +
            "After an ambiguity error, pass the email the user picked.",
        },
        ...DATE_FIELDS,
        compare: {
          type: "string",
          enum: [...COMPARE_MODES],
          default: "previous_period",
          description:
            "previous_period also fetches the equal-length period right before and returns " +
            "the change; none skips it.",
        },
        sections: {
          type: "array",
          items: { type: "string", enum: [...SECTION_KEYS] },
          minItems: 1,
          uniqueItems: true,
          description: "Which sections to return. Default: all.",
        },
        detail_limit: {
          type: "integer",
          minimum: 0,
          maximum: MAX_DETAIL_LIMIT,
          default: DEFAULT_DETAIL_LIMIT,
          description:
            "How many of the most recent lines to include in volume.recent.",
        },
      },
      required: ["employee"],
      additionalProperties: false,
    },
    annotations: {
      title: "Staff performance review",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getEmployeePerformance,
  },
  {
    name: TEAM_TOOL,
    description:
      "Work volume for everyone the caller may view in the ERP Personal Report (team leads, " +
      "accounting, IT, management), per person and per team, for one period: design points, " +
      "design and fulfill lines, orders. Members are listed by name, not ranked; only people " +
      "with counted work appear. Not available to people whose report scope is themselves " +
      `only; use ${EMPLOYEE_TOOL} with 'me' for that. Use ${EMPLOYEE_TOOL} for one person's ` +
      `review with the previous-period comparison. Max ${MAX_PERIOD_DAYS} days per call.`,
    category: "analytics",
    inputSchema: {
      type: "object",
      properties: { ...DATE_FIELDS },
      additionalProperties: false,
    },
    annotations: {
      title: "Team work volume",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: getTeamPerformance,
  },
];
