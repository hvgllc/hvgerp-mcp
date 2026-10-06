/**
 * Test cho tool đọc lại lịch họp `erpnext_meeting_get` và việc nó chỉ xuất hiện khi bật cờ Events.
 *
 * @module lib/erpnext/tests/tools/calendar_test
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ErpNextToolsClient } from "../client.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import { calendarTools, EVENTS_TOOL_NAMES } from "./calendar.ts";
import { allTools, toolsByCategory } from "./mod.ts";
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

Deno.test("erpnext_meeting_get rejects a bad event_id or malformed dates", async () => {
  const { ctx, calls } = makeClient(() => ({ ok: true, result: MEETING }));
  const tool = getTool();
  for (
    const bad of [{}, { event_id: "" }, { event_id: 5 }, {
      event_id: "x".repeat(141),
    }]
  ) {
    await assertRejects(() => tool.handler(bad, ctx), Error, "event_id");
  }
  for (const key of ["occurrence_start", "window_start", "window_end"]) {
    for (
      const value of [
        "tomorrow",
        "2030-13",
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

Deno.test("the tool is registered in the real registry under operations", () => {
  assert(allTools.some((tool) => tool.name === TOOL_NAME));
  assert(toolsByCategory.operations.some((tool) => tool.name === TOOL_NAME));
  assertEquals([...EVENTS_TOOL_NAMES], [TOOL_NAME]);
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
