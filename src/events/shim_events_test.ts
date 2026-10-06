/**
 * Events RPC đi qua shim tương thích đời cũ (`shim.ts`, `src/compat/legacy-shim.ts`) còn nguyên.
 *
 * Upstream là một `McpApp` stateless thật bọc bằng adapter Events, chạy trên `Deno.serve`; shim
 * gọi nó bằng `fetch` thật. Không có ERP: store là bản ghi nhớ trong test.
 *
 * @module lib/erpnext/src/events/shim_events_test
 */

import { assert, assertEquals } from "@std/assert";
import {
  type AuthInfo,
  AuthProvider,
  McpApp,
  type ProtectedResourceMetadata,
} from "@casys/mcp-server";
import { currentCaller } from "../api/caller-context.ts";
import { handleShimRequest } from "../compat/legacy-shim.ts";
import { createCallerIdentityMiddleware } from "../auth/caller-middleware.ts";
import { createEventsAdapter } from "./adapter.ts";
import type { EventsStore } from "./erp-store.ts";
import type { SubscribeRequest } from "./protocol.ts";

const PROTO_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const PROTO_VERSION = "2026-07-28";
const TOKEN = "user-token-a-0000000000000000";
const SECRET = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
const CALLBACK = "https://hooks.example.com/callback/path-xyz?sig=query-secret";

class FakeOidcProvider extends AuthProvider {
  verifyToken(token: string): Promise<AuthInfo | null> {
    if (token !== TOKEN) return Promise.resolve(null);
    return Promise.resolve({
      subject: "a@example.com",
      scopes: [],
      claims: { email: "a@example.com" },
    });
  }
  getResourceMetadata(): ProtectedResourceMetadata {
    return {
      resource: "https://mcp.test",
      authorization_servers: ["https://idp.test"],
      resource_metadata_url:
        "https://mcp.test/.well-known/oauth-protected-resource",
    } as ProtectedResourceMetadata;
  }
}

interface Upstream {
  url: string;
  subscribed: Array<
    { request: SubscribeRequest; accessToken: string | undefined }
  >;
  stop(): Promise<void>;
}

async function startEventsUpstream(): Promise<Upstream> {
  const provider = new FakeOidcProvider();
  const app = new McpApp({
    name: "hvgerp-mcp",
    version: "0.0.0-test",
    transport: "stateless",
    auth: { provider },
  });
  app.use(createCallerIdentityMiddleware({ required: true }));
  app.registerTools(
    [{
      name: "ping",
      description: "No-op tool used by shim tests",
      inputSchema: { type: "object" as const, properties: {} },
    }],
    new Map([[
      "ping",
      async (_args: unknown) => ({
        content: [{ type: "text" as const, text: "pong" }],
      }),
    ]]),
  );
  const base = await app.getFetchHandler({ cors: false });
  const subscribed: Upstream["subscribed"] = [];
  const store: EventsStore = {
    subscribe(request) {
      subscribed.push({ request, accessToken: currentCaller()?.accessToken });
      return Promise.resolve({
        id: "sub_1",
        refreshBefore: "2030-01-01T00:00:00Z",
        cursor: null,
        truncated: false,
      });
    },
    unsubscribe: () => Promise.resolve({}),
  };
  const handler = createEventsAdapter({
    base,
    authProvider: provider,
    serverInfo: { name: "hvgerp-mcp", version: "0.0.0-test" },
    store,
  });
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, handler);
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    subscribed,
    async stop() {
      await server.shutdown();
    },
  };
}

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  token: string | null = TOKEN,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "MCP-Protocol-Version": PROTO_VERSION,
    "Mcp-Method": method,
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return new Request("https://erp.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        _meta: { [PROTO_KEY]: PROTO_VERSION, [CLIENT_CAPS_KEY]: {} },
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

Deno.test("shim passes a 2026-07-28 events/list through unchanged", async () => {
  const upstream = await startEventsUpstream();
  try {
    const res = await handleShimRequest(modernRequest("events/list"), {
      upstream: upstream.url,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.result.resultType, "complete");
    assertEquals(body.result.events.length, 3);
  } finally {
    await upstream.stop();
  }
});

Deno.test("shim passes events/subscribe through with the caller bearer and body intact", async () => {
  const upstream = await startEventsUpstream();
  try {
    const res = await handleShimRequest(
      modernRequest("events/subscribe", SUBSCRIBE_PARAMS),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 200);
    const text = await res.text();
    assertEquals(JSON.parse(text).result.id, "sub_1");
    assert(!text.includes(SECRET), "the secret must never come back");
    assertEquals(upstream.subscribed.length, 1);
    assertEquals(upstream.subscribed[0].accessToken, TOKEN);
    assertEquals(upstream.subscribed[0].request.deliveryUrl, CALLBACK);
    assertEquals(upstream.subscribed[0].request.deliverySecret, SECRET);
  } finally {
    await upstream.stop();
  }
});

Deno.test("shim keeps the 401 and WWW-Authenticate of an unauthenticated events call", async () => {
  const upstream = await startEventsUpstream();
  try {
    const res = await handleShimRequest(
      modernRequest("events/list", {}, null),
      {
        upstream: upstream.url,
      },
    );
    assertEquals(res.status, 401);
    assert(res.headers.get("www-authenticate")?.includes("resource_metadata"));
    await res.body?.cancel();
    const bad = await handleShimRequest(
      modernRequest("events/list", {}, "not-a-token"),
      {
        upstream: upstream.url,
      },
    );
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
    assertEquals(upstream.subscribed.length, 0);
  } finally {
    await upstream.stop();
  }
});

Deno.test("shim keeps discovery and old tools intact next to events", async () => {
  const upstream = await startEventsUpstream();
  try {
    const discover = await handleShimRequest(modernRequest("server/discover"), {
      upstream: upstream.url,
    });
    const discovered = await discover.json();
    assertEquals(discovered.result.capabilities.events, {});
    assert(discovered.result.capabilities.tools !== undefined);

    const tools = await handleShimRequest(modernRequest("tools/list"), {
      upstream: upstream.url,
    });
    const listed = await tools.json();
    assertEquals(
      listed.result.tools.map((tool: { name: string }) => tool.name),
      ["ping"],
    );
  } finally {
    await upstream.stop();
  }
});

Deno.test("legacy-shaped events requests are translated by the shim and still hit the adapter", async () => {
  const upstream = await startEventsUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
          "X-Anthropic-Client": "Cowork",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "events/list",
          params: {},
        }),
      }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.id, 7);
    assertEquals(body.result.events.length, 3);
    assertEquals(
      body.result.resultType,
      undefined,
      "legacy clients do not get resultType",
    );
  } finally {
    await upstream.stop();
  }
});
