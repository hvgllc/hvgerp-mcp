/**
 * Test cho tool đọc lại lịch họp `erpnext_meeting_get` và việc nó chỉ xuất hiện khi bật cờ Events.
 *
 * @module lib/erpnext/tests/tools/calendar_test
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ErpNextToolsClient } from "../client.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import { calendarTools, EVENTS_TOOL_NAMES } from "./calendar.ts";
import {
  allTools,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./mod.ts";
import type { ErpNextToolContext } from "./types.ts";

const TOOL_NAME = "erpnext_meeting_get";

interface Call {
  method: string;
  args: Record<string, unknown>;
  httpMethod: string | undefined;
}

function makeClient(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = {
    actsAs: "caller",
    callMethod(
      method: string,
      args: Record<string, unknown>,
      options?: { httpMethod?: string },
    ) {
      const call = { method, args, httpMethod: options?.httpMethod };
      calls.push(call);
      try {
        return Promise.resolve(respond(call));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  } as unknown as FrappeClient;
  return { ctx: { client } as ErpNextToolContext, calls };
}

function getTool() {
  const tool = calendarTools.find((candidate) => candidate.name === TOOL_NAME);
  if (!tool) throw new Error("Tool not found");
  return tool;
}

const MEETING = {
  event_id: "EVT-1",
  revision: 1,
  status: "Open",
  all_day: false,
  time_zone: "Asia/Ho_Chi_Minh",
  starts_at: "2030-05-01T02:00:00Z",
  ends_at: "2030-05-01T03:00:00Z",
  start_date: null,
  end_date_exclusive: null,
  recurrence: null,
  occurrences: [],
  has_more: false,
};

Deno.test("erpnext_meeting_get is a read-only operations tool with a closed schema", () => {
  const tool = getTool();
  assertEquals(tool.category, "operations");
  assertEquals(tool.annotations?.readOnlyHint, true);
  const schema = tool.inputSchema as Record<string, unknown>;
  assertEquals(schema.additionalProperties, false);
  assertEquals(schema.required, ["event_id"]);
  assert(!("user_id" in (schema.properties as Record<string, unknown>)));
});

Deno.test("erpnext_meeting_get does a fresh GET on every call and caches nothing", async () => {
  let revision = 1;
  const { ctx, calls } = makeClient(() => ({
    ok: true,
    result: { ...MEETING, revision: revision++ },
  }));
  const tool = getTool();
  const first = await tool.handler({ event_id: "EVT-1" }, ctx) as Record<
    string,
    unknown
  >;
  const second = await tool.handler({ event_id: "EVT-1" }, ctx) as Record<
    string,
    unknown
  >;
  assertEquals([first.revision, second.revision], [1, 2]);
  assertEquals(calls.length, 2);
  for (const call of calls) {
    assertEquals(call.httpMethod, "GET");
    assertEquals(call.method, "hvg_workspace.mcp_events.api.meeting_get");
  }
});

Deno.test("erpnext_meeting_get forwards only the declared arguments", async () => {
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  await getTool().handler({
    event_id: "EVT-1",
    occurrence_start: "2030-05-01T02:00:00Z",
    window_start: "2030-05-01",
    window_end: "2030-06-01",
  }, ctx);
  assertEquals(calls[0].args, {
    event_id: "EVT-1",
    occurrence_start: "2030-05-01T02:00:00Z",
    window_start: "2030-05-01",
    window_end: "2030-06-01",
  });
});

Deno.test("erpnext_meeting_get rejects a reversed occurrence window without calling ERP", async () => {
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  const tool = getTool();
  for (
    const [start, end] of [
      ["2030-06-01", "2030-05-01"],
      ["2030-05-01T10:00:00", "2030-05-01T09:59:59"],
      ["2030-05-01T10:00:00Z", "2030-05-01T09:59:59Z"],
      // 10:00 giờ +07:00 là 03:00Z, muộn hơn 02:00Z cùng ngày.
      ["2030-05-01T10:00:00+07:00", "2030-05-01T02:00:00Z"],
      // Khác nhau chỉ ở chữ số thập phân sau mili giây vẫn là ngược thứ tự.
      ["2030-05-01T10:00:00.9999Z", "2030-05-01T10:00:00.9990Z"],
      ["2030-05-01T10:00:00.0000002Z", "2030-05-01T10:00:00.0000001Z"],
    ]
  ) {
    await assertRejects(
      () =>
        tool.handler(
          { event_id: "EVT-1", window_start: start, window_end: end },
          ctx,
        ),
      Error,
      "window_start must not be after window_end",
    );
  }
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_meeting_get ignores a reversed window when occurrence_start is given", async () => {
  // ERP bỏ qua cửa sổ khi có `occurrence_start`, nên cửa sổ cũ bị ngược không được chặn lần đọc.
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  await getTool().handler({
    event_id: "EVT-1",
    occurrence_start: "2030-05-01T02:00:00Z",
    window_start: "2030-06-01",
    window_end: "2030-05-01",
  }, ctx);
  assertEquals(calls.length, 1);
});

Deno.test("erpnext_meeting_get accepts equal and same-day window bounds", async () => {
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  const tool = getTool();
  for (
    const [start, end] of [
      ["2030-05-01", "2030-05-01"],
      ["2030-05-01T10:00:00Z", "2030-05-01T10:00:00Z"],
      // Ngày trơn ở đầu mút kết thúc nghĩa là hết ngày đó.
      ["2030-05-01T10:00", "2030-05-01"],
      // Số chữ số thập phân khác nhau nhưng cùng giá trị, và mốc sau chỉ hơn ở chữ số cuối.
      ["2030-05-01T10:00:00.5Z", "2030-05-01T10:00:00.50Z"],
      ["2030-05-01T10:00:00.9990Z", "2030-05-01T10:00:00.9999Z"],
      // Chữ số thập phân dài của cuối ngày vẫn nằm trong ngày đó.
      ["2030-05-01T23:59:59.99999999Z", "2030-05-01"],
      // Giờ trần là giờ địa phương của site (ví dụ +07:00) nên lẫn với mốc có múi giờ thì không sắp thứ tự được:
      // để ERP kiểm, không từ chối nhầm cửa sổ hợp lệ.
      ["2030-05-01T20:00:00", "2030-05-01T14:00:00Z"],
      ["2030-05-01T10:00:00+07:00", "2030-05-01T02:00:00"],
    ]
  ) {
    await tool.handler(
      { event_id: "EVT-1", window_start: start, window_end: end },
      ctx,
    );
  }
  assertEquals(calls.length, 8);
});

Deno.test("erpnext_meeting_get rejects user_id and any unknown key without calling ERP", async () => {
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  for (
    const extra of [{ user_id: "other@x.com" }, { owner: "x" }, {
      fields: ["title"],
    }]
  ) {
    await assertRejects(
      () => getTool().handler({ event_id: "EVT-1", ...extra }, ctx),
      Error,
      "Unknown argument",
    );
  }
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_meeting_get does not reflect the unknown argument name in its error", async () => {
  const { ctx } = makeClient(() => ({ ok: true, result: MEETING }));
  const hostile = "<script>alert(1)</script>";
  const error = await assertRejects(() =>
    getTool().handler({ event_id: "EVT-1", [hostile]: "x" }, ctx)
  );
  assert(error instanceof Error);
  assert(error.message.startsWith("Unknown argument"));
  assert(!error.message.includes(hostile));
});

Deno.test("erpnext_meeting_get refuses a client that does not act as the caller", async () => {
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  for (const identity of ["service", undefined]) {
    const shared = {
      ...ctx,
      client: Object.assign(Object.create(ctx.client), { actsAs: identity }),
    } as ErpNextToolContext;
    await assertRejects(
      () => getTool().handler({ event_id: "EVT-1" }, shared),
      Error,
      "Not authorized to read this meeting",
    );
  }
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_meeting_get rejects a bad event_id or malformed dates", async () => {
  const { ctx, calls } = makeClient((call) => ({
    ok: true,
    result: { ...MEETING, event_id: call.args.event_id },
  }));
  const tool = getTool();
  for (
    const bad of [{}, { event_id: "" }, { event_id: 5 }, {
      event_id: "x".repeat(141),
    }]
  ) {
    await assertRejects(() => tool.handler(bad, ctx), Error, "event_id");
  }
  assertEquals(calls.length, 0);
  // Giới hạn 140 tính theo code point: 71 emoji (142 code unit) là hợp lệ.
  await tool.handler({ event_id: "😀".repeat(71) }, ctx);
  await assertRejects(
    () => tool.handler({ event_id: "😀".repeat(141) }, ctx),
    Error,
    "event_id",
  );
  calls.length = 0;
  for (const key of ["occurrence_start", "window_start", "window_end"]) {
    for (
      const value of [
        "tomorrow",
        "2030-13",
        "2030-02-30",
        "2030-05-01T25:00:00Z",
        "2030-05-01T10:61:00Z",
        "2030-05-01T10:00:00+99:99",
        "2030-05-01T10:00:00-0960",
        "2030-05-01; drop",
        5,
        "2030-05-01".padEnd(80, "0"),
      ]
    ) {
      await assertRejects(
        () => tool.handler({ event_id: "EVT-1", [key]: value }, ctx),
        Error,
        key,
      );
    }
  }
  assertEquals(calls.length, 0);
});

Deno.test("erpnext_meeting_get passes a tombstone through", async () => {
  const tombstone = { event_id: "EVT-1", revision: 7, deleted: true };
  const { ctx } = makeClient(() => ({ ok: true, result: tombstone }));
  assertEquals(await getTool().handler({ event_id: "EVT-1" }, ctx), tombstone);
});

Deno.test("erpnext_meeting_get turns ERP failures into fixed messages", async () => {
  const cases: Array<[() => unknown, string]> = [
    [
      () => ({
        ok: false,
        error: { code: -32011, message: "EVT-1 missing for khoa@x" },
      }),
      "Unknown event name",
    ],
    [() => {
      throw new FrappeAPIError("PermissionError khoa@x", 403, null);
    }, "Not authorized to read this meeting"],
    [() => {
      throw new FrappeAPIError("Traceback password=hunter2", 500, null);
    }, "Events backend error"],
  ];
  for (const [respond, message] of cases) {
    const { ctx } = makeClient(respond);
    const error = await assertRejects(() =>
      getTool().handler({ event_id: "EVT-1" }, ctx)
    );
    assertEquals((error as Error).message, message);
  }
});

Deno.test("the tool stays out of every public default registry", () => {
  assert(!allTools.some((tool) => tool.name === TOOL_NAME));
  for (const tools of Object.values(toolsByCategory)) {
    assert(!tools.some((tool) => tool.name === TOOL_NAME));
  }
  for (const category of Object.keys(toolsByCategory)) {
    assert(
      !getToolsByCategory(category).some((tool) => tool.name === TOOL_NAME),
    );
  }
  assertEquals(getToolByName(TOOL_NAME), undefined);
  assertEquals([...EVENTS_TOOL_NAMES], [TOOL_NAME]);
  assertEquals(calendarTools.map((tool) => tool.name), [TOOL_NAME]);
});

Deno.test("ErpNextToolsClient hides the events tool unless the flag option is set", () => {
  const names = (client: ErpNextToolsClient) =>
    client.listTools().map((tool) => tool.name);
  assert(!names(new ErpNextToolsClient()).includes(TOOL_NAME));
  assert(
    !names(new ErpNextToolsClient({ includeEventsTools: false })).includes(
      TOOL_NAME,
    ),
  );
  assert(
    !names(new ErpNextToolsClient({ categories: ["operations"] })).includes(
      TOOL_NAME,
    ),
  );
  assert(
    names(new ErpNextToolsClient({ includeEventsTools: true })).includes(
      TOOL_NAME,
    ),
  );
  assert(
    names(
      new ErpNextToolsClient({
        categories: ["operations"],
        includeEventsTools: true,
      }),
    )
      .includes(TOOL_NAME),
  );
});
