import type { KanbanBoardData, KanbanCardData } from "./types.ts";

export interface QueuedKanbanMove {
  queueId?: string;
  doctype: string;
  moveToolName: string;
  cardId: string;
  fromColumn: string;
  toColumn: string;
}

function recalculateColumns(
  board: KanbanBoardData,
  cards: KanbanCardData[],
): KanbanBoardData["columns"] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    counts.set(card.columnId, (counts.get(card.columnId) ?? 0) + 1);
  }

  return board.columns.map((column) => ({
    ...column,
    count: counts.get(column.id) ?? 0,
  }));
}

export function applyOptimisticMove(
  board: KanbanBoardData,
  move: QueuedKanbanMove,
): {
  board: KanbanBoardData;
  snapshot: KanbanBoardData;
} {
  const cards = board.cards.map((card) =>
    card.id === move.cardId
      ? { ...card, columnId: move.toColumn, pending: true }
      : card
  );

  return {
    snapshot: board,
    board: {
      ...board,
      cards,
      columns: recalculateColumns(board, cards),
    },
  };
}

// Host có thể đã đọc board trước khi write đang chạy kịp ghi, nên bản trả về
// mang vị trí cũ và không có cờ pending. Giữ lại các thẻ đang chờ của board hiện
// tại để thẻ không nhảy ngược và mở lại thao tác kéo khi move chưa xong.
export function preservePendingMoves(
  previous: KanbanBoardData,
  next: KanbanBoardData,
): KanbanBoardData {
  const held = new Map(
    previous.cards.filter((card) => card.pending).map((
      card,
    ) => [card.id, card]),
  );
  if (held.size === 0) return next;
  let changed = false;
  const cards = next.cards.map((card) => {
    const pendingCard = held.get(card.id);
    if (!pendingCard) return card;
    changed = true;
    return { ...card, columnId: pendingCard.columnId, pending: true };
  });
  if (!changed) return next;
  return { ...next, cards, columns: recalculateColumns(next, cards) };
}

export function reconcileMoveSuccess(
  board: KanbanBoardData,
  result: {
    ok?: boolean;
    cardId: string;
    fromColumn?: string;
    toColumn: string;
    serverCard?: KanbanCardData;
  },
): KanbanBoardData {
  const cards = board.cards.map((card) => {
    if (card.id !== result.cardId) return card;
    if (result.serverCard) {
      return { ...result.serverCard, pending: false };
    }
    return { ...card, columnId: result.toColumn, pending: false };
  });

  return {
    ...board,
    cards,
    columns: recalculateColumns(board, cards),
  };
}

export function rollbackMoveFailure(
  snapshot: KanbanBoardData,
  _result: {
    ok?: boolean;
    cardId?: string;
    fromColumn?: string;
    toColumn?: string;
    errorMessage?: string;
  },
): KanbanBoardData {
  return snapshot;
}

export function enqueueMove(
  queue: QueuedKanbanMove[],
  move: QueuedKanbanMove,
): QueuedKanbanMove[] {
  return [...queue, move];
}

export function takeNextQueuedMove(queue: QueuedKanbanMove[]): {
  nextMove: QueuedKanbanMove | undefined;
  restQueue: QueuedKanbanMove[];
} {
  const [nextMove, ...restQueue] = queue;
  return { nextMove, restQueue };
}

export function canDropCardInColumn(
  board: KanbanBoardData,
  cardId: string,
  toColumn: string,
): boolean {
  const card = board.cards.find((candidate) => candidate.id === cardId);
  if (!card || card.pending || card.columnId === toColumn) {
    return false;
  }

  return board.allowedTransitions.some((transition) =>
    transition.allowed &&
    transition.fromColumn === card.columnId &&
    transition.toColumn === toColumn
  );
}
