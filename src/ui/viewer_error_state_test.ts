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
