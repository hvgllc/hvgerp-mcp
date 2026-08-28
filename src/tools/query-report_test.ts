/**
 * Query Report Tests
 *
 * Tests for the `frappe.desk.query_report.run` wrapper: the read-only guarantee,
 * the shape validation, and how period columns are picked out of a financial report.
 *
 * @module lib/erpnext/tests/tools/query-report_test
 */

// deno-lint-ignore-file no-explicit-any

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  cellNumber,
  FINANCIAL_REPORTS,
  periodColumns,
  type QueryReportResult,
  runQueryReport,
} from "./query-report.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

function makeCtx(callMethod: AnyFn): ErpNextToolContext {
  const client = {
    list: async () => [],
    get: async () => ({}),
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    callMethod,
    invalidate: () => {},
  } as unknown as FrappeClient;
  return { client };
}

// ── runQueryReport ───────────────────────────────────────────────────────────

Deno.test("runQueryReport - always tells Frappe to skip the prepared report", async () => {
  // Không có cờ này, `run()` có thể gọi `queue_prepared_report()`, và hàm đó chèn một bản
  // ghi Prepared Report: một lời gọi chỉ để đọc lại ghi lên site.
  let captured: any;
  const ctx = makeCtx(async (_method: string, args: any, opts: any) => {
    captured = { args, opts };
    return { columns: [], result: [] };
  });

  await runQueryReport(ctx, "Trial Balance", { company: "Havi Group" });

  assertEquals(captured.args.ignore_prepared_report, true);
  assertEquals(captured.args.report_name, "Trial Balance");
  assertEquals(captured.args.filters, { company: "Havi Group" });
  assertEquals(captured.opts.httpMethod, "GET");
});

Deno.test("runQueryReport - calls the whitelisted desk method by name", async () => {
  let method = "";
  const ctx = makeCtx(async (name: string) => {
    method = name;
    return { columns: [], result: [] };
  });

  await runQueryReport(ctx, "General Ledger", {});

  assertEquals(method, "frappe.desk.query_report.run");
});

Deno.test("runQueryReport - refuses a response that carries no report", async () => {
  for (const bad of [null, undefined, "", 0, []]) {
    const ctx = makeCtx(async () => bad);
    await assertRejects(
      () => runQueryReport(ctx, "Balance Sheet", {}),
      Error,
      "Balance Sheet",
    );
  }
});

Deno.test("runQueryReport - refuses a response with no columns or rows", async () => {
  const ctx = makeCtx(async () => ({ status: "queued", columns: [] }));
  await assertRejects(
    () => runQueryReport(ctx, "Cash Flow", {}),
    Error,
    "no usable",
  );
});

Deno.test("runQueryReport - keeps the summary and chart the report returned", async () => {
  const ctx = makeCtx(async () => ({
    columns: [{ fieldname: "account", fieldtype: "Link" }],
    result: [{ account: "Cash - HVG" }],
    report_summary: [{ label: "Tổng thu nhập", value: 0, currency: "VND" }],
    chart: { type: "bar" },
  }));

  const result = await runQueryReport(ctx, "Profit and Loss Statement", {});

  assertEquals(result.result.length, 1);
  assertEquals(result.report_summary?.[0]?.currency, "VND");
  assert(result.chart);
});

// ── periodColumns ────────────────────────────────────────────────────────────

Deno.test("periodColumns - picks Currency columns and drops the grand total", () => {
  const result = {
    columns: [
      { fieldname: "account", label: "Tài Khoản", fieldtype: "Link" },
      { fieldname: "currency", label: "Tiền tệ", fieldtype: "Link" },
      { fieldname: "mar_2026", label: "thg 3 2026", fieldtype: "Currency" },
      { fieldname: "apr_2026", label: "thg 4 2026", fieldtype: "Currency" },
      { fieldname: "total", label: "Tổng cộng", fieldtype: "Currency" },
    ],
    result: [],
  } as QueryReportResult;

  // Nhãn đã qua `_()` nên không dùng để nhận diện được; `fieldname` mới là thứ ổn định.
  assertEquals(periodColumns(result), [
    { fieldname: "mar_2026", label: "thg 3 2026" },
    { fieldname: "apr_2026", label: "thg 4 2026" },
  ]);
});

Deno.test("periodColumns - falls back to the fieldname when a column has no label", () => {
  const result = {
    columns: [{ fieldname: "aug_2026", fieldtype: "Currency" }],
    result: [],
  } as QueryReportResult;

  assertEquals(periodColumns(result), [
    { fieldname: "aug_2026", label: "aug_2026" },
  ]);
});

Deno.test("periodColumns - returns nothing for a report with no period columns", () => {
  const result = {
    columns: [{ fieldname: "account", fieldtype: "Link" }, {
      label: "no name",
    }],
    result: [],
  } as QueryReportResult;

  assertEquals(periodColumns(result), []);
});

// ── cellNumber ───────────────────────────────────────────────────────────────

Deno.test("cellNumber - accepts numbers and numeric strings only", () => {
  assertEquals(cellNumber(709262820.06), 709262820.06);
  assertEquals(cellNumber(0), 0);
  assertEquals(cellNumber(-1.5), -1.5);
  assertEquals(cellNumber("1234.5"), 1234.5);
});

Deno.test("cellNumber - reports an empty or broken cell as unknown, not as zero", () => {
  // `Number()` một mình biến cả bốn giá trị dưới đây thành 0, và một ô hỏng đọc thành 0 là
  // một con số sai trông y hệt một con số đúng.
  for (
    const value of [null, undefined, "", " ", [], {}, "abc", NaN, Infinity]
  ) {
    assertEquals(
      cellNumber(value),
      null,
      `cellNumber(${JSON.stringify(value)})`,
    );
  }
});

// ── Report allowlist ─────────────────────────────────────────────────────────

Deno.test("FINANCIAL_REPORTS - is a closed list of standard reports", () => {
  // `query_report.run` chạy được mọi Report kể cả Script Report do người dùng tự viết, nên
  // danh sách này phải đóng: mở tự do là mở một đường chạy mã tùy ý trên site.
  assert(FINANCIAL_REPORTS.includes("Profit and Loss Statement"));
  assert(FINANCIAL_REPORTS.includes("General Ledger"));
  assertEquals(new Set(FINANCIAL_REPORTS).size, FINANCIAL_REPORTS.length);
  for (const name of FINANCIAL_REPORTS) {
    assertEquals(typeof name, "string");
    assert(name.length > 0);
  }
});
