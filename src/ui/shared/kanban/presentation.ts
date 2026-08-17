import type { KanbanViewerState } from "./state.ts";
import type { KanbanBoardData } from "./types.ts";
import { getErrorPresentation as getViewerErrorPresentation } from "../presentation.ts";

/**
 * The rule itself is viewer-agnostic and lives in `../presentation.ts`, because
 * the doclist viewer needs the same verdict and a second copy of it is how the
 * two drift apart. This wrapper only translates: `board` is what this viewer
 * calls the data it already holds.
 */
export function getErrorPresentation(
  state: Pick<KanbanViewerState, "board" | "error">,
): {
  blockingError: string | null;
  inlineError: string | null;
} {
  return getViewerErrorPresentation({ data: state.board, error: state.error });
}

export function formatBoardSummary(
  board: Pick<
    KanbanBoardData,
    "doctype" | "moveToolName" | "cards" | "pagination"
  >,
): string {
  let countLabel: string;
  if (board.pagination.total !== undefined) {
    countLabel = `${board.pagination.total} cards`;
  } else if (board.pagination.hasMore) {
    countLabel = `${board.pagination.loadedCount}+ cards loaded`;
  } else {
    countLabel = `${board.pagination.loadedCount} cards`;
  }
  return `${countLabel} · ${board.doctype} · move tool ${board.moveToolName}`;
}

export function normalizeMoveFailureMessage(error: unknown): string {
  let raw: string;
  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === "string") {
    raw = error;
  } else {
    raw = "Move failed";
  }

  if (/timeout|timed out/i.test(raw)) {
    return "La mise a jour a expire, veuillez reessayer.";
  }

  return raw;
}
