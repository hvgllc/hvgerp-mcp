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

function harness({ initialBoard = true, hostContext = "normal" } = {}) {
  const componentSlots = [];
  let slots = componentSlots;
  let modalSlots = [], modalKey, modalCapture;
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
      const slot = slots[index];
      return [slot.value, (action) => {
        slot.value = reducer(slot.value, action);
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
      if (hostContext === "missing") return undefined;
      if (hostContext === "empty") return {};
      return {
        toolInfo: {
          tool: {
            name: hostContext === "normal"
              ? "erpnext_kanban_get_board"
              : hostContext,
          },
        },
      };
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
    captureModal(value) {
      modalCapture = value;
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
          handleAssignDetail, handleUnassignDetail, isDetailSessionCurrent });
        ${marker}`,
      );
    }
    if (filename.endsWith("/DetailModal.tsx")) {
      const marker =
        "  if (!detail.selectedCardId || !detail.session) return null;";
      assert.equal(source.split(marker).length, 2);
      source = source.replace(
        marker,
        "  captureModal({ editedFields, handleFieldChange });\n" + marker,
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
    slots = componentSlots;
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
    renderModal() {
      const current = render();
      const key = current.state.detail.selectedCardId
        ? JSON.stringify(current.state.detail.session)
        : undefined;
      if (key !== modalKey) modalSlots = [];
      modalKey = key;
      if (!key) return null;
      slots = modalSlots;
      cursor = 0;
      const { CardDetailModal } = load(
        path.join(root, "src/ui/kanban-viewer/src/DetailModal.tsx"),
      );
      const before = effects.length;
      CardDetailModal({
        detail: current.state.detail,
        board: current.state.board,
        onClose() {},
        onMove: current.requestMove,
        onSave: current.handleSaveDetail,
        isSessionCurrent: current.isDetailSessionCurrent,
      });
      for (const effect of effects.slice(before)) effect();
      slots = componentSlots;
      return modalCapture;
    },
  };
}

for (const recovered of [false, true]) {
  test(`component rejects late host B after C is adopted recovered=${recovered}`, async () => {
    const h = harness();
    const b = h.fixtures.boardFixture("B");
    const c = h.fixtures.boardFixture("B");
    c.refreshArguments.project = "PROJECT-C";
    c.title = "Board C";
    c.cards = c.cards.map((card) => ({
      ...card,
      id: card.id.replace("-B-", "-C-"),
    }));
    h.input(b.refreshArguments);
    h.input(c.refreshArguments);
    if (recovered) {
      h.result({
        isError: true,
        content: [{ type: "text", text: "Host C failed" }],
      });
      const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
      h.calls.at(-1).resolve(payload(c));
      await retry;
    } else h.result(payload(c));
    const session = await openDetail(h);
    h.result(payload(b));
    assert.equal(h.render().state.board.title, "Board C");
    assert.equal(h.render().state.detail.session, session);
    const refresh = h.render().requestBoardRefresh({ ignoreInterval: true });
    assert.equal(h.calls.at(-1).request.arguments.project, "PROJECT-C");
    h.calls.at(-1).resolve(payload(c));
    await refresh;
    assert.equal(h.render().state.board.cards[0].id, "TASK-C-1");
  });
}

test("paged fixture uses cumulative loadedCount like the server", () => {
  const h = harness();
  for (const offset of [0, 50]) {
    const board = h.fixtures.pagedBoardFixture(offset);
    assert.equal(board.pagination.loadedCount, offset + board.cards.length);
    assert.equal(board.pagination.loadedCount, offset === 0 ? 50 : 52);
    assert.equal(board.pagination.total, 52);
    assert.equal(board.cards[0].id, `TASK-PAGED-${offset + 1}`);
  }
});

test("component same-board rerun preserves actual DetailModal unsaved draft", async () => {
  const h = harness();
  await openDetail(h);
  h.renderModal();
  h.renderModal().handleFieldChange("subject", "Unsaved local draft");
  assert.equal(h.renderModal().editedFields.subject, "Unsaved local draft");
  const board = h.fixtures.boardFixture();
  h.input(board.refreshArguments);
  assert.equal(h.renderModal()?.editedFields.subject, "Unsaved local draft");
  h.result(payload(board));
  assert.equal(h.renderModal()?.editedFields.subject, "Unsaved local draft");
  h.input(h.fixtures.boardFixture("B").refreshArguments);
  assert.equal(h.renderModal(), null);
});

for (const hostFirst of [false, true]) {
  for (const failed of [false, true]) {
    test(`component unusable host input reconciles an active move hostFirst=${hostFirst} failed=${failed}`, async () => {
      const h = harness();
      const a = h.fixtures.boardFixture();
      h.render().requestMove(a.cards[0], "Working", "Start");
      h.input(undefined);
      const hostError = () =>
        h.result({
          isError: true,
          ...payload({ message: "Invalid host input" }),
        });
      if (hostFirst) hostError();
      if (failed) h.calls[0].reject(new Error("Move forbidden"));
      else h.calls[0].resolve(payload({ ok: true }));
      await tick();
      if (!hostFirst) hostError();
      await tick();
      assert.equal(
        h.calls.length,
        2,
        "mutation debt requires a corrective read despite missing input",
      );
      assert.equal(h.calls[1].request.name, "erpnext_kanban_get_board");
      assert.equal(h.calls[1].request.arguments.project, "PROJECT-A");
      assert.equal(
        h.render().state.board.cards[0].columnId,
        failed ? "Open" : "Working",
      );
      const fresh = h.fixtures.boardFixture();
      if (!failed) fresh.cards[0].columnId = "Working";
      h.calls[1].resolve(payload(fresh));
      await tick();
      assert.equal(
        h.render().state.board.cards[0].columnId,
        fresh.cards[0].columnId,
      );
    });
  }
}
for (const response of ["success", "error"]) {
  test(`component same-board host rerun preserves active detail session ${response}`, async () => {
    const h = harness();
    const session = await openDetail(h);
    const detail = h.render().state.detail;
    const board = h.fixtures.boardFixture();
    h.input({ ...board.refreshArguments });
    assert.equal(
      h.render().state.detail.session,
      session,
      "rerun must retain the modal key and unsaved draft owner",
    );
    assert.equal(h.render().state.detail, detail);
    if (response === "success") h.result(payload(board));
    else {
      h.result({ isError: true, ...payload({ message: "Host unavailable" }) });
      const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
      h.calls.at(-1).resolve(payload(board));
      await retry;
    }
    assert.equal(h.render().state.detail.session, session);
    assert.equal(h.render().state.detail, detail);
  });
}

for (const hostContext of ["missing", "empty"]) {
  for (const scope of ["cold", "project", "page", "doctype"]) {
    for (const failure of ["error", "malformed"]) {
      test(`component optional host metadata ${hostContext} ${scope} ${failure}`, async () => {
        const h = harness({ initialBoard: scope !== "cold", hostContext });
        const b = scope === "page"
          ? h.fixtures.pagedBoardFixture(50)
          : h.fixtures.boardFixture("B");
        if (scope === "doctype") {
          b.doctype = "Issue";
          b.boardId = "issue-board";
          b.refreshArguments = { doctype: "Issue", status: "Open" };
        }
        h.input(b.refreshArguments);
        h.result(
          failure === "error"
            ? { isError: true, ...payload({ message: "Unavailable" }) }
            : { content: [{ type: "text", text: "{" }] },
        );
        assert.ok(h.render().state.error);
        if (scope !== "cold") {
          h.render().requestMove(
            h.render().state.board.cards[0],
            "Working",
            "Start",
          );
          assert.equal(h.calls.length, 0);
        }
        const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
        assert.equal(
          h.calls.length,
          1,
          "optional toolInfo must not disable recovery",
        );
        assert.equal(h.calls[0].request.name, "erpnext_kanban_get_board");
        assert.deepEqual(
          JSON.parse(JSON.stringify(h.calls[0].request.arguments)),
          JSON.parse(JSON.stringify(b.refreshArguments)),
        );
        h.calls[0].resolve(payload(b));
        assert.equal(await retry, true);
        assert.equal(h.render().state.board.title, b.title);
        assert.equal(h.render().state.error, null);
      });
    }
  }
}

for (
  const args of [
    undefined,
    null,
    [],
    "Task",
    {},
    { doctype: "" },
    { doctype: 1 },
    { doctype: ["Task"] },
    { doctype: "Sales Invoice" },
  ]
) {
  test(`component missing metadata invalid arguments do not dispatch ${JSON.stringify(args)}`, async () => {
    const h = harness({ hostContext: "empty" });
    h.input(args);
    h.result({ isError: true, ...payload({ message: "Unavailable" }) });
    await h.render().requestBoardRefresh({ ignoreInterval: true });
    assert.equal(h.calls.length, 0);
  });
}

for (const hostContext of ["unknown_tool", "erpnext_kanban_move_card"]) {
  test(`component explicit non-read host tool cannot become retry ${hostContext}`, async () => {
    const h = harness({ hostContext });
    h.input(h.fixtures.boardFixture("B").refreshArguments);
    h.result({ isError: true, ...payload({ message: "Unavailable" }) });
    const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
    assert.equal(h.calls.length, 0);
    await retry;
  });
}

for (const stage of ["waiting", "recovering"]) {
  test(`component cannot open old detail while host ${stage}`, async () => {
    const h = harness();
    const oldCard = h.render().state.board.cards[0];
    h.input(h.fixtures.boardFixture("B").refreshArguments);
    if (stage === "recovering") {
      h.result({ isError: true, ...payload({ message: "Unavailable" }) });
    }
    h.render().handleCardTitleClick(oldCard);
    assert.equal(
      h.calls.length,
      0,
      "old detail must not start a read in the new session",
    );
    assert.equal(h.render().state.detail.selectedCardId, null);
    const b = h.fixtures.boardFixture("B");
    if (stage === "waiting") h.result(payload(b));
    else {
      const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
      h.calls[0].resolve(payload(b));
      await retry;
    }
    assert.equal(h.render().state.detail.selectedCardId, null);
    const before = h.calls.length;
    h.render().handleCardTitleClick(h.render().state.board.cards[0]);
    assert.equal(h.calls.length, before + 1);
    assert.equal(h.calls[before].request.arguments.name, b.cards[0].id);
    h.calls[before].resolve(payload({ data: { name: b.cards[0].id } }));
    await tick();
    assert.equal(h.render().state.detail.cardDetail.name, b.cards[0].id);
  });
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
  // Kết quả lệch phạm vi input hiện tại bị bỏ qua âm thầm, không hiện lỗi
  // giả cho user; controller tự chuyển sang hồi phục để retry đúng B bên dưới.
  assert.equal(h.render().state.error, null);
  h.render().requestMove(h.render().state.board.cards[0], "Working", "Start");
  assert.equal(h.calls.length, 0);
  const retry = h.render().requestBoardRefresh({ ignoreInterval: true });
  assert.equal(h.calls[0].request.arguments.project, "PROJECT-B");
  h.calls[0].resolve(payload(b));
  await retry;
  assert.equal(h.render().state.board.title, "Local board B");
});

test("component overlapping same-scope host results cannot both apply, only the first sticks", async () => {
  const h = harness();
  const args = h.fixtures.boardFixture().refreshArguments;
  // Hai lượt input cùng phạm vi (cùng tham số) dồn dập trước khi có kết quả
  // nào về: phía component chỉ giữ được seq mới nhất trong một ref dùng
  // chung, không có id đối chiếu từ SDK để phân biệt hai lượt, nên cả hai
  // kết quả tới sau đó đều mang cùng một seq. Nếu không chặn, kết quả đến
  // SAU sẽ đè lên kết quả đến TRƯỚC dù không có gì đảm bảo nó thật sự mới
  // hơn (host có thể trả lời không theo thứ tự gửi).
  h.input(args);
  h.input(args);
  const first = { ...h.fixtures.boardFixture(), title: "Local board A first" };
  const second = {
    ...h.fixtures.boardFixture(),
    title: "Local board A second",
  };
  h.result(payload(first));
  assert.equal(h.render().state.board.title, "Local board A first");
  // Kết quả thứ hai mang cùng seq với kết quả đã áp dụng: bị coi là bản sao
  // trễ của lượt chồng lấn, bỏ qua âm thầm, giữ nguyên board đã có.
  assert.equal(h.calls.length, 0);
  h.result(payload(second));
  assert.equal(h.render().state.board.title, "Local board A first");
  // Không biết bản nào mới hơn nên component phải tự đọc lại ngay, thay vì
  // hiển thị dữ liệu có thể đã cũ cho tới nhịp refresh theo interval sau.
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(
    payload({ ...h.fixtures.boardFixture(), title: "Local board A fresh" }),
  );
  await tick();
  assert.equal(h.render().state.board.title, "Local board A fresh");
  assert.equal(h.render().state.error, null);
});

test("component obsolete host failure does not surface after a newer result settled", () => {
  const h = harness();
  const b = h.fixtures.boardFixture("B");
  // Hai lượt host chồng lấn khác phạm vi; lượt B trả board hợp lệ trước và
  // được nhận, nên request đang chờ đã kết thúc.
  h.input(h.fixtures.boardFixture().refreshArguments);
  h.input(b.refreshArguments);
  h.result(payload(b));
  assert.equal(h.render().state.board.title, "Local board B");
  // Lượt cũ mới lỗi sau đó: failHost không còn trạng thái nào để chuyển, nên
  // lỗi đã lỗi thời này không được phép hiện đè lên board vừa nhận.
  h.result({ isError: true, ...payload({ message: "Obsolete failure" }) });
  assert.equal(h.render().state.error, null);
  assert.equal(h.render().state.board.title, "Local board B");
});

test("component requestMove reports rejection so callers keep the detail open", () => {
  const h = harness();
  const card = h.render().state.board.cards[0];
  // Đang chờ host trả lời cho input mới (waitingForHost=true, board cũ vẫn
  // còn): move phải bị chặn âm thầm và báo false, không phải bị lờ đi, để
  // detail modal (dùng giá trị trả về này) không đóng nhầm và mất draft.
  h.input(h.fixtures.boardFixture("B").refreshArguments);
  assert.equal(h.render().requestMove(card, "Working", "Start"), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.render().state.error, null);
  h.result(payload(h.fixtures.boardFixture("B")));
  // Chuyển không được phép (không nằm trong allowedTransitions) cũng phải
  // báo false, dù đã setError, vì bản thân move chưa hề xảy ra.
  const readyCard = h.render().state.board.cards[0];
  assert.equal(
    h.render().requestMove(readyCard, "Completed", "Complete"),
    false,
  );
  assert.match(h.render().state.error, /not allowed/);
  assert.equal(h.calls.length, 0);
  // Move hợp lệ, sẵn sàng: phải báo true để caller biết là đã nhận vào queue.
  assert.equal(h.render().requestMove(readyCard, "Working", "Start"), true);
  assert.equal(h.calls.length, 1);
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

for (const failure of ["reject", "isError", "notOk"]) {
  for (const nextFails of [false, true]) {
    test(`component queued move clears preceding failure ${failure} nextFails=${nextFails}`, async () => {
      const h = harness();
      const cards = h.render().state.board.cards;
      h.render().requestMove(cards[0], "Working", "Start");
      h.render().requestMove(cards[1], "Working", "Start");
      if (failure === "reject") {
        h.calls[0].reject(new Error("First move failed"));
      } else if (failure === "isError") {
        h.calls[0].resolve({
          isError: true,
          content: [{ type: "text", text: "First move failed" }],
        });
      } else {
        h.calls[0].resolve(
          payload({ ok: false, errorMessage: "First move failed" }),
        );
      }
      await tick();
      assert.equal(h.calls.length, 2);
      assert.equal(
        h.render().state.error,
        null,
        "starting queued move clears the previous failure",
      );
      if (nextFails) {
        h.calls[1].resolve(
          payload({ ok: false, errorMessage: "Second move failed" }),
        );
      } else h.calls[1].resolve(payload({ ok: true }));
      await tick();
      assert.equal(h.calls.length, 3);
      assert.equal(h.render().state.board.cards[0].columnId, "Open");
      assert.equal(
        h.render().state.board.cards[1].columnId,
        nextFails ? "Open" : "Working",
      );
      h.calls[2].resolve(payload(h.render().state.board));
      await tick();
      assert.equal(
        h.render().state.error,
        nextFails ? "Second move failed" : null,
      );
    });
  }
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

for (const operation of Object.keys(detailTools)) {
  for (const scope of ["same", "project", "page"]) {
    for (const failed of [false, true]) {
      test(`component active ${operation} survives host result scope=${scope} failed=${failed}`, async () => {
        const h = harness();
        if (scope === "page") h.send(h.fixtures.pagedBoardFixture(0));
        const card = h.render().state.board.cards[0];
        h.render().handleCardTitleClick(card);
        h.calls[0].resolve(payload({
          name: card.id,
          subject: "Initial",
          _assign: '["old@example.test"]',
        }));
        await tick();
        const session = h.render().state.detail.session;
        const writing = startDetailWrite(h, session, operation, "Updated");
        const write = h.calls.at(-1);
        const next = scope === "page"
          ? h.fixtures.pagedBoardFixture(50)
          : h.fixtures.boardFixture(scope === "project" ? "B" : "A");
        h.send(next);
        assert.equal(
          h.calls.length,
          2,
          "host result cannot start a read during the write",
        );
        if (scope === "same") {
          assert.equal(h.render().state.detail.session, session);
        } else assert.equal(h.render().state.detail.session, null);
        await finishDetailWrite(
          h,
          operation,
          write,
          "Updated",
          failed ? "write" : undefined,
        );
        const result = await writing;
        if (failed) assert.match(result.error.message, /Forbidden Updated/);
        else assert.equal(result.error, undefined);
        const refresh = h.calls.at(-1);
        assert.equal(refresh.request.name, "erpnext_kanban_get_board");
        assert.deepEqual(
          structuredClone(refresh.request.arguments),
          structuredClone(next.refreshArguments),
        );
        refresh.resolve(payload(next));
        await tick();
        const detail = h.render().state.detail;
        if (scope === "same") {
          assert.equal(detail.session, session);
          assert.equal(
            detail.cardDetail.subject,
            failed ? "Initial" : "Updated",
          );
          assert.equal(
            detail.cardDetail._assign,
            failed
              ? '["old@example.test"]'
              : operation === "Unassign"
              ? "[]"
              : '["local@example.test"]',
          );
          if (operation === "Save" && !failed) {
            assert.equal(result.value.saved, true);
            assert.equal(result.value.detailRefreshed, true);
          }
        } else {
          assert.equal(detail.session, null);
          assert.equal(detail.cardDetail, null);
          assert.deepEqual(
            structuredClone(h.render().state.board.refreshArguments),
            structuredClone(next.refreshArguments),
          );
        }
      });
    }
  }
}

test("component same-board host result preserves Save readback failure", async () => {
  const h = harness();
  const session = await openDetail(h);
  const writing = startDetailWrite(h, session, "Save", "Saved");
  const write = h.calls.at(-1);
  h.send(h.fixtures.boardFixture());
  await finishDetailWrite(h, "Save", write, "Saved", "readback");
  const result = await writing;
  assert.equal(result.value.saved, true);
  assert.equal(result.value.detailRefreshed, false);
  assert.equal(
    h.render().state.detail.detailError,
    "Failed to refresh saved detail",
  );
  h.calls.at(-1).resolve(payload(h.render().state.board));
  await tick();
  assert.equal(h.render().state.detail.session, session);
  assert.equal(h.render().state.detail.cardDetail.subject, "Initial");
  assert.equal(
    h.render().state.detail.detailError,
    "Failed to refresh saved detail",
  );
});

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

test("component keeps a move error created after the host input", async () => {
  const h = harness();
  const a = h.fixtures.boardFixture();
  h.render().requestMove(a.cards[0], "Working", "Start");
  // Host mở một lượt đọc lại cùng phạm vi trong lúc move đang chạy; lượt này tự
  // xóa lỗi move cũ, nên mọi lỗi sinh ra sau đó là lỗi đang còn hiệu lực.
  h.input(a.refreshArguments);
  h.calls[0].resolve({
    isError: true,
    ...payload({ message: "Permission denied" }),
  });
  await tick();
  const message = h.render().state.error;
  assert.ok(message);
  // Kết quả host về sau hydrate board; nếu xóa lỗi move vô điều kiện ở đây thì
  // lỗi biến mất im lặng và user tưởng move đã thành công.
  h.result(payload(a));
  assert.equal(h.render().state.error, message);
});

test("component host snapshot during an active move keeps the card pending", () => {
  const h = harness();
  const a = h.fixtures.boardFixture();
  h.render().requestMove(a.cards[0], "Working", "Start");
  assert.equal(h.render().state.board.cards[0].pending, true);
  // Bản host đọc trước khi write kịp ghi: thẻ phải giữ nguyên vị trí lạc quan và
  // cờ pending, nếu không thao tác kéo mở lại và user gửi trùng cùng một move.
  h.input(a.refreshArguments);
  h.result(payload(a));
  const card = h.render().state.board.cards.find((item) =>
    item.id === a.cards[0].id
  );
  assert.equal(card.pending, true);
  assert.equal(card.columnId, "Working");
});
