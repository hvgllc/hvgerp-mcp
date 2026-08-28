/**
 * Accounting Tools Tests
 *
 * Tests for ERPNext accounting MCP tools (accounts, journal entries,
 * payment entries). Injects a mock FrappeClient to avoid real network calls.
 *
 * @module lib/erpnext/tests/tools/accounting_test
 */

// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertRejects } from "@std/assert";
import { accountingTools } from "./accounting.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "NEW-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    invalidate: () => {},
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = accountingTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

// ── erpnext_payment_entry_list ───────────────────────────────────────────────

Deno.test("erpnext_payment_entry_list - throws if party set without party_type", async () => {
  const tool = getTool("erpnext_payment_entry_list");
  await assertRejects(
    () => tool.handler({ party: "Acme Corp" }, makeCtx(makeMockClient())),
    Error,
    "party_type",
  );
});

Deno.test("erpnext_payment_entry_list - resolves party against the party_type doctype", async () => {
  let resolvedDoctype = "";
  const client = makeMockClient({
    get: async () => {
      throw new FrappeAPIError("not found", 404, null);
    },
    list: async (doctype: string) => {
      if (doctype === "Payment Entry") return [];
      resolvedDoctype = doctype;
      return [{ name: "SUPP-007" }];
    },
  });

  const tool = getTool("erpnext_payment_entry_list");
  await tool.handler(
    { party: "Acme Supplies", party_type: "Supplier" },
    makeCtx(client),
  );

  assertEquals(resolvedDoctype, "Supplier");
});

Deno.test("erpnext_payment_entry_list - works without party/party_type at all", async () => {
  const tool = getTool("erpnext_payment_entry_list");
  const result = await tool.handler({}, makeCtx(makeMockClient())) as Record<
    string,
    unknown
  >;
  assertEquals(result.doctype, "Payment Entry");
});

Deno.test("erpnext_payment_entry_list - asks for the per-side currency columns", async () => {
  let capturedFields: string[] = [];
  const client = makeMockClient({
    list: async (_doctype: string, opts: { fields?: string[] }) => {
      capturedFields = opts?.fields ?? [];
      return [];
    },
  });

  await getTool("erpnext_payment_entry_list").handler({}, makeCtx(client));

  // Payment Entry không có cột `currency`: tiền chi và tiền thu mang đơn vị riêng theo tài
  // khoản hai đầu. Hỏi `currency` làm cả truy vấn chết với SQL 1054.
  assertEquals(capturedFields.includes("paid_from_account_currency"), true);
  assertEquals(capturedFields.includes("paid_to_account_currency"), true);
  assertEquals(capturedFields.includes("currency"), false);
});

// ── erpnext_account_list ─────────────────────────────────────────────────────

Deno.test("erpnext_account_list - returns chart of accounts with doclist meta", async () => {
  const mockClient = makeMockClient({
    list: async () => [
      { name: "Cash - C", account_name: "Cash", root_type: "Asset" },
      {
        name: "Sales - C",
        account_name: "Sales",
        root_type: "Income",
      },
    ],
  });

  const tool = getTool("erpnext_account_list");
  const result = await tool.handler({}, makeCtx(mockClient)) as any;

  assertEquals(result.doctype, "Account");
  assertEquals(result.count, 2);
  assertEquals(result._meta.ui.resourceUri, "ui://hvgerp-mcp/doclist-viewer");
});

Deno.test("erpnext_account_list - applies root_type filter", async () => {
  let capturedFilters: unknown;
  const mockClient = makeMockClient({
    list: async (_doctype: string, opts: any) => {
      capturedFilters = opts.filters;
      return [];
    },
  });

  const tool = getTool("erpnext_account_list");
  await tool.handler({ root_type: "Income" }, makeCtx(mockClient));

  assertEquals(capturedFilters, [["root_type", "=", "Income"]]);
});

// ── erpnext_journal_entry_create ─────────────────────────────────────────────

Deno.test("erpnext_journal_entry_create - throws if voucher_type missing", async () => {
  const tool = getTool("erpnext_journal_entry_create");
  await assertRejects(
    () =>
      tool.handler(
        { accounts: [{ account: "Cash" }] },
        makeCtx(makeMockClient()),
      ),
    Error,
    "voucher_type",
  );
});

Deno.test("erpnext_journal_entry_create - throws if accounts missing or empty", async () => {
  const tool = getTool("erpnext_journal_entry_create");
  await assertRejects(
    () =>
      tool.handler(
        { voucher_type: "Bank Entry", accounts: [] },
        makeCtx(makeMockClient()),
      ),
    Error,
    "accounts",
  );
});

Deno.test("erpnext_journal_entry_create - creates journal entry and forwards accounts", async () => {
  let capturedData: any;
  const mockClient = makeMockClient({
    create: async (_doctype: string, data: any) => {
      capturedData = data;
      return { name: "JE-2026-001" };
    },
  });

  const tool = getTool("erpnext_journal_entry_create");
  const result = await tool.handler(
    {
      voucher_type: "Bank Entry",
      accounts: [
        { account: "Cash - C", debit_in_account_currency: 1000 },
        { account: "Sales - C", credit_in_account_currency: 1000 },
      ],
      remark: "Test JE",
    },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.data.name, "JE-2026-001");
  assertEquals(capturedData.voucher_type, "Bank Entry");
  assertEquals(capturedData.accounts.length, 2);
  assertEquals(capturedData.remark, "Test JE");
});

// ── erpnext_payment_entry_get ────────────────────────────────────────────────

Deno.test("erpnext_payment_entry_get - throws if name missing", async () => {
  const tool = getTool("erpnext_payment_entry_get");
  await assertRejects(
    () => tool.handler({}, makeCtx(makeMockClient())),
    Error,
    "name",
  );
});

Deno.test("erpnext_payment_entry_get - returns payment entry data", async () => {
  const mockClient = makeMockClient({
    get: async () => ({
      name: "PE-00001",
      payment_type: "Receive",
      paid_amount: 1500,
    }),
  });

  const tool = getTool("erpnext_payment_entry_get");
  const result = await tool.handler(
    { name: "PE-00001" },
    makeCtx(mockClient),
  ) as any;

  assertEquals(result.data.name, "PE-00001");
  assertEquals(result.data.paid_amount, 1500);
});

// ── erpnext_gl_entry_list ────────────────────────────────────────────────────

Deno.test("erpnext_gl_entry_list - excludes cancelled ledger rows by default", async () => {
  // Huỷ một chứng từ không xoá bút toán: ERPNext giữ dòng gốc và ghi thêm dòng đảo, cả hai
  // đều `is_cancelled = 1`. Cộng cả hai vào là nhân đôi mọi chứng từ đã huỷ.
  let capturedFilters: any;
  const client = makeMockClient({
    list: async (_doctype: string, opts: any) => {
      capturedFilters = opts.filters;
      return [];
    },
  });

  await getTool("erpnext_gl_entry_list").handler({}, makeCtx(client));

  assertEquals(capturedFilters, [["is_cancelled", "=", 0]]);
});

Deno.test("erpnext_gl_entry_list - drops the cancelled filter only when asked", async () => {
  let capturedFilters: any;
  const client = makeMockClient({
    list: async (_doctype: string, opts: any) => {
      capturedFilters = opts.filters;
      return [];
    },
  });

  await getTool("erpnext_gl_entry_list").handler(
    { include_cancelled: true },
    makeCtx(client),
  );

  assertEquals(capturedFilters, []);
});

Deno.test("erpnext_gl_entry_list - asks for the debit/credit columns and a real total", async () => {
  let capturedFields: string[] = [];
  const client = makeMockClient({
    list: async (_doctype: string, opts: any) => {
      capturedFields = opts?.fields ?? [];
      return [{ name: "abc", debit: 1000, credit: 0 }];
    },
  });

  const result = await getTool("erpnext_gl_entry_list").handler(
    {},
    makeCtx(client),
  ) as any;

  for (const field of ["debit", "credit", "account", "voucher_no", "party"]) {
    assertEquals(capturedFields.includes(field), true, `missing ${field}`);
  }
  assertEquals(result.doctype, "GL Entry");
  assertEquals(result.count, 1);
  assertEquals(result.has_more, false);
});

Deno.test("erpnext_gl_entry_list - builds every documented filter", async () => {
  let capturedFilters: any;
  const client = makeMockClient({
    list: async (doctype: string, opts: any) => {
      if (doctype === "GL Entry") {
        capturedFilters = opts.filters;
        return [];
      }
      return [{ name: "HR-EMP-00024" }];
    },
    get: async () => ({ name: "HR-EMP-00024" }),
  });

  await getTool("erpnext_gl_entry_list").handler({
    account: "Administrative Expenses - HVG",
    party_type: "Employee",
    party: "HR-EMP-00024",
    voucher_type: "Expense Claim",
    voucher_no: "HR-EXP-2026-00089",
    cost_center: "Main - HVG",
    project: "PROJ-0001",
    company: "Havi Group",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
  }, makeCtx(client));

  assertEquals(capturedFilters, [
    ["is_cancelled", "=", 0],
    ["account", "=", "Administrative Expenses - HVG"],
    ["party_type", "=", "Employee"],
    ["party", "=", "HR-EMP-00024"],
    ["voucher_type", "=", "Expense Claim"],
    ["voucher_no", "=", "HR-EXP-2026-00089"],
    ["cost_center", "=", "Main - HVG"],
    ["project", "=", "PROJ-0001"],
    ["company", "=", "Havi Group"],
    ["posting_date", ">=", "2026-08-01"],
    ["posting_date", "<=", "2026-08-31"],
  ]);
});

Deno.test("erpnext_gl_entry_list - throws if party set without party_type", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_gl_entry_list").handler(
        { party: "HR-EMP-00024" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "party_type",
  );
});

// ── erpnext_financial_report ─────────────────────────────────────────────────

function makeReportClient(
  report: Record<string, unknown>,
  onCall?: (args: any) => void,
) {
  return makeMockClient({
    callMethod: async (_method: string, args: any) => {
      onCall?.(args);
      return report;
    },
  });
}

Deno.test("erpnext_financial_report - runs the report read-only and reports truncation", async () => {
  let capturedArgs: any;
  const rows = Array.from(
    { length: 5 },
    (_, index) => ({ account: `A${index}` }),
  );
  const client = makeReportClient(
    {
      columns: [{ fieldname: "account", fieldtype: "Link" }],
      result: rows,
      report_summary: [{ label: "Tổng chi phí", value: 709262820.06 }],
    },
    (args) => {
      capturedArgs = args;
    },
  );

  const result = await getTool("erpnext_financial_report").handler(
    {
      report: "Trial Balance",
      filters: { company: "Havi Group", from_date: "2026-08-01" },
      limit: 2,
    },
    makeCtx(client),
  ) as any;

  // Đọc báo cáo không được để lại bản ghi Prepared Report nào trên site.
  assertEquals(capturedArgs.ignore_prepared_report, true);
  assertEquals(capturedArgs.report_name, "Trial Balance");
  assertEquals(capturedArgs.filters.company, "Havi Group");

  assertEquals(result.report, "Trial Balance");
  assertEquals(result.count, 5);
  assertEquals(result.returned, 2);
  assertEquals(result.has_more, true);
  assertEquals(result.rows.length, 2);
  assertEquals(result.report_summary[0].value, 709262820.06);
});

Deno.test("erpnext_financial_report - reports a complete result as complete", async () => {
  const client = makeReportClient({
    columns: [{ fieldname: "account", fieldtype: "Link" }],
    result: [{ account: "Cash - HVG" }],
  });

  const result = await getTool("erpnext_financial_report").handler(
    { report: "Balance Sheet" },
    makeCtx(client),
  ) as any;

  assertEquals(result.count, 1);
  assertEquals(result.returned, 1);
  assertEquals(result.has_more, false);
  assertEquals(result.filters, {});
});

Deno.test("erpnext_financial_report - refuses a report outside the standard list", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_financial_report").handler(
        { report: "My Custom Script Report" },
        makeCtx(makeMockClient()),
      ),
    Error,
    "not one of the standard financial reports",
  );
});

Deno.test("erpnext_financial_report - requires a report name", async () => {
  await assertRejects(
    () =>
      getTool("erpnext_financial_report").handler(
        {},
        makeCtx(makeMockClient()),
      ),
    Error,
    "'report' is required",
  );
});

// ── Tool registry sanity ────────────────────────────────────────────────────

Deno.test("all accounting tools have name, description, category, handler", () => {
  for (const tool of accountingTools) {
    assertEquals(typeof tool.name, "string");
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.category, "accounting");
    assertEquals(typeof tool.handler, "function");
  }
});
