/**
 * Hợp đồng v2 giữa MCP và ERP cho hiệu suất cá nhân (`hvg_sdc_sync.person_performance`).
 *
 * Hai lớp kiểm, chạy theo thứ tự:
 * 1. JSON Schema trong `contract/person-performance.v2.json` (file ERP chép nguyên văn và kiểm bằng
 *    Python `jsonschema`, nên hai bên cùng một nguồn hình dạng).
 * 2. Các bất biến đếm mà schema không diễn đạt được: tổng phải cộng đúng, cặp trường cùng null,
 *    luật xu hướng E1, mốc `first_evaluable_to`. Danh sách đầy đủ ở `docs/staff-performance-contract.md`.
 *
 * Lớp 2 chỉ chạy khi lớp 1 sạch, vì nó dựa vào kiểu đã được schema bảo đảm. Thông báo lỗi chỉ gồm
 * đường dẫn và tên luật, không bao giờ chứa giá trị: tiêu đề việc và mã SKU là văn bản người dùng nhập.
 *
 * @module lib/erpnext/src/tools/person-performance-contract
 */

import { validateJsonSchema } from "../events/json-schema.ts";
import contract from "./contract/person-performance.v2.json" with {
  type: "json",
};

/** Phiên bản hợp đồng mà server này hiểu; ERP từ chối phiên bản khác bằng ValidationError. */
export const PERSON_PERFORMANCE_CONTRACT_VERSION = 2;

/** Độ dài kỳ tối đa (ngày, tính cả hai đầu) mà hai bên chấp nhận. */
export const MAX_PERIOD_DAYS = 93;

export type Trend =
  | "new"
  | "growing"
  | "stable"
  | "declining"
  | "low_sample"
  | "stopped";

export type CompletionSource =
  | "completed_on"
  | "born_completed"
  | "version"
  | "status_only";

export interface TaskRow {
  task: string;
  subject: string | null;
  title_redacted: boolean;
  project: string | null;
  project_name: string | null;
  status: string;
  role: "assignee_open" | "assignee_closed" | "owner_unassigned";
  created_on: string;
  completed_on: string | null;
  completion_source: CompletionSource | null;
  exp_end_date: string | null;
  sku: string | null;
  sku_status: "ok" | "missing_sku" | "invalid_sku" | "not_applicable";
}

export interface TasksSummary {
  assigned: number;
  completed: number;
  open: number;
  cancelled: number;
  owner_unassigned: number;
  with_sku: number;
  missing_sku: number;
  invalid_sku: number;
  title_redacted: number;
  completion_sources: Record<CompletionSource, number>;
}

export interface TasksSection {
  status: "ok";
  summary: TasksSummary;
  rows: TaskRow[];
  next_cursor: string | null;
}

export interface SalesVisibility {
  /** QĐ-8 phương án C: đếm mọi đơn đã submit, nên mọi người xem đều thấy cùng một con số. */
  mode: "all_orders";
  partial: false;
}

export interface SkuRow {
  sku: string;
  sales_status: "sold" | "no_sales" | "unmatched_code";
  task_count: number;
  people_sharing: number;
  first_completed_on: string | null;
  item_exists: boolean;
  item_names: string[];
  match_mode: "exact" | "prefix" | null;
  first_sold_on: string | null;
  sold_before_first_completion: boolean | null;
  qty: number;
  orders: number;
  previous_qty: number | null;
  previous_orders: number | null;
  trend: Trend | null;
}

export interface SkuSummary {
  skus: number;
  skus_with_item: number;
  skus_sold: number;
  skus_unmatched: number;
  skus_ambiguous: number;
  skus_shared: number;
  qty: number;
  orders: number;
  previous_qty: number | null;
  previous_orders: number | null;
  revenue: Array<
    { currency: string; amount: number; previous_amount: number | null }
  >;
  revenue_basis: string;
}

export type GrowthStatus =
  | "ok"
  | "insufficient_baseline"
  | "not_requested"
  | "no_sales";

export interface SkuSection {
  status: "ok";
  scope: "completed_in_period" | "portfolio";
  metric: "qty";
  sales_visibility: SalesVisibility;
  data_coverage: {
    order_kpi_since: string;
    sale_date_field: "transaction_date";
    channels: Array<{ channel: string; history_floor: string | null }>;
  };
  summary: SkuSummary;
  growth: {
    status: GrowthStatus;
    trend: Trend | null;
    first_evaluable_to: string;
  };
  rows: SkuRow[];
  next_cursor: string | null;
}

export type SignalId =
  | "on_time_completion"
  | "reopened_by_other"
  | "returned_from_review";

export interface QualitySignal {
  id: SignalId;
  status: "ok" | "insufficient_sample" | "not_measured";
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  reason: string | null;
  basis: Record<string, number>;
}

export interface QualitySection {
  status: "ok";
  signals: QualitySignal[];
}

export interface SummaryResponse {
  contract_version: 2;
  user: string;
  from_date: string;
  to_date: string;
  volume_applies: boolean;
  compare: { from_date: string | null; to_date: string | null };
  sections: {
    tasks?: TasksSection;
    sku?: SkuSection;
    quality?: QualitySection;
  };
  rules: Array<{ id: string; text: string }>;
}

export interface RowsResponse {
  contract_version: 2;
  user: string;
  from_date: string;
  to_date: string;
  section: "tasks" | "sku";
  rows: TaskRow[] | SkuRow[];
  next_cursor: string | null;
  sales_visibility?: SalesVisibility;
}

const SUMMARY_SCHEMA = { $ref: "#/$defs/summary_response" };
const ROWS_SCHEMA = { $ref: "#/$defs/rows_response" };
const DAY_MS = 86_400_000;

/** Số ngày kể từ epoch của một ngày `YYYY-MM-DD` (schema đã bảo đảm đây là ngày có thật). */
function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function dateFromDayNumber(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/** Số ngày của kỳ, tính cả ngày đầu và ngày cuối. */
export function periodDays(fromDate: string, toDate: string): number {
  return dayNumber(toDate) - dayNumber(fromDate) + 1;
}

/**
 * Ngày kết thúc sớm nhất của một kỳ dài `days` ngày mà kỳ so sánh liền trước nằm trọn sau
 * `order_kpi_since`: kỳ so sánh bắt đầu ở `to - (2·days - 1)`, nên `to = since + 2·days - 1`.
 */
export function firstEvaluableTo(orderKpiSince: string, days: number): string {
  return dateFromDayNumber(dayNumber(orderKpiSince) + 2 * days - 1);
}

/**
 * Luật xu hướng E1 (QĐ-3) cho một cặp số lượng kỳ này và kỳ trước, xét theo thứ tự.
 *
 * Ngưỡng tỉ lệ so bằng số nguyên (`cur·5 >= prev·6` thay cho `cur >= 1.2·prev`) để Python và
 * TypeScript cho cùng kết quả, không lệch vì làm tròn số thực. Trả `null` khi cả hai kỳ đều bằng 0:
 * không có gì để so.
 */
export function trendFor(current: number, previous: number): Trend | null {
  if (current === 0) return previous > 0 ? "stopped" : null;
  if (previous === 0) return current >= 3 ? "new" : "low_sample";
  if (current >= 5 && current - previous >= 3 && current * 5 >= previous * 6) {
    return "growing";
  }
  if (
    previous >= 5 && previous - current >= 3 && current * 5 <= previous * 4
  ) {
    return "declining";
  }
  return "stable";
}

/** `true` khi đúng một trong hai giá trị là `null`: cặp trường lẽ ra phải cùng có hoặc cùng vắng. */
function nullMismatch(left: unknown, right: unknown): boolean {
  return (left === null) !== (right === null);
}

function checkPeriod(
  fromDate: string,
  toDate: string,
  errors: string[],
): number {
  const days = periodDays(fromDate, toDate);
  if (days < 1) errors.push(": to_date is before from_date");
  if (days > MAX_PERIOD_DAYS) {
    errors.push(`: period longer than ${MAX_PERIOD_DAYS} days`);
  }
  return days;
}

function checkTaskRow(row: TaskRow, path: string, errors: string[]): void {
  // `status_only` là việc đã xong mà không biết lúc nào xong: có nguồn hoàn tất nhưng không có ngày.
  // Vì vậy "đã xong hay chưa" đọc từ `completion_source`, không đọc từ việc có ngày hay không.
  const completed = row.completion_source !== null;
  const momentKnown = completed && row.completion_source !== "status_only";
  if ((row.completed_on !== null) !== momentKnown) {
    errors.push(
      `${path}: completed_on must be null exactly when completion_source is null or status_only`,
    );
  }
  if ((row.sku_status === "not_applicable") === completed) {
    errors.push(
      `${path}: sku_status must be not_applicable exactly when completion_source is null`,
    );
  }
  if ((row.sku_status === "ok") !== (row.sku !== null)) {
    errors.push(`${path}: sku must be set exactly when sku_status is ok`);
  }
  if (row.title_redacted && row.subject !== null) {
    errors.push(`${path}: a redacted title must have a null subject`);
  }
  if (!row.title_redacted && row.subject === null) {
    errors.push(`${path}: subject must be set unless the title is redacted`);
  }
}

function checkTasksSection(
  section: TasksSection,
  path: string,
  errors: string[],
): void {
  const summary = section.summary;
  const summaryPath = `${path}/summary`;
  if (
    summary.assigned !== summary.completed + summary.open + summary.cancelled
  ) {
    errors.push(
      `${summaryPath}: assigned != completed + open + cancelled`,
    );
  }
  if (
    summary.with_sku + summary.missing_sku + summary.invalid_sku !==
      summary.completed
  ) {
    errors.push(
      `${summaryPath}: with_sku + missing_sku + invalid_sku != completed`,
    );
  }
  const sources = Object.values(summary.completion_sources).reduce(
    (total, count) => total + count,
    0,
  );
  if (sources !== summary.completed) {
    errors.push(
      `${summaryPath}: completion_sources do not add up to completed`,
    );
  }
  if (summary.owner_unassigned > summary.assigned) {
    errors.push(`${summaryPath}: owner_unassigned > assigned`);
  }
  if (summary.title_redacted > summary.assigned) {
    errors.push(`${summaryPath}: title_redacted > assigned`);
  }
  const rows = section.rows;
  // Trang đầu chỉ là một phần; khi không còn trang sau thì các dòng phải khớp đúng tổng.
  const complete = section.next_cursor === null;
  const counts: Array<[string, number, number]> = [
    ["rows", rows.length, summary.assigned],
    [
      "owner_unassigned rows",
      rows.filter((row) => row.role === "owner_unassigned").length,
      summary.owner_unassigned,
    ],
    [
      "title_redacted rows",
      rows.filter((row) => row.title_redacted).length,
      summary.title_redacted,
    ],
  ];
  checkRowCounts(counts, complete, path, errors);
  rows.forEach((row, index) =>
    checkTaskRow(row, `${path}/rows/${index}`, errors)
  );
}

/** So số dòng mỗi loại với tổng của section: không vượt khi còn trang sau, bằng đúng khi đã đủ. */
function checkRowCounts(
  counts: Array<[string, number, number]>,
  complete: boolean,
  path: string,
  errors: string[],
): void {
  for (const [label, shown, total] of counts) {
    if (shown > total) {
      errors.push(`${path}: more ${label} than the summary counts`);
    } else if (complete && shown !== total) {
      errors.push(
        `${path}: ${label} do not match the summary on the last page`,
      );
    }
  }
}

/** Luật của một dòng SKU không phụ thuộc vào section chứa nó (dùng cho cả tóm tắt lẫn trang chi tiết). */
function checkSkuRowShape(row: SkuRow, path: string, errors: string[]): void {
  if ((row.sales_status === "sold") !== (row.qty > 0)) {
    errors.push(`${path}: sales_status sold must match qty > 0`);
  }
  if ((row.qty > 0) !== (row.orders > 0)) {
    errors.push(`${path}: qty and orders must be both zero or both positive`);
  }
  if (nullMismatch(row.previous_qty, row.previous_orders)) {
    errors.push(
      `${path}: previous_qty and previous_orders must be both set or both null`,
    );
  } else if (
    row.previous_qty !== null &&
    (row.previous_qty > 0) !== ((row.previous_orders ?? 0) > 0)
  ) {
    errors.push(
      `${path}: previous_qty and previous_orders must be both zero or both positive`,
    );
  }
  if (row.sales_status === "sold" && row.match_mode === null) {
    errors.push(`${path}: a sold SKU must have a match_mode`);
  }
  if (row.sales_status === "unmatched_code") {
    if (row.match_mode !== null) {
      errors.push(`${path}: unmatched_code must have a null match_mode`);
    }
    if ((row.previous_qty ?? 0) > 0 || row.first_sold_on !== null) {
      errors.push(`${path}: unmatched_code must have no sales at all`);
    }
  }
  if (!row.item_exists && row.item_names.length > 0) {
    errors.push(`${path}: item_names must be empty when item_exists is false`);
  }
  if (row.item_exists && row.item_names.length === 0) {
    errors.push(
      `${path}: item_names must not be empty when item_exists is true`,
    );
  }
  const soldBefore = row.first_sold_on === null ||
      row.first_completed_on === null
    ? null
    : dayNumber(row.first_sold_on) < dayNumber(row.first_completed_on);
  if (row.sold_before_first_completion !== soldBefore) {
    errors.push(
      `${path}: sold_before_first_completion does not follow first_sold_on and first_completed_on`,
    );
  }
}

/**
 * Xu hướng của một dòng. `growthStatus` là trạng thái tăng trưởng của section, hoặc `undefined` khi
 * dòng đến từ trang chi tiết (trang không mang trạng thái đó, nên chỉ kiểm được khi trend khác null).
 */
function checkSkuRowTrend(
  row: SkuRow,
  growthStatus: GrowthStatus | undefined,
  path: string,
  errors: string[],
): void {
  const notEvaluable = growthStatus === "not_requested" ||
    growthStatus === "insufficient_baseline" || row.previous_qty === null;
  if (notEvaluable) {
    if (row.trend !== null) {
      errors.push(`${path}: trend must be null when growth is not evaluable`);
    }
    return;
  }
  if (growthStatus === undefined && row.trend === null) return;
  if (row.trend !== trendFor(row.qty, row.previous_qty ?? 0)) {
    errors.push(`${path}: trend does not follow the growth rule`);
  }
}

function checkSkuSection(
  section: SkuSection,
  response: SummaryResponse,
  path: string,
  errors: string[],
): void {
  const summary = section.summary;
  const summaryPath = `${path}/summary`;
  const compareRequested = response.compare.from_date !== null;
  for (
    const name of [
      "skus_with_item",
      "skus_sold",
      "skus_unmatched",
      "skus_shared",
    ] as const
  ) {
    if (summary[name] > summary.skus) {
      errors.push(`${summaryPath}: ${name} > skus`);
    }
  }
  if (summary.skus_sold + summary.skus_unmatched > summary.skus) {
    errors.push(`${summaryPath}: skus_sold + skus_unmatched > skus`);
  }
  if (summary.skus_ambiguous > summary.skus_with_item) {
    errors.push(`${summaryPath}: skus_ambiguous > skus_with_item`);
  }
  if ((summary.skus_sold > 0) !== (summary.qty > 0)) {
    errors.push(
      `${summaryPath}: skus_sold and qty must be both zero or both positive`,
    );
  }
  if ((summary.qty > 0) !== (summary.orders > 0)) {
    errors.push(
      `${summaryPath}: qty and orders must be both zero or both positive`,
    );
  }
  if (
    (summary.previous_qty === null) === compareRequested ||
    (summary.previous_orders === null) === compareRequested
  ) {
    errors.push(
      `${summaryPath}: previous_qty and previous_orders must be null exactly when compare is null`,
    );
  }
  if (
    summary.revenue.some((line) =>
      (line.previous_amount === null) === compareRequested
    )
  ) {
    errors.push(
      `${summaryPath}: revenue previous_amount must be null exactly when compare is null`,
    );
  }
  const currencies = summary.revenue.map((line) => line.currency);
  if (new Set(currencies).size !== currencies.length) {
    errors.push(`${summaryPath}: duplicate revenue currency`);
  }

  const growth = section.growth;
  const growthPath = `${path}/growth`;
  if ((growth.status === "not_requested") === compareRequested) {
    errors.push(
      `${growthPath}: not_requested must match a null compare window`,
    );
  }
  if (growth.status === "no_sales" && summary.qty !== 0) {
    errors.push(`${growthPath}: no_sales needs qty 0`);
  }
  if (growth.status === "ok") {
    if (
      summary.qty === 0 ||
      growth.trend !== trendFor(summary.qty, summary.previous_qty ?? 0)
    ) {
      errors.push(`${growthPath}: trend does not follow the growth rule`);
    }
  }
  const days = periodDays(response.from_date, response.to_date);
  const expectedFirst = firstEvaluableTo(
    section.data_coverage.order_kpi_since,
    days,
  );
  if (growth.first_evaluable_to !== expectedFirst) {
    errors.push(
      `${growthPath}: first_evaluable_to does not follow order_kpi_since and the period length`,
    );
  }
  if (
    growth.status === "ok" && response.compare.from_date !== null &&
    dayNumber(response.compare.from_date) <
      dayNumber(section.data_coverage.order_kpi_since)
  ) {
    errors.push(
      `${growthPath}: ok needs a compare window on or after order_kpi_since`,
    );
  }

  const rows = section.rows;
  const counts: Array<[string, number, number]> = [
    ["rows", rows.length, summary.skus],
    [
      "sold rows",
      rows.filter((row) => row.sales_status === "sold").length,
      summary.skus_sold,
    ],
    [
      "unmatched rows",
      rows.filter((row) => row.sales_status === "unmatched_code").length,
      summary.skus_unmatched,
    ],
    [
      "rows with an item",
      rows.filter((row) => row.item_exists).length,
      summary.skus_with_item,
    ],
    [
      "ambiguous rows",
      rows.filter((row) => row.item_names.length > 1).length,
      summary.skus_ambiguous,
    ],
    [
      "shared rows",
      rows.filter((row) => row.people_sharing > 1).length,
      summary.skus_shared,
    ],
  ];
  checkRowCounts(counts, section.next_cursor === null, path, errors);
  rows.forEach((row, index) => {
    const rowPath = `${path}/rows/${index}`;
    checkSkuRowShape(row, rowPath, errors);
    if (nullMismatch(row.previous_qty, summary.previous_qty)) {
      errors.push(
        `${rowPath}: previous_qty must be null exactly when the section has no comparison`,
      );
    }
    checkSkuRowTrend(row, growth.status, rowPath, errors);
  });
}

/** Tỉ lệ làm tròn 3 chữ số; chấp nhận cả hai cách làm tròn số nằm giữa (Python làm tròn về số chẵn). */
function rateMatches(rate: number, numerator: number, denominator: number) {
  return Math.abs(rate - numerator / denominator) <= 0.0005 + 1e-9;
}

function checkQualitySection(
  section: QualitySection,
  path: string,
  errors: string[],
): void {
  const seen = new Set<SignalId>();
  section.signals.forEach((signal, index) => {
    const signalPath = `${path}/signals/${index}`;
    if (seen.has(signal.id)) {
      errors.push(`${signalPath}: duplicate signal id`);
    }
    seen.add(signal.id);
    if (signal.status === "not_measured") return;
    // Schema bảo đảm tử số và mẫu số là số nguyên khi tín hiệu đã được đo.
    const numerator = signal.numerator ?? 0;
    const denominator = signal.denominator ?? 0;
    if (numerator > denominator) {
      errors.push(`${signalPath}: numerator > denominator`);
    }
    if (
      signal.status === "ok" && signal.rate !== null &&
      !rateMatches(signal.rate, numerator, denominator)
    ) {
      errors.push(
        `${signalPath}: rate != round(numerator / denominator, 3)`,
      );
    }
    const basis = signal.basis;
    if (
      signal.id === "on_time_completion" &&
      basis.with_deadline !== denominator
    ) {
      errors.push(`${signalPath}: denominator != basis.with_deadline`);
    }
    if (
      signal.id === "reopened_by_other" && basis.other_reopen !== numerator
    ) {
      errors.push(`${signalPath}: numerator != basis.other_reopen`);
    }
    if (signal.id === "returned_from_review") {
      if (basis.entered_review !== denominator) {
        errors.push(`${signalPath}: denominator != basis.entered_review`);
      }
      if (basis.returned_by_other !== numerator) {
        errors.push(`${signalPath}: numerator != basis.returned_by_other`);
      }
      if (basis.returned < basis.returned_by_other) {
        errors.push(`${signalPath}: returned < returned_by_other`);
      }
    }
  });
}

/**
 * Kiểm một phản hồi `get_person_performance`. Trả danh sách lỗi; rỗng nghĩa là hợp lệ.
 * Lỗi schema được trả riêng: bất biến chỉ có nghĩa trên một giá trị đúng hình dạng.
 */
export function checkSummaryResponse(value: unknown): string[] {
  const schemaErrors = validateJsonSchema(SUMMARY_SCHEMA, value, contract);
  if (schemaErrors.length > 0) return schemaErrors;
  const response = value as SummaryResponse;
  const errors: string[] = [];
  const days = checkPeriod(response.from_date, response.to_date, errors);
  const compare = response.compare;
  if (nullMismatch(compare.from_date, compare.to_date)) {
    errors.push(
      "/compare: from_date and to_date must be both set or both null",
    );
  } else if (compare.from_date !== null && compare.to_date !== null) {
    const start = dayNumber(response.from_date);
    if (
      dayNumber(compare.to_date) !== start - 1 ||
      dayNumber(compare.from_date) !== start - days
    ) {
      errors.push(
        "/compare: must be the period of the same length right before from_date",
      );
    }
  }
  const sections = response.sections;
  if (sections.tasks) {
    checkTasksSection(sections.tasks, "/sections/tasks", errors);
  }
  if (sections.sku) {
    checkSkuSection(sections.sku, response, "/sections/sku", errors);
  }
  if (sections.quality) {
    checkQualitySection(sections.quality, "/sections/quality", errors);
  }
  return errors;
}

/** Kiểm một phản hồi `list_person_performance_rows` (một trang của section `tasks` hoặc `sku`). */
export function checkRowsResponse(value: unknown): string[] {
  const schemaErrors = validateJsonSchema(ROWS_SCHEMA, value, contract);
  if (schemaErrors.length > 0) return schemaErrors;
  const response = value as RowsResponse;
  const errors: string[] = [];
  checkPeriod(response.from_date, response.to_date, errors);
  if (response.section === "tasks") {
    (response.rows as TaskRow[]).forEach((row, index) =>
      checkTaskRow(row, `/rows/${index}`, errors)
    );
  } else {
    (response.rows as SkuRow[]).forEach((row, index) => {
      checkSkuRowShape(row, `/rows/${index}`, errors);
      checkSkuRowTrend(row, undefined, `/rows/${index}`, errors);
    });
  }
  return errors;
}
