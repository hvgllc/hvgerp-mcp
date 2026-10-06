/**
 * Test cho proxy ERP của MCP Events: bearer của request, method được gọi, phong bì và ánh xạ lỗi.
 * Không có lệnh gọi ERP thật: `fetch` bị thay bằng bản ghi hoặc client giả.
 *
 * @module lib/erpnext/src/events/erp-store_test
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { runWithCaller } from "../api/caller-context.ts";
import {
  FrappeAPIError,
  type FrappeClient,
  setFrappeClient,
} from "../api/frappe-client.ts";
import {
  classifyTransportError,
  createErpEventsStore,
  ERP_EVENTS_METHODS,
  EventsAuthError,
  fetchMeeting,
  unwrapErpEnvelope,
} from "./erp-store.ts";
import { EventsErrorCode, EventsProtocolError } from "./protocol.ts";

const CALLER = {
  accessToken: "jwt-of-khoa",
  principal: "khoa.do@havigroup.llc",
};
const SECRET = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
const SUBSCRIBE = {
  name: "meeting.updated",
  arguments: { event_id: "EVT-1" },
  deliveryUrl: "https://hooks.example.com/cb",
  deliverySecret: SECRET,
};
const OK_SUBSCRIBE = {
  ok: true,
  result: {
    id: "sub_9",
    refresh_before: "2030-01-01T00:00:00Z",
    cursor: null,
    truncated: false,
  },
};

interface Call {
  method: string;
  args: Record<string, unknown>;
  httpMethod: string | undefined;
}

/** Client giả: ghi lại lệnh gọi và trả về (hoặc ném) theo kịch bản. */
function fakeClient(respond: (call: Call) => unknown) {
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
  return { client, calls };
}

function asCaller<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCaller(CALLER, fn);
}

// ── Đường gọi ERP ────────────────────────────────────────────────────────────

Deno.test("subscribe posts the whitelisted method with exactly the contract arguments", async () => {
  const { client, calls } = fakeClient(() => OK_SUBSCRIBE);
  const store = createErpEventsStore({ getClient: () => client });
  const result = await asCaller(() =>
    store.subscribe({ ...SUBSCRIBE, ttlMs: null, cursor: "c1" })
  );
  assertEquals(result, {
    id: "sub_9",
    refreshBefore: "2030-01-01T00:00:00Z",
    cursor: null,
    truncated: false,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "hvg_workspace.mcp_events.api.subscribe");
  assertEquals(calls[0].httpMethod, "POST");
  assertEquals(calls[0].args, {
    name: "meeting.updated",
    arguments: { event_id: "EVT-1" },
    delivery_url: "https://hooks.example.com/cb",
    delivery_secret: SECRET,
    ttl_ms: null,
    cursor: "c1",
  });
});

Deno.test("subscribe omits ttl_ms and cursor when the caller did not send them", async () => {
  const { client, calls } = fakeClient(() => OK_SUBSCRIBE);
  const store = createErpEventsStore({ getClient: () => client });
  await asCaller(() => store.subscribe(SUBSCRIBE));
  assertEquals(Object.keys(calls[0].args).sort(), [
    "arguments",
    "delivery_secret",
    "delivery_url",
    "name",
  ]);
});

Deno.test("unsubscribe posts name, arguments and url only, never a secret, and returns {}", async () => {
  const { client, calls } = fakeClient(() => ({
    ok: true,
    result: { removed: 1, internal: "x" },
  }));
  const store = createErpEventsStore({ getClient: () => client });
  const result = await asCaller(() =>
    store.unsubscribe({
      name: "meeting.updated",
      arguments: {},
      deliveryUrl: "https://hooks.example.com/cb",
    })
  );
  assertEquals(result, {});
  assertEquals(calls[0].method, "hvg_workspace.mcp_events.api.unsubscribe");
  assertEquals(calls[0].httpMethod, "POST");
  assertEquals(calls[0].args, {
    name: "meeting.updated",
    arguments: {},
    delivery_url: "https://hooks.example.com/cb",
  });
});

Deno.test("only the three whitelisted ERP methods exist", () => {
  assertEquals(Object.values(ERP_EVENTS_METHODS).sort(), [
    "hvg_workspace.mcp_events.api.meeting_get",
    "hvg_workspace.mcp_events.api.subscribe",
    "hvg_workspace.mcp_events.api.unsubscribe",
  ]);
});

Deno.test("a call outside a caller scope is refused before it reaches ERP", async () => {
  const { client, calls } = fakeClient(() => OK_SUBSCRIBE);
  const store = createErpEventsStore({ getClient: () => client });
  const error = await assertRejects(
    () => store.subscribe(SUBSCRIBE),
    EventsProtocolError,
  );
  assertEquals(error.code, EventsErrorCode.Forbidden);
  assertEquals(calls.length, 0);
});

Deno.test("the request's own bearer reaches the wire as HVGKeycloak with POST bodies", async () => {
  const original = globalThis.fetch;
  const seen: Array<
    { url: string; method: string; auth: string | null; body: string | null }
  > = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ message: OK_SUBSCRIBE }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const previous = Deno.env.get("ERPNEXT_URL");
  Deno.env.set("ERPNEXT_URL", "http://erp.test");
  try {
    setFrappeClient(null);
    const store = createErpEventsStore();
    await asCaller(() => store.subscribe(SUBSCRIBE));
    assertEquals(seen.length, 1);
    assertEquals(seen[0].auth, "HVGKeycloak jwt-of-khoa");
    assertEquals(seen[0].method, "POST");
    assert(
      seen[0].url.endsWith(
        "/api/method/hvg_workspace.mcp_events.api.subscribe",
      ),
    );
    assertEquals(
      JSON.parse(seen[0].body!).delivery_url,
      "https://hooks.example.com/cb",
    );
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) Deno.env.delete("ERPNEXT_URL");
    else Deno.env.set("ERPNEXT_URL", previous);
    setFrappeClient(null);
  }
});

// ── Phong bì và lỗi ──────────────────────────────────────────────────────────

Deno.test("an ok:false envelope becomes the matching Events error without the ERP message", async () => {
  const { client } = fakeClient(() => ({
    ok: false,
    error: {
      code: -32013,
      message: "limit 10 reached for user khoa",
      data: { limit: { max: 10 } },
    },
  }));
  const store = createErpEventsStore({ getClient: () => client });
  const error = await assertRejects(
    () => asCaller(() => store.subscribe(SUBSCRIBE)),
    EventsProtocolError,
  );
  assertEquals(error.toJsonRpcError(), {
    code: -32013,
    message: "Subscription limit reached",
    data: { limit: { max: 10 } },
  });
});

Deno.test("a malformed envelope or result is a backend error", async () => {
  for (
    const reply of [null, "text", {}, { ok: "yes" }, {
      ok: true,
      result: { id: 5 },
    }, { ok: true, result: null }]
  ) {
    const { client } = fakeClient(() => reply);
    const store = createErpEventsStore({ getClient: () => client });
    const error = await assertRejects(
      () => asCaller(() => store.subscribe(SUBSCRIBE)),
      EventsProtocolError,
    );
    assertEquals(error.code, EventsErrorCode.InternalError);
  }
});

Deno.test("transport errors: 401 is an auth failure, 403 is forbidden, 429 is quota, everything else is backend", async () => {
  const cases: Array<[unknown, "auth" | number]> = [
    [new FrappeAPIError("Not permitted token=abc", 401, null), "auth"],
    [
      new FrappeAPIError("PermissionError", 403, null),
      EventsErrorCode.Forbidden,
    ],
    [new FrappeAPIError("slow down", 429, null), EventsErrorCode.QuotaExceeded],
    [
      new FrappeAPIError("Traceback: password=hunter2", 500, null),
      EventsErrorCode.InternalError,
    ],
    [
      new FrappeAPIError("network down", 0, null),
      EventsErrorCode.InternalError,
    ],
    [new Error("boom"), EventsErrorCode.InternalError],
  ];
  for (const [failure, expected] of cases) {
    const { client } = fakeClient(() => {
      throw failure;
    });
    const store = createErpEventsStore({ getClient: () => client });
    const error = await assertRejects(() =>
      asCaller(() => store.subscribe(SUBSCRIBE))
    );
    if (expected === "auth") assert(error instanceof EventsAuthError);
    else {
      assert(error instanceof EventsProtocolError);
      assertEquals(error.code, expected);
      assert(!JSON.stringify(error.toJsonRpcError()).includes("hunter2"));
    }
  }
});

Deno.test("unwrapErpEnvelope and classifyTransportError behave on edge inputs", () => {
  assertEquals(unwrapErpEnvelope({ ok: true, result: 1 }), {
    ok: true,
    result: 1,
  });
  assertEquals(unwrapErpEnvelope({ ok: false, error: { code: 1 } }), {
    ok: false,
    error: { code: 1 },
  });
  assert(
    classifyTransportError(new EventsAuthError()) instanceof EventsAuthError,
  );
  const passthrough = new EventsProtocolError(EventsErrorCode.EventNotFound);
  assert(classifyTransportError(passthrough) === passthrough);
});

// ── meeting_get (đọc lại) ───────────────────────────────────────────────────

const MEETING = {
  event_id: "EVT-1",
  revision: 4,
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

Deno.test("fetchMeeting does a GET each time and sends only the declared arguments", async () => {
  let revision = 1;
  const { client, calls } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, revision: revision++ },
  }));
  const first = await fetchMeeting(client, {
    event_id: "EVT-1",
    window_start: "2030-05-01",
  });
  const second = await fetchMeeting(client, { event_id: "EVT-1" });
  assertEquals(first.revision, 1);
  assertEquals(second.revision, 2, "no result may be served from a cache");
  assertEquals(calls.map((call) => call.httpMethod), ["GET", "GET"]);
  assertEquals(calls[0].method, "hvg_workspace.mcp_events.api.meeting_get");
  assertEquals(calls[0].args, {
    event_id: "EVT-1",
    window_start: "2030-05-01",
  });
  assertEquals(calls[1].args, { event_id: "EVT-1" });
});

Deno.test("fetchMeeting passes a tombstone through unchanged", async () => {
  const tombstone = { event_id: "EVT-1", revision: 9, deleted: true };
  const { client } = fakeClient(() => ({ ok: true, result: tombstone }));
  assertEquals(await fetchMeeting(client, { event_id: "EVT-1" }), tombstone);
});

Deno.test("fetchMeeting returns only the advertised fields, even if ERP adds more", async () => {
  const { client } = fakeClient(() => ({
    ok: true,
    result: {
      ...MEETING,
      subject: "Salary review",
      description: "private notes",
      participants: [{ email: "someone@example.com" }],
      recurrence: {
        frequency: "Weekly",
        until: null,
        weekdays: ["monday"],
        link: "https://meet.example.com/x",
      },
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "2030-05-01T02:00:00Z",
        occurrence_end: "2030-05-01T03:00:00Z",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
        room: "Board room",
      }],
    },
  }));
  const result = await fetchMeeting(client, { event_id: "EVT-1" });
  const serialized = JSON.stringify(result);
  for (
    const leaked of [
      "Salary review",
      "private notes",
      "someone@example.com",
      "meet.example.com",
      "Board room",
    ]
  ) {
    assert(!serialized.includes(leaked), `${leaked} must not be returned`);
  }
  assertEquals(result.event_id, "EVT-1");
  assertEquals(result.revision, 4);
  assertEquals(
    (result.recurrence as Record<string, unknown>).frequency,
    "Weekly",
  );
  assertEquals((result.occurrences as unknown[]).length, 1);
});

Deno.test("fetchMeeting maps every failure to a fixed message", async () => {
  const cases: Array<[() => unknown, string]> = [
    [
      () => ({
        ok: false,
        error: { code: -32011, message: "Event EVT-1 not found for khoa" },
      }),
      "Unknown event name",
    ],
    [
      () => ({ ok: false, error: { code: -32012, message: "secret details" } }),
      "Not allowed to use this event",
    ],
    [
      () => ({ ok: false, error: { code: 418, message: "teapot" } }),
      "Events backend error",
    ],
    [() => {
      throw new FrappeAPIError("PermissionError: khoa@x", 403, null);
    }, "Not authorized to read this meeting"],
    [() => {
      throw new FrappeAPIError("Traceback hunter2", 500, null);
    }, "Events backend error"],
    [() => ({ nope: true }), "Events backend error"],
    [() => ({ ok: true, result: { revision: 1 } }), "Events backend error"],
  ];
  for (const [respond, message] of cases) {
    const { client } = fakeClient(respond);
    const error = await assertRejects(() =>
      fetchMeeting(client, { event_id: "EVT-1" })
    );
    assertEquals((error as Error).message, message);
  }
});
