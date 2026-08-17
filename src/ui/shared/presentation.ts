/**
 * Where a viewer's error belongs on screen.
 *
 * Two failures reach the same `error` state and must not reach the same
 * pixels. An error raised while the viewer already holds data is a refresh
 * that failed: what is on screen is still the last known truth, so the message
 * belongs inline beside it. An error raised before any data arrived leaves
 * nothing to show, and a viewer that falls through to its empty state there
 * tells the reader "no documents" when what actually happened is "the response
 * was broken" - the swap AGENTS.md:450-451 forbids, and the reason this rule
 * is one shared function instead of a branch order each viewer re-derives.
 */
export function getErrorPresentation(
  state: { data: unknown; error: string | null },
): {
  blockingError: string | null;
  inlineError: string | null;
} {
  if (!state.error) {
    return { blockingError: null, inlineError: null };
  }

  if (state.data) {
    return { blockingError: null, inlineError: state.error };
  }

  return { blockingError: state.error, inlineError: null };
}
