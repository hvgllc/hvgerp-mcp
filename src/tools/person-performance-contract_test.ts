/**
 * Khoá hợp đồng hiệu suất cá nhân v2 giữa MCP và ERP: file JSON, hash trong tài liệu, tập từ khoá,
 * payload mẫu dùng chung và các bất biến đếm mà schema không diễn đạt được.
 *
 * @module lib/erpnext/src/tools/person-performance-contract_test
 */

import { assert, assertEquals } from "@std/assert";
import { collectKeywords, SUPPORTED_KEYWORDS } from "../events/json-schema.ts";
import contract from "./contract/person-performance.v2.json" with {
  type: "json",
};
import examples from "./contract/fixtures/person-performance.v2.examples.json" with {
  type: "json",
};
import {
  checkRowsResponse,
  checkSummaryResponse,
  firstEvaluableTo,
  PERSON_PERFORMANCE_CONTRACT_VERSION,
  trendFor,
} from "./person-performance-contract.ts";

const CONTRACT_URL = new URL(
  "./contract/person-performance.v2.json",
  import.meta.url,
);
const DOC_URL = new URL(
  "../../docs/staff-performance-contract.md",
  import.meta.url,
);

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** Bản sao sâu để mỗi test sửa payload mẫu mà không ảnh hưởng test khác. */
// deno-lint-ignore no-explicit-any
function copy(name: keyof typeof examples): any {
  return structuredClone(examples[name]);
}

Deno.test("the SHA-256 recorded in docs/staff-performance-contract.md matches the contract file", async () => {
  const actual = await sha256Hex(await Deno.readFile(CONTRACT_URL));
  const doc = await Deno.readTextFile(DOC_URL);
  const match = /SHA-256 of the contract file:\s+`([0-9a-f]{64})`/.exec(doc);
  assert(match, "the documentation must record the contract hash");
  assertEquals(match[1], actual);
});

Deno.test("the performance contract only uses keywords the validator understands", () => {
  const unsupported = [...collectKeywords(contract)].filter((keyword) =>
    !SUPPORTED_KEYWORDS.includes(keyword)
  );
  assertEquals(unsupported, []);
  assertEquals(PERSON_PERFORMANCE_CONTRACT_VERSION, 2);
});

Deno.test("every shared example passes the schema and the counting rules", () => {
  for (const [name, value] of Object.entries(examples)) {
    const errors = name.startsWith("summary_")
      ? checkSummaryResponse(value)
      : checkRowsResponse(value);
    assertEquals(errors, [], name);
  }
  // Mỗi nhánh của hợp đồng có ít nhất một payload mẫu, để ERP test được cùng các ca đó.
  assertEquals(Object.keys(examples).sort(), [
    "rows_sku",
    "rows_tasks",
    "summary_full",
    "summary_insufficient_baseline",
    "summary_no_compare",
  ]);
});

Deno.test("a different contract_version is rejected by the schema", () => {
  const value = copy("summary_full");
  value.contract_version = 3;
  assertEquals(checkSummaryResponse(value), [
    "/contract_version: const mismatch",
  ]);
});

Deno.test("task counts must add up", () => {
  const value = copy("summary_full");
  value.sections.tasks.summary.assigned = 9;
  value.sections.tasks.summary.with_sku = 2;
  value.sections.tasks.summary.completion_sources.version = 0;
  assertEquals(checkSummaryResponse(value), [
    "/sections/tasks/summary: assigned != completed + open + cancelled",
    "/sections/tasks/summary: with_sku + missing_sku + invalid_sku != completed",
    "/sections/tasks/summary: completion_sources do not add up to completed",
  ]);
});

Deno.test("a task row keeps completion, SKU status and redaction consistent", () => {
  const value = copy("rows_tasks");
  value.rows[0].completed_on = null;
  value.rows[0].title_redacted = true;
  assertEquals(checkRowsResponse(value), [
    "/rows/0: completed_on must be null exactly when completion_source is null or status_only",
    "/rows/0: a redacted title must have a null subject",
  ]);
  const open = copy("rows_tasks");
  open.rows[0].completed_on = null;
  open.rows[0].completion_source = null;
  assertEquals(checkRowsResponse(open), [
    "/rows/0: sku_status must be not_applicable exactly when completion_source is null",
  ]);
});

Deno.test("a task completed with no known moment keeps its SKU status", () => {
  // `status_only`: Task ghi Completed nhưng không tìm được thời điểm xong. Việc đó vẫn là việc đã xong,
  // nên vẫn có trạng thái SKU, chỉ là `completed_on` rỗng.
  const value = copy("rows_tasks");
  value.rows[0].completed_on = null;
  value.rows[0].completion_source = "status_only";
  assertEquals(checkRowsResponse(value), []);
  value.rows[0].completed_on = "2026-12-12";
  assertEquals(checkRowsResponse(value), [
    "/rows/0: completed_on must be null exactly when completion_source is null or status_only",
  ]);
});

Deno.test("SKU counts must stay inside the SKU total", () => {
  const value = copy("summary_full");
  value.sections.sku.summary.skus_sold = 3;
  value.sections.sku.summary.skus_ambiguous = 3;
  assertEquals(checkSummaryResponse(value), [
    "/sections/sku/summary: skus_sold + skus_unmatched > skus",
    "/sections/sku/summary: skus_ambiguous > skus_with_item",
  ]);
});

Deno.test("previous figures exist exactly when a comparison was requested", () => {
  const value = copy("summary_no_compare");
  value.sections.sku.summary.previous_qty = 0;
  assertEquals(checkSummaryResponse(value), [
    "/sections/sku/summary: previous_qty and previous_orders must be null exactly when compare is null",
  ]);
  const requested = copy("summary_full");
  requested.sections.sku.growth.status = "not_requested";
  requested.sections.sku.growth.trend = null;
  assert(
    checkSummaryResponse(requested).includes(
      "/sections/sku/growth: not_requested must match a null compare window",
    ),
  );
});

Deno.test("growth trend and the first evaluable date follow the decided rule", () => {
  const value = copy("summary_full");
  value.sections.sku.growth.trend = "stable";
  value.sections.sku.growth.first_evaluable_to = "2026-12-11";
  value.sections.sku.rows[0].trend = "growing";
  assertEquals(checkSummaryResponse(value), [
    "/sections/sku/growth: trend does not follow the growth rule",
    "/sections/sku/growth: first_evaluable_to does not follow order_kpi_since and the period length",
    "/sections/sku/rows/0: trend does not follow the growth rule",
  ]);
});

Deno.test("evaluable growth needs every channel's order history to cover the comparison window", () => {
  // Một kênh chỉ có lịch sử đơn từ giữa kỳ so sánh thì số kỳ trước thiếu phần của kênh đó, nên
  // `ok` ở đây sẽ biến dữ liệu thiếu thành xu hướng trông như đã kiểm chứng.
  const late = copy("summary_full");
  late.sections.sku.data_coverage.channels[0].history_floor = "2026-11-15";
  assertEquals(checkSummaryResponse(late), [
    "/sections/sku/growth: ok needs a compare window on or after every channel's history_floor",
  ]);
  // Mốc đúng bằng ngày đầu kỳ so sánh là đủ, và kênh không có mốc riêng thì không chặn.
  const onTime = copy("summary_full");
  onTime.sections.sku.data_coverage.channels[0].history_floor = "2026-11-01";
  assertEquals(checkSummaryResponse(onTime), []);
  // `insufficient_baseline` vẫn hợp lệ với cùng mốc muộn đó: luật chỉ chặn việc nhận là `ok`.
  late.sections.sku.growth.status = "insufficient_baseline";
  late.sections.sku.growth.trend = null;
  for (const row of late.sections.sku.rows) row.trend = null;
  assertEquals(checkSummaryResponse(late), []);
});

Deno.test("row trends stay null while the baseline is insufficient", () => {
  const value = copy("summary_insufficient_baseline");
  value.sections.sku.rows[0].trend = "new";
  assertEquals(checkSummaryResponse(value), [
    "/sections/sku/rows/0: trend must be null when growth is not evaluable",
  ]);
});

Deno.test("a SKU row keeps its sales status consistent with its numbers", () => {
  const value = copy("rows_sku");
  value.rows[0].sales_status = "no_sales";
  value.rows[0].item_exists = false;
  assertEquals(checkRowsResponse(value), [
    "/rows/0: sales_status sold must match qty > 0",
    "/rows/0: item_names must be empty when item_exists is false",
  ]);
  const unmatched = copy("rows_sku");
  unmatched.rows[0].sales_status = "unmatched_code";
  unmatched.rows[0].qty = 0;
  unmatched.rows[0].orders = 0;
  unmatched.rows[0].previous_qty = 0;
  unmatched.rows[0].previous_orders = 0;
  unmatched.rows[0].first_sold_on = null;
  unmatched.rows[0].sold_before_first_completion = null;
  unmatched.rows[0].trend = null;
  assertEquals(checkRowsResponse(unmatched), [
    "/rows/0: unmatched_code must have a null match_mode",
  ]);
});

Deno.test("quality rates are recomputed and checked against their basis", () => {
  const value = copy("summary_full");
  const reopen = value.sections.quality.signals[1];
  reopen.rate = 0.25;
  reopen.basis.other_reopen = 2;
  const review = value.sections.quality.signals[2];
  review.basis.entered_review = 3;
  assertEquals(checkSummaryResponse(value), [
    "/sections/quality/signals/1: rate != round(numerator / denominator, 3)",
    "/sections/quality/signals/1: numerator != basis.other_reopen",
    "/sections/quality/signals/2: denominator != basis.entered_review",
  ]);
  const duplicated = copy("summary_full");
  duplicated.sections.quality.signals[2].id = "reopened_by_other";
  duplicated.sections.quality.signals[2].basis = {
    self_reopen: 0,
    other_reopen: 1,
    bot_reopen: 0,
  };
  assertEquals(checkSummaryResponse(duplicated), [
    "/sections/quality/signals/2: duplicate signal id",
  ]);
});

Deno.test("a signal below the minimum sample cannot carry a rate", () => {
  const value = copy("summary_full");
  value.sections.quality.signals[2].rate = 0.5;
  assertEquals(checkSummaryResponse(value), [
    "/sections/quality/signals/2/rate: expected null",
  ]);
});

Deno.test("a rows page must carry sales visibility exactly for the sku section", () => {
  const tasks = copy("rows_tasks");
  tasks.sales_visibility = { mode: "all_orders", partial: false };
  assertEquals(checkRowsResponse(tasks), [": matched a forbidden shape"]);
  const sku = copy("rows_sku");
  delete sku.sales_visibility;
  assertEquals(checkRowsResponse(sku), ["/sales_visibility: required"]);
});

Deno.test("sales cover every order, so they are never partial and never name a merchant", () => {
  // QĐ-8 phương án C: số bán đếm trên mọi đơn, kể cả đơn người xem không mở được, nên phản hồi
  // không được nêu đơn hay merchant nào, và không có chuyện "chỉ thấy một phần".
  const scoped = copy("summary_full");
  scoped.sections.sku.sales_visibility = {
    mode: "viewer_order_scope",
    partial: true,
  };
  assertEquals(checkSummaryResponse(scoped), [
    "/sections/sku/sales_visibility/mode: not in enum",
    "/sections/sku/sales_visibility/partial: const mismatch",
  ]);
  const named = copy("rows_sku");
  named.rows[0].merchants = ["TikTok Shop US 01"];
  const errors = checkRowsResponse(named);
  assertEquals(errors.length, 1);
  assert(errors[0].startsWith("/rows/0"), errors[0]);
  assertEquals(errors[0].includes("TikTok"), false);
});

Deno.test("errors carry paths and rules, never the values that broke them", () => {
  const value = copy("rows_sku");
  value.rows[0].sku = "S".repeat(141);
  value.rows[0].item_names = ["secret-item", 7];
  const errors = checkRowsResponse(value).join("\n");
  assertEquals(errors.includes("secret-item"), false);
  assertEquals(errors.includes("SSSS"), false);
  assert(errors.includes("/rows/0/sku: longer than maxLength"));
});

Deno.test("the growth rule matches the decided thresholds", () => {
  const cases: Array<[number, number, string | null]> = [
    [0, 0, null],
    [0, 4, "stopped"],
    [3, 0, "new"],
    [2, 0, "low_sample"],
    [1, 0, "low_sample"],
    [4, 3, "stable"],
    [1, 1, "stable"],
    [5, 2, "growing"],
    [12, 10, "stable"],
    [13, 10, "growing"],
    [6, 5, "stable"],
    [9, 11, "stable"],
    [8, 11, "declining"],
    [8, 12, "declining"],
    [12, 18, "declining"],
    [42, 20, "growing"],
    [30, 0, "new"],
  ];
  for (const [current, previous, expected] of cases) {
    assertEquals(
      trendFor(current, previous),
      expected,
      `${current}/${previous}`,
    );
  }
});

Deno.test("the first evaluable period end is order_kpi_since plus two period lengths minus a day", () => {
  assertEquals(firstEvaluableTo("2026-10-12", 30), "2026-12-10");
  assertEquals(firstEvaluableTo("2026-10-12", 93), "2027-04-15");
  assertEquals(firstEvaluableTo("2026-10-12", 1), "2026-10-13");
});
