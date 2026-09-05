import type { KanbanBoardData } from "./types.ts";

export interface KanbanRefreshRequestData {
  toolName: string;
  arguments: Record<string, unknown>;
}

function canonicalArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalArguments);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalArguments(item)]),
    );
  }
  return value;
}

export function kanbanRequestIdentity(
  board: KanbanBoardData,
  request: KanbanRefreshRequestData,
): string {
  return JSON.stringify([
    board.boardId,
    board.doctype,
    request.toolName,
    canonicalArguments(request.arguments),
  ]);
}

export interface KanbanRefreshGate {
  board: KanbanBoardData | null;
  request: KanbanRefreshRequestData | null;
  visibilityState: string;
  dragging: boolean;
  processingMove: boolean;
  queuedMoves: number;
  refreshInFlight: boolean;
  now: number;
  lastRefreshStartedAt: number;
  minIntervalMs: number;
}

export function canRequestBoardRefresh(
  gate: KanbanRefreshGate,
  options: { ignoreInterval?: boolean } = {},
): boolean {
  if (!gate.board || !gate.request) {
    return false;
  }

  if (gate.visibilityState !== "visible") {
    return false;
  }

  if (
    gate.dragging || gate.processingMove || gate.queuedMoves > 0 ||
    gate.refreshInFlight
  ) {
    return false;
  }

  if (options.ignoreInterval) {
    return true;
  }

  return gate.now - gate.lastRefreshStartedAt >= gate.minIntervalMs;
}

export function resolveKanbanRefreshRequest(
  board: KanbanBoardData | null,
  fallback: KanbanRefreshRequestData | null,
): KanbanRefreshRequestData | null {
  if (board) {
    return {
      toolName: "erpnext_kanban_get_board",
      arguments: board.refreshArguments,
    };
  }

  return fallback;
}
