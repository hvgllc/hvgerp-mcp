import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  boardFixture,
  createDetailFixtureStore,
  malformedViewerFixture,
  SCENARIOS,
  TOOL_NAMES,
  toolArguments,
  UI_VIEWERS,
  viewerFixture,
} from "./fixtures.ts";

function element<T extends HTMLElement>(id: string, kind: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`Missing host element: ${id}`);
  return node;
}

const query = new URLSearchParams(location.search);
const viewer = UI_VIEWERS.find((name) => name === query.get("viewer")) ??
  "doclist-viewer";
const scenario = SCENARIOS.find((name) => name === query.get("scenario")) ??
  "smoke";
const chartTypes = ["bar", "horizontal-bar", "pie", "donut"] as const;
const chartType = chartTypes.find((name) => name === query.get("chart")) ??
  "bar";
for (
  const [id, values, selected] of [
    ["viewer", UI_VIEWERS, viewer],
    ["scenario", SCENARIOS, scenario],
  ] as const
) {
  const select = element(id, HTMLSelectElement);
  for (const value of values) {
    select.add(new Option(value, value, false, value === selected));
  }
}
element("chart", HTMLSelectElement).value = chartType;
const frame = element("viewer-frame", HTMLIFrameElement);
const trace = element("trace", HTMLPreElement);
const pendingList = element("pending", HTMLUListElement);
const status = element("status", HTMLSpanElement);
const boardButton = element("send-board-b", HTMLButtonElement);
const successButton = element("send-success", HTMLButtonElement);
const events: object[] = [];
function record(event: object) {
  events.push(event);
  trace.textContent = JSON.stringify(events, null, 2);
}

function result(payload: object) {
  return {
    isError: false,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
type FixtureResult = ReturnType<typeof result> | ReturnType<typeof failure>;
const boards = [boardFixture("A"), boardFixture("B")];
const details = createDetailFixtureStore();
const detailMutations = new Set([
  "erpnext_doc_update",
  "erpnext_doc_assign",
  "erpnext_doc_unassign",
]);
let board = boards[0];
let nextId = 1;

function detailMutation(
  name: string,
  args: Record<string, unknown>,
  apply = false,
): FixtureResult {
  if (typeof args.doctype !== "string" || typeof args.name !== "string") {
    return failure("Missing local document identity");
  }
  const doc = details.get(args.doctype, args.name);
  let assignment: object | undefined;
  if (name === "erpnext_doc_update") {
    if (
      !args.data || typeof args.data !== "object" || Array.isArray(args.data)
    ) return failure("Missing local update data");
    Object.assign(doc, args.data);
  } else {
    if (typeof args.assign_to !== "string") {
      return failure("Missing local assignee");
    }
    const current = JSON.parse(String(doc._assign ?? "[]")) as string[];
    const assignees = name === "erpnext_doc_assign"
      ? [...new Set([...current, args.assign_to])]
      : current.filter((entry) => entry !== args.assign_to);
    doc._assign = JSON.stringify(assignees);
    const todos = assignees.map((owner) => ({
      owner,
      name: `TODO-${args.name}-${owner}`,
    }));
    assignment = name === "erpnext_doc_assign"
      ? { notify_user: true, assignees: [args.assign_to], todos }
      : { removed: args.assign_to, remaining: todos };
  }
  if (apply) {
    details.set(args.doctype, args.name, doc);
    for (const entry of boards) {
      if (entry.doctype !== args.doctype) continue;
      const card = entry.cards.find((candidate) => candidate.id === args.name);
      if (card && typeof doc.subject === "string") card.title = doc.subject;
    }
  }
  return result({
    data: doc,
    message: "Local mutation succeeded",
    ...(assignment ? { assignment } : {}),
  });
}

function responseFor(
  name: string,
  args: Record<string, unknown>,
): FixtureResult {
  if (name === TOOL_NAMES[viewer]) {
    if (scenario === "refresh-error") return failure("Local refresh error");
    if (viewer === "kanban-viewer") {
      const requestedBoard = boards.find((entry) =>
        entry.refreshArguments.project === args.project
      );
      return requestedBoard
        ? result(structuredClone(requestedBoard))
        : failure("Unknown local board project");
    }
    return result(
      viewerFixture(viewer, chartType),
    );
  }
  if (name === "erpnext_doc_get" && viewer === "kanban-viewer") {
    return result({
      data: details.get(String(args.doctype), String(args.name)),
    });
  }
  if (detailMutations.has(name) && viewer === "kanban-viewer") {
    return detailMutation(name, args);
  }
  if (name === "erpnext_user_list" && viewer === "kanban-viewer") {
    return result({
      doctype: "User",
      count: 1,
      returned: 1,
      has_more: false,
      data: [{
        name: "local-user@example.test",
        full_name: "Local User",
        enabled: 1,
      }],
      _meta: {
        ui: { resourceUri: "ui://hvgerp-mcp/doclist-viewer" },
        "ui/resourceUri": "ui://hvgerp-mcp/doclist-viewer",
      },
    });
  }
  if (name === "erpnext_kanban_move_card" && viewer === "kanban-viewer") {
    const requestedBoard = boards.find((entry) =>
      entry.cards.some((card) => card.id === args.card_id)
    );
    const card = requestedBoard?.cards.find((entry) =>
      entry.id === args.card_id
    );
    const column = requestedBoard?.columns.find((entry) =>
      entry.id === args.to_column
    );
    if (!card || !column) return failure("Unknown local card or column");
    return result({
      ok: true,
      cardId: card.id,
      fromColumn: card.columnId,
      toColumn: column.id,
      serverCard: { ...card, columnId: column.id },
    });
  }
  if (
    name === "erpnext_item_get" &&
    (viewer === "invoice-viewer" || viewer === "stock-viewer")
  ) {
    return result({
      data: {
        name: "ITEM-LOCAL",
        item_name: "Local Item",
        item_group: "Local Group",
        stock_uom: "Nos",
        standard_rate: 15,
      },
    });
  }
  if (name === "erpnext_stock_balance" && viewer === "invoice-viewer") {
    return result(viewerFixture("stock-viewer"));
  }
  if (name === "erpnext_stock_entry_list" && viewer === "stock-viewer") {
    return result({
      data: [{
        name: "STOCK-LOCAL",
        stock_entry_type: "Material Receipt",
        posting_date: "2026-09-05",
      }],
    });
  }
  return failure(`Unsupported local fixture tool: ${name}`);
}

const bridge = new AppBridge(
  null,
  { name: "LocalTestHost", version: "0.0.0" },
  {
    serverTools: {},
    logging: {},
  },
);
bridge.oncalltool = async (params, extra) => {
  const id = nextId++;
  const args = params.arguments ?? {};
  record({ id, tool: params.name, args, outcome: "received" });
  const held = (scenario === "detail-race" &&
    (params.name === "erpnext_doc_get" ||
      detailMutations.has(params.name))) ||
    (scenario === "board-race" &&
      (params.name === "erpnext_kanban_get_board" ||
        params.name === "erpnext_kanban_move_card"));
  const reply = responseFor(params.name, args);
  function applySuccessfulMove() {
    if (params.name !== "erpnext_kanban_move_card" || reply.isError) return;
    const requestedBoard = boards.find((entry) =>
      entry.cards.some((card) => card.id === args.card_id)
    );
    const card = requestedBoard?.cards.find((entry) =>
      entry.id === args.card_id
    );
    if (!requestedBoard || !card || typeof args.to_column !== "string") return;
    card.columnId = args.to_column;
    for (const column of requestedBoard.columns) {
      column.count = requestedBoard.cards.filter((entry) =>
        entry.columnId === column.id
      ).length;
    }
  }
  if (!held) {
    const completedReply = detailMutations.has(params.name) && !reply.isError
      ? detailMutation(params.name, args, true)
      : reply;
    applySuccessfulMove();
    record({
      id,
      outcome: completedReply.isError ? "error-result" : "resolved",
    });
    return completedReply;
  }
  return await new Promise<FixtureResult>((resolve) => {
    const row = document.createElement("li");
    row.dataset.requestId = String(id);
    row.append(`#${id} ${params.name} ${JSON.stringify(args)} `);
    const release = document.createElement("button");
    release.textContent = `Trả kết quả #${id}`;
    const reject = document.createElement("button");
    reject.textContent = `Trả lỗi #${id}`;
    let settled = false;
    function finish(value: FixtureResult, outcome: string) {
      if (settled) return;
      settled = true;
      if (!value.isError) applySuccessfulMove();
      if (!value.isError && detailMutations.has(params.name)) {
        value = detailMutation(params.name, args, true);
      }
      extra.signal.removeEventListener("abort", aborted);
      row.remove();
      record({ id, outcome });
      resolve(value);
    }
    function aborted() {
      finish(failure("Local request cancelled"), "cancelled");
    }
    release.onclick = () => finish(reply, "released");
    reject.onclick = () =>
      finish(failure(`Local deferred error #${id}`), "rejected");
    row.append(release, reject);
    pendingList.append(row);
    extra.signal.addEventListener("abort", aborted, { once: true });
    if (extra.signal.aborted) aborted();
    record({ id, outcome: "held" });
  });
};
bridge.onmessage = async (params) => {
  record({ outcome: "message", params });
  return {};
};
bridge.onloggingmessage = (params) => record({ outcome: "viewer-log", params });
bridge.onerror = (error) => {
  status.textContent = "Lỗi host";
  record({ outcome: "host-error", message: error.message });
};

async function sendSuccess() {
  await bridge.sendToolResult(
    result(
      viewer === "kanban-viewer" ? board : viewerFixture(viewer, chartType),
    ),
  );
  record({
    outcome: "tool-result",
    viewer,
    boardId: viewer === "kanban-viewer" ? board.boardId : undefined,
    refreshArguments: viewer === "kanban-viewer"
      ? board.refreshArguments
      : undefined,
  });
}
bridge.oninitialized = () => {
  void (async () => {
    record({ outcome: "initialized", viewer, scenario });
    await bridge.sendToolInput({ arguments: toolArguments(viewer) });
    record({ outcome: "tool-input" });
    if (scenario === "initial-error") {
      await bridge.sendToolResult(failure("Local initial error"));
      record({ outcome: "initial-error" });
    } else if (scenario === "malformed-payload") {
      await bridge.sendToolResult(result(malformedViewerFixture(viewer)));
      record({ outcome: "malformed-payload", viewer });
    } else {
      await sendSuccess();
    }
    status.textContent = "Đã kết nối";
    boardButton.disabled = viewer !== "kanban-viewer";
    successButton.disabled = false;
  })().catch((error: unknown) => {
    status.textContent = "Lỗi khởi tạo";
    record({ outcome: "initialization-error", message: String(error) });
  });
};
boardButton.onclick = () => {
  board = boards[1];
  void sendSuccess().catch((error: unknown) =>
    record({ outcome: "send-error", message: String(error) })
  );
};
successButton.onclick = () => {
  void sendSuccess().catch((error: unknown) =>
    record({ outcome: "send-error", message: String(error) })
  );
};
if (!frame.contentWindow) throw new Error("Missing viewer window");
await bridge.connect(
  new PostMessageTransport(frame.contentWindow, frame.contentWindow),
);
frame.src = `/dist/${viewer}/index.html`;
