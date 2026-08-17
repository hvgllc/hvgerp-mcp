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
 * When that call fails, `count` is `null` and `count_error` says why. It is
 * never quietly replaced by the page length: doing so would re-introduce the
 * very lie described above, in the one case where the list is most likely to
 * actually be truncated.
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
  /**
   * Total matching documents visible to the caller, or `null` when the count
   * could not be resolved. `null` means UNKNOWN, never zero and never "the page
   * is all there is" - see `count_error`.
   */
  count: number | null;
  /** How many documents this page actually carries. */
  returned: number;
  /** True when there are, or may be, documents beyond this page. */
  has_more: boolean;
  /** Why `count` is `null`. Absent whenever `count` is a number. */
  count_error?: string;
  data: FrappeDoc[];
  _meta: ViewerMeta;
}

/** Outcome of a total lookup: a real number, or an explained absence. */
export interface TotalResolution {
  count: number | null;
  error?: string;
}

/**
 * Resolve the true total for a page of documents.
 *
 * A failed count is reported as unknown, never smoothed over. Returning the
 * page length here would re-create the exact defect this module exists to fix:
 * a full page would once again claim to be the whole result set, and the
 * repository forbids silent fallbacks for precisely this reason. The list
 * itself still succeeds, because a secondary count failing is not a reason to
 * throw away documents the caller already holds.
 */
export async function resolveTotal(
  ctx: ErpNextToolContext,
  doctype: string,
  filters: FrappeFilter[] | undefined,
  pageLength: number,
  limit: number,
): Promise<TotalResolution> {
  if (pageLength < limit) return { count: pageLength };
  try {
    const raw = await ctx.client.callMethod<unknown>(
      "frappe.client.get_count",
      { doctype, filters: filters ?? [] },
      { httpMethod: "GET" },
    );
    const total = Number(raw);
    // A total below the page we are holding is a contradiction, not a count.
    if (!Number.isFinite(total) || total < pageLength) {
      return {
        count: null,
        error:
          `frappe.client.get_count on '${doctype}' returned ${
            JSON.stringify(raw)
          }, ` +
          `which cannot be the total for a page of ${pageLength}. Treat the total ` +
          "as unknown; do not answer a 'how many' question from this result.",
      };
    }
    return { count: total };
  } catch (err) {
    return {
      count: null,
      error:
        `frappe.client.get_count on '${doctype}' failed (${
          err instanceof Error ? err.message : String(err)
        }). The documents below are correct but incomplete; the total is unknown, ` +
        "so do not answer a 'how many' question from this result.",
    };
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
  const total = await resolveTotal(
    ctx,
    doctype,
    options.filters,
    docs.length,
    options.limit,
  );
  return {
    doctype,
    count: total.count,
    returned: docs.length,
    // An unknown total only ever happens on a full page, and a full page may
    // well have more behind it. Erring toward "there may be more" keeps a
    // consumer that only reads this flag from concluding the list is complete.
    has_more: total.count === null ? true : total.count > docs.length,
    ...(total.error ? { count_error: total.error } : {}),
    data: docs,
    _meta: options.meta ?? DOCLIST_META,
  };
}
