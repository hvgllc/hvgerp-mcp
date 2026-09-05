import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "../../../src/ui/node_modules/typescript/lib/typescript.js";

// Chạy callback component thật với hook tối thiểu, không mô phỏng DOM/Browser.
const root = path.resolve(import.meta.dirname, "../../..");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const payload = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

function harness({ initialBoard = true } = {}) {
  const slots = [];
  const effects = [];
  const calls = [];
  const cache = new Map();
  let cursor = 0;
  let captured;
  let app;
  const hooks = {
    useRef(value) {
      const index = cursor++;
      return slots[index] ??= { current: value };
    },
    useReducer(reducer, initial, init = (value) => value) {
      const index = cursor++;
      slots[index] ??= { value: init(initial) };
      return [slots[index].value, (action) => {
        slots[index].value = reducer(slots[index].value, action);
      }];
    },
    useState(initial) {
      return hooks.useReducer(
        (previous, next) => typeof next === "function" ? next(previous) : next,
        initial,
      );
    },
    useEffect(effect) {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = true;
        effects.push(effect);
      }
    },
    useCallback: (callback) => callback,
  };
  class App {
    constructor() {
      app = this;
    }
    getHostCapabilities() {
      return { serverTools: true };
    }
    getHostContext() {
      return { toolInfo: { tool: { name: "erpnext_kanban_get_board" } } };
    }
    connect() {
      return Promise.resolve();
    }
    callServerTool(request, options) {
      assert.equal(options.timeout, 10_000);
      return new Promise((resolve, reject) => {
        calls.push({ request, resolve, reject });
      });
    }
  }
  const context = vm.createContext({
    console,
    structuredClone,
    crypto: globalThis.crypto,
    Date,
    window: {
      setInterval: () => 1,
      clearInterval() {},
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
    capture(value) {
      captured = value;
    },
  });
  function load(filename) {
    if (!path.extname(filename)) {
      filename += existsSync(`${filename}.ts`) ? ".ts" : ".tsx";
    }
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    cache.set(filename, module.exports);
    let source = readFileSync(filename, "utf8");
    if (filename.endsWith("/KanbanViewer.tsx")) {
      if (process.env.KANBAN_COMPONENT_REVISION) {
        source = execFileSync("git", [
          "show",
          `${process.env.KANBAN_COMPONENT_REVISION}:src/ui/kanban-viewer/src/KanbanViewer.tsx`,
        ], { cwd: root, encoding: "utf8" });
      }
      const marker = "  if (state.loading) {";
      assert.equal(source.split(marker).length, 2);
      source = source.replace(
        marker,
        `
        capture({ state, requestMove, requestBoardRefresh, handleDragStart,
          handleDragEnd, handleDropCard, handleCardTitleClick, handleSaveDetail,
          handleAssignDetail, handleUnassignDetail });
        ${marker}`,
      );
    }
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: filename,
    }).outputText;
    const require = (specifier) => {
      if (specifier === "react") return hooks;
      if (specifier === "react/jsx-runtime") {
        return { jsx: () => null, jsxs: () => null };
      }
      if (specifier === "@modelcontextprotocol/ext-apps") return { App };
      if (specifier.endsWith("ErpNextBrand")) return {};
      if (specifier === "./DetailModal") return {};
      assert.ok(specifier.startsWith(".") || specifier.startsWith("~/"));
      return load(
        specifier.startsWith("~/")
          ? path.join(root, "src/ui", specifier.slice(2))
          : path.resolve(path.dirname(filename), specifier),
      );
    };
    vm.runInContext(
      `(function(require,module,exports){${compiled}\n})`,
      context,
      {
        filename,
      },
    )(require, module, module.exports);
    return module.exports;
  }
  const { KanbanViewer } = load(
    path.join(root, "src/ui/kanban-viewer/src/KanbanViewer.tsx"),
  );
  const fixtures = load(path.join(root, "src/ui/testing/fixtures.ts"));
  function render() {
    cursor = 0;
    KanbanViewer();
    return captured;
  }
  render();
  effects.forEach((effect) => effect());
  function send(board) {
    app.ontoolinput({ arguments: board.refreshArguments });
    app.ontoolresult(payload(board));
    render();
  }
  if (initialBoard) send(fixtures.boardFixture());
  return {
    calls,
    render,
    send,
    fixtures,
    input: (args) => app.ontoolinput({ arguments: args }),
    result: (value) => app.ontoolresult(value),
  };
}

for (const scope of ["A", "B", "page"]) {
  test(`fixture held host snapshot stays frozen ${scope}`, () => {
    const h = harness();
    const board = scope === "page"
      ? h.fixtures.pagedBoardFixture(50)
      : h.fixtures.boardFixture(scope);
    const captured = h.fixtures.captureHostBoard(board);
    const before = JSON.stringify(captured);
    board.cards[0].columnId = "Changed";
    board.refreshArguments.offset = 999;
    assert.equal(JSON.stringify(captured), before);
    captured.arguments.offset = 888;
    assert.notEqual(captured.board.refreshArguments.offset, 888);
  });
}

for (const failure of ["error", "empty", "json", "schema"]) {
  for (const scope of ["project", "page", "doctype", "cold"]) {
    test(`component failed host retries latest scope ${failure} ${scope}`, async () => {
      const h = harness({ initialBoard: scope !== "cold" });
      const a = h.fixtures.boardFixture();
      const b = h.fixtures.boardFixture("B");
      if (scope === "page") {
        b.refreshArguments = { ...a.refreshArguments, offset: 50 };
      }
      if (scope === "doctype") {
        b.doctype = "Issue";
        b.boardId = "issue-board";
        b.refreshArguments = { doctype: "Issue", status: "Open" };
      }
      h.input(b.refreshArguments);
      h.result(
        failure === "error"
          ? { isError: true, ...payload(a) }
          : failure === "empty"
          ? { content: [] }
          : failure === "json"
          ? { content: [{ type: "text", text: "{" }] }
          : payload({ wrong: true }),
      );
      assert.ok(
        h.render().state.error,
        "failed host result must become an error, not a board",
      );
      if (scope !== "cold") {
        h.render().requestMove(a.cards[0], "Working", "Start");
        assert.equal(
          h.calls.length,
          0,
          "last good board must not accept moves while recovering",
        );
      }
      const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
      assert.equal(h.calls.length, 1, "failed host input must be retryable");
      assert.deepEqual(
        JSON.parse(JSON.stringify(h.calls[0].request.arguments)),
        JSON.parse(JSON.stringify(b.refreshArguments)),
      );
      h.calls[0].resolve(payload(b));
      assert.equal(await retry, true);
      assert.equal(h.render().state.board.doctype, b.doctype);
      assert.deepEqual(
        JSON.parse(JSON.stringify(h.render().state.board.refreshArguments)),
        JSON.parse(JSON.stringify(b.refreshArguments)),
      );
    });
  }
}

for (const failure of ["throw", "tool", "business"]) {
  test(`component move failure remains visible after revalidation ${failure}`, async () => {
    const h = harness();
    h.render().requestMove(h.render().state.board.cards[0], "Working", "Start");
    if (failure === "throw") h.calls[0].reject(new Error("Permission denied"));
    else {h.calls[0].resolve(
        failure === "tool"
          ? { isError: true, ...payload({ message: "Permission denied" }) }
          : payload({ ok: false, errorMessage: "Permission denied" }),
      );}
    await tick();
    const message = h.render().state.error;
    assert.ok(message);
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve(payload(h.fixtures.boardFixture()));
    await tick();
    assert.equal(
      h.render().state.error,
      message,
      "corrective read must retain the move error",
    );
    h.send(h.fixtures.boardFixture("B"));
    assert.equal(
      h.render().state.error,
      null,
      "new host session clears previous move error",
    );
  });
}

for (const failed of [false, true]) {
  test(`component host snapshot after completed mutation still corrects failed=${failed}`, async () => {
    const h = harness();
    const a = h.fixtures.boardFixture();
    h.render().requestMove(a.cards[0], "Working", "Start");
    h.input(a.refreshArguments);
    if (failed) h.calls[0].reject(new Error("Forbidden"));
    else h.calls[0].resolve(payload({ ok: true }));
    await tick();
    assert.equal(h.calls.length, 1);
    h.result(payload(a));
    await tick();
    assert.equal(
      h.calls.length,
      2,
      "completed write still requires a corrective read after host snapshot",
    );
    const fresh = h.fixtures.boardFixture();
    if (!failed) fresh.cards[0].columnId = "Working";
    h.calls[1].resolve(payload(fresh));
    await tick();
    assert.equal(
      h.render().state.board.cards[0].columnId,
      failed ? "Open" : "Working",
    );
  });
}

for (const oldFails of [false, true]) {
  test(`component failed host discards in-flight A oldFails=${oldFails}`, async () => {
    const h = harness();
    const old = h.render().requestBoardRefresh({ ignoreInterval: true });
    const b = h.fixtures.boardFixture("B");
    h.input(b.refreshArguments);
    h.result({ isError: true, ...payload({ message: "B unavailable" }) });
    await h.render().requestBoardRefresh({ ignoreInterval: true });
    assert.equal(h.calls.length, 1);
    if (oldFails) h.calls[0].reject(new Error("A unavailable"));
    else h.calls[0].resolve(payload(h.fixtures.boardFixture()));
    await old;
    assert.equal(h.render().state.board.title, "Local board A");
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].request.arguments.project, "PROJECT-B");
    h.calls[1].resolve(payload(b));
    await tick();
    assert.equal(h.render().state.board.title, "Local board B");
    assert.equal(h.render().state.error, null);
  });
}

test("component mismatched host payload does not unlock the old board", async () => {
  const h = harness();
  const b = h.fixtures.boardFixture("B");
  h.input(b.refreshArguments);
  h.result(payload(h.fixtures.boardFixture()));
  assert.match(h.render().state.error, /identity mismatch/);
  h.render().requestMove(h.render().state.board.cards[0], "Working", "Start");
  assert.equal(h.calls.length, 0);
  const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
  assert.equal(h.calls[0].request.arguments.project, "PROJECT-B");
  h.calls[0].resolve(payload(b));
  await retry;
  assert.equal(h.render().state.board.title, "Local board B");
});

test("component a new explicit move clears the previous move failure", async () => {
  const h = harness();
  h.render().requestMove(h.render().state.board.cards[0], "Working", "Start");
  h.calls[0].reject(new Error("Forbidden"));
  await tick();
  h.calls[1].resolve(payload(h.fixtures.boardFixture()));
  await tick();
  assert.ok(h.render().state.error);
  h.render().requestMove(h.render().state.board.cards[0], "Working", "Start");
  assert.equal(h.render().state.error, null);
  h.calls[2].resolve(payload({ ok: true }));
  await tick();
  h.calls[3].resolve(payload(h.render().state.board));
  await tick();
  assert.equal(h.render().state.error, null);
});

function dragEvent() {
  const data = new Map();
  return {
    preventDefault() {},
    dataTransfer: {
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) ?? "",
    },
  };
}

for (const oldFirst of [true, false]) {
  for (const failed of [false, true]) {
    test(`component drop without source dragend drains once oldFirst=${oldFirst} failed=${failed}`, async () => {
      const h = harness();
      const old = h.render().requestBoardRefresh({ ignoreInterval: true });
      const event = dragEvent();
      h.render().handleDragStart(h.render().state.board.cards[0], event);
      h.render().handleDropCard("Working", event);
      // Thẻ đã đổi cột; không gọi dragend từ article nguồn đã bị thay thế.
      assert.equal(h.render().state.board.cards[0].columnId, "Working");
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[1].request.name, "erpnext_kanban_move_card");
      if (oldFirst) {
        h.calls[0].resolve(payload(h.fixtures.boardFixture()));
        await old;
        assert.equal(h.render().state.board.cards[0].columnId, "Working");
        assert.equal(h.calls.length, 2);
      }
      if (failed) h.calls[1].reject(new Error("Forbidden"));
      else h.calls[1].resolve(payload({ ok: true }));
      await tick();
      if (!oldFirst) {
        h.calls[0].resolve(payload(h.fixtures.boardFixture()));
        await old;
      }
      assert.equal(
        h.render().state.board.cards[0].columnId,
        failed ? "Open" : "Working",
      );
      assert.equal(h.calls.length, 3);
      assert.equal(h.calls[2].request.name, "erpnext_kanban_get_board");
      // dragend đến muộn hoặc lặp lại không tạo read song song.
      h.render().handleDragEnd();
      h.render().handleDragEnd();
      assert.equal(h.calls.length, 3);
      h.calls[2].resolve(payload(h.render().state.board));
      await tick();
      assert.equal(h.calls.length, 3);
    });
  }
}

for (
  const drop of ["empty", "malformed", "throw", "unknown", "same", "blocked"]
) {
  test(`component drop ${drop} releases pending read without dragend`, async () => {
    const h = harness();
    const old = h.render().requestBoardRefresh({ ignoreInterval: true });
    const event = dragEvent();
    h.render().handleDragStart(h.render().state.board.cards[0], event);
    h.calls[0].resolve(payload(h.fixtures.boardFixture()));
    await old;
    assert.equal(h.calls.length, 1);
    if (drop === "empty") event.dataTransfer.setData("application/json", "");
    if (drop === "malformed") {
      event.dataTransfer.setData("application/json", "{");
    }
    if (drop === "unknown") {
      event.dataTransfer.setData("application/json", '{"cardId":"missing"}');
    }
    if (drop === "throw") {
      event.dataTransfer.getData = () => {
        throw new Error("Unreadable transfer");
      };
    }
    h.render().handleDropCard(
      drop === "same" ? "Open" : drop === "blocked" ? "Completed" : "Working",
      event,
    );
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].request.name, "erpnext_kanban_get_board");
    assert.equal(h.render().state.board.cards[0].columnId, "Open");
    h.calls[1].resolve(payload(h.render().state.board));
    await tick();
    assert.equal(h.calls.length, 2);
  });
}

test("component drop begins mutation before draining an idle pending read", async () => {
  const h = harness();
  const event = dragEvent();
  h.render().handleDragStart(h.render().state.board.cards[0], event);
  await h.render().requestBoardRefresh({ ignoreInterval: true });
  assert.equal(h.calls.length, 0);
  h.render().handleDropCard("Working", event);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.name, "erpnext_kanban_move_card");
  h.calls[0].resolve(payload({ ok: true }));
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].request.name, "erpnext_kanban_get_board");
  h.calls[1].resolve(payload(h.render().state.board));
  await tick();
  assert.equal(h.calls.length, 2);
});

for (const oldFirst of [true, false]) {
  test(`component move retains actual board when old read returns first=${oldFirst}`, async () => {
    const h = harness();
    const old = h.render().requestBoardRefresh({ ignoreInterval: true });
    h.render().requestMove(h.render().state.board.cards[0], "Working", "Start");
    assert.equal(h.render().state.board.cards[0].columnId, "Working");
    assert.equal(h.calls.length, 2);
    if (oldFirst) {
      h.calls[0].resolve(payload(h.fixtures.boardFixture()));
      await old;
      assert.equal(h.render().state.board.cards[0].columnId, "Working");
    }
    h.calls[1].resolve(payload({ ok: true }));
    await tick();
    if (!oldFirst) {
      h.calls[0].resolve(payload(h.fixtures.boardFixture()));
      await old;
    }
    assert.equal(h.render().state.board.cards[0].columnId, "Working");
    assert.equal(h.calls.length, 3);
    h.calls[2].resolve(payload(h.render().state.board));
    await tick();
  });
}

test("component serial queue rolls back only failed second move and drains once", async () => {
  const h = harness();
  const cards = h.render().state.board.cards;
  h.render().requestMove(cards[0], "Working", "Start");
  h.render().requestMove(cards[1], "Working", "Start");
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(payload({ ok: true }));
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.render().state.board.cards[1].columnId, "Working");
  h.calls[1].reject(new Error("Forbidden"));
  await tick();
  assert.equal(h.render().state.board.cards[0].columnId, "Working");
  assert.equal(h.render().state.board.cards[1].columnId, "Open");
  assert.equal(h.calls.length, 3);
  h.calls[2].resolve(payload(h.render().state.board));
  await tick();
});

for (const change of ["project", "offset"]) {
  test(`component host ${change} change rejects previous board read`, async () => {
    const h = harness();
    const before = change === "offset"
      ? h.fixtures.pagedBoardFixture(0)
      : h.fixtures.boardFixture();
    const after = change === "offset"
      ? h.fixtures.pagedBoardFixture(50)
      : h.fixtures.boardFixture("B");
    h.send(before);
    const old = h.render().requestBoardRefresh({ ignoreInterval: true });
    h.send(after);
    h.calls[0].resolve(payload(before));
    await old;
    assert.equal(h.render().state.board.cards[0].id, after.cards[0].id);
    assert.equal(
      h.render().state.board.pagination.offset,
      after.pagination.offset,
    );
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve(payload(after));
    await tick();
  });
}

const detailTools = {
  Save: "erpnext_doc_update",
  Assign: "erpnext_doc_assign",
  Unassign: "erpnext_doc_unassign",
};

async function openDetail(h, index = 0) {
  const card = h.render().state.board.cards[index];
  h.render().handleCardTitleClick(card);
  h.calls.at(-1).resolve(payload({ name: card.id, subject: "Initial" }));
  await tick();
  return h.render().state.detail.session;
}

function startDetailWrite(h, session, operation, subject) {
  return h.render()[`handle${operation}Detail`](
    session,
    operation === "Save" ? { subject } : "local@example.test",
  ).then((value) => ({ value }), (error) => ({ error }));
}

async function finishDetailWrite(h, operation, call, subject, failure) {
  assert.equal(call.request.name, detailTools[operation]);
  if (failure === "write") {
    call.reject(new Error("Forbidden " + subject));
  } else {
    const doc = {
      name: call.request.arguments.name,
      subject,
      _assign: operation === "Unassign" ? "[]" : '["local@example.test"]',
    };
    const before = h.calls.length;
    call.resolve(payload(doc));
    await tick();
    if (operation === "Save") {
      const read = h.calls.slice(before).find((candidate) =>
        candidate.request.name === "erpnext_doc_get"
      );
      assert.ok(read);
      if (failure === "readback") read.reject(new Error("Readback failed"));
      else read.resolve(payload(doc));
    }
  }
  await tick();
}

for (const first of Object.keys(detailTools)) {
  for (
    const second of Object.keys(detailTools).filter((name) => name !== first)
  ) {
    test(`component overlapping detail ${first} then ${second} cannot hydrate an older response last`, async () => {
      const h = harness();
      const session = await openDetail(h);
      const firstWrite = startDetailWrite(h, session, first, "Older");
      const firstCall = h.calls.at(-1);
      const secondWrite = startDetailWrite(h, session, second, "Latest");
      if (h.calls.length === 3) {
        // Source cũ gửi song song: trả snapshot mới trước, snapshot cũ sau.
        await finishDetailWrite(h, second, h.calls[2], "Latest");
        await secondWrite;
        assert.equal(h.render().state.detail.cardDetail.subject, "Latest");
        await finishDetailWrite(h, first, firstCall, "Older");
      } else {
        assert.equal(h.calls.length, 2);
        await finishDetailWrite(h, first, firstCall, "Older");
        await finishDetailWrite(h, second, h.calls.at(-1), "Latest");
      }
      await Promise.all([firstWrite, secondWrite]);
      assert.equal(h.render().state.detail.cardDetail.subject, "Latest");
      assert.equal(h.calls.at(-1).request.name, "erpnext_kanban_get_board");
      h.calls.at(-1).resolve(payload(h.render().state.board));
      await tick();
    });
    for (const failure of ["first-write", "second-write"]) {
      test(`component overlapping detail ${first}/${second} serializes and survives ${failure}`, async () => {
        const h = harness();
        const session = await openDetail(h);
        const firstWrite = startDetailWrite(h, session, first, "Older");
        const firstCall = h.calls.at(-1);
        const secondWrite = startDetailWrite(h, session, second, "Latest");
        assert.equal(h.calls.length, 2);
        await finishDetailWrite(
          h,
          first,
          firstCall,
          "Older",
          failure === "first-write" ? "write" : undefined,
        );
        const firstResult = await firstWrite;
        assert.equal(Boolean(firstResult.error), failure === "first-write");
        assert.equal(h.calls.at(-1).request.name, detailTools[second]);
        assert.equal(
          h.calls.some((call) =>
            call.request.name === "erpnext_kanban_get_board"
          ),
          false,
        );
        await finishDetailWrite(
          h,
          second,
          h.calls.at(-1),
          "Latest",
          failure === "second-write" ? "write" : undefined,
        );
        const secondResult = await secondWrite;
        assert.equal(Boolean(secondResult.error), failure === "second-write");
        assert.equal(
          h.render().state.detail.cardDetail.subject,
          failure === "first-write" ? "Latest" : "Older",
        );
        assert.equal(h.calls.at(-1).request.name, "erpnext_kanban_get_board");
        h.calls.at(-1).resolve(payload(h.render().state.board));
        await tick();
      });
    }
  }
}

for (const operation of ["Assign", "Unassign"]) {
  test(`component detail queue survives Save readback failure before ${operation}`, async () => {
    const h = harness();
    const session = await openDetail(h);
    const save = startDetailWrite(h, session, "Save", "Saved");
    const writing = startDetailWrite(h, session, operation, "Latest");
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve(payload({ name: "TASK-A-1", subject: "Saved" }));
    await tick();
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls[2].request.name, "erpnext_doc_get");
    h.calls[2].reject(new Error("Readback failed"));
    const result = await save;
    assert.equal(result.value.saved, true);
    assert.equal(result.value.detailRefreshed, false);
    await tick();
    await finishDetailWrite(h, operation, h.calls.at(-1), "Latest");
    await writing;
    assert.equal(h.render().state.detail.cardDetail.subject, "Latest");
    assert.equal(h.render().state.detail.detailError, null);
    h.calls.at(-1).resolve(payload(h.render().state.board));
    await tick();
  });
}

test("component detail queue continues after an isError tool response", async () => {
  const h = harness();
  const session = await openDetail(h);
  const assign = startDetailWrite(h, session, "Assign", "Older");
  const save = startDetailWrite(h, session, "Save", "Latest");
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({
    isError: true,
    content: [{ type: "text", text: "Forbidden" }],
  });
  assert.match((await assign).error.message, /Forbidden/);
  await tick();
  await finishDetailWrite(h, "Save", h.calls.at(-1), "Latest");
  assert.equal((await save).value.saved, true);
  assert.equal(h.render().state.detail.cardDetail.subject, "Latest");
  h.calls.at(-1).resolve(payload(h.render().state.board));
  await tick();
});

test("component first move rollback survives a queued move and a detail mutation", async () => {
  const h = harness();
  const session = await openDetail(h);
  const cards = h.render().state.board.cards;
  h.render().requestMove(cards[0], "Working", "Start");
  h.render().requestMove(cards[1], "Working", "Start");
  const writing = startDetailWrite(h, session, "Assign", "Assigned");
  assert.equal(h.calls.length, 3);
  h.calls[1].reject(new Error("Move failed"));
  await tick();
  assert.equal(h.render().state.board.cards[0].columnId, "Open");
  assert.equal(h.render().state.board.cards[1].columnId, "Working");
  assert.equal(h.calls[3].request.arguments.card_id, "TASK-A-2");
  h.calls[3].resolve(payload({ ok: true }));
  await tick();
  assert.equal(h.calls.length, 4);
  await finishDetailWrite(h, "Assign", h.calls[2], "Assigned");
  await writing;
  assert.equal(h.render().state.board.cards[0].columnId, "Open");
  assert.equal(h.render().state.board.cards[1].columnId, "Working");
  assert.equal(h.calls.length, 5);
  h.calls[4].resolve(payload(h.render().state.board));
  await tick();
});

for (const change of ["board", "card", "reopen"]) {
  for (const failed of [false, true]) {
    test(`component detail queue keeps requested writes across ${change} switch failure=${failed}`, async () => {
      const h = harness();
      const session = await openDetail(h);
      const assign = startDetailWrite(h, session, "Assign", "Old assigned");
      const save = startDetailWrite(h, session, "Save", "Old saved");
      assert.equal(h.calls.length, 2);
      const first = h.calls[1];
      if (change === "board") h.send(h.fixtures.boardFixture("B"));
      await openDetail(h, change === "card" ? 1 : 0);
      const active = h.render().state.detail.session;
      assert.notEqual(active.generation, session.generation);
      await finishDetailWrite(
        h,
        "Assign",
        first,
        "Old assigned",
        failed ? "write" : undefined,
      );
      await assign;
      const next = h.calls.at(-1);
      assert.equal(next.request.name, "erpnext_doc_update");
      assert.equal(next.request.arguments.name, "TASK-A-1");
      await finishDetailWrite(h, "Save", next, "Old saved");
      const result = await save;
      assert.equal(result.value.saved, true);
      assert.equal(h.render().state.detail.cardDetail.subject, "Initial");
      assert.equal(h.render().state.detail.session, active);
      assert.equal(h.calls.at(-1).request.name, "erpnext_kanban_get_board");
      assert.equal(
        h.calls.at(-1).request.arguments.project,
        change === "board" ? "PROJECT-B" : "PROJECT-A",
      );
      h.calls.at(-1).resolve(payload(h.render().state.board));
      await tick();
    });
  }
}

for (const operation of ["Save", "Assign", "Unassign"]) {
  test(`component ${operation} failure preserves pending revalidation through finally`, async () => {
    const h = harness();
    h.render().handleCardTitleClick(h.render().state.board.cards[0]);
    h.calls[0].resolve(payload({ name: "TASK-A-1", subject: "Initial" }));
    await tick();
    const session = h.render().state.detail.session;
    const old = h.render().requestBoardRefresh({ ignoreInterval: true });
    const writing = h.render()[`handle${operation}Detail`](
      session,
      operation === "Save" ? { subject: "Saved" } : "local@example.test",
    );
    const rejected = assert.rejects(writing, /Forbidden/);
    h.calls[2].reject(new Error("Forbidden"));
    await rejected;
    assert.equal(h.calls.length, 3);
    h.calls[1].resolve(payload(h.fixtures.boardFixture()));
    await old;
    assert.equal(h.calls.length, 4);
    assert.equal(h.render().state.detail.cardDetail.subject, "Initial");
    h.calls[3].resolve(payload(h.render().state.board));
    await tick();
  });
  for (const switchBoard of [false, true]) {
    test(`component ${operation} settles and refreshes correct board switch=${switchBoard}`, async () => {
      const h = harness();
      h.render().handleCardTitleClick(h.render().state.board.cards[0]);
      h.calls[0].resolve(payload({ name: "TASK-A-1", subject: "Initial" }));
      await tick();
      const session = h.render().state.detail.session;
      assert.ok(session);
      const old = h.render().requestBoardRefresh({ ignoreInterval: true });
      const writing = h.render()[`handle${operation}Detail`](
        session,
        operation === "Save" ? { subject: "Saved" } : "local@example.test",
      );
      if (switchBoard) h.send(h.fixtures.boardFixture("B"));
      h.calls[1].resolve(payload(h.fixtures.boardFixture()));
      await old;
      assert.equal(h.calls.length, 3);
      h.calls[2].resolve(payload({
        name: "TASK-A-1",
        subject: "Saved",
        assignment: { assignees: ["local@example.test"], remaining: [] },
      }));
      if (operation === "Save") {
        await tick();
        assert.equal(h.calls[3].request.name, "erpnext_doc_get");
        h.calls[3].reject(new Error("Readback failed"));
        const result = await writing;
        assert.equal(result.saved, true);
        assert.equal(result.detailRefreshed, false);
      } else {
        await writing;
      }
      const last = h.calls.at(-1);
      assert.equal(last.request.name, "erpnext_kanban_get_board");
      assert.equal(
        last.request.arguments.project,
        switchBoard ? "PROJECT-B" : "PROJECT-A",
      );
      assert.equal(
        h.render().state.board.cards[0].id,
        switchBoard ? "TASK-B-1" : "TASK-A-1",
      );
      if (switchBoard) assert.equal(h.render().state.detail.cardDetail, null);
      else if (operation === "Assign") {
        assert.equal(
          h.render().state.detail.cardDetail._assign,
          '["local@example.test"]',
        );
      } else if (operation === "Unassign") {
        assert.equal(h.render().state.detail.cardDetail._assign, "[]");
      }
      last.resolve(payload(h.render().state.board));
      await tick();
    });
  }
}
