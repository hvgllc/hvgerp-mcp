/**
 * Shared shape for every "list documents" tool result.
 *
 * `count` is the TOTAL number of matching documents the caller may see, not the
 * length of the page that was fetched. The doclist viewer already renders it
 * that way (`{sorted.length} of {data.count} records`), so returning the page
 * length there made every truncated list claim it was complete: a chart of
 * accounts with 97 rows reported "50 of 50 records" under the default limit,
 * and a model answering "how many accounts are there" read 50 as the answer.
 *
 * The total comes from `frappe.client.get_count`, which is whitelisted and runs
 * through the same DocType permissions and permission-query conditions as the
 * list itself, so it can never reveal a count the caller is not allowed to see.
 * It is only called when the page came back full: a short page already proves
 * the total equals the page length, so the common case costs no extra request.
 *
 * @module lib/erpnext/tools/list-result
 */

import type { FrappeDoc, FrappeFilter } from "../api/types.ts";
import type { ErpNextToolContext } from "./types.ts";
import { DOCLIST_META } from "./viewer-meta.ts";

/** Viewer binding carried on a tool result; shaped by `viewer-meta.ts`. */
type ViewerMeta = typeof DOCLIST_META;

export interface ListResult {
  doctype: string;
  /** Total matching documents visible to the caller. */
  count: number;
  /** How many documents this page actually carries. */
  returned: number;
  /** True when `count` exceeds `returned`, i.e. the list was cut by `limit`. */
  has_more: boolean;
  data: FrappeDoc[];
  _meta: ViewerMeta;
}

/**
 * Resolve the true total for a page of documents.
 *
 * Falls back to the page length whenever the count call fails; an approximate
 * total is never invented, and a transient error must not turn a working list
 * tool into a failing one.
 */
export async function resolveTotal(
  ctx: ErpNextToolContext,
  doctype: string,
  filters: FrappeFilter[] | undefined,
  pageLength: number,
  limit: number,
): Promise<number> {
  if (pageLength < limit) return pageLength;
  try {
    const raw = await ctx.client.callMethod<unknown>(
      "frappe.client.get_count",
      { doctype, filters: filters ?? [] },
      { httpMethod: "GET" },
    );
    const total = Number(raw);
    // A total below the page we are holding is a contradiction, not a count.
    return Number.isFinite(total) && total >= pageLength ? total : pageLength;
  } catch {
    return pageLength;
  }
}

/**
 * Build the standard list result, resolving the true total on the way.
 */
export async function listResult(
  ctx: ErpNextToolContext,
  doctype: string,
  docs: FrappeDoc[],
  options: {
    filters?: FrappeFilter[];
    limit: number;
    meta?: ViewerMeta;
  },
): Promise<ListResult> {
  const count = await resolveTotal(
    ctx,
    doctype,
    options.filters,
    docs.length,
    options.limit,
  );
  return {
    doctype,
    count,
    returned: docs.length,
    has_more: count > docs.length,
    data: docs,
    _meta: options.meta ?? DOCLIST_META,
  };
}
