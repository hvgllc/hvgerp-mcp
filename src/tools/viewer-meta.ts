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
 * A binding is a promise that a resource exists. Nothing here can keep that
 * promise on its own: the viewer bundles are built separately and may be
 * missing, so {@link readViewerResourceUri} and {@link withoutViewerBinding}
 * exist to let the caller that *does* know what it serves take a binding back.
 *
 * @module lib/erpnext/tools/viewer-meta
 */

import type { MCPToolMeta } from "@casys/mcp-server";

/** Resource URI namespace for this server's viewers. */
const VIEWER_URI_PREFIX = "ui://hvgerp-mcp/";

/** The `ui://` resource URI a viewer is registered under. */
export function viewerResourceUri(viewerName: string): string {
  return `${VIEWER_URI_PREFIX}${viewerName}`;
}

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
  const resourceUri = viewerResourceUri(name);
  return {
    ui: { resourceUri },
    [LEGACY_RESOURCE_URI_KEY]: resourceUri,
  };
};

/**
 * The viewer resource a `_meta` object binds to, or `null` if it binds none.
 *
 * Reads the same two keys {@link viewer} writes, so a caller checking whether a
 * binding is servable cannot miss the half it forgot about.
 */
export function readViewerResourceUri(
  meta: object | undefined | null,
): string | null {
  if (!meta) return null;
  // `object`, not `Record<string, unknown>`: the two shapes that reach here are
  // `ViewerToolMeta` (no index signature) and a bag read off the wire, and a
  // parameter narrow enough to reject the first forces a cast at every call
  // site — where a wrong one stops being a type error.
  const bag = meta as Record<string, unknown>;
  const ui = bag.ui as { resourceUri?: unknown } | undefined | null;
  const nested = ui?.resourceUri;
  if (typeof nested === "string" && nested.length > 0) return nested;
  const flat = bag[LEGACY_RESOURCE_URI_KEY];
  return typeof flat === "string" && flat.length > 0 ? flat : null;
}

/**
 * `meta` with its viewer binding removed, or `undefined` if nothing else was in
 * it.
 *
 * Used when the bound viewer bundle is not on disk. Dropping the binding is not
 * a degradation: without it a host renders the tool result as plain JSON, which
 * is what every host did before this server bound viewers at all. Keeping a
 * binding to a resource the process cannot serve is the worse outcome, because
 * the host commits to an app frame and then fails to load it.
 *
 * Both keys go, not just the flat one — a host reading the nested key hits the
 * same missing resource.
 */
export function withoutViewerBinding(
  meta: object,
): Record<string, unknown> | undefined {
  const rest = { ...meta } as Record<string, unknown>;
  delete rest.ui;
  delete rest[LEGACY_RESOURCE_URI_KEY];
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export const DOCLIST_META = viewer("doclist-viewer");
export const INVOICE_META = viewer("invoice-viewer");
export const STOCK_META = viewer("stock-viewer");
export const CHART_META = viewer("chart-viewer");
export const KANBAN_META = viewer("kanban-viewer");
export const KPI_META = viewer("kpi-viewer");
export const FUNNEL_META = viewer("funnel-viewer");
