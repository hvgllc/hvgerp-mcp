/**
 * Chạy báo cáo tài chính chuẩn của ERPNext qua `frappe.desk.query_report.run`.
 *
 * Vì sao phải đi đường báo cáo chứ không tự cộng sổ cái: bản Frappe trên site này từ chối
 * hàm gộp dạng chuỗi trong `fields` của `get_list` (`ValidationError: Không cho phép hàm SQL
 * dạng chuỗi trong SELECT: sum(debit) as debit`), nên không có cách nào GROUP BY phía máy chủ
 * qua REST. Tự cộng phía client thì phải kéo về toàn bộ GL Entry của kỳ, tức là không có
 * chặn trên. Báo cáo "Profit and Loss Statement" lấy dữ liệu từ chính GL Entry, đã gộp sẵn
 * theo kỳ, và chạy qua đúng bộ quyền của người gọi.
 *
 * @module lib/erpnext/tools/query-report
 */

import type { ErpNextToolContext } from "./types.ts";

/**
 * Các báo cáo tài chính chuẩn được phép chạy qua tool.
 *
 * Danh sách đóng chứ không mở, vì `query_report.run` chạy được mọi Report kể cả Query Report
 * và Script Report do người dùng tự viết: mở tự do là biến một tool đọc báo cáo thành một
 * đường chạy mã tùy ý trên site. Mười ba tên dưới đây đã đối chiếu metadata thật: đều là
 * Script Report chuẩn, `disabled = 0`, và `prepared_report = 0`.
 */
export const FINANCIAL_REPORTS = [
  "Accounts Payable",
  "Accounts Payable Summary",
  "Accounts Receivable",
  "Accounts Receivable Summary",
  "Balance Sheet",
  "Cash Flow",
  "Customer Ledger Summary",
  "Financial Ratios",
  "General Ledger",
  "Gross Profit",
  "Profit and Loss Statement",
  "Supplier Ledger Summary",
  "Trial Balance",
] as const;

export type FinancialReportName = typeof FINANCIAL_REPORTS[number];

/** Một cột trong kết quả báo cáo. Frappe còn gắn thêm khoá riêng từng báo cáo. */
export interface QueryReportColumn {
  fieldname?: string;
  label?: string;
  fieldtype?: string;
  options?: string;
  [key: string]: unknown;
}

/** Một dòng kết quả. Script Report tài chính trả dict; dòng tổng tổng hợp cũng vậy. */
export type QueryReportRow = Record<string, unknown>;

/** Một ô trong dải tóm tắt phía trên báo cáo. */
export interface QueryReportSummaryEntry {
  label?: string;
  value?: unknown;
  datatype?: string;
  currency?: string;
  indicator?: string;
  [key: string]: unknown;
}

/** Phần kết quả của `query_report.run` mà phía tool thực sự đọc. */
export interface QueryReportResult {
  columns: QueryReportColumn[];
  result: QueryReportRow[];
  report_summary?: QueryReportSummaryEntry[];
  message?: unknown;
  chart?: unknown;
  add_total_row?: unknown;
  skip_total_row?: unknown;
  execution_time?: unknown;
  status?: unknown;
}

/**
 * Chạy một báo cáo chuẩn và trả kết quả đã kiểm hình dạng.
 *
 * `ignore_prepared_report: true` là bắt buộc, không phải tùy chọn hiệu năng. Thiếu nó,
 * `run()` có thể rẽ sang `queue_prepared_report()`, và hàm đó **chèn một bản ghi Prepared
 * Report**: một tool khai `readOnlyHint: true` sẽ âm thầm ghi lên site sản xuất mỗi lần
 * người dùng xem báo cáo. Đã đo trên production: với cờ này, số dòng Prepared Report giữ
 * nguyên 0 qua mọi lần chạy.
 */
export async function runQueryReport(
  ctx: ErpNextToolContext,
  reportName: string,
  filters: Record<string, unknown>,
): Promise<QueryReportResult> {
  const raw = await ctx.client.callMethod<unknown>(
    "frappe.desk.query_report.run",
    {
      report_name: reportName,
      filters,
      ignore_prepared_report: true,
    },
    { httpMethod: "GET" },
  );

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `frappe.desk.query_report.run on '${reportName}' returned ${
        JSON.stringify(raw)
      }, which is not a report result. Do not read any number out of this call.`,
    );
  }

  const envelope = raw as Record<string, unknown>;
  const columns = envelope.columns;
  const rows = envelope.result;
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new Error(
      `frappe.desk.query_report.run on '${reportName}' returned keys [${
        Object.keys(envelope).sort().join(", ")
      }] with no usable 'columns'/'result' arrays. Do not read any number out ` +
        "of this call.",
    );
  }

  return {
    ...envelope,
    columns: columns as QueryReportColumn[],
    result: rows as QueryReportRow[],
  } as QueryReportResult;
}

/**
 * Các cột kỳ của một báo cáo tài chính theo kỳ (tháng, quý, năm).
 *
 * Nhận diện theo `fieldtype === "Currency"` chứ không theo nhãn: nhãn cột đã qua `_()` nên
 * trên site tiếng Việt nó ra "thg 3 2026", còn `fieldname` giữ nguyên dạng `mar_2026`. Cột
 * `total` bị loại vì nó là tổng của chính các cột kia, cộng vào là đếm hai lần.
 */
export function periodColumns(
  result: QueryReportResult,
): { fieldname: string; label: string }[] {
  const periods: { fieldname: string; label: string }[] = [];
  for (const column of result.columns) {
    const fieldname = column.fieldname;
    if (typeof fieldname !== "string" || fieldname === "") continue;
    if (column.fieldtype !== "Currency") continue;
    if (fieldname === "total") continue;
    periods.push({
      fieldname,
      label: typeof column.label === "string" && column.label !== ""
        ? column.label
        : fieldname,
    });
  }
  return periods;
}

/**
 * Giá trị số của một ô, hoặc 0 khi ô trống.
 *
 * `Number()` một mình quá rộng: nó biến `null`, `""` và `[]` thành 0, nên một ô hỏng sẽ
 * lẫn vào giữa những ô thật sự bằng 0. Chỉ số, hoặc chuỗi toàn số, mới được nhận; còn lại
 * trả `null` để nơi gọi tự quyết định là bỏ qua hay báo lỗi.
 */
export function cellNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
