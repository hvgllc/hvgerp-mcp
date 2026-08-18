/**
 * Test cho shim tương thích: upstream giả ở đây kiểm tra ĐÚNG những gì server
 * thật kiểm tra (header phải khớp `_meta`, `Mcp-Method` phải khớp `method`,
 * `Mcp-Name` phải soi gương trường định danh), nên một bài test đạt nghĩa là
 * request đó cũng đi lọt server thật, chứ không chỉ lọt một bản giả dễ tính.
 */
import { assertEquals, assertExists } from "@std/assert";
import {
  encodeHeaderValue,
  handleShimRequest,
  isModernRequest,
  rewriteInbound,
  rewriteOutbound,
} from "./legacy-shim.ts";

const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeUpstream {
  url: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
}

/** Upstream giả nói đúng một revision 2026-07-28, như server thật. */
async function startUpstream(
  override?: (req: Request, body: unknown) => Response | undefined,
): Promise<FakeUpstream> {
  const captured: CapturedRequest[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const raw = req.method === "POST" ? await req.text() : "";
    const body = raw.length > 0 ? JSON.parse(raw) : undefined;
    captured.push({
      method: req.method,
      url: new URL(req.url).pathname,
      headers: Object.fromEntries(req.headers),
      body,
    });

    const forced = override?.(req, body);
    if (forced !== undefined) return forced;

    if (req.method === "GET" || req.method === "DELETE") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const message = body as Record<string, unknown>;
    const id = message?.["id"];
    const method = message?.["method"];
    const params = (message?.["params"] ?? {}) as Record<string, unknown>;
    const meta = (params["_meta"] ?? {}) as Record<string, unknown>;

    if (id === undefined) return new Response(null, { status: 202 });

    const fail = (code: number, text: string) =>
      Response.json({ jsonrpc: "2.0", id, error: { code, message: text } }, {
        status: 400,
      });

    if (req.headers.get("MCP-Protocol-Version") !== meta[META_PROTOCOL]) {
      return fail(-32020, "MCP-Protocol-Version does not match _meta");
    }
    if (req.headers.get("Mcp-Method") !== method) {
      return fail(-32020, "Mcp-Method does not match body method");
    }
    if (typeof meta[META_CAPABILITIES] !== "object") {
      return fail(-32602, "Missing required field clientCapabilities");
    }
    if (meta[META_PROTOCOL] !== "2026-07-28") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32022, message: "Unsupported protocol version" },
      }, { status: 400 });
    }

    if (method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2026-07-28",
          capabilities: { tools: {} },
          serverInfo: { name: "hvgerp-mcp", version: "3.3.2" },
          resultType: "complete",
        },
      }, { headers: { "MCP-Protocol-Version": "2026-07-28" } });
    }

    if (method === "tools/call") {
      const expected = params["name"];
      if (req.headers.get("Mcp-Name") !== encodeHeaderValue(String(expected))) {
        return fail(-32020, "Mcp-Name does not match body name");
      }
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "ok" }],
          resultType: "complete",
        },
      });
    }

    // Method đã bị gỡ khỏi revision này: 404, đúng như server thật.
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    }, { status: 404 });
  });

  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    captured,
    close: async () => {
      await server.shutdown();
    },
  };
}

/** Request y như Cowork gửi: không header MCP, protocolVersion đời cũ. */
function legacyPost(body: unknown): Request {
  return new Request("https://erp.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer test-token",
      "X-Anthropic-Client": "Cowork",
    },
    body: JSON.stringify(body),
  });
}

Deno.test("initialize doi cu duoc dich va tra ve dung ban client de nghi", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "claude-cowork", version: "1.0.0" },
        },
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.result.protocolVersion, "2025-11-25");
    assertEquals(payload.result.resultType, undefined);
    assertEquals(res.headers.get("MCP-Protocol-Version"), "2025-11-25");

    const sent = upstream.captured[0];
    assertEquals(sent.headers["mcp-protocol-version"], "2026-07-28");
    assertEquals(sent.headers["mcp-method"], "initialize");
    const params =
      (sent.body as Record<string, Record<string, unknown>>).params;
    assertEquals(params.protocolVersion, "2026-07-28");
    const meta = params._meta as Record<string, unknown>;
    assertEquals(meta[META_PROTOCOL], "2026-07-28");
    assertEquals(meta[META_CAPABILITIES], { roots: { listChanged: true } });
  } finally {
    await upstream.close();
  }
});

Deno.test("tools/call sinh Mcp-Name khop voi than request", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "erpnext_whoami", arguments: {} },
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.result.content[0].text, "ok");
    assertEquals(payload.result.resultType, undefined);
    assertEquals(upstream.captured[0].headers["mcp-name"], "erpnext_whoami");
  } finally {
    await upstream.close();
  }
});

Deno.test("request hien dai di thang, than khong bi sua", async () => {
  const upstream = await startUpstream();
  try {
    const body = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {
        _meta: {
          [META_PROTOCOL]: "2026-07-28",
          [META_CAPABILITIES]: {},
        },
      },
    };
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify(body),
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 404); // upstream gia khong cai tools/list
    await res.body?.cancel();
    assertEquals(upstream.captured[0].body, body);
    assertEquals(upstream.captured[0].headers["mcp-method"], "tools/list");
  } finally {
    await upstream.close();
  }
});

Deno.test("GET /mcp mo stream SSE thay vi 405", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        headers: { "Accept": "text/event-stream" },
      }),
      { upstream: upstream.url, heartbeatMs: 60_000 },
    );

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assertEquals(new TextDecoder().decode(first.value), ": connected\n\n");
    await reader.cancel();
    assertEquals(upstream.captured.length, 0);
  } finally {
    await upstream.close();
  }
});

Deno.test("DELETE /mcp tra 204 va khong cham upstream", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", { method: "DELETE" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 204);
    assertEquals(upstream.captured.length, 0);
  } finally {
    await upstream.close();
  }
});

Deno.test("ping duoc tra loi tai cho", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 4, method: "ping" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { jsonrpc: "2.0", id: 4, result: {} });
    assertEquals(upstream.captured.length, 0);
  } finally {
    await upstream.close();
  }
});

Deno.test("method khong ton tai: loi JSON-RPC giu nguyen, HTTP 404 thanh 200", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 5, method: "resources/templates/list" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 200);
    const payload = await res.json();
    assertEquals(payload.error.code, -32601);
  } finally {
    await upstream.close();
  }
});

Deno.test("notification tra 202", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 202);
    assertEquals(upstream.captured.length, 1);
  } finally {
    await upstream.close();
  }
});

Deno.test("401 cua upstream toi thang client kem WWW-Authenticate", async () => {
  const upstream = await startUpstream(() =>
    new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate":
          'Bearer resource_metadata="https://erp.example/.well-known/oauth-protected-resource/mcp"',
      },
    })
  );
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 401);
    assertExists(res.headers.get("WWW-Authenticate"));
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("gia tri Mcp-Name ngoai ASCII duoc boc sentinel", () => {
  const { headers } = rewriteOutbound(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "hvg://báo-cáo" },
    },
    { name: "test", version: "1" },
  );
  assertEquals(headers["Mcp-Name"], encodeHeaderValue("hvg://báo-cáo"));
  assertEquals(headers["Mcp-Name"].startsWith("=?base64?"), true);
});

Deno.test("cong tac hien dai chi bat khi header khop tuyet doi", () => {
  assertEquals(
    isModernRequest(new Headers({ "MCP-Protocol-Version": "2026-07-28" })),
    true,
  );
  assertEquals(
    isModernRequest(new Headers({ "MCP-Protocol-Version": "2025-11-25" })),
    false,
  );
  assertEquals(isModernRequest(new Headers()), false);
});

Deno.test("rewriteInbound khong dung toi payload khong co result", () => {
  const errorPayload = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -1, message: "x" },
  };
  assertEquals(rewriteInbound(errorPayload, "2025-11-25"), errorPayload);
});
