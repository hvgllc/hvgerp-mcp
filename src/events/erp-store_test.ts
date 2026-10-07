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

Deno.test("subscribe forwards maxAgeMs as max_age_ms and omits it otherwise", async () => {
  const { client, calls } = fakeClient(() => OK_SUBSCRIBE);
  const store = createErpEventsStore({ getClient: () => client });
  await asCaller(() => store.subscribe({ ...SUBSCRIBE, maxAgeMs: 60_000 }));
  assertEquals(calls[0].args.max_age_ms, 60_000);
  await asCaller(() => store.subscribe(SUBSCRIBE));
  assertEquals(Object.hasOwn(calls[1].args, "max_age_ms"), false);
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

Deno.test("a shared service client is refused even inside a caller scope", async () => {
  // `setFrappeClient()` có thể tiêm tài khoản dịch vụ; request có danh tính vẫn không được chạy bằng nó.
  for (const identity of ["service", undefined]) {
    const { client, calls } = fakeClient(() => OK_SUBSCRIBE);
    Object.assign(client, { actsAs: identity });
    const store = createErpEventsStore({ getClient: () => client });
    for (
      const call of [
        () => store.subscribe(SUBSCRIBE),
        () =>
          store.unsubscribe({
            name: SUBSCRIBE.name,
            arguments: SUBSCRIBE.arguments,
            deliveryUrl: SUBSCRIBE.deliveryUrl,
          }),
      ]
    ) {
      const error = await asCaller(() =>
        assertRejects(call, EventsProtocolError)
      );
      assertEquals(error.code, EventsErrorCode.Forbidden);
    }
    assertEquals(calls.length, 0);
  }
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
      data: { limit: "subscriptions", max: 10 },
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
    data: { limit: "subscriptions", max: 10 },
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

Deno.test("transport errors: 401 is an auth failure, 403 is forbidden, 429 throttling is a neutral backend error, everything else is backend", async () => {
  const cases: Array<[unknown, "auth" | number]> = [
    [new FrappeAPIError("Not permitted token=abc", 401, null), "auth"],
    [
      new FrappeAPIError("PermissionError", 403, null),
      EventsErrorCode.Forbidden,
    ],
    [new FrappeAPIError("slow down", 429, null), EventsErrorCode.InternalError],
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

Deno.test("a contradictory or incomplete success envelope is a backend error, even for unsubscribe", async () => {
  const malformed = [
    { ok: true },
    { ok: true, error: { code: -32012 } },
    { ok: true, result: {}, error: { code: -32012 } },
    { ok: false },
    { ok: false, result: {} },
  ];
  for (const message of malformed) {
    assertThrowsBackend(() => unwrapErpEnvelope(message));
    const { client } = fakeClient(() => message);
    const store = createErpEventsStore({ getClient: () => client });
    const error = await assertRejects(() =>
      asCaller(() =>
        store.unsubscribe({
          name: "meeting.updated",
          arguments: {},
          deliveryUrl: "https://hooks.example.com/cb",
        })
      )
    );
    assert(error instanceof EventsProtocolError);
    assertEquals(error.code, EventsErrorCode.InternalError);
  }
  // Phong bì đúng hình vẫn được chấp nhận, kể cả result rỗng.
  assertEquals(unwrapErpEnvelope({ ok: true, result: null }), {
    ok: true,
    result: null,
  });
});

function assertThrowsBackend(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    assert(error instanceof EventsProtocolError);
    assertEquals(error.code, EventsErrorCode.InternalError);
    return;
  }
  throw new Error("expected a backend error");
}

Deno.test("fetchMeeting reports ERP throttling without mentioning subscription limits", async () => {
  const { client } = fakeClient(() => {
    throw new FrappeAPIError("slow down", 429, null);
  });
  const error = await assertRejects(() =>
    fetchMeeting(client, { event_id: "EVT-1" })
  );
  assertEquals(
    (error as Error).message,
    "ERP is rate limiting requests, try again later",
  );
});

Deno.test("fetchMeeting reduces a deleted meeting to the three tombstone fields", async () => {
  const { client } = fakeClient(() => ({
    ok: true,
    result: {
      ...MEETING,
      deleted: true,
      recurrence: { frequency: "Weekly", until: null, weekdays: ["monday"] },
      occurrences: [{ series_id: "EVT-1", occurrence_start: "2030-05-01" }],
    },
  }));
  assertEquals(await fetchMeeting(client, { event_id: "EVT-1" }), {
    event_id: "EVT-1",
    revision: 4,
    deleted: true,
  });
});

Deno.test("fetchMeeting accepts every native Event recurrence frequency", async () => {
  for (
    const frequency of [
      "Daily",
      "Weekly",
      "Monthly",
      "Quarterly",
      "Half Yearly",
      "Yearly",
    ]
  ) {
    const { client } = fakeClient(() => ({
      ok: true,
      result: {
        ...MEETING,
        recurrence: { frequency, until: null, weekdays: [] },
      },
    }));
    const result = await fetchMeeting(client, { event_id: "EVT-1" });
    assertEquals(
      (result.recurrence as { frequency: string }).frequency,
      frequency,
    );
  }
});

Deno.test("fetchMeeting fails on a malformed occurrence instead of dropping it", async () => {
  for (const occurrences of [[null], ["x"], [1, {}], {}, "none"]) {
    const { client } = fakeClient(() => ({
      ok: true,
      result: { ...MEETING, occurrences },
    }));
    await assertRejects(
      () => fetchMeeting(client, { event_id: "EVT-1" }),
      Error,
      "Events backend error",
    );
  }
});

Deno.test("fetchMeeting fails on a malformed recurrence instead of reading it as non-recurring", async () => {
  for (const recurrence of ["Weekly", 1, true, [], ["Weekly"]]) {
    const { client } = fakeClient(() => ({
      ok: true,
      result: { ...MEETING, recurrence },
    }));
    await assertRejects(
      () => fetchMeeting(client, { event_id: "EVT-1" }),
      Error,
      "Events backend error",
    );
  }
  const { client } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, recurrence: null },
  }));
  assertEquals(
    (await fetchMeeting(client, { event_id: "EVT-1" })).recurrence,
    null,
  );
});

Deno.test("fetchMeeting rejects a successful result whose values have the wrong shape", async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["missing revision", { revision: undefined }],
    ["fractional revision", { revision: 1.5 }],
    ["zero revision", { revision: 0 }],
    ["string revision", { revision: "4" }],
    ["object status", { status: { note: "private" } }],
    ["free-form status", { status: "Private: salary review" }],
    ["empty status", { status: "" }],
    ["lowercase status", { status: "open" }],
    ["string all_day", { all_day: "false" }],
    ["object time_zone", { time_zone: { x: 1 } }],
    ["empty time_zone", { time_zone: "" }],
    ["empty occurrence zone", {
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "2030-05-01T10:00:00Z",
        occurrence_end: "2030-05-01T11:00:00Z",
        zone: "",
        schedule_revision: 4,
      }],
    }],
    ["timed recurrence ending two days before the meeting", {
      recurrence: { frequency: "Weekly", until: "2030-04-29" },
    }],
    ["all-day recurrence ending before the meeting", {
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: "2030-05-10",
      end_date_exclusive: "2030-05-11",
      recurrence: { frequency: "Weekly", until: "2030-05-01" },
    }],
    ["object starts_at", { starts_at: { x: 1 } }],
    ["number ends_at", { ends_at: 5 }],
    ["array start_date", { start_date: ["2030-05-01"] }],
    ["string has_more", { has_more: "no" }],
    ["non-date starts_at", { starts_at: "tomorrow" }],
    ["starts_at without a UTC designator", {
      starts_at: "2030-05-01T02:00:00",
    }],
    ["impossible starts_at day", { starts_at: "2030-02-30T02:00:00Z" }],
    ["non-date ends_at", { ends_at: "soon" }],
    ["impossible all-day date", {
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: "2030-02-30",
      end_date_exclusive: "2030-03-01",
    }],
    ["all-day end given as a timestamp", {
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: "2030-05-01",
      end_date_exclusive: "2030-05-02T00:00:00Z",
    }],
    ["malformed recurrence until", {
      recurrence: { frequency: "Weekly", until: "2030-13-01" },
    }],
    ["malformed occurrence start", {
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "next tuesday",
        occurrence_end: "2030-05-01T03:00:00Z",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    }],
    ["occurrence from another series", {
      occurrences: [{
        series_id: "EVT-2",
        occurrence_start: "2030-05-01T02:00:00Z",
        occurrence_end: "2030-05-01T03:00:00Z",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    }],
    ["occurrence with an empty series", {
      occurrences: [{
        series_id: "",
        occurrence_start: "2030-05-01T02:00:00Z",
        occurrence_end: "2030-05-01T03:00:00Z",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    }],
    ["timed meeting with a date-only occurrence", {
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "2030-05-01",
        occurrence_end: "2030-05-02",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    }],
    ["timed meeting without starts_at", { starts_at: null }],
    ["timed meeting with empty starts_at", { starts_at: "" }],
    ["timed meeting carrying all-day dates", {
      start_date: "2030-05-01",
      end_date_exclusive: "2030-05-02",
    }],
    ["all-day meeting without dates", { all_day: true }],
    ["all-day meeting with only a start date", {
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: "2030-05-01",
    }],
    ["all-day meeting carrying timed fields", {
      all_day: true,
      start_date: "2030-05-01",
      end_date_exclusive: "2030-05-02",
    }],
    ["timed meeting ending before it starts", {
      starts_at: "2030-05-02T02:00:00Z",
      ends_at: "2030-05-01T02:00:00Z",
    }],
    ["all-day meeting whose exclusive end is before its start", {
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: "2030-05-02",
      end_date_exclusive: "2030-05-01",
    }],
    ["all-day meeting with an empty range", {
      all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: "2030-05-02",
      end_date_exclusive: "2030-05-02",
    }],
    ["timed occurrence ending before it starts", {
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "2030-05-01T03:00:00Z",
        occurrence_end: "2030-05-01T02:00:00Z",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    }],
    ["timed meeting ending before it starts by sub-millisecond digits", {
      starts_at: "2030-05-01T10:00:00.9999Z",
      ends_at: "2030-05-01T10:00:00.9990Z",
    }],
    ["timed occurrence ending before it starts by sub-millisecond digits", {
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "2030-05-01T10:00:00.9999Z",
        occurrence_end: "2030-05-01T10:00:00.9990Z",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    }],
    ["truthy non-boolean deleted", { deleted: "yes" }],
    ["object frequency", { recurrence: { frequency: { a: 1 }, until: null } }],
    ["object until", { recurrence: { frequency: "Weekly", until: { a: 1 } } }],
    ["free-text weekday", {
      recurrence: { frequency: "Weekly", weekdays: ["private notes"] },
    }],
    ["empty weekday", { recurrence: { frequency: "Weekly", weekdays: [""] } }],
    ["wrong-case weekday", {
      recurrence: { frequency: "Weekly", weekdays: ["Monday"] },
    }],
    ["duplicate weekday", {
      recurrence: { frequency: "Weekly", weekdays: ["monday", "monday"] },
    }],
    ["free-text frequency", {
      recurrence: { frequency: "private notes", until: null },
    }],
    ["object weekday", { recurrence: { frequency: "Weekly", weekdays: [{}] } }],
    ["string weekdays", {
      recurrence: { frequency: "Weekly", weekdays: "monday" },
    }],
    [
      "object occurrence zone",
      {
        occurrences: [{
          series_id: "EVT-1",
          occurrence_start: "2030-05-01T02:00:00Z",
          occurrence_end: "2030-05-01T03:00:00Z",
          zone: { a: 1 },
          schedule_revision: 4,
        }],
      },
    ],
    [
      "missing schedule_revision",
      {
        occurrences: [{
          series_id: "EVT-1",
          occurrence_start: "2030-05-01T02:00:00Z",
          occurrence_end: "2030-05-01T03:00:00Z",
          zone: "Asia/Ho_Chi_Minh",
        }],
      },
    ],
  ];
  for (const [label, patch] of bad) {
    const { client } = fakeClient(() => ({
      ok: true,
      result: { ...MEETING, ...patch },
    }));
    await assertRejects(
      () => fetchMeeting(client, { event_id: "EVT-1" }),
      Error,
      "Events backend error",
      label,
    );
  }
});

Deno.test("fetchMeeting accepts a well-formed all-day meeting and a timed meeting without an end", async () => {
  const allDay = {
    ...MEETING,
    all_day: true,
    starts_at: null,
    ends_at: null,
    start_date: "2030-05-01",
    end_date_exclusive: "2030-05-02",
  };
  const { client: allDayClient } = fakeClient(() => ({
    ok: true,
    result: allDay,
  }));
  const meeting = await fetchMeeting(allDayClient, { event_id: "EVT-1" });
  assertEquals(meeting.all_day, true);
  assertEquals(meeting.start_date, "2030-05-01");
  const { client: dateOccurrenceClient } = fakeClient(() => ({
    ok: true,
    result: {
      ...allDay,
      recurrence: { frequency: "Weekly", until: "2030-06-01" },
      occurrences: [{
        series_id: "EVT-1",
        occurrence_start: "2030-05-01",
        occurrence_end: "2030-05-02",
        zone: "Asia/Ho_Chi_Minh",
        schedule_revision: 4,
      }],
    },
  }));
  const dated = await fetchMeeting(dateOccurrenceClient, {
    event_id: "EVT-1",
  });
  assertEquals((dated.occurrences as unknown[]).length, 1);
  const { client: openEndedClient } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, ends_at: null },
  }));
  const openEnded = await fetchMeeting(openEndedClient, {
    event_id: "EVT-1",
  });
  assertEquals(openEnded.ends_at, null);
});

Deno.test("fetchMeeting rejects a tombstone without an integer revision", async () => {
  for (const revision of [undefined, 0, 2.5, "9", null, { a: 1 }]) {
    const { client } = fakeClient(() => ({
      ok: true,
      result: { event_id: "EVT-1", revision, deleted: true },
    }));
    await assertRejects(
      () => fetchMeeting(client, { event_id: "EVT-1" }),
      Error,
      "Events backend error",
    );
  }
});

Deno.test("fetchMeeting accepts a well-formed recurring meeting unchanged", async () => {
  const recurring = {
    ...MEETING,
    recurrence: {
      frequency: "Weekly",
      until: "2030-12-31",
      weekdays: ["monday", "friday"],
    },
    occurrences: [{
      series_id: "EVT-1",
      occurrence_start: "2030-05-01T02:00:00Z",
      occurrence_end: "2030-05-01T03:00:00Z",
      zone: "Asia/Ho_Chi_Minh",
      schedule_revision: 4,
    }],
    has_more: true,
  };
  const { client } = fakeClient(() => ({ ok: true, result: recurring }));
  assertEquals(await fetchMeeting(client, { event_id: "EVT-1" }), recurring);
});

Deno.test("fetchMeeting rejects a result that answers for a different event", async () => {
  for (const eventId of ["EVT-2", "", "evt-1", "EVT-1 "]) {
    const { client } = fakeClient(() => ({
      ok: true,
      result: { ...MEETING, event_id: eventId },
    }));
    await assertRejects(
      () => fetchMeeting(client, { event_id: "EVT-1" }),
      Error,
      "Events backend error",
      `event_id ${JSON.stringify(eventId)}`,
    );
  }
  const { client } = fakeClient(() => ({
    ok: true,
    result: { event_id: "EVT-2", revision: 3, deleted: true },
  }));
  await assertRejects(
    () => fetchMeeting(client, { event_id: "EVT-1" }),
    Error,
    "Events backend error",
  );
});

Deno.test("fetchMeeting requires an occurrences array for every windowed read", async () => {
  const withoutOccurrences = { ...MEETING } as Record<string, unknown>;
  delete withoutOccurrences.occurrences;
  const { client } = fakeClient(() => ({
    ok: true,
    result: withoutOccurrences,
  }));
  for (
    const args of [
      { event_id: "EVT-1", window_start: "2030-05-01" },
      { event_id: "EVT-1", window_end: "2030-05-02" },
      { event_id: "EVT-1", occurrence_start: "2030-05-01" },
    ]
  ) {
    await assertRejects(
      () => fetchMeeting(client, args),
      Error,
      "Events backend error",
    );
  }
  // Không có cửa sổ thì không bắt buộc, như trước.
  const plain = await fetchMeeting(client, { event_id: "EVT-1" });
  assertEquals(Object.hasOwn(plain, "occurrences"), false);
});

Deno.test("fetchMeeting requires recurrence on a live meeting: an object or exactly null", async () => {
  const withoutRecurrence = { ...MEETING } as Record<string, unknown>;
  delete withoutRecurrence.recurrence;
  const { client } = fakeClient(() => ({
    ok: true,
    result: withoutRecurrence,
  }));
  for (
    const args of [
      { event_id: "EVT-1" },
      { event_id: "EVT-1", window_start: "2030-05-01" },
    ]
  ) {
    await assertRejects(
      () => fetchMeeting(client, args),
      Error,
      "Events backend error",
    );
  }
  // Một phản hồi `undefined` (khóa có mặt nhưng rỗng) cũng không phải `null`.
  const { client: undefinedClient } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, recurrence: undefined },
  }));
  await assertRejects(
    () => fetchMeeting(undefinedClient, { event_id: "EVT-1" }),
    Error,
    "Events backend error",
  );
});

const TIMED_OCCURRENCE = {
  series_id: "EVT-1",
  occurrence_start: "2030-05-01T02:00:00Z",
  occurrence_end: "2030-05-01T03:00:00Z",
  zone: "Asia/Ho_Chi_Minh",
  schedule_revision: 4,
};

async function readOccurrences(
  requested: string,
  occurrence: Record<string, unknown>,
  meeting: Record<string, unknown> = {},
) {
  const { client } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, ...meeting, occurrences: [occurrence] },
  }));
  return await fetchMeeting(client, {
    event_id: "EVT-1",
    occurrence_start: requested,
  });
}

Deno.test("fetchMeeting accepts occurrences that touch the requested day in the meeting zone", async () => {
  for (
    const requested of [
      "2030-05-01T02:00:00Z",
      "2030-05-01",
      // 20:00Z ngày 30/04 là 03:00 ngày 01/05 theo giờ Việt Nam: ngày UTC lệch nhưng ngày của cuộc họp thì không.
      "2030-04-30T20:00:00Z",
      "2030-05-01T09:00:00",
      "2030-05-01T09:00:00+07:00",
    ]
  ) {
    const result = await readOccurrences(requested, TIMED_OCCURRENCE);
    assertEquals((result.occurrences as unknown[]).length, 1, requested);
  }
  // Lần bắt đầu tối 01/05 và kết thúc 01:00 ngày 02/05 vẫn chạm ngày 02/05.
  const spanning = {
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-05-01T15:00:00Z",
    occurrence_end: "2030-05-01T18:00:00Z",
  };
  assertEquals(
    ((await readOccurrences("2030-05-02", spanning)).occurrences as unknown[])
      .length,
    1,
  );
});

Deno.test("fetchMeeting rejects an occurrence that does not touch the requested day", async () => {
  for (
    const requested of [
      "2030-05-03",
      "2030-04-30",
      "2030-05-01T20:00:00Z",
      "2030-05-03T02:00:00+07:00",
    ]
  ) {
    await assertRejects(
      () => readOccurrences(requested, TIMED_OCCURRENCE),
      Error,
      "Events backend error",
      requested,
    );
  }
});

Deno.test("fetchMeeting treats a timed occurrence ending at midnight of the requested day as not touching it", async () => {
  const endsAtMidnight = {
    ...TIMED_OCCURRENCE,
    zone: "UTC",
    occurrence_start: "2030-05-01T23:00:00Z",
    occurrence_end: "2030-05-02T00:00:00Z",
  };
  // Lần diễn ra kết thúc đúng 00:00 ngày 02/05 chỉ chạm ngày 01/05, không được nhận là lần diễn ra của ngày 02/05.
  await assertRejects(
    () => readOccurrences("2030-05-02", endsAtMidnight),
    Error,
    "Events backend error",
  );
  assertEquals(
    ((await readOccurrences("2030-05-01", endsAtMidnight))
      .occurrences as unknown[]).length,
    1,
  );
  // Chỉ cần kéo dài qua mốc nửa đêm là chạm cả ngày sau, kể cả khi chỉ vượt dưới một mili giây.
  for (
    const occurrenceEnd of [
      "2030-05-02T00:00:00.001Z",
      "2030-05-02T00:00:00.0001Z",
    ]
  ) {
    const pastMidnight = { ...endsAtMidnight, occurrence_end: occurrenceEnd };
    assertEquals(
      ((await readOccurrences("2030-05-02", pastMidnight))
        .occurrences as unknown[]).length,
      1,
      occurrenceEnd,
    );
  }
  // Phần thập phân toàn số 0 vẫn là đúng nửa đêm.
  await assertRejects(
    () =>
      readOccurrences("2030-05-02", {
        ...endsAtMidnight,
        occurrence_end: "2030-05-02T00:00:00.000000Z",
      }),
    Error,
    "Events backend error",
  );
});

Deno.test("fetchMeeting keeps sub-millisecond overlaps at the window floor", async () => {
  const window = { window_start: "2030-05-02T00:00:00Z" };
  const endingAt = (occurrenceEnd: string) => ({
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-04-30T23:00:00Z",
    occurrence_end: occurrenceEnd,
  });
  // Kết thúc sau biên dưới (một ngày trước cửa sổ) dù chỉ dưới một mili giây vẫn chồng lên vùng được nhận.
  for (const occurrenceEnd of ["2030-05-01T00:00:00.0001Z"]) {
    assertEquals(
      ((await readWindow(window, endingAt(occurrenceEnd)))
        .occurrences as unknown[]).length,
      1,
      occurrenceEnd,
    );
  }
  // Kết thúc đúng tại biên dưới thì không chồng.
  for (
    const occurrenceEnd of [
      "2030-05-01T00:00:00Z",
      "2030-05-01T00:00:00.0000Z",
    ]
  ) {
    await assertRejects(
      () => readWindow(window, endingAt(occurrenceEnd)),
      Error,
      "Events backend error",
      occurrenceEnd,
    );
  }
});

Deno.test("fetchMeeting builds local days from date parts, not from locale-formatted text", async () => {
  const RealFormat = Intl.DateTimeFormat;
  // Mô phỏng ICU rút gọn: `format()` trả `MM/DD/YYYY` thay vì `YYYY-MM-DD`.
  class ReducedFormat extends RealFormat {
    override format(date?: Date | number): string {
      const parts = this.formatToParts(date);
      const pick = (type: string) =>
        parts.find((part) => part.type === type)?.value;
      return `${pick("month")}/${pick("day")}/${pick("year")}`;
    }
  }
  const spanningYear = {
    ...TIMED_OCCURRENCE,
    zone: "UTC",
    occurrence_start: "2030-12-31T20:00:00Z",
    occurrence_end: "2031-01-01T02:00:00Z",
  };
  (Intl as { DateTimeFormat: unknown }).DateTimeFormat = ReducedFormat;
  try {
    for (const requested of ["2030-12-31", "2031-01-01"]) {
      assertEquals(
        ((await readOccurrences(requested, spanningYear))
          .occurrences as unknown[]).length,
        1,
        requested,
      );
    }
    await assertRejects(
      () => readOccurrences("2031-01-02", spanningYear),
      Error,
      "Events backend error",
    );
  } finally {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = RealFormat;
  }
});

Deno.test("fetchMeeting binds all-day occurrences to the requested day with an exclusive end", async () => {
  const meeting = {
    all_day: true,
    starts_at: null,
    ends_at: null,
    start_date: "2030-05-01",
    end_date_exclusive: "2030-05-03",
  };
  const allDay = {
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-05-01",
    occurrence_end: "2030-05-03",
  };
  for (const requested of ["2030-05-01", "2030-05-02"]) {
    const result = await readOccurrences(requested, allDay, meeting);
    assertEquals((result.occurrences as unknown[]).length, 1, requested);
  }
  for (const requested of ["2030-05-03", "2030-04-30"]) {
    await assertRejects(
      () => readOccurrences(requested, allDay, meeting),
      Error,
      "Events backend error",
      requested,
    );
  }
});

Deno.test("fetchMeeting leaves the day check to ERP when it cannot read the requested start", async () => {
  const result = await readOccurrences("20300503", TIMED_OCCURRENCE);
  assertEquals((result.occurrences as unknown[]).length, 1);
});

Deno.test("fetchMeeting leaves a naive occurrence_start to ERP because its zone is the site's", async () => {
  // ERP đọc mốc không offset theo múi giờ của site, nên ngày từ vựng không phải ngày của cuộc họp: không được từ chối.
  for (const requested of ["2030-05-03T09:00:00", "2030-04-30 23:30:00"]) {
    const result = await readOccurrences(requested, TIMED_OCCURRENCE);
    assertEquals((result.occurrences as unknown[]).length, 1, requested);
  }
});

async function readWindow(
  window: { window_start?: string; window_end?: string },
  occurrence: Record<string, unknown>,
  meeting: Record<string, unknown> = {},
) {
  const { client } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, ...meeting, occurrences: [occurrence] },
  }));
  return await fetchMeeting(client, { event_id: "EVT-1", ...window });
}

Deno.test("fetchMeeting accepts occurrences inside or touching the requested window", async () => {
  for (
    const window of [
      {
        window_start: "2030-05-01T00:00:00Z",
        window_end: "2030-05-02T00:00:00Z",
      },
      { window_start: "2030-05-01", window_end: "2030-05-01" },
      // Biên không offset được nới một ngày mỗi phía vì múi giờ của site chưa biết.
      {
        window_start: "2030-05-01T20:00:00",
        window_end: "2030-05-02T08:00:00",
      },
      { window_start: "2030-05-01T09:00:00+07:00" },
      { window_end: "2030-05-01T10:00:00Z" },
      {},
    ]
  ) {
    const result = await readWindow(window, TIMED_OCCURRENCE);
    assertEquals(
      (result.occurrences as unknown[]).length,
      1,
      JSON.stringify(window),
    );
  }
});

Deno.test("fetchMeeting rejects an occurrence wholly outside the requested window", async () => {
  for (
    const window of [
      {
        window_start: "2030-05-04T00:00:00Z",
        window_end: "2030-05-10T00:00:00Z",
      },
      { window_start: "2030-05-04" },
      { window_end: "2030-04-20T00:00:00Z" },
      { window_start: "2030-06-01T00:00:00+07:00", window_end: "2030-06-02" },
    ]
  ) {
    await assertRejects(
      () => readWindow(window, TIMED_OCCURRENCE),
      Error,
      "Events backend error",
      JSON.stringify(window),
    );
  }
});

Deno.test("fetchMeeting applies the window check to all-day occurrences", async () => {
  const meeting = {
    all_day: true,
    starts_at: null,
    ends_at: null,
    start_date: "2030-05-01",
    end_date_exclusive: "2030-05-03",
  };
  const allDay = {
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-05-01",
    occurrence_end: "2030-05-03",
  };
  const inside = await readWindow(
    { window_start: "2030-05-02", window_end: "2030-05-09" },
    allDay,
    meeting,
  );
  assertEquals((inside.occurrences as unknown[]).length, 1);
  await assertRejects(
    () => readWindow({ window_start: "2030-05-20" }, allDay, meeting),
    Error,
    "Events backend error",
  );
});

Deno.test("fetchMeeting ignores the window bounds when occurrence_start is given", async () => {
  // ERP bỏ qua cửa sổ khi có `occurrence_start`, nên biên cửa sổ không được làm hỏng lần diễn ra đúng ngày.
  const { client } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, occurrences: [TIMED_OCCURRENCE] },
  }));
  const result = await fetchMeeting(client, {
    event_id: "EVT-1",
    occurrence_start: "2030-05-01",
    window_start: "2031-01-01",
    window_end: "2031-02-01",
  });
  assertEquals((result.occurrences as unknown[]).length, 1);
});

Deno.test("fetchMeeting limits a date-time window_end to a one-day slack but gives a date-only end its whole day", async () => {
  const farLater = {
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-05-03T09:00:00Z",
    occurrence_end: "2030-05-03T10:00:00Z",
  };
  await assertRejects(
    () => readWindow({ window_end: "2030-05-01T10:00:00Z" }, farLater),
    Error,
    "Events backend error",
  );
  const nextDay = {
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-05-02T08:00:00Z",
    occurrence_end: "2030-05-02T09:00:00Z",
  };
  // Một ngày chừa biên múi giờ vẫn được nhận với mốc có giờ.
  assertEquals(
    ((await readWindow({ window_end: "2030-05-01T10:00:00Z" }, nextDay))
      .occurrences as unknown[]).length,
    1,
  );
  // Biên chỉ có ngày nghĩa là hết ngày đó: lần diễn ra cuối ngày 01/05 và đầu ngày 02/05 (UTC) đều hợp lệ, ngày 04/05 thì không.
  const endOfDay = {
    ...TIMED_OCCURRENCE,
    occurrence_start: "2030-05-02T20:00:00Z",
    occurrence_end: "2030-05-02T21:00:00Z",
  };
  assertEquals(
    ((await readWindow({ window_end: "2030-05-01" }, endOfDay))
      .occurrences as unknown[]).length,
    1,
  );
  await assertRejects(
    () =>
      readWindow({ window_end: "2030-05-01" }, {
        ...TIMED_OCCURRENCE,
        occurrence_start: "2030-05-04T00:00:00Z",
        occurrence_end: "2030-05-04T01:00:00Z",
      }),
    Error,
    "Events backend error",
  );
});

async function readRecurrence(
  meeting: Record<string, unknown>,
  until: string,
) {
  const { client } = fakeClient(() => ({
    ok: true,
    result: {
      ...MEETING,
      ...meeting,
      recurrence: { frequency: "Weekly", until },
    },
  }));
  return await fetchMeeting(client, { event_id: "EVT-1" });
}

Deno.test("fetchMeeting derives the first local day of a timed recurrence from the declared zone", async () => {
  const utcMeeting = {
    time_zone: "UTC",
    starts_at: "2030-05-10T09:00:00Z",
    ends_at: "2030-05-10T10:00:00Z",
  };
  assertEquals(
    ((await readRecurrence(utcMeeting, "2030-05-10")).recurrence as {
      until: string;
    }).until,
    "2030-05-10",
  );
  await assertRejects(
    () => readRecurrence(utcMeeting, "2030-05-09"),
    Error,
    "Events backend error",
  );
  // 20:00Z ngày 09/05 là 03:00 ngày 10/05 theo giờ Việt Nam: ngày bắt đầu của cuộc họp là 10/05.
  const vietnamMeeting = {
    time_zone: "Asia/Ho_Chi_Minh",
    starts_at: "2030-05-09T20:00:00Z",
    ends_at: "2030-05-09T21:00:00Z",
  };
  await readRecurrence(vietnamMeeting, "2030-05-10");
  await assertRejects(
    () => readRecurrence(vietnamMeeting, "2030-05-09"),
    Error,
    "Events backend error",
  );
});

Deno.test("fetchMeeting rejects a time zone it cannot interpret on the meeting or on an occurrence", async () => {
  const { client: badMeeting } = fakeClient(() => ({
    ok: true,
    result: { ...MEETING, time_zone: "private notes" },
  }));
  await assertRejects(
    () => fetchMeeting(badMeeting, { event_id: "EVT-1" }),
    Error,
    "Events backend error",
  );
  // Zone hỏng trên lần diễn ra không được làm kiểm tra ngày bị bỏ qua: `private notes` không bao giờ tới người gọi.
  await assertRejects(
    () =>
      readOccurrences("2030-05-03T02:00:00+07:00", {
        ...TIMED_OCCURRENCE,
        zone: "private notes",
      }),
    Error,
    "Events backend error",
  );
  await assertRejects(
    () => readWindow({}, { ...TIMED_OCCURRENCE, zone: "private notes" }),
    Error,
    "Events backend error",
  );
});
