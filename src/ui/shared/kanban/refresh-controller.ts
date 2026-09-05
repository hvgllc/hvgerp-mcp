import {
  canRequestBoardRefresh,
  kanbanRequestIdentity,
  resolveKanbanRefreshRequest,
} from "./refresh.ts";
import type { KanbanRefreshRequestData } from "./refresh.ts";
import type { KanbanBoardData } from "./types.ts";

export interface BoardMutationToken {
  session: number;
  id: symbol;
}

export interface BoardRefreshPorts {
  read(request: KanbanRefreshRequestData): Promise<KanbanBoardData>;
  apply(board: KanbanBoardData): void;
  gate(): {
    visibilityState: string;
    dragging: boolean;
    processingMove: boolean;
    queuedMoves: number;
    available: boolean;
  };
  now(): number;
  minIntervalMs: number;
}

export function createBoardRefreshController(ports: BoardRefreshPorts) {
  let board: KanbanBoardData | null = null;
  let fallback: KanbanRefreshRequestData | null = null;
  let session = 0;
  let generation = 0;
  let waitingForHost = false;
  let recoveringHost = false;
  let inFlight = false;
  let pending = false;
  let force = false;
  let lastStarted = 0;
  let retryAt = 0;
  const mutations = new Set<symbol>();
  const detailQueues = new Map<string, Promise<void>>();

  function update(next: KanbanBoardData) {
    board = next;
    ports.apply(next);
  }
  function currentRequest() {
    // Khi host lỗi, board cũ chỉ để hiển thị; retry phải theo input mới.
    return recoveringHost
      ? fallback
      : resolveKanbanRefreshRequest(board, fallback);
  }
  async function drain(): Promise<boolean> {
    if (!pending || waitingForHost || mutations.size > 0) return false;
    const refresh = currentRequest();
    const gate = ports.gate();
    if (
      ports.now() < retryAt || !gate.available || !canRequestBoardRefresh({
        ...gate,
        board,
        request: refresh,
        refreshInFlight: inFlight,
        now: ports.now(),
        lastRefreshStartedAt: lastStarted,
        minIntervalMs: ports.minIntervalMs,
      }, { ignoreInterval: force, allowWithoutBoard: recoveringHost }) ||
      !refresh
    ) return false;
    const captured = {
      session,
      generation,
      recoveringHost,
      identity: kanbanRequestIdentity(recoveringHost ? null : board, refresh),
    };
    const request = structuredClone(refresh);
    inFlight = true;
    pending = false;
    force = false;
    lastStarted = ports.now();
    let failed = false;
    try {
      const next = await ports.read(request);
      const latestRequest = currentRequest();
      if (
        captured.session !== session || captured.generation !== generation ||
        waitingForHost || mutations.size > 0 || !latestRequest ||
        captured.recoveringHost !== recoveringHost ||
        captured.identity !==
          kanbanRequestIdentity(recoveringHost ? null : board, latestRequest) ||
        ports.gate().dragging
      ) {
        pending = true;
        force = true;
        return false;
      }
      // Response cùng lượt đọc không được âm thầm chuyển sang filter/trang khác.
      if (
        kanbanRequestIdentity(
          captured.recoveringHost ? null : next,
          resolveKanbanRefreshRequest(next, null)!,
        ) !== captured.identity
      ) {
        throw new Error("Board refresh response identity mismatch");
      }
      recoveringHost = false;
      update(next);
      return true;
    } catch {
      pending = true;
      failed = captured.session === session &&
        captured.generation === generation;
      // Chỉ retry theo interval/focus thật; finally không tự quay vòng khi lỗi.
      if (failed) {
        retryAt = lastStarted + ports.minIntervalMs;
      }
      return false;
    } finally {
      inFlight = false;
      if (!failed) void drain();
    }
  }
  function request(options: { ignoreInterval?: boolean } = {}) {
    pending = true;
    force ||= options.ignoreInterval === true;
    if (options.ignoreInterval) retryAt = 0;
    return drain();
  }
  function beginMutation(): BoardMutationToken {
    generation++;
    const token = { session, id: Symbol() };
    mutations.add(token.id);
    pending = true;
    force = true;
    return token;
  }
  function endMutation(token: BoardMutationToken) {
    if (!mutations.delete(token.id)) return;
    pending = true;
    force = true;
    retryAt = 0;
    void drain();
  }
  return {
    update,
    request,
    receiveBoard(next: KanbanBoardData) {
      if (
        (waitingForHost || recoveringHost) && fallback &&
        kanbanRequestIdentity(null, fallback) !==
          kanbanRequestIdentity(null, resolveKanbanRefreshRequest(next, null)!)
      ) throw new Error("Host board response identity mismatch");
      session++;
      waitingForHost = false;
      recoveringHost = false;
      pending ||= inFlight || mutations.size > 0;
      force = pending;
      retryAt = 0;
      update(next);
      void drain();
    },
    receiveInput(next: KanbanRefreshRequestData | null) {
      session++;
      waitingForHost = true;
      recoveringHost = false;
      fallback = next ? structuredClone(next) : null;
      pending ||= inFlight || mutations.size > 0;
      force = pending;
      retryAt = 0;
    },
    failHost() {
      if (!waitingForHost && !recoveringHost) return;
      waitingForHost = false;
      recoveringHost = true;
      pending = fallback !== null;
      force = false;
      retryAt = ports.now() + ports.minIntervalMs;
    },
    beginMutation,
    runDetailMutation<T>(
      doctype: string,
      cardId: string,
      operation: (token: BoardMutationToken) => Promise<T>,
    ): Promise<T> {
      // Giữ token ngay lúc enqueue; chỉ tuần tự hóa detail cùng document, không khóa move.
      const token = beginMutation();
      const key = JSON.stringify([doctype, cardId]);
      const previous = detailQueues.get(key);
      const execute = async () => {
        try {
          return await operation(token);
        } finally {
          endMutation(token);
        }
      };
      const result = previous ? previous.then(execute) : execute();
      // Chain nội bộ luôn settle để lỗi một write không chặn write đã yêu cầu sau nó.
      const settled = result.then(() => {}, () => {});
      detailQueues.set(key, settled);
      void settled.then(() => {
        if (detailQueues.get(key) === settled) detailQueues.delete(key);
      });
      return result;
    },
    isCurrent(token: BoardMutationToken) {
      return token.session === session;
    },
    endMutation,
    drain,
    get board() {
      return board;
    },
    get pending() {
      return pending;
    },
    get ready() {
      return board !== null && !waitingForHost && !recoveringHost;
    },
  };
}
