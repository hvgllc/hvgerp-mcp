import { useReducer, useRef } from "react";
import {
  createDetailSessionTracker,
  type DetailSessionToken,
} from "./detail-session";
import { createKanbanInitialState, kanbanStateReducer } from "./state";
import type { KanbanBoardData } from "./types";

export function useKanbanBoard() {
  const sessions = useRef(createDetailSessionTracker()).current;
  const [state, dispatch] = useReducer(
    kanbanStateReducer,
    undefined,
    createKanbanInitialState,
  );

  return {
    state,
    startLoading() {
      dispatch({ type: "tool-input" });
    },
    hydrateBoard(board: KanbanBoardData) {
      dispatch({ type: "hydrate-board", board });
    },
    setError(message: string) {
      dispatch({ type: "tool-error", message });
    },
    selectCard(doctype: string, cardId: string) {
      const session = sessions.open(doctype, cardId);
      dispatch({ type: "select-card", session });
      return session;
    },
    isDetailSessionCurrent: sessions.isCurrent,
    hydrateDetail(
      session: DetailSessionToken,
      detail: Record<string, unknown>,
    ) {
      dispatch({ type: "hydrate-detail", session, detail });
    },
    closeDetail() {
      sessions.close();
      dispatch({ type: "close-detail" });
    },
    setDetailError(session: DetailSessionToken, message: string) {
      dispatch({ type: "detail-error", session, message });
    },
  };
}
