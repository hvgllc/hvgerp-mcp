import { assert } from "@std/assert";

/**
 * The rule that decides blocking vs inline is unit-tested in
 * `shared/presentation_test.ts`. What this test guards is the wiring, which
 * lives in JSX that no unit test here can render: the empty-state branch must
 * come AFTER the blocking-error branch, and the verdict must come from the
 * shared function rather than a hand-rolled condition that drifts from it.
 * Getting that order wrong is silent - the view renders, and answers a broken
 * response with "no documents", which is exactly the failure the rejection
 * upstream was added to stop reporting as an empty result.
 */
const VIEWERS: { source: string; emptyElement: string }[] = [
  {
    source: "./doclist-viewer/src/DoclistViewer.tsx",
    emptyElement: "<DoclistEmptyState",
  },
  {
    source: "./kanban-viewer/src/KanbanViewer.tsx",
    emptyElement: "<EmptyState",
  },
  {
    source: "./invoice-viewer/src/InvoiceViewer.tsx",
    emptyElement: "<InvoiceEmptyState",
  },
  {
    source: "./stock-viewer/src/StockViewer.tsx",
    emptyElement: "<StockEmptyState",
  },
  {
    source: "./chart-viewer/src/ChartViewer.tsx",
    emptyElement: "No chart data",
  },
  { source: "./kpi-viewer/src/KpiViewer.tsx", emptyElement: "No KPI data" },
  {
    source: "./funnel-viewer/src/FunnelViewer.tsx",
    emptyElement: "<FunnelEmptyState",
  },
];

Deno.test("viewers render a blocking error before falling back to the empty state", async () => {
  for (const viewer of VIEWERS) {
    const source = await Deno.readTextFile(
      new URL(viewer.source, import.meta.url),
    );

    assert(
      source.includes("getErrorPresentation"),
      `${viewer.source}: the blocking-vs-inline verdict must come from the shared getErrorPresentation`,
    );

    const blockingIndex = source.indexOf("blockingError");
    assert(
      blockingIndex >= 0,
      `${viewer.source}: no blocking-error branch is rendered`,
    );

    const emptyIndex = source.indexOf(viewer.emptyElement);
    assert(
      emptyIndex >= 0,
      `${viewer.source}: ${viewer.emptyElement} is missing`,
    );

    assert(
      blockingIndex < emptyIndex,
      `${viewer.source}: the empty state is reached before the blocking error, so a failure renders as "no documents"`,
    );
  }
});

Deno.test("five passive viewers use the tested result transition for initial and refresh results", async () => {
  for (const kind of ["invoice", "stock", "chart", "kpi", "funnel"]) {
    const name = kind === "kpi" ? "Kpi" : kind[0].toUpperCase() + kind.slice(1);
    const source = await Deno.readTextFile(
      new URL(`./${kind}-viewer/src/${name}Viewer.tsx`, import.meta.url),
    );
    const consume = source.slice(
      source.indexOf("function consumeToolResult"),
      source.indexOf("async function requestRefresh"),
    );
    assert(consume.includes(`consumeViewerResult("${kind}", result,`));
    assert(consume.includes("if (next.error) return false"));
    assert(
      consume.indexOf("if (next.error)") <
        consume.indexOf("dataRef.current = next.data"),
    );
    assert(
      consume.indexOf("if (next.error)") <
        consume.indexOf("refreshRequestRef.current = next.refreshRequest"),
    );
    const refresh = source.slice(
      source.indexOf("async function requestRefresh"),
      source.indexOf("app.ontoolresult"),
    );
    assert(
      refresh.includes("consumeToolResult(result)"),
      `${kind}: refresh must use the same tested transition`,
    );
    assert(
      /app\.ontoolresult\s*=[\s\S]*?consumeToolResult\(result\)/.test(source),
    );
    assert(
      !source.includes("JSON.parse(text)"),
      `${kind}: no unvalidated hydration bypass`,
    );
    assert(
      !source.includes("setError(null)"),
      `${kind}: only successful hydration clears the error`,
    );
  }
});

Deno.test("invoice viewer renders the validated posting or transaction date through the shared helper", async () => {
  const source = await Deno.readTextFile(
    new URL("./invoice-viewer/src/InvoiceViewer.tsx", import.meta.url),
  );
  assert(source.includes("{getInvoiceDate(data)}"));
  assert(!source.includes("{data.posting_date}"));
});
