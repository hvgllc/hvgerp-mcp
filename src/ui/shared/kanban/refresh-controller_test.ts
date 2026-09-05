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

function fixture() {
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
  controller.receiveBoard(rendered);
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
