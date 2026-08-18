/**
 * Viewer metadata constants — single source of truth for tool → viewer binding.
 *
 * Builds the MCP Apps `_meta` object that binds each tool to its viewer
 * resource. Inlined (no `@casys/mcp-compose` dependency) — only `resourceUri`
 * is needed here. Add standard MCP Apps fields (`visibility`, `csp`, …) inline
 * if required; cross-UI sync fields (`emits`/`accepts`) belong to mcp-compose
 * and are only relevant for synchronized multi-UI dashboards.
 *
 * Each binding is emitted twice, under both keys the MCP Apps SDK defines. See
 * {@link LEGACY_RESOURCE_URI_KEY} for why the deprecated one is not dead weight.
 *
 * @module lib/erpnext/tools/viewer-meta
 */

import type { MCPToolMeta } from "@casys/mcp-server";

/**
 * The deprecated flat binding key, `RESOURCE_URI_META_KEY` in the MCP Apps SDK.
 *
 * The spec-current key is the nested `_meta.ui.resourceUri`, and that is what
 * this server emitted alone until now. The SDK deprecates the flat key for
 * *authors* but still instructs *hosts* to read both:
 *
 *     const uiUri = meta?.ui?.resourceUri ?? meta?.["ui/resourceUri"];
 *
 * and its own `registerAppTool` helper writes both. This server hand-builds
 * `_meta` rather than going through that helper, so the compatibility half had
 * to be added by hand. Emitting both costs one string per tool and removes a
 * whole class of "the viewer never appeared" failure on any host that reads
 * only the legacy key.
 */
const LEGACY_RESOURCE_URI_KEY = "ui/resourceUri";

/** Tool metadata carrying the viewer binding under both keys. */
export type ViewerToolMeta =
  & MCPToolMeta
  & Record<typeof LEGACY_RESOURCE_URI_KEY, string>;

const viewer = (name: string): ViewerToolMeta => {
  const resourceUri = `ui://hvgerp-mcp/${name}`;
  return {
    ui: { resourceUri },
    [LEGACY_RESOURCE_URI_KEY]: resourceUri,
  };
};

export const DOCLIST_META = viewer("doclist-viewer");
export const INVOICE_META = viewer("invoice-viewer");
export const STOCK_META = viewer("stock-viewer");
export const CHART_META = viewer("chart-viewer");
export const KANBAN_META = viewer("kanban-viewer");
export const KPI_META = viewer("kpi-viewer");
export const FUNNEL_META = viewer("funnel-viewer");
