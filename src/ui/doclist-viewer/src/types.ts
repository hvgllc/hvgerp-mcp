/** Doclist Viewer types */

import type { UiRefreshRequestData } from "~/shared/refresh";

/** Server-driven row action — injected in tool payload to make rows clickable */
export interface RowAction {
  toolName: string;
  idField: string;
  argName: string;
  /** Extra static args merged into every callServerTool call (e.g. { doctype: "Campaign" }) */
  extraArgs?: Record<string, unknown>;
}

/** Navigation hint for sendMessage cross-viewer links */
export interface SendMessageHint {
  label: string;
  message: string;
}

export interface DoclistData {
  /**
   * Total matching the query, or `null` when the server could not establish one.
   * Never fall back to the page length here: a page is what got returned, and
   * printing it as the total is a lie precisely when the list IS truncated.
   */
  count: number | null;
  /** Why `count` is null, when it is. */
  count_error?: string;
  doctype?: string;
  _title?: string;
  data: Record<string, unknown>[];
  refreshRequest?: UiRefreshRequestData;
  _rowAction?: RowAction;
  _sendMessageHints?: SendMessageHint[];
}

export type SortDir = "asc" | "desc";
