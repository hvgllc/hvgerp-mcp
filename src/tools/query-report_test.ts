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
  receivableInvoiceRows,
  runQueryReport,
} from "./query-report.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

const arInvoice = {
  voucher_type: "Sales Invoice",
  voucher_no: "INV-USD",
  currency: "VND",
  account_currency: "USD",
  outstanding: "250000",
  outstanding_in_account_currency: 10,
  posting_date: "2026-01-01",
  due_date: "2026-01-31",
  party: "Customer",
  party_account: "Receivables - VND",
};

for (const count of [0, 999, 1000, 1001, 2001, 100000, 100001]) {
  Deno.test(`receivable report validates the complete ${count} row result without local truncation`, async () => {
    let calls = 0;
    const ctx = makeCtx(async () => {
      calls++;
      return {
        columns: [],
        result: Array.from(
          { length: count },
          (_, i) => ({ ...arInvoice, voucher_no: `INV-${i}`, outstanding: 1 }),
        ),
      };
    });
    if (count > 100000) {
      await assertRejects(
        () =>
          receivableInvoiceRows(ctx, "Vietnam Company", "VND", "2026-09-05"),
        Error,
        "100000 row safety limit",
      );
    } else {
      const result = await receivableInvoiceRows(
        ctx,
        "Vietnam Company",
        "VND",
        "2026-09-05",
      );
      assertEquals(result.length, count);
      assertEquals(
        result.reduce((sum, row) => sum + row.outstanding_amount, 0),
        count,
      );
    }
    assertEquals(calls, 1);
  });
}

Deno.test("receivable invoice rows lock company currency and avoid Prepared Report writes", async () => {
  const ctx = makeCtx(async (method, args, options) => {
    assertEquals(method, "frappe.desk.query_report.run");
    assertEquals(options, { httpMethod: "GET" });
    assertEquals(args, {
      report_name: "Accounts Receivable",
      filters: {
        company: "Vietnam Company",
        report_date: "2026-09-05",
        in_party_currency: 0,
        based_on_payment_terms: 0,
        group_by_party: 0,
      },
      ignore_prepared_report: true,
    });
    return {
      columns: [],
      result: [arInvoice, { outstanding: 250000 }, {
        ...arInvoice,
        voucher_type: "Journal Entry",
        outstanding: 100000,
      }, { ...arInvoice, voucher_no: "INV-PAID", outstanding: 0 }],
    };
  });
  assertEquals(
    await receivableInvoiceRows(ctx, "Vietnam Company", "VND", "2026-09-05"),
    [{
      voucher_no: "INV-USD",
      customer_name: "Customer",
      outstanding_amount: 250000,
      posting_date: "2026-01-01",
      due_date: "2026-01-31",
    }],
  );
});

Deno.test("receivable invoice rows reject mixed and missing currency instead of reporting zero", async () => {
  for (const currency of ["USD", "", undefined]) {
    const ctx = makeCtx(async () => ({
      columns: [],
      result: [{ ...arInvoice, currency }],
    }));
    await assertRejects(
      () => receivableInvoiceRows(ctx, "Vietnam Company", "VND", "2026-09-05"),
      Error,
      "currency",
    );
  }
});

Deno.test("receivable invoice rows reject malformed amount and missing voucher identity", async () => {
  for (
    const overrides of [
      { outstanding: null },
      { outstanding: "" },
      { outstanding: "NaN" },
      { voucher_no: "" },
      { posting_date: "invalid" },
      { party: "" },
    ]
  ) {
    const ctx = makeCtx(async () => ({
      columns: [],
      result: [{ ...arInvoice, ...overrides }],
    }));
    await assertRejects(
      () => receivableInvoiceRows(ctx, "Vietnam Company", "VND", "2026-09-05"),
      Error,
      "Accounts Receivable",
    );
  }
});

Deno.test("receivable invoice rows propagate report permission errors unchanged", async () => {
  const denied = new Error("Report permission denied");
  const ctx = makeCtx(async () => {
    throw denied;
  });
  assertEquals(
    await assertRejects(() =>
      receivableInvoiceRows(ctx, "Vietnam Company", "VND", "2026-09-05")
    ),
    denied,
  );
});

Deno.test("receivable invoice rows retain distinct accounts but reject duplicate ledger keys", async () => {
  const ctx = makeCtx(async () => ({
    columns: [],
    result: [arInvoice, {
      ...arInvoice,
      party_account: "Other Receivables - VND",
      outstanding: 125000,
    }],
  }));
  const rows = await receivableInvoiceRows(
    ctx,
    "Vietnam Company",
    "VND",
    "2026-09-05",
  );
  assertEquals(
    rows.reduce((total, row) => total + row.outstanding_amount, 0),
    375000,
  );
  assertEquals(new Set(rows.map((row) => row.voucher_no)).size, 1);
  const duplicate = makeCtx(async () => ({
    columns: [],
    result: [arInvoice, { ...arInvoice }],
  }));
  await assertRejects(
    () =>
      receivableInvoiceRows(duplicate, "Vietnam Company", "VND", "2026-09-05"),
    Error,
    "duplicate ledger balance",
  );
});

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
