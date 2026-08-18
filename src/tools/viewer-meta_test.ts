/**
 * Viewer binding metadata tests.
 *
 * The binding between a tool and its viewer travels in `_meta`, and the MCP
 * Apps SDK defines two keys for it: the spec-current nested `ui.resourceUri`
 * and the deprecated flat `ui/resourceUri`. Hosts are instructed to read both,
 * and the SDK's own `registerAppTool` writes both — but this server hand-builds
 * `_meta`, so nothing but these tests stops the compatibility key from being
 * dropped by a future edit that "cleans up the deprecated field".
 *
 * @module src/tools/viewer-meta_test
 */

import { assert, assertEquals } from "@std/assert";
import { UI_VIEWERS } from "../ui/viewers.ts";
import {
  CHART_META,
  DOCLIST_META,
  FUNNEL_META,
  INVOICE_META,
  KANBAN_META,
  KPI_META,
  readViewerResourceUri,
  STOCK_META,
  viewerResourceUri,
  withoutViewerBinding,
} from "./viewer-meta.ts";

const ALL_METAS = {
  CHART_META,
  DOCLIST_META,
  FUNNEL_META,
  INVOICE_META,
  KANBAN_META,
  KPI_META,
  STOCK_META,
};

Deno.test("every viewer binding carries both the nested and the flat key", () => {
  for (const [constantName, meta] of Object.entries(ALL_METAS)) {
    const nested = meta.ui?.resourceUri;
    const flat = meta["ui/resourceUri"];

    assert(
      typeof nested === "string" && nested.length > 0,
      `${constantName} must set _meta.ui.resourceUri (the spec-current key)`,
    );
    assert(
      typeof flat === "string" && flat.length > 0,
      `${constantName} must also set _meta["ui/resourceUri"]: it is deprecated ` +
        "for authors but hosts still read it, and a host that reads only this " +
        "key renders raw JSON instead of the viewer",
    );
    assertEquals(
      flat,
      nested,
      `${constantName} points the two keys at different resources — a host ` +
        "reading either one must reach the same viewer",
    );
  }
});

Deno.test("readViewerResourceUri finds the binding under either key alone", () => {
  const uri = viewerResourceUri("doclist-viewer");

  assertEquals(readViewerResourceUri({ ui: { resourceUri: uri } }), uri);
  assertEquals(readViewerResourceUri({ "ui/resourceUri": uri }), uri);
  assertEquals(readViewerResourceUri(DOCLIST_META), uri);

  // A caller that only knew the nested key would read `null` here and conclude
  // "no binding", then ship the flat one to a host that cannot serve it.
  assertEquals(readViewerResourceUri({ other: 1 }), null);
  assertEquals(readViewerResourceUri(undefined), null);
  assertEquals(readViewerResourceUri({ ui: { resourceUri: "" } }), null);
});

Deno.test("withoutViewerBinding removes both keys, never one of them", () => {
  const stripped = withoutViewerBinding({ ...DOCLIST_META, keep: "me" });
  assertEquals(stripped, { keep: "me" });
  assertEquals(
    readViewerResourceUri(stripped ?? null),
    null,
    "a half-stripped binding still points a host at a missing resource",
  );

  // Nothing but the binding means nothing left to send: `undefined` lets the
  // caller drop `_meta` entirely instead of emitting an empty object.
  assertEquals(withoutViewerBinding({ ...DOCLIST_META }), undefined);
});

Deno.test("viewer bindings resolve to registered viewer resources", () => {
  const registered = new Set<string>(UI_VIEWERS);
  const bound = new Set<string>();

  for (const [constantName, meta] of Object.entries(ALL_METAS)) {
    const uri = meta.ui?.resourceUri ?? "";
    const prefix = "ui://hvgerp-mcp/";
    assert(
      uri.startsWith(prefix),
      `${constantName} must bind to this server's namespace, got "${uri}"`,
    );
    const viewerName = uri.slice(prefix.length);
    assert(
      registered.has(viewerName),
      `${constantName} binds to "${viewerName}", which is not in UI_VIEWERS — ` +
        "server.ts registers a resource for each UI_VIEWERS entry and nothing " +
        "else, so this binding would resolve to nothing at runtime",
    );
    bound.add(viewerName);
  }

  // The reverse direction: a viewer nobody binds to is dead weight, and more
  // usefully, this fails when a new viewer is added without its own constant.
  const unbound = UI_VIEWERS.filter((name) => !bound.has(name));
  assertEquals(
    unbound,
    [],
    `these viewers have no binding constant in viewer-meta.ts: ${
      unbound.join(", ")
    }`,
  );
});
