/**
 * Wire test cho adapter MCP Events: một `McpApp` stateless thật được bọc bằng `createEventsAdapter`
 * rồi bị gọi bằng `Request` HTTP thật, không mock SDK. Bao các mục A1, A2, A3 và A6 của đặc tả.
 *
 * @module lib/erpnext/src/events/adapter_wire_test
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  type AuthInfo,
  AuthProvider,
  createStaticTokenAuthProvider,
  McpApp,
  type ProtectedResourceMetadata,
} from "@casys/mcp-server";
import type { FetchHandler } from "@casys/mcp-server";
import { currentCaller } from "../api/caller-context.ts";
import { createCallerIdentityMiddleware } from "../auth/caller-middleware.ts";
import { createEventsAdapter } from "./adapter.ts";
import { EventsAuthError, type EventsStore } from "./erp-store.ts";
import {
  EventsErrorCode,
  EventsProtocolError,
  type SubscribeRequest,
  type UnsubscribeRequest,
} from "./protocol.ts";
import contract from "./contract/meeting-events.v1.json" with { type: "json" };

const PROTO_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const PROTO_VERSION = "2026-07-28";
const SERVER_INFO = { name: "hvgerp-mcp", version: "0.0.0-test" };
const METADATA_URL = "https://mcp.test/.well-known/oauth-protected-resource";

const TOKEN_A = "user-token-a-0000000000000000";
const TOKEN_B = "user-token-b-1111111111111111";
const STATIC_TOKEN = "static-shared-token-2222222222";
const SECRET = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
const CALLBACK = "https://hooks.example.com/callback/path-xyz?sig=query-secret";

/** Provider kiểu OIDC: chấp nhận hai token người dùng, có claim email. */
class FakeOidcProvider extends AuthProvider {
  verifyToken(token: string): Promise<AuthInfo | null> {
    const users: Record<string, string> = {
      [TOKEN_A]: "a@example.com",
      [TOKEN_B]: "b@example.com",
    };
    const email = users[token];
    if (!email) return Promise.resolve(null);
    return Promise.resolve({
      subject: email,
      scopes: [],
      claims: { email },
    });
  }
  getResourceMetadata(): ProtectedResourceMetadata {
    return {
      resource: "https://mcp.test",
      authorization_servers: ["https://idp.test"],
      resource_metadata_url: METADATA_URL,
    } as ProtectedResourceMetadata;
  }
}

/** Provider chấp nhận cả token tĩnh (không có claim) lẫn token người dùng, như cấu hình hỗn hợp. */
class MixedProvider extends AuthProvider {
  private readonly oidc = new FakeOidcProvider();
  private readonly statics = createStaticTokenAuthProvider([STATIC_TOKEN], {
    resource: "https://mcp.test",
  });
  async verifyToken(token: string): Promise<AuthInfo | null> {
    return (await this.oidc.verifyToken(token)) ??
      (await this.statics.verifyToken(token));
  }
  getResourceMetadata(): ProtectedResourceMetadata {
    return this.oidc.getResourceMetadata();
  }
}

interface RecordedCall {
  method: "subscribe" | "unsubscribe";
  request: SubscribeRequest | UnsubscribeRequest;
  accessToken: string | undefined;
  principal: string | undefined;
}

function makeStore(overrides: Partial<EventsStore> = {}) {
  const calls: RecordedCall[] = [];
  const store: EventsStore = {
    subscribe(request) {
      calls.push({
        method: "subscribe",
        request,
        accessToken: currentCaller()?.accessToken,
        principal: currentCaller()?.principal,
      });
      return Promise.resolve({
        id: "sub_1",
        refreshBefore: "2030-01-01T00:00:00Z",
        cursor: null,
        truncated: false,
      });
    },
    unsubscribe(request) {
      calls.push({
        method: "unsubscribe",
        request,
        accessToken: currentCaller()?.accessToken,
        principal: currentCaller()?.principal,
      });
      return Promise.resolve({});
    },
    ...overrides,
  };
  return { store, calls };
}

interface Fixture {
  base: FetchHandler;
  handler: FetchHandler;
  calls: RecordedCall[];
  logs: string[];
}

async function buildFixture(
  options: {
    store?: Partial<EventsStore>;
    cors?: boolean;
    maxBodyBytes?: number;
    maxConcurrent?: number;
    maxQueued?: number;
  } = {},
): Promise<Fixture> {
  const provider = new MixedProvider();
  const app = new McpApp({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: "stateless",
    auth: { provider },
  });
  app.use(createCallerIdentityMiddleware({ required: true }));
  app.registerTools(
    [{
      name: "ping",
      description: "No-op tool used by wire tests",
      inputSchema: { type: "object" as const, properties: {} },
    }],
    new Map([[
      "ping",
      async (_args: unknown) => ({
        content: [{ type: "text" as const, text: "pong" }],
      }),
    ]]),
  );
  const base = await app.getFetchHandler({ cors: options.cors ?? false });
  const { store, calls } = makeStore(options.store);
  const logs: string[] = [];
  const handler = createEventsAdapter({
    base,
    authProvider: provider,
    serverInfo: SERVER_INFO,
    store,
    maxBodyBytes: options.maxBodyBytes,
    maxConcurrent: options.maxConcurrent,
    maxQueued: options.maxQueued,
    log: (message) => logs.push(message),
  });
  return { base, handler, calls, logs };
}

function rpc(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    token?: string | null;
    headers?: Record<string, string>;
    meta?: Record<string, unknown>;
    id?: number | string;
    path?: string;
    /** Bỏ `Mcp-Name` tự sinh để thử request thiếu header. */
    omitName?: boolean;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "MCP-Protocol-Version": PROTO_VERSION,
    "Mcp-Method": method,
    ...options.headers,
  };
  // Method nhắm vào một đối tượng có tên thì HTTP binding bắt `Mcp-Name` soi gương `params.name`.
  if (
    !options.omitName && !("Mcp-Name" in headers) &&
    (method === "events/subscribe" || method === "events/unsubscribe") &&
    typeof params.name === "string"
  ) {
    headers["Mcp-Name"] = params.name;
  }
  const token = options.token === undefined ? TOKEN_A : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request(`http://localhost${options.path ?? "/mcp"}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method,
      params: {
        _meta: options.meta ?? {
          [PROTO_KEY]: PROTO_VERSION,
          [CLIENT_CAPS_KEY]: {},
        },
        ...params,
      },
    }),
  });
}

const SUBSCRIBE_PARAMS = {
  name: "meeting.updated",
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  arguments: { event_id: "EVT-0001" },
};

const UNSUBSCRIBE_PARAMS = {
  name: "meeting.updated",
  delivery: { mode: "webhook", url: CALLBACK },
  arguments: { event_id: "EVT-0001" },
};

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

async function json(response: Response): Promise<Json> {
  return await response.json() as Json;
}

// ── A1: discovery giữ tool cũ và thêm events ────────────────────────────────

Deno.test("A1 discover with a valid user keeps old capabilities and adds events", async () => {
  const { handler, base } = await buildFixture();
  const plain = await json(await base(rpc("server/discover")));
  const res = await handler(rpc("server/discover"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("mcp-protocol-version"), PROTO_VERSION);
  const body = await json(res);
  assertEquals(body.result.resultType, "complete");
  assertEquals(body.result.supportedVersions, plain.result.supportedVersions);
  assertEquals(body.result.serverInfo, plain.result.serverInfo);
  assertEquals(body.result._meta, plain.result._meta);
  // Mọi capability cũ còn nguyên, chỉ thêm đúng `events`.
  const { events, ...rest } = body.result.capabilities;
  assertEquals(events, {});
  assertEquals(rest, plain.result.capabilities);
  assert("tools" in rest, "the old tools capability must survive");
});

Deno.test("A1 discover without a user identity does not advertise events", async () => {
  const { handler, base } = await buildFixture();
  const plain = await json(
    await base(rpc("server/discover", {}, { token: STATIC_TOKEN })),
  );
  const res = await handler(
    rpc("server/discover", {}, { token: STATIC_TOKEN }),
  );
  assertEquals(res.status, 200);
  const body = await json(res);
  assertEquals(body.result.capabilities, plain.result.capabilities);
  assertEquals("events" in body.result.capabilities, false);
});

Deno.test("A1 discover without a bearer is the base 401, never an events advertisement", async () => {
  const { handler } = await buildFixture();
  const res = await handler(rpc("server/discover", {}, { token: null }));
  assertEquals(res.status, 401);
  assert(res.headers.get("www-authenticate")?.includes("Bearer"));
});

Deno.test("A1 tools/list and tools/call still work through the adapter", async () => {
  const { handler } = await buildFixture();
  const list = await json(await handler(rpc("tools/list")));
  assertEquals(
    list.result.tools.map((tool: { name: string }) => tool.name),
    ["ping"],
  );
  const call = await handler(
    rpc("tools/call", { name: "ping", arguments: {} }, {
      headers: { "Mcp-Name": "ping" },
    }),
  );
  assertEquals(call.status, 200);
  const body = await json(call);
  assertEquals(body.result.content[0].text, "pong");
  assertEquals(body.result.resultType, "complete");
});

Deno.test("A1 events/list returns three descriptors sharing one payloadSchema", async () => {
  const { handler } = await buildFixture();
  const res = await handler(rpc("events/list"));
  assertEquals(res.status, 200);
  const body = await json(res);
  const events = body.result.events as Array<Record<string, unknown>>;
  assertEquals(
    events.map((event) => event.name),
    ["meeting.created", "meeting.updated", "meeting.cancelled"],
  );
  const payloadSchemas = new Set(
    events.map((e) => JSON.stringify(e.payloadSchema)),
  );
  assertEquals(
    payloadSchemas.size,
    1,
    "all descriptors must share ONE payloadSchema",
  );
  assertEquals(events[0].payloadSchema, contract.payloadSchema);
  for (const event of events) {
    assertEquals(event.delivery, ["webhook"]);
    assertEquals(event.inputSchema, contract.inputSchema);
  }
  // Catalog không phân trang và không có cursor.
  assertEquals("nextCursor" in body.result, false);
});

Deno.test("A1 events/list stamps resultType, serverInfo meta and the protocol header", async () => {
  const { handler } = await buildFixture();
  const res = await handler(rpc("events/list", {}, { id: "req-7" }));
  assertEquals(res.headers.get("mcp-protocol-version"), PROTO_VERSION);
  assertEquals(res.headers.get("content-type"), "application/json");
  const body = await json(res);
  assertEquals(body.jsonrpc, "2.0");
  assertEquals(body.id, "req-7");
  assertEquals(body.result.resultType, "complete");
  assertEquals(body.result._meta[SERVER_INFO_KEY], SERVER_INFO);
});

Deno.test("A1 events/list rejects a made-up cursor", async () => {
  const { handler } = await buildFixture();
  const res = await handler(rpc("events/list", { cursor: "abc" }));
  assertEquals(res.status, 400);
  assertEquals((await json(res)).error.code, -32602);
});

Deno.test("A1 events responses carry the CORS headers of the base handler", async () => {
  const { handler } = await buildFixture({ cors: true });
  const res = await handler(
    rpc("events/list", {}, { headers: { Origin: "https://app.example.com" } }),
  );
  assertEquals(res.status, 200);
  assertNotEquals(res.headers.get("access-control-allow-origin"), null);
});

// ── A2: events/* đi qua auth ─────────────────────────────────────────────────

const EVENTS_CALLS: Array<[string, Record<string, unknown>]> = [
  ["events/list", {}],
  ["events/subscribe", SUBSCRIBE_PARAMS],
  ["events/unsubscribe", UNSUBSCRIBE_PARAMS],
];

for (const [method, params] of EVENTS_CALLS) {
  Deno.test(`A2 ${method} without a bearer is HTTP 401 with WWW-Authenticate`, async () => {
    const { handler, calls } = await buildFixture();
    const res = await handler(rpc(method, params, { token: null }));
    assertEquals(res.status, 401);
    assert(res.headers.get("www-authenticate")?.includes(METADATA_URL));
    const body = await json(res);
    assert(body.error, "must be a JSON-RPC error, never a result");
    assertEquals("result" in body, false);
    assertEquals(calls.length, 0);
  });

  Deno.test(`A2 ${method} with an invalid bearer is HTTP 401`, async () => {
    const { handler, calls } = await buildFixture();
    const res = await handler(
      rpc(method, params, { token: "not-a-real-token-xxxxxxxxxxxx" }),
    );
    assertEquals(res.status, 401);
    assert(res.headers.get("www-authenticate"));
    assertEquals(calls.length, 0);
  });

  Deno.test(`A2 ${method} with a static shared bearer is refused with -32012 and never reaches the store`, async () => {
    const { handler, calls } = await buildFixture();
    const res = await handler(rpc(method, params, { token: STATIC_TOKEN }));
    assertEquals(res.status, 403);
    const body = await json(res);
    assertEquals(body.error.code, EventsErrorCode.Forbidden);
    assertEquals("result" in body, false);
    assertEquals(calls.length, 0);
  });
}

Deno.test("A2 a bearer that passed the gate but fails the second verification is a 401", async () => {
  // Provider không ổn định: lần đầu cho qua, lần hai (adapter xác minh lại) báo token hỏng.
  let verifications = 0;
  const flaky = new (class extends FakeOidcProvider {
    override verifyToken(token: string) {
      verifications += 1;
      return verifications === 1
        ? super.verifyToken(token)
        : Promise.reject(new Error("jwks unreachable"));
    }
  })();
  const app = new McpApp({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    transport: "stateless",
    auth: { provider: flaky },
  });
  const base = await app.getFetchHandler({ cors: false });
  const { store, calls } = makeStore();
  const handler = createEventsAdapter({
    base,
    authProvider: flaky,
    serverInfo: SERVER_INFO,
    store,
  });
  const res = await handler(rpc("events/list"));
  assertEquals(res.status, 401);
  assert(res.headers.get("www-authenticate"));
  assertEquals(calls.length, 0);
});

Deno.test("A2 the store runs as the calling user and concurrent callers never mix", async () => {
  const seen: Array<[string | undefined, string | undefined]> = [];
  const { handler } = await buildFixture({
    store: {
      async subscribe() {
        const caller = currentCaller();
        // Nhường lượt để hai request thật sự chạy xen kẽ.
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push([caller?.principal, currentCaller()?.accessToken]);
        return {
          id: "sub",
          refreshBefore: "2030-01-01T00:00:00Z",
          cursor: null,
          truncated: false,
        };
      },
    },
  });
  const [first, second] = await Promise.all([
    handler(rpc("events/subscribe", SUBSCRIBE_PARAMS, { token: TOKEN_A })),
    handler(rpc("events/subscribe", SUBSCRIBE_PARAMS, { token: TOKEN_B })),
  ]);
  assertEquals(first.status, 200);
  assertEquals(second.status, 200);
  assertEquals(seen.length, 2);
  seen.sort();
  assertEquals(seen, [
    ["a@example.com", TOKEN_A],
    ["b@example.com", TOKEN_B],
  ]);
});

// ── A3: header, _meta và method lạ ───────────────────────────────────────────

Deno.test("A3 a Mcp-Method that disagrees with the body is -32020", async () => {
  const { handler, calls } = await buildFixture();
  const res = await handler(
    rpc("events/subscribe", SUBSCRIBE_PARAMS, {
      headers: { "Mcp-Method": "events/list" },
    }),
  );
  assertEquals(res.status, 400);
  assertEquals((await json(res)).error.code, -32020);
  assertEquals(calls.length, 0);
});

Deno.test("A3 a missing MCP-Protocol-Version header is -32020", async () => {
  const { handler, calls } = await buildFixture();
  const request = rpc("events/subscribe", SUBSCRIBE_PARAMS);
  request.headers.delete("MCP-Protocol-Version");
  const res = await handler(request);
  assertEquals(res.status, 400);
  assertEquals((await json(res)).error.code, -32020);
  assertEquals(calls.length, 0);
});

Deno.test("A3 an unsupported _meta protocol version is -32022", async () => {
  const { handler, calls } = await buildFixture();
  const res = await handler(
    rpc("events/subscribe", SUBSCRIBE_PARAMS, {
      meta: { [PROTO_KEY]: "2025-06-18", [CLIENT_CAPS_KEY]: {} },
    }),
  );
  assertEquals(res.status, 400);
  assertEquals((await json(res)).error.code, -32022);
  assertEquals(calls.length, 0);
});

Deno.test("A3 a _meta without a protocol version is -32602", async () => {
  const { handler, calls } = await buildFixture();
  const res = await handler(
    rpc("events/unsubscribe", UNSUBSCRIBE_PARAMS, {
      meta: { [CLIENT_CAPS_KEY]: {} },
    }),
  );
  assertEquals(res.status, 400);
  assertEquals((await json(res)).error.code, -32602);
  assertEquals(calls.length, 0);
});

Deno.test("A3 a header that disagrees with _meta is refused", async () => {
  const { handler, calls } = await buildFixture();
  const res = await handler(
    rpc("events/list", {}, {
      headers: { "MCP-Protocol-Version": "2025-06-18" },
    }),
  );
  assertEquals(res.status, 400);
  const code = (await json(res)).error.code;
  assert(code === -32020 || code === -32022, `unexpected code ${code}`);
  assertEquals(calls.length, 0);
});

Deno.test("A3 an unknown method behaves exactly as without the adapter", async () => {
  const { handler, base } = await buildFixture();
  for (
    const method of ["nope/unknown", "events/poll", "events/stream", "events"]
  ) {
    const expected = await base(rpc(method));
    const actual = await handler(rpc(method));
    assertEquals(actual.status, expected.status, method);
    assertEquals(await actual.text(), await expected.text(), method);
    assertEquals(actual.status, 404, method);
  }
});

Deno.test("A3 an events request without an id (notification) is left to the base handler", async () => {
  const { handler, base, calls } = await buildFixture();
  const notification = () =>
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTO_VERSION,
        "Mcp-Method": "events/list",
        Authorization: `Bearer ${TOKEN_A}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "events/list",
        params: {
          _meta: { [PROTO_KEY]: PROTO_VERSION, [CLIENT_CAPS_KEY]: {} },
        },
      }),
    });
  const expected = await base(notification());
  const actual = await handler(notification());
  assertEquals(actual.status, expected.status);
  assertEquals(await actual.text(), await expected.text());
  assertEquals(calls.length, 0);
});

Deno.test("A3 non-MCP traffic passes through untouched", async () => {
  const { handler, base } = await buildFixture();
  const get = () => new Request("http://localhost/health");
  const expected = await base(get());
  const actual = await handler(get());
  assertEquals(actual.status, expected.status);
  // POST tới đường dẫn khác `/mcp` cũng không bị xem là Events.
  const other = await handler(rpc("events/list", {}, { path: "/other" }));
  const otherExpected = await base(rpc("events/list", {}, { path: "/other" }));
  assertEquals(other.status, otherExpected.status);
});

Deno.test("A3 an oversized body is left to the base handler's own limit", async () => {
  const { handler, calls } = await buildFixture({ maxBodyBytes: 256 });
  const res = await handler(
    rpc("events/subscribe", { ...SUBSCRIBE_PARAMS, padding: "x".repeat(2000) }),
  );
  // Adapter không đọc nổi body nên không nhận việc; base trả 404 vì không biết method.
  assertEquals(res.status, 404);
  assertEquals(calls.length, 0);
});

Deno.test("A3 an oversized streamed body does not hang the adapter", async () => {
  const { handler, calls } = await buildFixture({ maxBodyBytes: 256 });
  const encoder = new TextEncoder();
  const chunk = encoder.encode("x".repeat(200));
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "MCP-Protocol-Version": PROTO_VERSION,
      "Mcp-Method": "events/subscribe",
      Authorization: `Bearer ${TOKEN_A}`,
    },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    }),
    duplex: "half",
  } as RequestInit);
  const timeout = new Promise<"hung">((resolve) =>
    setTimeout(() => resolve("hung"), 3000)
  );
  const outcome = await Promise.race([handler(request), timeout]);
  assert(outcome !== "hung", "adapter must hand the request to base, not wait");
  assertEquals(calls.length, 0);
  await (outcome as Response).body?.cancel();
});

// ── Mcp-Name ────────────────────────────────────────────────────────────────

for (
  const [method, params] of [
    ["events/subscribe", SUBSCRIBE_PARAMS],
    ["events/unsubscribe", UNSUBSCRIBE_PARAMS],
  ] as const
) {
  Deno.test(`${method} without Mcp-Name is a header mismatch`, async () => {
    const { handler, calls } = await buildFixture();
    const res = await handler(rpc(method, params, { omitName: true }));
    assertEquals(res.status, 400);
    assertEquals((await json(res)).error.code, EventsErrorCode.HeaderMismatch);
    assertEquals(calls.length, 0);
  });

  Deno.test(`${method} with a conflicting Mcp-Name is a header mismatch`, async () => {
    const { handler, calls } = await buildFixture();
    const res = await handler(
      rpc(method, params, { headers: { "Mcp-Name": "meeting.created" } }),
    );
    assertEquals(res.status, 400);
    assertEquals((await json(res)).error.code, EventsErrorCode.HeaderMismatch);
    assertEquals(calls.length, 0);
  });
}

Deno.test("an unauthenticated events call without Mcp-Name is still a 401", async () => {
  const { handler } = await buildFixture();
  const res = await handler(
    rpc("events/subscribe", SUBSCRIBE_PARAMS, { token: null, omitName: true }),
  );
  assertEquals(res.status, 401);
});

// ── Giới hạn đồng thời ──────────────────────────────────────────────────────

Deno.test("backend calls are bounded by maxConcurrent and the overflow is refused", async () => {
  let running = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  const { handler } = await buildFixture({
    maxConcurrent: 2,
    maxQueued: 1,
    store: {
      subscribe() {
        running++;
        peak = Math.max(peak, running);
        return new Promise((resolve) => {
          gates.push(() => {
            running--;
            resolve({
              id: "sub_x",
              refreshBefore: "2030-01-01T00:00:00Z",
              cursor: null,
              truncated: false,
            });
          });
        });
      },
    },
  });
  const pending = [1, 2, 3].map(() =>
    handler(rpc("events/subscribe", SUBSCRIBE_PARAMS))
  );
  const refused = await handler(rpc("events/subscribe", SUBSCRIBE_PARAMS));
  assertEquals(refused.status, 503);
  await refused.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEquals(peak, 2);
  while (gates.length > 0 || running > 0) {
    gates.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const settled = await Promise.all(pending);
  assertEquals(settled.map((res) => res.status), [200, 200, 200]);
  assertEquals(peak, 2);
});

// ── Kiểm tra schema (-32602, -32011, -32014) ────────────────────────────────

async function subscribeError(params: Record<string, unknown>) {
  const { handler, calls } = await buildFixture();
  const res = await handler(rpc("events/subscribe", params));
  const body = await json(res);
  return { status: res.status, error: body.error, calls };
}

Deno.test("schema: an unknown event name is -32011", async () => {
  const { status, error, calls } = await subscribeError({
    ...SUBSCRIBE_PARAMS,
    name: "meeting.exploded",
  });
  assertEquals(status, 404);
  assertEquals(error.code, EventsErrorCode.EventNotFound);
  assertEquals(calls.length, 0);
});

Deno.test("schema: a bad secret, url or argument is -32602 with only the field name", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { delivery: { mode: "webhook", url: CALLBACK, secret: "whsec_short" } },
      "delivery.secret",
    ],
    [
      { delivery: { mode: "webhook", url: CALLBACK, secret: "plain-secret" } },
      "delivery.secret",
    ],
    [{
      delivery: {
        mode: "webhook",
        url: "http://hooks.example.com/x",
        secret: SECRET,
      },
    }, "delivery.url"],
    [{
      delivery: {
        mode: "webhook",
        url: "https://user:pw@hooks.example.com/x",
        secret: SECRET,
      },
    }, "delivery.url"],
    [{ arguments: { event_id: "" } }, "arguments"],
    [
      { arguments: { event_id: "E", user_id: "someone@example.com" } },
      "arguments",
    ],
    [{ ttlMs: -5 }, "ttlMs"],
    [{ ttlMs: 1.5 }, "ttlMs"],
    [{ cursor: "" }, "cursor"],
  ];
  for (const [override, field] of cases) {
    const { status, error, calls } = await subscribeError({
      ...SUBSCRIBE_PARAMS,
      ...override,
    });
    assertEquals(status, 400, field);
    assertEquals(error.code, EventsErrorCode.InvalidParams, field);
    assertEquals(error.data, { field }, field);
    assertEquals(error.message, "Invalid params");
    assertEquals(calls.length, 0, field);
  }
});

Deno.test("schema: a non-webhook delivery is -32014 and lists the supported modes", async () => {
  for (
    const delivery of [
      { mode: "poll" },
      { mode: "webhook", url: CALLBACK, secret: SECRET, extra: true },
    ]
  ) {
    const { status, error, calls } = await subscribeError({
      ...SUBSCRIBE_PARAMS,
      delivery,
    });
    assertEquals(status, 400);
    assertEquals(error.code, EventsErrorCode.UnsupportedDelivery);
    assertEquals(error.data, { supportedModes: ["webhook"] });
    assertEquals(calls.length, 0);
  }
});

Deno.test("schema: params that are not an object are -32602", async () => {
  const { handler } = await buildFixture();
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTO_VERSION,
      "Mcp-Method": "events/subscribe",
      Authorization: `Bearer ${TOKEN_A}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "events/subscribe",
      params: { _meta: { [PROTO_KEY]: PROTO_VERSION, [CLIENT_CAPS_KEY]: {} } },
    }),
  });
  const res = await handler(request);
  assertEquals(res.status, 400);
  assertEquals((await json(res)).error.code, -32602);
});

Deno.test("schema: a valid subscribe forwards a clean request to the store", async () => {
  const { handler, calls } = await buildFixture();
  const res = await handler(
    rpc("events/subscribe", {
      ...SUBSCRIBE_PARAMS,
      ttlMs: null,
      cursor: "c-1",
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].accessToken, TOKEN_A);
  assertEquals(calls[0].principal, "a@example.com");
  assertEquals(calls[0].request, {
    name: "meeting.updated",
    arguments: { event_id: "EVT-0001" },
    deliveryUrl: CALLBACK,
    deliverySecret: SECRET,
    ttlMs: null,
    cursor: "c-1",
  });
  const body = await json(res);
  assertEquals(body.result.id, "sub_1");
  assertEquals(body.result.refreshBefore, "2030-01-01T00:00:00Z");
  assertEquals(body.result.cursor, null);
  assertEquals(body.result.truncated, false);
  assertEquals(body.result.resultType, "complete");
  assertEquals(body.result._meta[SERVER_INFO_KEY], SERVER_INFO);
});

// ── A6: unsubscribe idempotent và stamping ──────────────────────────────────

Deno.test("A6 unsubscribe twice returns the same empty business result with core stamping", async () => {
  const { handler, calls } = await buildFixture();
  const results: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await handler(rpc("events/unsubscribe", UNSUBSCRIBE_PARAMS));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("mcp-protocol-version"), PROTO_VERSION);
    results.push((await json(res)).result);
  }
  assertEquals(results[0], results[1]);
  assertEquals(results[0], {
    resultType: "complete",
    _meta: { [SERVER_INFO_KEY]: SERVER_INFO },
  });
  assertEquals(calls.length, 2);
  // Hủy không mang secret đi tiếp, kể cả khi client lỡ gửi.
  const withSecret = await handler(
    rpc("events/unsubscribe", {
      ...UNSUBSCRIBE_PARAMS,
      delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
    }),
  );
  assertEquals(withSecret.status, 200);
  assertEquals("deliverySecret" in calls[2].request, false);
});

// ── Lỗi từ store ─────────────────────────────────────────────────────────────

Deno.test("store errors: protocol errors keep their code and fixed message", async () => {
  const { handler } = await buildFixture({
    store: {
      subscribe: () =>
        Promise.reject(
          new EventsProtocolError(EventsErrorCode.QuotaExceeded, {
            limit: { max: 5 },
          }),
        ),
    },
  });
  const res = await handler(rpc("events/subscribe", SUBSCRIBE_PARAMS));
  assertEquals(res.status, 429);
  const body = await json(res);
  assertEquals(body.error, {
    code: -32013,
    message: "Subscription limit reached",
    data: { limit: { max: 5 } },
  });
});

Deno.test("store errors: ERP auth failure becomes HTTP 401 with a challenge", async () => {
  const { handler } = await buildFixture({
    store: { subscribe: () => Promise.reject(new EventsAuthError()) },
  });
  const res = await handler(rpc("events/subscribe", SUBSCRIBE_PARAMS));
  assertEquals(res.status, 401);
  assert(res.headers.get("www-authenticate")?.includes(METADATA_URL));
});

Deno.test("store errors: an unexpected failure is -32603 and never leaks its message", async () => {
  const { handler, logs } = await buildFixture({
    store: {
      subscribe: () =>
        Promise.reject(new Error("db password=hunter2 at /srv/erp")),
    },
  });
  const res = await handler(rpc("events/subscribe", SUBSCRIBE_PARAMS));
  assertEquals(res.status, 502);
  const text = await res.text();
  assert(!text.includes("hunter2"));
  assertEquals(JSON.parse(text).error, {
    code: -32603,
    message: "Events backend error",
  });
  assert(!logs.join("\n").includes("hunter2"));
});

// ── Không lộ thông tin nhạy cảm ─────────────────────────────────────────────

Deno.test("logging: no token, secret, callback path or query ever reaches the log", async () => {
  const { handler, logs } = await buildFixture();
  await handler(rpc("events/subscribe", SUBSCRIBE_PARAMS));
  await handler(rpc("events/unsubscribe", UNSUBSCRIBE_PARAMS));
  await handler(rpc("events/subscribe", { ...SUBSCRIBE_PARAMS, name: "bad" }));
  await handler(
    rpc("events/subscribe", SUBSCRIBE_PARAMS, { token: STATIC_TOKEN }),
  );
  assert(logs.length > 0, "the adapter should log method and code only");
  const joined = logs.join("\n");
  for (
    const forbidden of [
      TOKEN_A,
      STATIC_TOKEN,
      SECRET,
      "whsec_",
      "path-xyz",
      "query-secret",
      "hooks.example.com",
      "a@example.com",
      "EVT-0001",
    ]
  ) {
    assert(!joined.includes(forbidden), `log leaked ${forbidden}`);
  }
});

Deno.test("error bodies never echo caller supplied values", async () => {
  const { handler } = await buildFixture();
  const res = await handler(
    rpc("events/subscribe", {
      ...SUBSCRIBE_PARAMS,
      delivery: {
        mode: "webhook",
        url: "http://leak.example.com/secret-path",
        secret: SECRET,
      },
    }),
  );
  const text = await res.text();
  for (
    const forbidden of ["leak.example.com", "secret-path", SECRET, TOKEN_A]
  ) {
    assert(!text.includes(forbidden), `error body leaked ${forbidden}`);
  }
});
