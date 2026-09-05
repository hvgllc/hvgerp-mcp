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

function harness() {
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
  send(fixtures.boardFixture());
  return { calls, render, send, fixtures };
}

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
