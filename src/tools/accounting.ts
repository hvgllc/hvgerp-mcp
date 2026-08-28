/**
 * ERPNext Accounting Tools
 *
 * MCP tools for accounting: accounts, journal entries, payment entries,
 * purchase orders, purchase invoices.
 *
 * @module lib/erpnext/tools/accounting
 */

import type { FrappeFilter } from "../api/types.ts";
import type { ErpNextTool } from "./types.ts";
import { listResult } from "./list-result.ts";
import { FINANCIAL_REPORTS, runQueryReport } from "./query-report.ts";
import { DOCLIST_META } from "./viewer-meta.ts";
import { resolveDynamicLink } from "../api/resolve.ts";

/** Bao nhiêu dòng báo cáo trả về khi người gọi không nói gì. */
const DEFAULT_REPORT_ROWS = 100;

export const accountingTools: ErpNextTool[] = [
  // ── Chart of Accounts ─────────────────────────────────────────────────────

  {
    name: "erpnext_account_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Chart of Accounts. Filterable by root_type, is_group and disabled. " +
      "Fields: name, account_name, account_type, root_type, parent_account, is_group, disabled. " +
      "root_type values: Asset, Liability, Income, Expense, Equity. " +
      "An account is 'active' when disabled is 0; pass disabled:false to count only those.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 50)",
        },
        root_type: {
          type: "string",
          description:
            "Filter by root type: Asset, Liability, Income, Expense, Equity",
          enum: ["Asset", "Liability", "Income", "Expense", "Equity"],
        },
        is_group: {
          type: "boolean",
          description: "Filter by group accounts only",
        },
        company: { type: "string", description: "Filter by company" },
        disabled: {
          type: "boolean",
          description:
            "Filter by disabled flag. Omit to list every account regardless of state.",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 50;
      const filters: FrappeFilter[] = [];
      if (input.root_type) {
        filters.push(["root_type", "=", input.root_type as string]);
      }
      if (input.is_group !== undefined) {
        filters.push(["is_group", "=", (input.is_group as boolean) ? 1 : 0]);
      }
      if (input.company) {
        filters.push(["company", "=", input.company as string]);
      }
      if (input.disabled !== undefined) {
        filters.push(["disabled", "=", (input.disabled as boolean) ? 1 : 0]);
      }

      const docs = await ctx.client.list("Account", {
        fields: [
          "name",
          "account_name",
          "account_type",
          "root_type",
          "parent_account",
          "is_group",
          "disabled",
        ],
        filters,
        limit,
        order_by: "name asc",
      });

      return await listResult(ctx, "Account", docs, {
        filters,
        limit,
      });
    },
  },

  // ── Journal Entries ───────────────────────────────────────────────────────

  {
    name: "erpnext_journal_entry_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Journal Entries. Filterable by date range and voucher_type. " +
      "Fields: name, voucher_type, posting_date, total_debit, total_credit, remark.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        voucher_type: {
          type: "string",
          description:
            "Filter by voucher type (Journal Entry, Bank Entry, Cash Entry, etc.)",
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD",
        },
        date_to: { type: "string", description: "End date filter YYYY-MM-DD" },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.voucher_type) {
        filters.push(["voucher_type", "=", input.voucher_type as string]);
      }
      if (input.date_from) {
        filters.push(["posting_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["posting_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("Journal Entry", {
        fields: [
          "name",
          "voucher_type",
          "posting_date",
          "total_debit",
          "total_credit",
          "remark",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Journal Entry", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_journal_entry_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Journal Entry by name (e.g. JV-00001). Returns full document with accounts.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Journal Entry name (e.g. JV-00001)",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_journal_entry_get] 'name' is required");
      }
      const doc = await ctx.client.get("Journal Entry", input.name as string);
      return { data: doc };
    },
  },

  // ── Payment Entries ───────────────────────────────────────────────────────

  {
    name: "erpnext_payment_entry_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List Payment Entries. Filterable by payment_type, party_type, date range. " +
      "Fields: name, payment_type, party_type, party, posting_date, paid_amount, " +
      "paid_from_account_currency, paid_to_account_currency. " +
      "payment_type values: Receive, Pay, Internal Transfer.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        payment_type: {
          type: "string",
          description:
            "Filter by payment type: Receive, Pay, Internal Transfer",
          enum: ["Receive", "Pay", "Internal Transfer"],
        },
        party_type: {
          type: "string",
          description: "Filter by party type (Customer, Supplier, Employee). " +
            "Required when 'party' is set, so the party name/ID can be resolved against the right doctype.",
          enum: ["Customer", "Supplier", "Employee"],
        },
        party: {
          type: "string",
          description:
            "Filter by party — ID or name (e.g. 'CUST-00001' or 'Acme Corp'). Requires 'party_type'.",
        },
        date_from: {
          type: "string",
          description: "Start date filter YYYY-MM-DD",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];
      if (input.payment_type) {
        filters.push(["payment_type", "=", input.payment_type as string]);
      }
      if (input.party_type) {
        filters.push(["party_type", "=", input.party_type as string]);
      }
      if (input.party) {
        if (!input.party_type) {
          throw new Error(
            "[erpnext_payment_entry_list] 'party_type' is required when filtering by 'party'",
          );
        }
        filters.push([
          "party",
          "=",
          await resolveDynamicLink(
            ctx.client,
            input.party_type as string,
            input.party as string,
            { inputPath: "party" },
          ),
        ]);
      }
      if (input.date_from) {
        filters.push(["posting_date", ">=", input.date_from as string]);
      }

      const docs = await ctx.client.list("Payment Entry", {
        fields: [
          "name",
          "payment_type",
          "party_type",
          "party",
          "posting_date",
          "paid_amount",
          // Payment Entry không có cột `currency`: số tiền chi và số tiền thu mang đơn vị
          // riêng, lấy từ tài khoản hai đầu.
          "paid_from_account_currency",
          "paid_to_account_currency",
        ],
        filters,
        limit,
        order_by: "modified desc",
      });

      return await listResult(ctx, "Payment Entry", docs, {
        filters,
        limit,
      });
    },
  },

  {
    name: "erpnext_payment_entry_get",
    annotations: { readOnlyHint: true },
    description:
      "Get a single Payment Entry by name (e.g. PE-00001). Returns full document including references.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Payment Entry name (e.g. PE-00001)",
        },
      },
      required: ["name"],
    },
    handler: async (input, ctx) => {
      if (!input.name) {
        throw new Error("[erpnext_payment_entry_get] 'name' is required");
      }
      const doc = await ctx.client.get("Payment Entry", input.name as string);
      return { data: doc };
    },
  },

  {
    name: "erpnext_journal_entry_create",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    description:
      "Create a new Journal Entry. Requires voucher_type and accounts with debit/credit amounts. " +
      "Total debits must equal total credits.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        voucher_type: {
          type: "string",
          description:
            "Journal entry type (Journal Entry, Bank Entry, Cash Entry, Credit Card Entry, etc.)",
        },
        accounts: {
          type: "array",
          description:
            "Account entries: [{account, debit_in_account_currency, credit_in_account_currency}]",
          items: {
            type: "object",
            properties: {
              account: { type: "string", description: "Account name" },
              debit_in_account_currency: {
                type: "number",
                description: "Debit amount (0 if credit)",
              },
              credit_in_account_currency: {
                type: "number",
                description: "Credit amount (0 if debit)",
              },
            },
            required: ["account"],
          },
        },
        posting_date: {
          type: "string",
          description: "Posting date YYYY-MM-DD (default: today)",
        },
        remark: { type: "string", description: "Narration / remark" },
      },
      required: ["voucher_type", "accounts"],
    },
    handler: async (input, ctx) => {
      if (!input.voucher_type) {
        throw new Error(
          "[erpnext_journal_entry_create] 'voucher_type' is required",
        );
      }
      if (
        !input.accounts || !Array.isArray(input.accounts) ||
        input.accounts.length === 0
      ) {
        throw new Error(
          "[erpnext_journal_entry_create] 'accounts' must be a non-empty array",
        );
      }

      const data: Record<string, unknown> = {
        voucher_type: input.voucher_type as string,
        accounts: input.accounts,
      };
      if (input.posting_date) data.posting_date = input.posting_date as string;
      if (input.remark) data.remark = input.remark as string;

      const doc = await ctx.client.create("Journal Entry", data);
      return {
        data: doc,
        message: `Journal Entry ${doc.name} created successfully`,
      };
    },
  },

  // ── General Ledger ────────────────────────────────────────────────────────

  {
    name: "erpnext_gl_entry_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description:
      "List GL Entry rows: the general ledger itself, one row per account posting. " +
      "This is where the money actually is — every submitted Sales Invoice, Purchase Invoice, " +
      "Payment Entry, Journal Entry and Expense Claim writes its debits and credits here, " +
      "so income and expense totals must be read from GL Entry, not from orders. " +
      "Filterable by account, party, voucher, cost_center, project, company and date range. " +
      "Fields: name, posting_date, account, account_currency, party_type, party, debit, credit, " +
      "voucher_type, voucher_no, against, cost_center, project, company, is_cancelled, remarks. " +
      "Cancelled rows are excluded by default; see 'include_cancelled'.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description: "Max results (default 20)",
        },
        account: {
          type: "string",
          description:
            "Filter by account (e.g. 'Administrative Expenses - HVG')",
        },
        party_type: {
          type: "string",
          description:
            "Filter by party type (Customer, Supplier, Employee, Shareholder). " +
            "Required when 'party' is set, so the party name/ID can be resolved against the right doctype.",
          enum: ["Customer", "Supplier", "Employee", "Shareholder"],
        },
        party: {
          type: "string",
          description:
            "Filter by party — ID or name (e.g. 'HR-EMP-00024' or 'Acme Corp'). Requires 'party_type'.",
        },
        voucher_type: {
          type: "string",
          description:
            "Filter by source document type (Sales Invoice, Purchase Invoice, Payment Entry, Journal Entry, Expense Claim, ...)",
        },
        voucher_no: {
          type: "string",
          description:
            "Filter by source document name (e.g. 'HR-EXP-2026-00089')",
        },
        cost_center: { type: "string", description: "Filter by cost center" },
        project: { type: "string", description: "Filter by project" },
        company: { type: "string", description: "Filter by company" },
        date_from: {
          type: "string",
          description: "Earliest posting_date, YYYY-MM-DD",
        },
        date_to: {
          type: "string",
          description: "Latest posting_date, YYYY-MM-DD",
        },
        include_cancelled: {
          type: "boolean",
          description:
            "Include cancelled ledger rows (default false). Cancelling a voucher does not delete " +
            "its GL rows: ERPNext keeps the original AND writes a mirrored reversal, both flagged " +
            "is_cancelled=1. Summing debits with these included therefore double-counts every " +
            "cancelled voucher, so only turn this on to audit cancellations, never to total money.",
        },
      },
    },
    handler: async (input, ctx) => {
      const limit = (input.limit as number) ?? 20;
      const filters: FrappeFilter[] = [];

      if (!input.include_cancelled) {
        filters.push(["is_cancelled", "=", 0]);
      }
      if (input.account) {
        filters.push(["account", "=", input.account as string]);
      }
      if (input.party_type) {
        filters.push(["party_type", "=", input.party_type as string]);
      }
      if (input.party) {
        if (!input.party_type) {
          throw new Error(
            "[erpnext_gl_entry_list] 'party_type' is required when filtering by 'party'",
          );
        }
        filters.push([
          "party",
          "=",
          await resolveDynamicLink(
            ctx.client,
            input.party_type as string,
            input.party as string,
            { inputPath: "party" },
          ),
        ]);
      }
      if (input.voucher_type) {
        filters.push(["voucher_type", "=", input.voucher_type as string]);
      }
      if (input.voucher_no) {
        filters.push(["voucher_no", "=", input.voucher_no as string]);
      }
      if (input.cost_center) {
        filters.push(["cost_center", "=", input.cost_center as string]);
      }
      if (input.project) {
        filters.push(["project", "=", input.project as string]);
      }
      if (input.company) {
        filters.push(["company", "=", input.company as string]);
      }
      if (input.date_from) {
        filters.push(["posting_date", ">=", input.date_from as string]);
      }
      if (input.date_to) {
        filters.push(["posting_date", "<=", input.date_to as string]);
      }

      const docs = await ctx.client.list("GL Entry", {
        fields: [
          "name",
          "posting_date",
          "account",
          "account_currency",
          "party_type",
          "party",
          "debit",
          "credit",
          "voucher_type",
          "voucher_no",
          "against",
          "cost_center",
          "project",
          "company",
          "is_cancelled",
          "remarks",
        ],
        filters,
        limit,
        order_by: "posting_date desc, creation desc",
      });

      return await listResult(ctx, "GL Entry", docs, { filters, limit });
    },
  },

  // ── Standard financial reports ────────────────────────────────────────────

  {
    name: "erpnext_financial_report",
    annotations: { readOnlyHint: true },
    description:
      "Run one of ERPNext's standard financial reports and return its columns, rows and summary. " +
      "These reports read the general ledger and apply ERPNext's own accounting rules " +
      "(account tree, period buckets, debit/credit signs), so they are the correct source for " +
      "P&L, balance sheet and ledger questions — reproducing them by hand gets the signs wrong. " +
      "'filters' is passed through to the report as-is; common keys are company, from_date, to_date, " +
      "period_start_date, period_end_date, filter_based_on ('Date Range' or 'Fiscal Year'), " +
      "periodicity (Monthly, Quarterly, Half-Yearly, Yearly), fiscal_year and accumulated_values. " +
      "Reports run under the caller's own permissions and most require an Accounts User, " +
      "Accounts Manager or Auditor role.",
    category: "accounting",
    inputSchema: {
      type: "object",
      properties: {
        report: {
          type: "string",
          description: "Which standard report to run",
          enum: [...FINANCIAL_REPORTS],
        },
        filters: {
          type: "object",
          description:
            "Report filters, passed to ERPNext unchanged. Most financial reports require at " +
            "least 'company' plus a date range.",
        },
        limit: {
          type: "number",
          minimum: 1,
          description:
            `Max report rows to return (default ${DEFAULT_REPORT_ROWS}). ` +
            "Truncation is always reported in 'total_rows' and 'has_more'.",
        },
      },
      required: ["report"],
    },
    handler: async (input, ctx) => {
      const report = input.report as string;
      if (!report) {
        throw new Error("[erpnext_financial_report] 'report' is required");
      }
      if (!(FINANCIAL_REPORTS as readonly string[]).includes(report)) {
        throw new Error(
          `[erpnext_financial_report] '${report}' is not one of the standard financial reports. ` +
            `Choose one of: ${FINANCIAL_REPORTS.join(", ")}.`,
        );
      }

      const filters = (input.filters ?? {}) as Record<string, unknown>;
      if (typeof filters !== "object" || Array.isArray(filters)) {
        throw new Error(
          "[erpnext_financial_report] 'filters' must be an object of report filter values",
        );
      }

      const limit = (input.limit as number) ?? DEFAULT_REPORT_ROWS;
      const result = await runQueryReport(ctx, report, filters);
      const rows = result.result;

      return {
        report,
        filters,
        columns: result.columns,
        // `count` là tổng dòng báo cáo trả về, `returned` là số dòng thật sự nằm dưới đây.
        // Cắt bớt luôn được nói ra, vì một bảng bị cắt im lặng đọc y hệt một bảng đầy đủ.
        count: rows.length,
        returned: Math.min(rows.length, limit),
        has_more: rows.length > limit,
        rows: rows.slice(0, limit),
        ...(result.report_summary
          ? { report_summary: result.report_summary }
          : {}),
        ...(result.message ? { message: result.message } : {}),
      };
    },
  },
];
