import type { FrappeDoc, FrappeListOptions } from "../api/types.ts";

export const ANALYTICS_PAGE_SIZE = 1000;
export const ANALYTICS_MAX_ROWS = 100000;
export const ANALYTICS_MAX_REQUESTS = 1000;

export interface AnalyticsReadBudget {
  requests: number;
  rows: number;
}

export type AnalyticsList = (
  doctype: string,
  options: FrappeListOptions,
) => Promise<FrappeDoc[]>;

export type CompleteListOptions = Omit<
  FrappeListOptions,
  "limit" | "limit_start"
>;

export function completePageOptions(
  options: CompleteListOptions,
  offset: number,
): FrappeListOptions {
  const order = options.order_by ?? "modified desc";
  if (!/^[a-z_]+ (?:asc|desc)(?:,\s*[a-z_]+ (?:asc|desc))*$/.test(order)) {
    throw new Error("Analytics pagination requires explicit field ordering.");
  }
  return {
    ...options,
    fields: [...new Set([...(options.fields ?? []), "name"])],
    order_by: order.split(",").some((part) => part.trim().startsWith("name "))
      ? order
      : `${order}, name asc`,
    limit: ANALYTICS_PAGE_SIZE,
    limit_start: offset,
  };
}

/** Đọc hết tập được phép, không trả prefix nếu trang lỗi hoặc vượt ngân sách. */
export async function listCompleteAnalytics(
  list: AnalyticsList,
  doctype: string,
  options: CompleteListOptions,
  budget: AnalyticsReadBudget = { requests: 0, rows: 0 },
): Promise<FrappeDoc[]> {
  const result: FrappeDoc[] = [];
  const names = new Set<string>();
  for (let offset = 0;; offset += ANALYTICS_PAGE_SIZE) {
    if (budget.requests >= ANALYTICS_MAX_REQUESTS) {
      throw new Error(
        `Analytics ${doctype} cannot prove completeness within the ${ANALYTICS_MAX_REQUESTS} request safety limit.`,
      );
    }
    budget.requests++;
    const rows = await list(doctype, completePageOptions(options, offset));
    if (!Array.isArray(rows) || rows.length > ANALYTICS_PAGE_SIZE) {
      throw new Error(
        `Analytics ${doctype} returned an invalid or oversized page.`,
      );
    }
    budget.rows += rows.length;
    if (budget.rows > ANALYTICS_MAX_ROWS) {
      throw new Error(
        `Analytics ${doctype} cannot prove completeness within the ${ANALYTICS_MAX_ROWS} row safety limit.`,
      );
    }
    for (const row of rows) {
      if (
        !row || typeof row !== "object" || Array.isArray(row) ||
        typeof row.name !== "string" || row.name.trim() === ""
      ) {
        throw new Error(
          `Analytics ${doctype} returned a row without a valid name.`,
        );
      }
      if (names.has(row.name)) {
        throw new Error(
          `Analytics ${doctype} pagination did not make unique progress; data may have changed during the read.`,
        );
      }
      names.add(row.name);
      result.push(row);
    }
    // Bội đúng của page size vẫn cần trang cuối rỗng để chứng minh đã đọc hết.
    if (rows.length < ANALYTICS_PAGE_SIZE) return result;
  }
}
