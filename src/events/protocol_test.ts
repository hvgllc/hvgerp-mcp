/**
 * Test cho catalog, schema và kiểm tra tham số của MCP Events (không qua HTTP).
 *
 * @module lib/erpnext/src/events/protocol_test
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import contract from "./contract/meeting-events.v1.json" with { type: "json" };
import {
  collectKeywords,
  SUPPORTED_KEYWORDS,
  validateJsonSchema,
} from "./json-schema.ts";
import {
  CHANGE_BY_EVENT,
  eventCatalog,
  EventsErrorCode,
  EventsProtocolError,
  handleEventsList,
  isValidSigningSecret,
  mapErpError,
  MEETING_EVENT_NAMES,
  parseSubscribeParams,
  parseUnsubscribeParams,
  PAYLOAD_SCHEMA,
  toSubscribeResult,
  validateEventPayload,
} from "./protocol.ts";

const CALLBACK = "https://hooks.example.com/cb";

function secretOf(byteLength: number): string {
  return "whsec_" +
    btoa(String.fromCharCode(...new Uint8Array(byteLength).fill(65)));
}

const VALID_SECRET = secretOf(32);

function code(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof EventsProtocolError) return error.code;
    throw error;
  }
  throw new Error("expected EventsProtocolError");
}

// ── Catalog ──────────────────────────────────────────────────────────────────

Deno.test("catalog has exactly three descriptors that share ONE payloadSchema object", () => {
  const catalog = eventCatalog();
  assertEquals(catalog.map((d) => d.name), [
    "meeting.created",
    "meeting.updated",
    "meeting.cancelled",
  ]);
  assertEquals(MEETING_EVENT_NAMES.length, 3);
  for (const descriptor of catalog) {
    // Cùng một tham chiếu, không chỉ bằng nhau về giá trị.
    assert(descriptor.payloadSchema === PAYLOAD_SCHEMA);
    assertEquals(descriptor.delivery, ["webhook"]);
  }
});

Deno.test("events/list returns fresh copies of descriptors but unchanged content", () => {
  const first = handleEventsList({});
  const second = handleEventsList({ cursor: null });
  assertEquals(first, second);
  assertEquals(first.events.length, 3);
  assert(
    first.events[0] !== eventCatalog()[0],
    "result must not alias the catalog entry",
  );
});

Deno.test("events/list rejects any non-null cursor", () => {
  assertEquals(
    code(() => handleEventsList({ cursor: "x" })),
    EventsErrorCode.InvalidParams,
  );
});

Deno.test("the contract only uses JSON Schema keywords the validator understands", () => {
  const used = collectKeywords({
    inputSchema: contract.inputSchema,
    payloadSchema: contract.payloadSchema,
  });
  const unsupported = [...used].filter(
    (keyword) =>
      !SUPPORTED_KEYWORDS.includes(keyword) &&
      !["inputSchema", "payloadSchema"].includes(keyword),
  );
  assertEquals(unsupported, []);
});

Deno.test("each event name maps to its own change and the map matches the contract", () => {
  assertEquals(CHANGE_BY_EVENT, {
    "meeting.created": "created",
    "meeting.updated": "updated",
    "meeting.cancelled": "cancelled",
  });
});

// ── Payload schema ───────────────────────────────────────────────────────────

const TIMED = {
  event_id: "EVT-1",
  revision: 3,
  change: "updated",
  changed_fields: ["starts_on", "ends_on"],
  deleted: false,
  series_changed: false,
  all_day: false,
  time_zone: "Asia/Ho_Chi_Minh",
  starts_at: "2030-05-01T02:00:00Z",
  ends_at: "2030-05-01T03:00:00Z",
};

const ALL_DAY = {
  event_id: "EVT-2",
  revision: 1,
  change: "created",
  changed_fields: [],
  deleted: false,
  series_changed: false,
  all_day: true,
  start_date: "2030-05-01",
  end_date_exclusive: "2030-05-02",
};

const TOMBSTONE = {
  event_id: "EVT-3",
  revision: 9,
  change: "cancelled",
  changed_fields: [],
  deleted: true,
  series_changed: false,
};

Deno.test("payload: valid timed, all-day and tombstone payloads pass", () => {
  assertEquals(validateEventPayload("meeting.updated", TIMED), []);
  assertEquals(validateEventPayload("meeting.created", ALL_DAY), []);
  assertEquals(validateEventPayload("meeting.cancelled", TOMBSTONE), []);
});

Deno.test("payload: structural violations are rejected", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["extra property", { ...TIMED, title: "Secret board meeting" }],
    ["revision 0", { ...TIMED, revision: 0 }],
    ["revision float", { ...TIMED, revision: 1.5 }],
    ["unknown change", { ...TIMED, change: "moved" }],
    ["unknown changed field", { ...TIMED, changed_fields: ["title"] }],
    ["missing required", (({ deleted: _d, ...rest }) => rest)(TIMED)],
    ["bad instant", { ...TIMED, starts_at: "2030-05-01 02:00" }],
    ["bad date", { ...ALL_DAY, start_date: "2030-02-30" }],
    ["empty event id", { ...TIMED, event_id: "" }],
    ["impossible date-time", { ...TIMED, starts_at: "2030-02-30T00:00:00Z" }],
    ["hour 24", { ...TIMED, starts_at: "2030-05-01T24:00:00Z" }],
    ["minute 61", { ...TIMED, ends_at: "2030-05-01T10:61:00Z" }],
    ["offset +99:99", { ...TIMED, ends_at: "2030-05-01T10:00:00+99:99" }],
  ];
  for (const [label, payload] of bad) {
    assert(
      validateEventPayload("meeting.updated", payload).length > 0,
      `${label} must be rejected`,
    );
  }
});

Deno.test("payload: all_day relations are enforced", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["all_day without dates", (({ start_date: _s, ...rest }) => rest)(ALL_DAY)],
    ["all_day with instants", {
      ...ALL_DAY,
      starts_at: "2030-05-01T00:00:00Z",
    }],
    ["timed without zone", (({ time_zone: _z, ...rest }) => rest)(TIMED)],
    ["timed without start", (({ starts_at: _s, ...rest }) => rest)(TIMED)],
    ["timed with dates", { ...TIMED, start_date: "2030-05-01" }],
    [
      "no all_day but has instants",
      (({ all_day: _a, ...rest }) => rest)(TIMED),
    ],
  ];
  for (const [label, payload] of bad) {
    assert(
      validateEventPayload("meeting.updated", payload).length > 0,
      `${label} must be rejected`,
    );
  }
});

Deno.test("payload: a tombstone must be cancelled and carry no schedule", () => {
  assert(
    validateEventPayload("meeting.cancelled", {
      ...TOMBSTONE,
      change: "updated",
    }).length > 0,
  );
  assert(
    validateEventPayload("meeting.cancelled", {
      ...TOMBSTONE,
      starts_at: TIMED.starts_at,
    })
      .length > 0,
  );
  assert(
    validateEventPayload("meeting.cancelled", { ...TOMBSTONE, all_day: true })
      .length > 0,
  );
});

Deno.test("payload: the change must match the event name", () => {
  assert(validateEventPayload("meeting.created", TIMED).length > 0);
  assert(validateEventPayload("meeting.cancelled", ALL_DAY).length > 0);
  assert(validateEventPayload("meeting.unknown", TIMED).length > 0);
});

Deno.test("validator errors never contain the offending value", () => {
  const errors = validateJsonSchema(PAYLOAD_SCHEMA as Record<string, unknown>, {
    ...TIMED,
    event_id: 12345,
    note: "super-secret-agenda",
  });
  assert(errors.length > 0);
  assert(!errors.join("\n").includes("super-secret-agenda"));
  assert(!errors.join("\n").includes("12345"));
});

// ── Secret ───────────────────────────────────────────────────────────────────

Deno.test("signing secret: whsec_ plus base64 of 24..64 bytes is accepted", () => {
  for (const size of [24, 25, 32, 48, 63, 64]) {
    assert(
      isValidSigningSecret(secretOf(size)),
      `${size} bytes must be accepted`,
    );
  }
});

Deno.test("signing secret: wrong prefix, size, alphabet or type is rejected", () => {
  const rejected: unknown[] = [
    secretOf(23),
    secretOf(65),
    secretOf(0),
    "whsec_",
    "WHSEC_" + btoa("x".repeat(32)),
    VALID_SECRET.replace("whsec_", "whsek_"),
    "whsec_" + btoa("x".repeat(32)).replace(/\+|\//g, "-") + "!",
    "whsec_" + "AAAA".repeat(12).replace(/A/g, "-"),
    "whsec_" + "AAAA".repeat(10) + "AAA",
    `${VALID_SECRET} `,
    42,
    null,
    undefined,
  ];
  for (const candidate of rejected) {
    assertEquals(isValidSigningSecret(candidate), false, String(candidate));
  }
});

// ── Subscribe params ─────────────────────────────────────────────────────────

const BASE_SUBSCRIBE = {
  name: "meeting.created",
  delivery: { mode: "webhook", url: CALLBACK, secret: VALID_SECRET },
};

Deno.test("subscribe: a minimal request parses and arguments default to {}", () => {
  assertEquals(parseSubscribeParams(BASE_SUBSCRIBE), {
    name: "meeting.created",
    arguments: {},
    deliveryUrl: CALLBACK,
    deliverySecret: VALID_SECRET,
  });
});

Deno.test("subscribe: ttlMs and cursor keep the difference between absent and null", () => {
  const absent = parseSubscribeParams(BASE_SUBSCRIBE);
  assertEquals("ttlMs" in absent, false);
  assertEquals("cursor" in absent, false);
  const explicit = parseSubscribeParams({
    ...BASE_SUBSCRIBE,
    ttlMs: null,
    cursor: null,
  });
  assertEquals(explicit.ttlMs, null);
  assertEquals(explicit.cursor, null);
  assertEquals(
    parseSubscribeParams({ ...BASE_SUBSCRIBE, ttlMs: 60_000 }).ttlMs,
    60_000,
  );
});

Deno.test("subscribe: invalid shapes map to the right Events error code", () => {
  const cases: Array<[unknown, number]> = [
    [null, -32602],
    [[], -32602],
    [{ ...BASE_SUBSCRIBE, name: 5 }, -32602],
    [{ ...BASE_SUBSCRIBE, name: "meeting.nope" }, -32011],
    [{ ...BASE_SUBSCRIBE, delivery: "x" }, -32602],
    [{ ...BASE_SUBSCRIBE, delivery: { mode: "stream" } }, -32014],
    [{
      ...BASE_SUBSCRIBE,
      delivery: { ...BASE_SUBSCRIBE.delivery, retries: 3 },
    }, -32014],
    [{
      ...BASE_SUBSCRIBE,
      delivery: { ...BASE_SUBSCRIBE.delivery, url: "http://x.test/" },
    }, -32602],
    [{
      ...BASE_SUBSCRIBE,
      delivery: { ...BASE_SUBSCRIBE.delivery, url: "not a url" },
    }, -32602],
    [{
      ...BASE_SUBSCRIBE,
      delivery: { ...BASE_SUBSCRIBE.delivery, url: "https://u:p@x.test/" },
    }, -32602],
    [{
      ...BASE_SUBSCRIBE,
      delivery: {
        ...BASE_SUBSCRIBE.delivery,
        url: `https://x.test/${"a".repeat(2100)}`,
      },
    }, -32602],
    [{
      ...BASE_SUBSCRIBE,
      delivery: { ...BASE_SUBSCRIBE.delivery, secret: "whsec_AAAA" },
    }, -32602],
    [{ ...BASE_SUBSCRIBE, arguments: "x" }, -32602],
    [{ ...BASE_SUBSCRIBE, arguments: { event_id: 7 } }, -32602],
    [{ ...BASE_SUBSCRIBE, arguments: { user_id: "x@y.z" } }, -32602],
    [{ ...BASE_SUBSCRIBE, ttlMs: 0 }, -32602],
    [{ ...BASE_SUBSCRIBE, ttlMs: "5" }, -32602],
    [{ ...BASE_SUBSCRIBE, ttlMs: Number.MAX_SAFE_INTEGER + 2 }, -32602],
    [{ ...BASE_SUBSCRIBE, cursor: 12 }, -32602],
    [{ ...BASE_SUBSCRIBE, cursor: "c".repeat(1025) }, -32602],
  ];
  for (const [params, expected] of cases) {
    assertEquals(
      code(() => parseSubscribeParams(params)),
      expected,
      JSON.stringify(params).slice(0, 80),
    );
  }
});

Deno.test("subscribe: error data carries a field name but never the supplied value", () => {
  try {
    parseSubscribeParams({
      ...BASE_SUBSCRIBE,
      delivery: {
        mode: "webhook",
        url: "http://leaky.example.com/token?x=1",
        secret: VALID_SECRET,
      },
    });
    throw new Error("should have thrown");
  } catch (error) {
    assert(error instanceof EventsProtocolError);
    const serialized = JSON.stringify(error.toJsonRpcError());
    assertEquals(error.data, { field: "delivery.url" });
    assert(!serialized.includes("leaky"));
    assert(!serialized.includes("token"));
  }
});

Deno.test("unsubscribe: needs name and url, tolerates and drops a secret", () => {
  const parsed = parseUnsubscribeParams({
    name: "meeting.updated",
    delivery: { mode: "webhook", url: CALLBACK, secret: VALID_SECRET },
    arguments: { event_id: "E1" },
  });
  assertEquals(parsed, {
    name: "meeting.updated",
    arguments: { event_id: "E1" },
    deliveryUrl: CALLBACK,
  });
  assertEquals(
    code(() =>
      parseUnsubscribeParams({
        name: "meeting.updated",
        delivery: { mode: "webhook" },
      })
    ),
    -32602,
  );
  // Thiếu `mode` vẫn hủy được, vì hủy chỉ cần `url`.
  assertEquals(
    parseUnsubscribeParams({
      name: "meeting.updated",
      delivery: { url: CALLBACK },
    }).deliveryUrl,
    CALLBACK,
  );
  // `mode` có mặt mà khác `webhook` vẫn bị từ chối.
  assertEquals(
    code(() =>
      parseUnsubscribeParams({
        name: "meeting.updated",
        delivery: { mode: "polling", url: CALLBACK },
      })
    ),
    -32014,
  );
  // Tên sự kiện lạ bị chặn trước khi xét delivery.
  assertEquals(
    code(() => parseUnsubscribeParams({ name: "x", delivery: {} })),
    -32011,
  );
  // Thiếu cả `url` là tham số sai.
  assertEquals(
    code(() =>
      parseUnsubscribeParams({ name: "meeting.updated", delivery: {} })
    ),
    -32602,
  );
});

// ── Kết quả và lỗi từ ERP ───────────────────────────────────────────────────

Deno.test("toSubscribeResult maps snake_case to the wire shape and validates it", () => {
  assertEquals(
    toSubscribeResult({
      id: "sub_1",
      refresh_before: "2030-01-01T00:00:00Z",
      cursor: "c1",
      truncated: true,
    }),
    {
      id: "sub_1",
      refreshBefore: "2030-01-01T00:00:00Z",
      cursor: "c1",
      truncated: true,
    },
  );
  // Cursor ở đúng giới hạn vẫn đi qua và phải được parseSubscribeParams nhận lại.
  const edge = "x".repeat(1024);
  assertEquals(
    toSubscribeResult({
      id: "sub_1",
      refresh_before: "2030-01-01T00:00:00Z",
      cursor: edge,
      truncated: false,
    }).cursor,
    edge,
  );
  assertEquals(
    parseSubscribeParams({ ...BASE_SUBSCRIBE, cursor: edge }).cursor,
    edge,
  );
  const malformed: unknown[] = [
    null,
    {},
    {
      id: "",
      refresh_before: "2030-01-01T00:00:00Z",
      cursor: null,
      truncated: false,
    },
    {
      id: "s",
      refresh_before: "2030-01-01 00:00:00",
      cursor: null,
      truncated: false,
    },
    {
      id: "s",
      refresh_before: "2030-01-01T00:00:00+07:00",
      cursor: null,
      truncated: false,
    },
    ...[
      "2026-99-99T99:99:99Z",
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
    ].map((refresh_before) => ({
      id: "s",
      refresh_before,
      cursor: null,
      truncated: false,
    })),
    {
      id: "s",
      refresh_before: "2030-01-01T00:00:00Z",
      cursor: 5,
      truncated: false,
    },
    {
      id: "s",
      refresh_before: "2030-01-01T00:00:00Z",
      cursor: null,
      truncated: "no",
    },
    // Cursor mà chính server sẽ từ chối khi client gửi lại: rỗng hoặc dài quá 1024 ký tự.
    ...["", "x".repeat(1025)].map((cursor) => ({
      id: "s",
      refresh_before: "2030-01-01T00:00:00Z",
      cursor,
      truncated: false,
    })),
  ];
  for (const raw of malformed) {
    assertEquals(
      code(() => toSubscribeResult(raw)),
      EventsErrorCode.InternalError,
    );
  }
});

Deno.test("mapErpError keeps only the closed code set and drops ERP messages", () => {
  const mapped = mapErpError({
    code: -32012,
    message: "User x@y.z may not read Event EVT-9 (server stack trace...)",
    data: { secret: "s" },
  });
  assertEquals(mapped.toJsonRpcError(), {
    code: -32012,
    message: "Not allowed to use this event",
  });

  assertEquals(mapErpError({ code: -32011, message: "m" }).code, -32011);
  assertEquals(
    mapErpError({ code: -32602, data: { field: "arguments" } }).data,
    {
      field: "arguments",
    },
  );
  // Tên field bẩn không được đi qua.
  assertEquals(
    mapErpError({ code: -32602, data: { field: "a b; drop table" } }).data,
    undefined,
  );
  assertEquals(
    mapErpError({
      code: -32013,
      data: { limit: "subscriptions", max: 10, note: "free text here" },
    })
      .data,
    { limit: "subscriptions", max: 10 },
  );
  // Tên hạn mức bẩn hoặc sai kiểu thì bỏ cả khối; `max` không hữu hạn thì chỉ bỏ `max`.
  assertEquals(
    mapErpError({ code: -32013, data: { limit: "bad key!", max: 10 } }).data,
    undefined,
  );
  assertEquals(
    mapErpError({ code: -32013, data: { limit: { max: 10 } } }).data,
    undefined,
  );
  assertEquals(
    mapErpError({ code: -32013, data: { limit: "rate", max: "ten" } }).data,
    { limit: "rate" },
  );
  assertEquals(
    mapErpError({ code: -32014, data: { supportedModes: ["poll", "sms"] } })
      .data,
    {
      supportedModes: ["webhook"],
    },
  );
  assertEquals(
    mapErpError({ code: -32015, data: { reason: "timeout" } }).data,
    { reason: "timeout" },
  );
  assertEquals(
    mapErpError({
      code: -32015,
      data: { reason: "GET https://internal.corp/x failed" },
    }).data,
    undefined,
  );
});

Deno.test("mapErpError turns every unknown or malformed error into -32603", () => {
  for (
    const raw of [null, "boom", {}, { code: "x" }, { code: 500 }, {
      code: -32099,
    }, { code: -32603 }]
  ) {
    const mapped = mapErpError(raw);
    assertEquals(mapped.code, EventsErrorCode.InternalError);
    assertEquals(mapped.message, "Events backend error");
    assertEquals(mapped.httpStatus, 502);
  }
});

Deno.test("error HTTP statuses follow the documented mapping", () => {
  const expected: Record<number, number> = {
    [-32602]: 400,
    [-32011]: 404,
    [-32012]: 403,
    [-32013]: 429,
    [-32014]: 400,
    [-32015]: 502,
    [-32603]: 502,
  };
  for (const [errorCode, status] of Object.entries(expected)) {
    const error = new EventsProtocolError(Number(errorCode) as never);
    assertEquals(error.httpStatus, status, errorCode);
  }
  assertThrows(() => {
    throw new EventsProtocolError(EventsErrorCode.Forbidden);
  }, EventsProtocolError);
});

Deno.test("subscribe and unsubscribe reject unknown top-level keys instead of defaulting them", () => {
  const unsubscribe = {
    name: "meeting.created",
    delivery: { mode: "webhook", url: CALLBACK },
  };
  for (
    const [parse, base] of [
      [parseSubscribeParams, BASE_SUBSCRIBE],
      [parseUnsubscribeParams, unsubscribe],
    ] as const
  ) {
    const error = assertThrows(
      () => parse({ ...base, argumnts: { event_id: "EVT-1" } }),
      EventsProtocolError,
    );
    assertEquals(error.code, EventsErrorCode.InvalidParams);
    assertEquals(error.toJsonRpcError().data, { field: "params.argumnts" });
    // Các khoá giao thức đã công bố vẫn được nhận.
    parse({ ...base, _meta: { trace: "x" } });
  }
  const parsed = parseSubscribeParams({
    ...BASE_SUBSCRIBE,
    maxAgeMs: 1000,
    ttlMs: null,
    cursor: null,
  });
  assertEquals(parsed.maxAgeMs, 1000);
  for (const bad of [0, -1, 1.5, "1000", null, Number.NaN]) {
    const error = assertThrows(
      () => parseSubscribeParams({ ...BASE_SUBSCRIBE, maxAgeMs: bad }),
      EventsProtocolError,
    );
    assertEquals(error.toJsonRpcError().data, { field: "maxAgeMs" });
  }
});
