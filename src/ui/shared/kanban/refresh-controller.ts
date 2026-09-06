import { preservePendingMoves } from "./interactions.ts";
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
  let mutationPending = false;
  let force = false;
  let lastStarted = 0;
  let retryAt = 0;
  // Tăng ở mỗi lần host báo input mới, kể cả input trùng identity, để phân biệt
  // hai lần gọi host cùng tham số nhưng khác lượt (chống race kết quả cũ đè mới).
  let inputSeq = 0;
  // Seq của lượt receiveBoard gần nhất đã áp dụng được (đã qua cả kiểm tra seq
  // lẫn kiểm tra phạm vi). Hai lượt host cùng phạm vi chồng lấn (input A rồi
  // input B dồn dập trước khi có kết quả nào về) đều chỉ ghi nhận được seq mới
  // nhất tại nơi gọi (không phân biệt được input A hay B do phía gọi dùng
  // chung một ref, không có id đối chiếu từ SDK) nên cả hai kết quả sẽ mang
  // cùng một seq. Nếu không chặn, kết quả về sau sẽ đè lên kết quả về trước dù
  // nó có thể cũ hơn thật sự (last-write-wins không an toàn).
  let lastAcceptedSeq = 0;
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
      mutationPending = false;
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
    mutationPending = true;
    const token = { session, id: Symbol() };
    mutations.add(token.id);
    pending = true;
    force = true;
    return token;
  }
  // Dùng chung cho failHost() và cho nhánh identity lệch trong receiveBoard:
  // nếu đã có lượt khác giải quyết xong (không còn chờ/hồi phục) thì không
  // làm gì; ngược lại chuyển sang hồi phục để lần request sau tự retry.
  // Trả về true chỉ khi thật sự chuyển sang hồi phục, để nơi gọi biết lượt lỗi
  // này có còn thuộc về request đang chờ hay đã bị một lượt khác giải quyết.
  function markHostFailed() {
    if (!waitingForHost && !recoveringHost) return false;
    waitingForHost = false;
    recoveringHost = true;
    pending = fallback !== null;
    force = mutationPending && pending;
    retryAt = force ? 0 : ports.now() + ports.minIntervalMs;
    if (force) void drain();
    return true;
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
    receiveBoard(next: KanbanBoardData, seq?: number) {
      // seq là input đã ghi nhận lúc host báo input; nếu lệch nghĩa là kết quả
      // này thuộc một lượt host cũ hơn đã bị lượt sau (cùng phạm vi) đè lên.
      // Câu trả lời thật của lượt mới vẫn đang tới, không đụng vào trạng thái
      // chờ/hồi phục, chỉ bỏ qua bản sao cũ này.
      if (seq !== undefined && seq !== inputSeq) return false;
      if (
        fallback &&
        kanbanRequestIdentity(null, fallback) !==
          kanbanRequestIdentity(null, resolveKanbanRefreshRequest(next, null)!)
      ) {
        // Host trả lời sai phạm vi input hiện tại: bỏ qua âm thầm, không hiện
        // lỗi cho user, nhưng vẫn đánh dấu hồi phục nếu còn đang chờ thật sự
        // (markHostFailed tự no-op nếu một lượt khác đã giải quyết xong rồi).
        // Kiểm phạm vi phải chạy TRƯỚC khi ghi nhận seq, nếu không một kết quả
        // sai phạm vi sẽ tiêu mất seq của lượt đúng và chặn luôn kết quả thật.
        markHostFailed();
        return false;
      }
      if (seq !== undefined && seq === lastAcceptedSeq) {
        // Đúng phạm vi nhưng trùng seq với lượt đã áp dụng: hai lượt host chồng
        // lấn cùng phạm vi chỉ ghi nhận được một seq chung ở nơi gọi, nên không
        // có cách nào biết bản nào mới hơn. Giữ bản đã áp dụng thay vì để bản
        // này đè lên, đồng thời xếp một lượt đọc lại để board không kẹt ở dữ
        // liệu có thể đã cũ cho tới nhịp refresh sau.
        pending = true;
        force = true;
        retryAt = 0;
        void drain();
        return false;
      }
      if (seq !== undefined) lastAcceptedSeq = seq;
      const changed = !board || kanbanRequestIdentity(
            board,
            resolveKanbanRefreshRequest(board, null)!,
          ) !==
          kanbanRequestIdentity(next, resolveKanbanRefreshRequest(next, null)!);
      if (changed) session++;
      generation++;
      waitingForHost = false;
      recoveringHost = false;
      pending ||= inFlight || mutations.size > 0;
      force = pending;
      retryAt = 0;
      // Còn move đang chạy và host trả về đúng phạm vi cũ: giữ lại thẻ đang chờ,
      // nếu không thẻ nhảy ngược về cột cũ và mở lại thao tác kéo dù move chưa
      // xong, để user gửi trùng một move rồi bị từ chối vì xung đột.
      update(
        !changed && board && mutations.size > 0
          ? preservePendingMoves(board, next)
          : next,
      );
      void drain();
      return changed;
    },
    receiveInput(next: KanbanRefreshRequestData | null) {
      inputSeq++;
      const previous = waitingForHost || recoveringHost
        ? fallback
        : currentRequest();
      // Input không dùng được không được xóa request đọc bù cho write đã yêu cầu.
      const retained = next ?? (mutationPending ? previous : null);
      const changed = !board || !retained || kanbanRequestIdentity(
            null,
            resolveKanbanRefreshRequest(board, null)!,
          ) !== kanbanRequestIdentity(null, retained);
      if (changed) session++;
      generation++;
      waitingForHost = true;
      recoveringHost = false;
      fallback = retained ? structuredClone(retained) : null;
      pending ||= inFlight || mutations.size > 0;
      force = pending;
      retryAt = 0;
      return changed;
    },
    failHost: markHostFailed,
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
    get inputSeq() {
      return inputSeq;
    },
    get ready() {
      return board !== null && !waitingForHost && !recoveringHost;
    },
  };
}
