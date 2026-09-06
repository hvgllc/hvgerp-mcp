import { assertEquals } from "@std/assert";
import { createBoardRefreshController } from "./refresh-controller.ts";
import type { BoardMutationToken } from "./refresh-controller.ts";
import type { KanbanRefreshRequestData } from "./refresh.ts";
import {
  applyOptimisticMove,
  reconcileMoveSuccess,
  rollbackMoveFailure,
} from "./interactions.ts";
import type { KanbanBoardData } from "./types.ts";
import { kanbanTools } from "../../../tools/kanban.ts";
import type { FrappeClient } from "../../../api/frappe-client.ts";

function boardFixture(): KanbanBoardData {
  return {
    boardId: "task-board",
    title: "Board A",
    doctype: "Task",
    generatedAt: "2026-09-05T00:00:00.000Z",
    moveToolName: "erpnext_kanban_move_card",
    refreshArguments: { doctype: "Task", project: "A", offset: 0, limit: 50 },
    cards: [1, 2].map((id) => ({
      id: `TASK-A-${id}`,
      title: `Task ${id}`,
      columnId: "Open",
    })),
    columns: [
      { id: "Open", label: "Open", color: "blue", count: 2 },
      { id: "Working", label: "Working", color: "orange", count: 0 },
    ],
    allowedTransitions: [{
      fromColumn: "Open",
      toColumn: "Working",
      allowed: true,
    }],
    capabilities: { canMoveCards: true },
    pagination: { offset: 0, limit: 50, loadedCount: 2, hasMore: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (
  const input of [
    { doctype: "Task" },
    { doctype: "Issue", status: "Open" },
    { doctype: "Opportunity", status: "Quotation" },
    { doctype: "Task", project: "A", limit: 1.9, offset: -3 },
  ]
) {
  Deno.test(`host input accepts real handler normalized defaults ${JSON.stringify(input)}`, async () => {
    const actual = await kanbanTools[0].handler(input, {
      client: { list: () => Promise.resolve([]) } as unknown as FrappeClient,
    }) as KanbanBoardData;
    const f = fixture();
    f.controller.receiveInput({
      toolName: "erpnext_kanban_get_board",
      arguments: input,
    });
    f.controller.receiveBoard(actual);
    assertEquals(f.controller.ready, true);
    const cold = fixture(false);
    cold.controller.receiveInput({
      toolName: "erpnext_kanban_get_board",
      arguments: input,
    });
    cold.controller.failHost();
    const retry = cold.controller.request({ ignoreInterval: true });
    assertEquals(cold.calls[0].request.arguments, input);
    cold.calls[0].resolve(actual);
    assertEquals(await retry, true);
    assertEquals(cold.rendered, actual);
  });
}

function fixture(initialBoard = true) {
  const calls: Array<
    ReturnType<typeof deferred<KanbanBoardData>> & {
      request: KanbanRefreshRequestData;
    }
  > = [];
  let rendered = boardFixture();
  const gate = {
    visibilityState: "visible",
    dragging: false,
    processingMove: false,
    queuedMoves: 0,
    available: true,
  };
  const clock = { now: 20_000 };
  const controller = createBoardRefreshController({
    read(request) {
      const call = { ...deferred<KanbanBoardData>(), request };
      calls.push(call);
      return call.promise;
    },
    apply(board) {
      rendered = board;
    },
    gate: () => gate,
    now: () => clock.now,
    minIntervalMs: 15_000,
  });
  if (initialBoard) controller.receiveBoard(rendered);
  function move(cardId = "TASK-A-1") {
    const token = controller.beginMutation();
    const move = {
      cardId,
      doctype: "Task",
      moveToolName: "erpnext_kanban_move_card",
      fromColumn: "Open",
      toColumn: "Working",
    };
    const optimistic = applyOptimisticMove(controller.board!, move);
    controller.update(optimistic.board);
    return { token, move, snapshot: optimistic.snapshot };
  }
  function succeed(mutation: ReturnType<typeof move>) {
    if (controller.isCurrent(mutation.token)) {
      controller.update(reconcileMoveSuccess(controller.board!, mutation.move));
    }
    controller.endMutation(mutation.token);
  }
  return {
    controller,
    calls,
    clock,
    gate,
    move,
    succeed,
    get rendered() {
      return rendered;
    },
    finish(token: BoardMutationToken) {
      controller.endMutation(token);
    },
  };
}

for (const hostFirst of [false, true]) {
  for (const hidden of [false, true]) {
    Deno.test(`unusable host input keeps mutation reconciliation hostFirst=${hostFirst} hidden=${hidden}`, async () => {
      const f = fixture();
      const mutation = f.move();
      assertEquals(f.controller.receiveInput(null), false);
      assertEquals(f.controller.isCurrent(mutation.token), true);
      f.gate.visibilityState = hidden ? "hidden" : "visible";
      if (hostFirst) f.controller.failHost();
      f.succeed(mutation);
      if (!hostFirst) f.controller.failHost();
      assertEquals(f.calls.length, hidden ? 0 : 1);
      if (hidden) {
        f.gate.visibilityState = "visible";
        void f.controller.drain();
      }
      assertEquals(
        f.calls[0].request.arguments,
        boardFixture().refreshArguments,
      );
      f.calls[0].resolve(f.rendered);
      await Promise.resolve();
      assertEquals(f.controller.ready, true);
      assertEquals(f.controller.pending, false);
      f.controller.receiveInput(null);
      f.controller.failHost();
      await f.controller.request({ ignoreInterval: true });
      assertEquals(
        f.calls.length,
        1,
        "settled mutation must not authorize later invalid-input retries",
      );
    });
  }
}
Deno.test("unusable input after valid B retains B rather than reverting mutation correction to A", async () => {
  const f = fixture();
  const mutation = f.move();
  const b = {
    ...boardFixture(),
    title: "B",
    refreshArguments: { doctype: "Task", project: "B", offset: 50 },
  };
  assertEquals(
    f.controller.receiveInput({
      toolName: "erpnext_kanban_get_board",
      arguments: b.refreshArguments,
    }),
    true,
  );
  f.controller.receiveInput(null);
  f.controller.failHost();
  assertEquals(f.controller.isCurrent(mutation.token), false);
  f.succeed(mutation);
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].request.arguments, b.refreshArguments);
  f.calls[0].resolve(b);
  await Promise.resolve();
  assertEquals(f.rendered, b);
});

for (const oldFails of [false, true]) {
  Deno.test(`failed host retries B without overlapping or applying A oldFails=${oldFails}`, async () => {
    const f = fixture();
    const old = f.controller.request();
    const b = {
      ...boardFixture(),
      title: "Board B",
      doctype: "Issue",
      boardId: "issue-board",
      refreshArguments: { doctype: "Issue", offset: 50 },
    };
    f.controller.receiveInput({
      toolName: "erpnext_kanban_get_board",
      arguments: b.refreshArguments,
    });
    f.controller.failHost();
    assertEquals(f.controller.ready, false);
    await f.controller.request({ ignoreInterval: true });
    assertEquals(f.calls.length, 1);
    if (oldFails) f.calls[0].reject(new Error("Old A failed"));
    else f.calls[0].resolve(boardFixture());
    await old;
    assertEquals(f.rendered.title, "Board A");
    assertEquals(f.calls.length, 2);
    assertEquals(f.calls[1].request.arguments, b.refreshArguments);
    f.calls[1].resolve(b);
    await Promise.resolve();
    assertEquals(f.rendered, b);
    assertEquals(f.controller.ready, true);
  });
}

Deno.test("failed host cold retry observes hidden, interval and read-error backoff", async () => {
  const f = fixture(false);
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: boardFixture().refreshArguments,
  });
  f.controller.failHost();
  await f.controller.drain();
  await f.controller.request();
  assertEquals(f.calls.length, 0);
  f.clock.now += 15_000;
  f.gate.visibilityState = "hidden";
  await f.controller.request();
  assertEquals(f.calls.length, 0);
  f.gate.visibilityState = "visible";
  const retry = f.controller.request();
  f.calls[0].reject(new Error("Retry failed"));
  await retry;
  await f.controller.drain();
  assertEquals(f.calls.length, 1);
  assertEquals(f.controller.ready, false);
  f.clock.now += 15_000;
  const again = f.controller.request();
  f.calls[1].resolve(boardFixture());
  assertEquals(await again, true);
  assertEquals(f.controller.ready, true);
});

Deno.test("failed host cannot fall back to A when input request is missing", async () => {
  const f = fixture();
  f.controller.receiveInput(null);
  f.controller.failHost();
  await f.controller.request({ ignoreInterval: true });
  assertEquals(f.calls.length, 0);
  assertEquals(f.controller.ready, false);
  f.controller.receiveBoard(boardFixture());
  assertEquals(f.controller.ready, true);
  f.calls[0]?.resolve(boardFixture());
  await Promise.resolve();
});

Deno.test("recovery rejects an old scope response and a newer host session wins", async () => {
  const f = fixture();
  const b = {
    ...boardFixture(),
    title: "Board B",
    refreshArguments: { doctype: "Task", project: "B" },
  };
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: b.refreshArguments,
  });
  f.controller.failHost();
  const wrong = f.controller.request({ ignoreInterval: true });
  f.calls[0].resolve(boardFixture());
  assertEquals(await wrong, false);
  assertEquals(f.rendered.title, "Board A");
  assertEquals(f.controller.ready, false);
  const retry = f.controller.request({ ignoreInterval: true });
  const c = {
    ...boardFixture(),
    title: "Board C",
    refreshArguments: { doctype: "Task", project: "C" },
  };
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: c.refreshArguments,
  });
  f.controller.receiveBoard(c);
  f.calls[1].resolve(b);
  await retry;
  assertEquals(f.rendered.title, "Board C");
  assertEquals(f.calls[2].request.arguments, c.refreshArguments);
  f.calls[2].resolve(c);
  await Promise.resolve();
});

for (const recovered of [false, true]) {
  Deno.test(`latest host input rejects late payload after adoption recovered=${recovered}`, async () => {
    const f = fixture();
    const b = boardFixture();
    b.refreshArguments!.project = "B";
    const c = boardFixture();
    c.refreshArguments!.project = "C";
    for (const next of [b, c]) {
      f.controller.receiveInput({
        toolName: "erpnext_kanban_get_board",
        arguments: next.refreshArguments!,
      });
    }
    if (recovered) {
      f.controller.failHost();
      const retry = f.controller.request({ ignoreInterval: true });
      f.calls[0].resolve(c);
      assertEquals(await retry, true);
    } else f.controller.receiveBoard(c);
    const mutation = f.controller.beginMutation();
    // Kết quả lệch identity là race vô hại của host trả trễ: bỏ qua âm thầm
    // (return false), không throw, để không hiện lỗi giả cho user.
    assertEquals(f.controller.receiveBoard(b), false);
    assertEquals(f.controller.board, c);
    assertEquals(f.controller.ready, true);
    assertEquals(f.controller.isCurrent(mutation), true);
    const canonical = structuredClone(c);
    canonical.refreshArguments = { project: "C", doctype: "Task" };
    assertEquals(f.controller.receiveBoard(canonical), false);
    assertEquals(f.controller.isCurrent(mutation), true);
    f.controller.endMutation(mutation);
    assertEquals(f.calls.at(-1)!.request.arguments, canonical.refreshArguments);
    f.calls.at(-1)!.resolve(canonical);
    await Promise.resolve();
  });
}

Deno.test("stale input sequence rejects same-identity board even when fallback matches", () => {
  const f = fixture(false);
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: boardFixture().refreshArguments,
  });
  const staleSeq = f.controller.inputSeq;
  // Host báo lại input y hệt (duplicate invocation): identity không đổi
  // nhưng inputSeq vẫn phải tăng để phân biệt hai lượt.
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: { ...boardFixture().refreshArguments },
  });
  const freshSeq = f.controller.inputSeq;
  assertEquals(staleSeq === freshSeq, false);
  const stale = { ...boardFixture(), title: "Stale response" };
  const fresh = { ...boardFixture(), title: "Fresh response" };
  // Kết quả của lượt cũ về sau lượt mới: bỏ qua âm thầm dù identity khớp.
  assertEquals(f.controller.receiveBoard(stale, staleSeq), false);
  assertEquals(f.controller.board, null);
  assertEquals(f.controller.receiveBoard(fresh, freshSeq), true);
  assertEquals(f.controller.board, fresh);
});

Deno.test("wrong-scope host result must not consume the seq of the pending scope", () => {
  const f = fixture(false);
  // Hai lượt input KHÁC phạm vi dồn dập; nơi gọi chỉ giữ được seq mới nhất nên
  // kết quả của lượt cũ cũng mang seq của lượt mới. Kết quả sai phạm vi bị bỏ
  // qua, nhưng không được tiêu mất seq, nếu không kết quả thật của lượt đang
  // chờ sẽ bị chặn nhầm và board kẹt ở dữ liệu cũ cho tới lượt hồi phục sau.
  const boardB = structuredClone(boardFixture());
  boardB.title = "Board B";
  boardB.refreshArguments = { doctype: "Task", project: "B" };
  const boardC = structuredClone(boardFixture());
  boardC.title = "Board C";
  boardC.refreshArguments = { doctype: "Task", project: "C" };
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: boardB.refreshArguments,
  });
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: boardC.refreshArguments,
  });
  const sharedSeq = f.controller.inputSeq;
  assertEquals(f.controller.receiveBoard(boardB, sharedSeq), false);
  assertEquals(f.controller.board, null);
  assertEquals(f.controller.receiveBoard(boardC, sharedSeq), true);
  assertEquals(f.controller.board, boardC);
});

Deno.test("overlapping host results sharing one captured seq cannot both apply", async () => {
  const f = fixture(false);
  // Mô phỏng đúng giới hạn phía gọi (KanbanViewer.tsx): hai lượt input cùng
  // phạm vi dồn dập trước khi có kết quả nào về, nên cả hai kết quả tới sau
  // đó đều được gọi receiveBoard với CÙNG một seq (seq mới nhất tại nơi gọi,
  // do phía gọi chỉ giữ được một ref dùng chung, SDK không có id đối chiếu
  // để tách riêng từng lượt). Controller không được để lượt về sau âm thầm
  // đè lên lượt về trước chỉ vì chúng trùng seq.
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: boardFixture().refreshArguments,
  });
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: { ...boardFixture().refreshArguments },
  });
  const sharedSeq = f.controller.inputSeq;
  const arrivedFirst = { ...boardFixture(), title: "Arrived first" };
  const arrivedSecond = { ...boardFixture(), title: "Arrived second" };
  assertEquals(f.controller.receiveBoard(arrivedFirst, sharedSeq), true);
  assertEquals(f.controller.board, arrivedFirst);
  // Lượt thứ hai mang cùng seq với lượt đã áp dụng: bị coi là bản sao trễ
  // của lượt chồng lấn, bỏ qua âm thầm, giữ nguyên board đã áp dụng.
  assertEquals(f.calls.length, 0);
  assertEquals(f.controller.receiveBoard(arrivedSecond, sharedSeq), false);
  assertEquals(f.controller.board, arrivedFirst);
  // Không có cách nào biết bản nào thật sự mới hơn, nên phải xếp ngay một lượt
  // đọc lại thay vì để board đứng yên ở dữ liệu có thể đã cũ tới nhịp sau.
  assertEquals(f.calls.length, 1);
  const revalidated = { ...boardFixture(), title: "Revalidated" };
  f.calls[0].resolve(revalidated);
  await f.calls[0].promise;
  await Promise.resolve();
  assertEquals(f.controller.board, revalidated);
});

for (const hidden of [false, true]) {
  Deno.test(`host snapshot retains a completed write pending refresh hidden=${hidden}`, async () => {
    const f = fixture();
    const mutation = f.move();
    f.controller.receiveInput({
      toolName: "erpnext_kanban_get_board",
      arguments: boardFixture().refreshArguments,
    });
    f.finish(mutation.token);
    f.gate.visibilityState = hidden ? "hidden" : "visible";
    f.controller.receiveBoard(boardFixture());
    assertEquals(f.calls.length, hidden ? 0 : 1);
    if (hidden) {
      assertEquals(f.controller.pending, true);
      f.gate.visibilityState = "visible";
      void f.controller.drain();
    }
    const fresh = boardFixture();
    fresh.cards[0].columnId = "Working";
    f.calls[0].resolve(fresh);
    await Promise.resolve();
    assertEquals(f.rendered.cards[0].columnId, "Working");
    assertEquals(f.controller.pending, false);
  });
}

Deno.test("unsolicited host snapshot preserves a completed mutation blocked by drag", async () => {
  const f = fixture();
  f.gate.dragging = true;
  const mutation = f.move();
  f.succeed(mutation);
  f.controller.receiveBoard(boardFixture());
  assertEquals(f.controller.pending, true);
  assertEquals(f.calls.length, 0);
  f.gate.dragging = false;
  void f.controller.drain();
  assertEquals(f.calls.length, 1);
  f.calls[0].resolve(boardFixture());
  await Promise.resolve();
});

Deno.test("board controller rejects pre-move snapshot and drains one final read", async () => {
  const f = fixture();
  const old = f.controller.request();
  const mutation = f.move();
  f.succeed(mutation);
  assertEquals(f.rendered.cards[0].columnId, "Working");
  f.calls[0].resolve(boardFixture());
  await old;
  assertEquals(f.rendered.cards[0].columnId, "Working");
  assertEquals(f.calls.length, 2);
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
  assertEquals(f.controller.pending, false);
});

Deno.test("board controller rejects a read returning during an optimistic move", async () => {
  const f = fixture();
  const old = f.controller.request();
  const mutation = f.move();
  f.calls[0].resolve(boardFixture());
  await old;
  assertEquals(f.rendered.cards[0].columnId, "Working");
  assertEquals(f.rendered.cards[0].pending, true);
  assertEquals(f.calls.length, 1);
  f.succeed(mutation);
  assertEquals(f.calls.length, 2);
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
});

Deno.test("board controller retains mutation refresh blocked by drag", async () => {
  const f = fixture();
  const mutation = f.move();
  f.gate.dragging = true;
  f.succeed(mutation);
  assertEquals(f.controller.pending, true);
  assertEquals(f.calls.length, 0);
  f.gate.dragging = false;
  const refresh = f.controller.drain();
  assertEquals(f.calls.length, 1);
  f.calls[0].resolve(f.rendered);
  await refresh;
  assertEquals(f.controller.pending, false);
});

for (
  const blocked of ["hidden", "processing", "queue", "capability"] as const
) {
  Deno.test(`board controller preserves pending through ${blocked} gate and drains once`, async () => {
    const f = fixture();
    if (blocked === "hidden") f.gate.visibilityState = "hidden";
    if (blocked === "processing") f.gate.processingMove = true;
    if (blocked === "queue") f.gate.queuedMoves = 2;
    if (blocked === "capability") f.gate.available = false;
    await f.controller.request({ ignoreInterval: true });
    await f.controller.drain();
    assertEquals(f.calls.length, 0);
    assertEquals(f.controller.pending, true);
    f.gate.visibilityState = "visible";
    f.gate.processingMove = false;
    f.gate.queuedMoves = 0;
    f.gate.available = true;
    const request = f.controller.drain();
    void f.controller.drain();
    assertEquals(f.calls.length, 1);
    f.calls[0].resolve(f.rendered);
    await request;
    assertEquals(f.controller.pending, false);
    assertEquals(f.calls.length, 1);
  });
}

Deno.test("board controller coalesces pending requests without concurrent reads", async () => {
  const f = fixture();
  const old = f.controller.request();
  for (let i = 0; i < 10; i++) {
    await f.controller.request({ ignoreInterval: true });
  }
  assertEquals(f.calls.length, 1);
  f.calls[0].resolve(f.rendered);
  await old;
  assertEquals(f.calls.length, 2);
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
  await f.controller.drain();
  assertEquals(f.calls.length, 2);
});

for (const duration of [1_000, 20_000]) {
  Deno.test(`board controller read failure after ${duration}ms does not busy-loop`, async () => {
    const f = fixture();
    const old = f.controller.request();
    f.clock.now += duration;
    f.calls[0].reject(new Error("Read unavailable"));
    assertEquals(await old, false);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assertEquals(f.calls.length, 1);
    assertEquals(f.controller.pending, true);
    assertEquals(f.rendered.cards[0].columnId, "Open");
    f.clock.now += 15_000;
    const retry = f.controller.request();
    assertEquals(f.calls.length, 2);
    f.calls[1].resolve(f.rendered);
    assertEquals(await retry, true);
    assertEquals(f.controller.pending, false);
  });
}

Deno.test("board controller hidden after read error waits for real focus request", async () => {
  const f = fixture();
  const request = f.controller.request();
  f.gate.visibilityState = "hidden";
  f.calls[0].reject(new Error("Read failed"));
  await request;
  f.clock.now += 30_000;
  await f.controller.request();
  await f.controller.drain();
  assertEquals(f.calls.length, 1);
  f.gate.visibilityState = "visible";
  const focused = f.controller.request({ ignoreInterval: true });
  f.calls[1].resolve(f.rendered);
  await focused;
  assertEquals(f.calls.length, 2);
});

Deno.test("board controller queued writes settle before one final revalidation", async () => {
  const f = fixture();
  const old = f.controller.request();
  const first = f.move();
  const secondToken = f.controller.beginMutation();
  f.gate.queuedMoves = 1;
  f.succeed(first);
  f.calls[0].resolve(boardFixture());
  await old;
  assertEquals(f.rendered.cards[0].columnId, "Working");
  assertEquals(f.calls.length, 1);
  f.gate.queuedMoves = 0;
  const nextMove = { ...first.move, cardId: "TASK-A-2" };
  f.controller.update(applyOptimisticMove(f.rendered, nextMove).board);
  f.controller.update(reconcileMoveSuccess(f.rendered, nextMove));
  f.finish(secondToken);
  assertEquals(f.rendered.cards.map((card) => card.columnId), [
    "Working",
    "Working",
  ]);
  assertEquals(f.calls.length, 2);
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
  assertEquals(f.controller.pending, false);
});

Deno.test("board controller failed queued move preserves earlier success after stale read", async () => {
  const f = fixture();
  const first = f.move();
  const queued = f.controller.beginMutation();
  f.succeed(first);
  const move = { ...first.move, cardId: "TASK-A-2" };
  const optimistic = applyOptimisticMove(f.rendered, move);
  f.controller.update(optimistic.board);
  f.controller.update(
    rollbackMoveFailure(optimistic.snapshot, { errorMessage: "Forbidden" }),
  );
  f.finish(queued);
  assertEquals(f.rendered.cards.map((card) => card.columnId), [
    "Working",
    "Open",
  ]);
  assertEquals(f.calls.length, 1);
  f.calls[0].resolve(f.rendered);
  await Promise.resolve();
});

Deno.test("board controller failed move rollback is not overwritten by an earlier read", async () => {
  const f = fixture();
  const old = f.controller.request();
  const mutation = f.move();
  f.controller.update(
    rollbackMoveFailure(mutation.snapshot, { errorMessage: "Conflict" }),
  );
  f.finish(mutation.token);
  const stale = boardFixture();
  stale.cards[0].title = "Stale title";
  f.calls[0].resolve(stale);
  await old;
  assertEquals(f.rendered.cards[0].title, "Task 1");
  assertEquals(f.rendered.cards[0].columnId, "Open");
  assertEquals(f.calls.length, 2);
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
});

for (
  const changes of [
    { project: "B" },
    { offset: 50 },
    { priority: "High" },
    { custom_filter: { owner: "another", tags: ["x", "y"] } },
  ]
) {
  Deno.test(`board controller rejects previous session read for ${JSON.stringify(changes)}`, async () => {
    const f = fixture();
    const old = f.controller.request();
    const next = boardFixture();
    next.refreshArguments = { ...next.refreshArguments, ...changes };
    next.title = "New scope";
    next.cards = [{ ...next.cards[0], id: "NEW", title: "New scope card" }];
    f.controller.receiveBoard(next);
    f.calls[0].resolve(boardFixture());
    await old;
    assertEquals(f.rendered, next);
    assertEquals(f.calls.length, 2);
    assertEquals(f.calls[1].request.arguments, next.refreshArguments);
    f.calls[1].resolve(next);
    await Promise.resolve();
  });
}

Deno.test("board controller invalidates same-argument host sessions but not refresh results", async () => {
  const f = fixture();
  const old = f.controller.request();
  const next = boardFixture();
  next.cards[0].title = "Host pushed newer title";
  f.controller.receiveBoard(next);
  f.calls[0].resolve(boardFixture());
  await old;
  assertEquals(f.rendered.cards[0].title, next.cards[0].title);
  const refreshed = structuredClone(next);
  refreshed.generatedAt = "2026-09-06T00:00:00.000Z";
  f.calls[1].resolve(refreshed);
  await Promise.resolve();
  assertEquals(f.rendered.generatedAt, refreshed.generatedAt);
  assertEquals(f.calls.length, 2);
});

Deno.test("board controller host input invalidates read before its board payload arrives", async () => {
  const f = fixture();
  const old = f.controller.request();
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: { doctype: "Task", project: "B" },
  });
  f.calls[0].resolve({ ...boardFixture(), title: "Old read must not render" });
  await old;
  assertEquals(f.rendered.title, "Board A");
  assertEquals(f.controller.ready, false);
  assertEquals(f.calls.length, 1);
  f.controller.receiveBoard({
    ...boardFixture(),
    title: "Board B",
    refreshArguments: { doctype: "Task", project: "B" },
  });
  assertEquals(f.controller.ready, true);
  assertEquals(f.rendered.title, "Board B");
});

Deno.test("board controller mutation completion from old session cannot hydrate new board", async () => {
  const f = fixture();
  const old = f.move();
  const next = {
    ...boardFixture(),
    title: "Board B",
    refreshArguments: { project: "B", doctype: "Task" },
  };
  f.controller.receiveBoard(next);
  assertEquals(f.controller.isCurrent(old.token), false);
  f.succeed(old);
  assertEquals(f.rendered, next);
  assertEquals(f.calls.length, 1);
  assertEquals(f.calls[0].request.arguments, next.refreshArguments);
  f.calls[0].resolve(next);
  await Promise.resolve();
  f.finish(old.token);
  assertEquals(f.calls.length, 1);
});

Deno.test("board controller obsolete read error drains the completed mutation without backoff", async () => {
  const f = fixture();
  const old = f.controller.request();
  const mutation = f.move();
  f.succeed(mutation);
  f.calls[0].reject(new Error("Obsolete read failed"));
  await old;
  assertEquals(f.rendered.cards[0].columnId, "Working");
  assertEquals(f.calls.length, 2);
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
});

Deno.test("board controller new mutation clears previous read failure backoff", async () => {
  const f = fixture();
  const old = f.controller.request();
  f.calls[0].reject(new Error("Read failed"));
  await old;
  const mutation = f.move();
  f.succeed(mutation);
  assertEquals(f.calls.length, 2);
  assertEquals(f.rendered.cards[0].columnId, "Working");
  f.calls[1].resolve(f.rendered);
  await Promise.resolve();
});

Deno.test("board controller drag starting after read defers replacement until drag end", async () => {
  const f = fixture();
  const old = f.controller.request();
  f.gate.dragging = true;
  f.calls[0].resolve({ ...boardFixture(), title: "Read during drag" });
  await old;
  assertEquals(f.rendered.title, "Board A");
  assertEquals(f.controller.pending, true);
  assertEquals(f.calls.length, 1);
  f.gate.dragging = false;
  const fresh = f.controller.drain();
  f.calls[1].resolve({ ...boardFixture(), title: "Read after drag" });
  await fresh;
  assertEquals(f.rendered.title, "Read after drag");
});

Deno.test("board controller rejects wrong response scope and keeps last good board", async () => {
  const f = fixture();
  const request = f.controller.request();
  f.calls[0].resolve({ ...boardFixture(), refreshArguments: { project: "B" } });
  assertEquals(await request, false);
  assertEquals(f.rendered.title, "Board A");
  assertEquals(f.calls.length, 1);
  assertEquals(f.controller.pending, true);
});

for (const failed of [false, true]) {
  Deno.test(`detail mutation queue releases its chain after failure=${failed}`, async () => {
    const f = fixture();
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    const run = (label: string, done: Promise<string>) =>
      f.controller.runDetailMutation("Task", "A", () => {
        started.push(label);
        return done;
      });
    const one = run("first", first.promise).catch(() => "failed");
    const two = run("second", second.promise);
    assertEquals(started, ["first"]);
    if (failed) first.reject(new Error("Forbidden"));
    else first.resolve("first");
    assertEquals(await one, failed ? "failed" : "first");
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(started, ["first", "second"]);
    assertEquals(f.calls.length, 0);
    second.resolve("second");
    assertEquals(await two, "second");
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(f.calls.length, 1);
    f.calls[0].resolve(f.rendered);
    await Promise.resolve();
    const three = run("third", Promise.resolve("third"));
    // Không còn chain trong map: callback mới bắt đầu ngay, không đợi microtask cũ.
    assertEquals(started, ["first", "second", "third"]);
    assertEquals(await three, "third");
    f.calls.at(-1)!.resolve(f.rendered);
    await Promise.resolve();
  });
}

Deno.test("detail queue keys include doctype and card while move tokens remain current", async () => {
  const f = fixture();
  const done = deferred<void>();
  const started: string[] = [];
  const one = f.controller.runDetailMutation("Task", "A", (token) => {
    started.push("Task A");
    assertEquals(f.controller.isCurrent(token), true);
    return done.promise;
  });
  const move = f.move();
  const two = f.controller.runDetailMutation("Task", "B", () => {
    started.push("Task B");
    return done.promise;
  });
  const three = f.controller.runDetailMutation("Issue", "A", () => {
    started.push("Issue A");
    return done.promise;
  });
  assertEquals(started, ["Task A", "Task B", "Issue A"]);
  assertEquals(f.controller.isCurrent(move.token), true);
  f.succeed(move);
  assertEquals(f.rendered.cards[0].columnId, "Working");
  done.resolve();
  await Promise.all([one, two, three]);
  assertEquals(f.calls.length, 1);
  f.calls[0].resolve(f.rendered);
  await Promise.resolve();
});

for (
  const change of ["same", "project", "page", "boardId", "doctype"] as const
) {
  Deno.test(`host result preserves detail mutation only for identical scope ${change}`, async () => {
    const f = fixture();
    const done = deferred<void>();
    const current: boolean[] = [];
    const one = f.controller.runDetailMutation("Task", "A", async (token) => {
      await done.promise;
      current.push(f.controller.isCurrent(token));
    });
    const two = f.controller.runDetailMutation("Task", "A", (token) => {
      current.push(f.controller.isCurrent(token));
      return Promise.resolve();
    });
    const next = boardFixture();
    next.title = "New presentation title";
    next.generatedAt = "2026-09-06T00:00:00.000Z";
    if (change === "project") next.refreshArguments!.project = "B";
    if (change === "page") next.refreshArguments!.offset = 50;
    if (change === "boardId") next.boardId = "other-task-board";
    if (change === "doctype") {
      next.doctype = "Issue";
      next.refreshArguments!.doctype = "Issue";
    }
    f.controller.receiveInput({
      toolName: "erpnext_kanban_get_board",
      arguments: next.refreshArguments!,
    });
    f.controller.receiveBoard(next);
    assertEquals(f.calls.length, 0);
    done.resolve();
    await Promise.all([one, two]);
    assertEquals(current, [change === "same", change === "same"]);
    assertEquals(f.calls.length, 1);
    assertEquals(f.calls[0].request.arguments, next.refreshArguments);
    f.calls[0].resolve(next);
    await Promise.resolve();
  });
}

Deno.test("detail queue sends an old-session queued write without marking it current", async () => {
  const f = fixture();
  const done = deferred<void>();
  let queuedCurrent: boolean | undefined;
  const one = f.controller.runDetailMutation("Task", "A", () => done.promise);
  const two = f.controller.runDetailMutation("Task", "A", (token) => {
    queuedCurrent = f.controller.isCurrent(token);
    return Promise.resolve();
  });
  f.controller.receiveBoard({
    ...boardFixture(),
    title: "Board B",
    refreshArguments: { ...boardFixture().refreshArguments, project: "B" },
  });
  assertEquals(queuedCurrent, undefined);
  done.resolve();
  await Promise.all([one, two]);
  assertEquals(queuedCurrent, false);
  assertEquals(f.rendered.title, "Board B");
  assertEquals(f.calls.length, 1);
  f.calls[0].resolve(f.rendered);
  await Promise.resolve();
});

Deno.test("host hydration during a move keeps the pending card in place", () => {
  const f = fixture();
  const mutation = f.move();
  assertEquals(
    f.controller.board!.cards.find((card) => card.id === "TASK-A-1")!.columnId,
    "Working",
  );
  // Host đọc lại đúng phạm vi cũ nhưng bản đọc chưa thấy write đang chạy: nếu
  // áp nguyên bản đó thì thẻ nhảy ngược về cột cũ và mất cờ pending, thao tác
  // kéo mở lại và user gửi trùng một move rồi bị từ chối vì xung đột.
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: boardFixture().refreshArguments,
  });
  assertEquals(
    f.controller.receiveBoard(boardFixture(), f.controller.inputSeq),
    false,
  );
  const card = f.controller.board!.cards.find((item) =>
    item.id === "TASK-A-1"
  )!;
  assertEquals(card.columnId, "Working");
  assertEquals(card.pending, true);
  assertEquals(
    f.controller.board!.columns.find((column) => column.id === "Working")!
      .count,
    1,
  );
  f.succeed(mutation);
});

Deno.test("host hydration into another scope does not carry pending cards", () => {
  const f = fixture();
  const mutation = f.move();
  // Đổi phạm vi thì thẻ đang chờ thuộc board cũ, không được gán sang board mới.
  const other = {
    ...boardFixture(),
    title: "Board B",
    refreshArguments: { ...boardFixture().refreshArguments, project: "B" },
  };
  f.controller.receiveInput({
    toolName: "erpnext_kanban_get_board",
    arguments: other.refreshArguments,
  });
  assertEquals(
    f.controller.receiveBoard(other, f.controller.inputSeq),
    true,
  );
  const card = f.controller.board!.cards.find((item) =>
    item.id === "TASK-A-1"
  )!;
  assertEquals(card.columnId, "Open");
  assertEquals(card.pending, undefined);
  f.succeed(mutation);
});
