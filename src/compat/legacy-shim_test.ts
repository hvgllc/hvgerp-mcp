/**
 * Test cho shim tương thích: upstream giả ở đây kiểm tra ĐÚNG những gì server
 * thật kiểm tra (header phải khớp `_meta`, `Mcp-Method` phải khớp `method`,
 * `Mcp-Name` phải soi gương trường định danh), nên một bài test đạt nghĩa là
 * request đó cũng đi lọt server thật, chứ không chỉ lọt một bản giả dễ tính.
 */
import { assertEquals, assertExists } from "@std/assert";
import {
  acceptsEventStream,
  clearCapabilityCache,
  encodeHeaderValue,
  handleShimRequest,
  isTranslatableBody,
  isTranslatableRequest,
  readPositiveInteger,
  rewriteInbound,
  rewriteOutbound,
  translateEventStream,
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
    // Thân không phải JSON vẫn phải được ghi nhận: đường đi thẳng chuyển tiếp
    // nguyên byte, và test cần thấy lượt gọi đó.
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
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
        headers: {
          "Accept": "text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
      }),
      { upstream: upstream.url, heartbeatMs: 60_000 },
    );

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assertEquals(new TextDecoder().decode(first.value), ": connected\n\n");
    await reader.cancel();
    // Đúng một lượt: phép hỏi quyền. Stream chỉ mở sau khi upstream cho qua.
    assertEquals(upstream.captured.length, 1);
    assertEquals(upstream.captured[0].method, "POST");
    assertEquals(
      (upstream.captured[0].body as Record<string, unknown>)["method"],
      "ping",
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("DELETE /mcp tra 204 sau khi upstream cho qua", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", { method: "DELETE" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 204);
    assertEquals(upstream.captured.length, 1);
    assertEquals(
      (upstream.captured[0].body as Record<string, unknown>)["method"],
      "ping",
    );
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
    // Đúng một lượt: phép hỏi quyền. Trả lời tại chỗ không được đi vòng qua cổng.
    assertEquals(upstream.captured.length, 1);
    assertEquals(
      (upstream.captured[0].body as Record<string, unknown>)["method"],
      "ping",
    );
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

Deno.test("cong tac dich doc ca revision khai trong than initialize", () => {
  const init = (version?: unknown) =>
    isTranslatableBody({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      ...(version === undefined
        ? {}
        : { params: { protocolVersion: version } }),
    });

  assertEquals(init(), true);
  assertEquals(init("2025-11-25"), true);
  assertEquals(init("2026-07-28"), true);
  assertEquals(init("2027-03-01"), false);
  // Khai sai kiểu là khai, không phải im lặng: dịch nó nghĩa là thay 42 bằng
  // 2026-07-28 rồi để một request sai định dạng bắt tay thành công.
  assertEquals(init(42), false);
  assertEquals(isTranslatableBody({ jsonrpc: "2.0", method: "ping" }), true);
  assertEquals(
    isTranslatableBody([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2027-03-01" },
      },
    ]),
    false,
  );
});

Deno.test("rewriteInbound khong dung toi payload khong co result", () => {
  const errorPayload = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -1, message: "x" },
  };
  assertEquals(rewriteInbound(errorPayload, "2025-11-25"), errorPayload);
});

/** Upstream chặn mọi POST bằng 401, đúng như server khi thiếu Bearer token. */
function unauthorized(): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: null,
    error: {
      code: -31401,
      message: "Authorization header with Bearer token required",
    },
  }, {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="hvgerp-mcp"' },
  });
}

Deno.test("GET /mcp khong co quyen: 401 chu khong phai stream", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST" ? unauthorized() : undefined
  );
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        headers: {
          "Accept": "text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
      }),
      { upstream: upstream.url, heartbeatMs: 60_000 },
    );

    assertEquals(res.status, 401);
    assertEquals(res.headers.get("Content-Type"), "application/json");
    assertExists(res.headers.get("WWW-Authenticate"));
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("DELETE /mcp khong co quyen: 401 chu khong phai 204", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST" ? unauthorized() : undefined
  );
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", { method: "DELETE" }),
      { upstream: upstream.url },
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("revision la hon 2026-07-28 di thang, than khong bi dich", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2027-03-01",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "initialize",
          params: { protocolVersion: "2027-03-01" },
        }),
      }),
      { upstream: upstream.url },
    );

    // Không dịch nghĩa là không bịa `_meta`, và cũng không tự nhận đã thương
    // lượng xong: câu trả lời là lời từ chối của chính server thật.
    assertEquals(upstream.captured.length, 1);
    const params = (upstream.captured[0].body as Record<string, unknown>)[
      "params"
    ] as Record<string, unknown>;
    assertEquals(params["_meta"], undefined);
    assertEquals(params["protocolVersion"], "2027-03-01");
    assertEquals(
      upstream.captured[0].headers["mcp-protocol-version"],
      "2027-03-01",
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("duong dan /mcp/ duoc chuan hoa va van duoc dich", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        }),
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    assertEquals(upstream.captured[0].url, "/mcp");
    const payload = await res.json();
    assertEquals(payload.result.protocolVersion, "2025-11-25");
  } finally {
    await upstream.close();
  }
});

Deno.test("header CORS cua upstream duoc giu tren response da dich", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    const id = (body as Record<string, unknown>)["id"];
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: "2026-07-28", resultType: "complete" },
    }, {
      headers: {
        "Access-Control-Allow-Origin": "https://claude.ai",
        "Access-Control-Expose-Headers": "MCP-Protocol-Version",
        "Vary": "Origin",
      },
    });
  });
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 11,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      }),
      { upstream: upstream.url },
    );

    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      "https://claude.ai",
    );
    assertEquals(
      res.headers.get("Access-Control-Expose-Headers"),
      "MCP-Protocol-Version",
    );
    assertEquals(res.headers.get("Vary"), "Origin");
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("cong tac dich: chi ban cu va ban khong khai moi duoc dich", () => {
  const at = (value?: string) =>
    isTranslatableRequest(
      new Headers(value === undefined ? {} : { "MCP-Protocol-Version": value }),
    );

  assertEquals(at(), true);
  assertEquals(at("2025-11-25"), true);
  assertEquals(at("2025-03-26"), true);
  assertEquals(at("2026-07-28"), false);
  assertEquals(at("2027-03-01"), false);
  assertEquals(at("khong-phai-ngay"), false);
});

Deno.test("readPositiveInteger tu choi cau hinh vo nghia", () => {
  const bounds = { min: 1000, max: 300_000 };
  assertEquals(readPositiveInteger("X", undefined, 15_000, bounds), 15_000);
  assertEquals(readPositiveInteger("X", "  ", 15_000, bounds), 15_000);
  assertEquals(readPositiveInteger("X", "20000", 15_000, bounds), 20_000);

  for (const bad of ["abc", "0", "-1", "1.5", "999", "300001", "NaN"]) {
    let threw = false;
    try {
      readPositiveInteger("SHIM_HEARTBEAT_MS", bad, 15_000, bounds);
    } catch (error) {
      threw = error instanceof RangeError;
    }
    assertEquals(threw, true, `phai nem loi voi gia tri ${bad}`);
  }
});

Deno.test("ping khong co quyen: 401 chu khong phai result rong", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST" ? unauthorized() : undefined
  );
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 12, method: "ping" }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 401);
    assertExists(res.headers.get("WWW-Authenticate"));
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("initialize khai ban tuong lai trong than: di thang, khong dich", async () => {
  const upstream = await startUpstream();
  try {
    // Không header MCP - đúng hình dạng của Cowork - nhưng thân khai một
    // revision shim không biết. Dịch nó là bịa ra một cuộc thương lượng.
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 13,
        method: "initialize",
        params: { protocolVersion: "2027-03-01" },
      }),
      { upstream: upstream.url },
    );

    assertEquals(upstream.captured.length, 1);
    const params = (upstream.captured[0].body as Record<string, unknown>)[
      "params"
    ] as Record<string, unknown>;
    assertEquals(params["_meta"], undefined);
    assertEquals(params["protocolVersion"], "2027-03-01");
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("than POST vuot tran bi tu choi, khong bao gio duoc chuyen tiep", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "erpnext_file_upload",
          arguments: { blob: "x".repeat(4096) },
        },
      }),
      { upstream: upstream.url, maxBodyBytes: 1024 },
    );

    assertEquals(res.status, 413);
    assertEquals((await res.json()).error.code, -32600);
    // Upstream chỉ thấy đúng một request: mũi dò `ping` để lấy quyết định xác
    // thực và header CORS. Thân 4 KiB không bao giờ được chuyển tiếp.
    assertEquals(upstream.captured.length, 1);
    assertEquals(
      (upstream.captured[0].body as Record<string, unknown>)["method"],
      "ping",
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("than chunked vuot tran cung bi tu choi", async () => {
  const upstream = await startUpstream();
  try {
    // Không `Content-Length` để khai: chỉ vòng đọc tự đếm mới chặn được.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
        controller.close();
      },
    });
    const req = new Request(
      "https://erp.example/mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: string },
    );

    const res = await handleShimRequest(req, {
      upstream: upstream.url,
      maxBodyBytes: 1024,
    });

    assertEquals(res.status, 413);
    assertEquals(upstream.captured.length, 1);
    assertEquals(
      (upstream.captured[0].body as Record<string, unknown>)["method"],
      "ping",
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("400 kem loi JSON-RPC thanh 200, 401 thi khong", async () => {
  const upstream = await startUpstream();
  try {
    // `name` không phải chuỗi nên shim không sinh `Mcp-Name`, và server thật
    // trả 400 kèm -32020. Client cũ đọc 400 là "endpoint hỏng".
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: 42 },
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    assertEquals((await res.json()).error.code, -32020);
  } finally {
    await upstream.close();
  }
});

Deno.test("202 cua notification van mang header CORS cua upstream", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    if ((body as Record<string, unknown>)["id"] !== undefined) return undefined;
    return new Response(null, {
      status: 202,
      headers: { "Access-Control-Allow-Origin": "https://claude.ai" },
    });
  });
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 202);
    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      "https://claude.ai",
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("Accept doc theo media range, khong phai chuoi con", () => {
  assertEquals(acceptsEventStream("text/event-stream"), true);
  assertEquals(acceptsEventStream("Text/Event-Stream"), true);
  assertEquals(acceptsEventStream("application/json, text/event-stream"), true);
  assertEquals(acceptsEventStream("text/event-stream;q=0.5"), true);
  assertEquals(
    acceptsEventStream("application/json, text/event-stream;q=0"),
    false,
  );
  assertEquals(acceptsEventStream("application/json"), false);
  assertEquals(acceptsEventStream("*/*"), false);
  assertEquals(acceptsEventStream(""), false);
});

Deno.test("Accept tu choi SSE bang q=0 khong mo stream", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        headers: {
          "Accept": "application/json, text/event-stream;q=0",
          "MCP-Protocol-Version": "2025-11-25",
        },
      }),
      { upstream: upstream.url, heartbeatMs: 60_000 },
    );

    // Không phải stream: chuyển tiếp thẳng và nhận đúng 405 của server.
    assertEquals(res.status, 405);
    assertEquals(
      (res.headers.get("Content-Type") ?? "").includes("text/event-stream"),
      false,
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("phep hoi quyen gap 5xx thi khong tong hop stream", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST"
      ? new Response("upstream down", { status: 503 })
      : undefined
  );
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        headers: {
          "Accept": "text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
      }),
      { upstream: upstream.url, heartbeatMs: 60_000 },
    );

    assertEquals(res.status, 503);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("phep hoi quyen gap 429 thi tra thang lenh lui nhip", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST"
      ? new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "30" },
      })
      : undefined
  );
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", { method: "DELETE" }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 429);
    assertEquals(res.headers.get("Retry-After"), "30");
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("revision la khai trong _meta cung chan viec dich", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 16,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2027-03-01" },
        },
      }),
      { upstream: upstream.url },
    );

    assertEquals(upstream.captured.length, 1);
    const params = (upstream.captured[0].body as Record<string, unknown>)[
      "params"
    ] as Record<string, unknown>;
    const meta = params["_meta"] as Record<string, unknown>;
    // Không bị ghi đè xuống 2026-07-28: lời từ chối là của server thật.
    assertEquals(meta["io.modelcontextprotocol/protocolVersion"], "2027-03-01");
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("batch dung lai ngay khi cham 401, khong khuech dai", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST" ? unauthorized() : undefined
  );
  try {
    const res = await handleShimRequest(
      legacyPost([
        { jsonrpc: "2.0", id: 20, method: "tools/list" },
        { jsonrpc: "2.0", id: 21, method: "tools/list" },
        { jsonrpc: "2.0", id: 22, method: "tools/list" },
        { jsonrpc: "2.0", id: 23, method: "tools/list" },
      ]),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 401);
    // Đúng một lượt lên upstream cho cả batch bốn message.
    assertEquals(upstream.captured.length, 1);
    assertExists(res.headers.get("WWW-Authenticate"));
    const payload = await res.json();
    assertEquals(payload.length, 1);
    assertEquals(payload[0].error.code, -31401);
  } finally {
    await upstream.close();
  }
});

Deno.test("429 da dich van giu Retry-After", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    const id = (body as Record<string, unknown>)["id"];
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "Rate limit exceeded" },
    }, { status: 429, headers: { "Retry-After": "42" } });
  });
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 24, method: "tools/list" }),
      { upstream: upstream.url },
    );

    // 429 không bị hạ xuống 200, và lệnh lùi nhịp đi kèm đủ nhịp.
    assertEquals(res.status, 429);
    assertEquals(res.headers.get("Retry-After"), "42");
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("header do Connection goi ten khong duoc chuyen tiep", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
          "Connection": "X-Internal-Auth, keep-alive",
          "X-Internal-Auth": "proxy-local-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 25, method: "tools/list" }),
      }),
      { upstream: upstream.url },
    );

    assertEquals(upstream.captured.length, 1);
    assertEquals(upstream.captured[0].headers["x-internal-auth"], undefined);
    assertEquals(upstream.captured[0].headers["connection"], undefined);
    assertEquals(
      upstream.captured[0].headers["authorization"],
      "Bearer test-token",
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("path mo dau bang // khong doi duoc upstream", async () => {
  const upstream = await startUpstream();
  try {
    // `new URL("//host/x", upstream)` là URL scheme-relative: nếu shim dựng
    // target theo cách đó thì request này rời hẳn upstream đã cấu hình.
    const res = await handleShimRequest(
      new Request("https://erp.example//169.254.169.254/latest/meta-data"),
      { upstream: upstream.url },
    );

    assertEquals(upstream.captured.length, 1);
    assertEquals(
      upstream.captured[0].url,
      "//169.254.169.254/latest/meta-data",
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("2024-11-05 khong duoc nhan dich vi thieu su kien endpoint", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2024-11-05",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 30,
          method: "initialize",
          params: { protocolVersion: "2024-11-05" },
        }),
      }),
      { upstream: upstream.url },
    );

    // Đi thẳng: không `_meta` bịa ra, nên client nhận lời từ chối thật thay vì
    // treo mãi chờ một sự kiện `endpoint` shim không phát.
    assertEquals(upstream.captured.length, 1);
    const params = (upstream.captured[0].body as Record<string, unknown>)[
      "params"
    ] as Record<string, unknown>;
    assertEquals(params["_meta"], undefined);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("revision doi cu khai trong _meta duoc echo dung", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "erpnext_whoami",
          _meta: { "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
        },
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    // Không phải 2025-11-25 mặc định: client khai gì thì nhận lại đúng thứ đó.
    assertEquals(res.headers.get("MCP-Protocol-Version"), "2025-06-18");
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("407 giu Proxy-Authenticate khi dung lai response", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    const id = (body as Record<string, unknown>)["id"];
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "Proxy authentication required" },
    }, {
      status: 407,
      headers: { "Proxy-Authenticate": 'Basic realm="corp-proxy"' },
    });
  });
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 32, method: "tools/list" }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 407);
    assertEquals(
      res.headers.get("Proxy-Authenticate"),
      'Basic realm="corp-proxy"',
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("loi 413 do shim sinh ra van mang CORS cua upstream", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST"
      ? new Response(null, {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "https://claude.ai" },
      })
      : undefined
  );
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 33,
        method: "tools/call",
        params: { name: "x", arguments: { blob: "y".repeat(4096) } },
      }),
      { upstream: upstream.url, maxBodyBytes: 1024 },
    );

    assertEquals(res.status, 413);
    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      "https://claude.ai",
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("batch rong la Invalid Request, khong phai 202", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost([]),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 400);
    assertEquals((await res.json()).error.code, -32600);
  } finally {
    await upstream.close();
  }
});

Deno.test("capabilities thuong luong o initialize duoc giu cho loi goi sau", async () => {
  clearCapabilityCache();
  const upstream = await startUpstream();
  try {
    await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 40,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {
            experimental: { havi: true },
            // Hai thứ này shim không chở nổi tới cùng nên không được khai hộ.
            elicitation: {},
            roots: { listChanged: true },
          },
        },
      }),
      { upstream: upstream.url },
    ).then((res) => res.body?.cancel());

    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "erpnext_whoami" },
      }),
      { upstream: upstream.url },
    );
    await res.body?.cancel();

    // Client cũ chỉ khai capabilities một lần, còn server 2026-07-28 đọc chúng
    // ở TỪNG request: gửi `{}` là nói dối rằng client không làm được elicitation.
    const params = (upstream.captured[1].body as Record<string, unknown>)[
      "params"
    ] as Record<string, unknown>;
    const meta = params["_meta"] as Record<string, unknown>;
    assertEquals(meta[META_CAPABILITIES], { experimental: { havi: true } });
  } finally {
    clearCapabilityCache();
    await upstream.close();
  }
});

Deno.test("GET SSE voi revision ngoai danh sach khong duoc stream tong hop", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        headers: {
          "Accept": "text/event-stream",
          "MCP-Protocol-Version": "2024-11-05",
        },
      }),
      { upstream: upstream.url },
    );

    // Stream im lặng ở đây là lời hứa suông: client 2024-11-05 chờ sự kiện
    // `endpoint` mãi mãi. Để nó nhận 405 thật của server.
    assertEquals(res.status, 405);
    assertEquals(
      (res.headers.get("Content-Type") ?? "").includes("text/event-stream"),
      false,
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("DELETE voi revision ngoai danh sach di thang, khong bao 204 gia", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "DELETE",
        headers: { "MCP-Protocol-Version": "2026-07-28" },
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 405);
    assertEquals(upstream.captured.length, 1);
    assertEquals(upstream.captured[0].method, "DELETE");
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("duong `/` la but danh cua `/mcp`, khong phai goc upstream", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer test-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/list" }),
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    // Gửi lên goc upstream thi `initialize` roi vao 404 cua tang dinh tuyen,
    // va phep hoi quyen doc dung cai 404 do thanh "da lot cong".
    for (const call of upstream.captured) {
      assertEquals(call.url, "/mcp");
    }
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("than gzip duoc giai nen truoc khi dich", async () => {
  const upstream = await startUpstream();
  try {
    const plain = new TextEncoder().encode(JSON.stringify({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "erpnext_whoami" },
    }));
    const gzipped = new Response(
      new Blob([plain]).stream().pipeThrough(new CompressionStream("gzip")),
    );

    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Authorization": "Bearer test-token",
        },
        body: await gzipped.arrayBuffer(),
      }),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 200);
    assertEquals(upstream.captured.length, 1);
    assertEquals(
      (upstream.captured[0].body as Record<string, unknown>)["method"],
      "tools/call",
    );
    // Thân shim gửi đi là JSON phẳng, nên không được mang theo lời khai nén cũ.
    assertEquals(upstream.captured[0].headers["content-encoding"], undefined);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("Content-Encoding la khong giai duoc thi di thang", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "br",
          "Authorization": "Bearer test-token",
        },
        body: new Uint8Array([0x1b, 0x2f, 0x00]),
      }),
      { upstream: upstream.url },
    );

    assertEquals(upstream.captured.length, 1);
    // Đi thẳng: không `_meta` bịa ra, và lời khai nén giữ nguyên cho upstream.
    assertEquals(upstream.captured[0].headers["content-encoding"], "br");
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("phong bi input_required thanh tool result doc duoc", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    const message = body as Record<string, unknown>;
    if (message["method"] !== "tools/call") return undefined;
    return Response.json({
      jsonrpc: "2.0",
      id: message["id"],
      result: {
        resultType: "input_required",
        inputRequests: {
          "link-disambiguation:customer": {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: 'Multiple Customer records match "Havi". ' +
                "Choose the record ID to use: CUST-001 (Havi A), CUST-002 (Havi B).",
              requestedSchema: { type: "object" },
            },
          },
        },
      },
    });
  });
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: { name: "erpnext_customer_get" },
      }),
      { upstream: upstream.url },
    );

    const payload = await res.json();
    // Gỡ `resultType` rồi thả đi thì client cũ thấy một result rỗng và không
    // biết mình vừa được hỏi điều gì.
    assertEquals(payload.result.resultType, undefined);
    assertEquals(payload.result.isError, true);
    assertEquals(
      payload.result.content[0].text.includes("CUST-002 (Havi B)"),
      true,
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("khong co chung danh thi khong nho capabilities", async () => {
  clearCapabilityCache();
  const upstream = await startUpstream();
  const anonymous = (body: unknown) =>
    new Request("https://erp.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    await handleShimRequest(
      anonymous({
        jsonrpc: "2.0",
        id: 60,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { experimental: { havi: true } },
        },
      }),
      { upstream: upstream.url },
    ).then((res) => res.body?.cancel());

    const res = await handleShimRequest(
      anonymous({
        jsonrpc: "2.0",
        id: 61,
        method: "tools/call",
        params: { name: "erpnext_whoami" },
      }),
      { upstream: upstream.url },
    );
    await res.body?.cancel();

    // Mọi caller không chứng danh đều băm ra cùng một khoá, nên nhớ ở đây là
    // để `initialize` của người này đè capabilities của người kia.
    const params = (upstream.captured[1].body as Record<string, unknown>)[
      "params"
    ] as Record<string, unknown>;
    const meta = params["_meta"] as Record<string, unknown>;
    assertEquals(meta[META_CAPABILITIES], {});
  } finally {
    clearCapabilityCache();
    await upstream.close();
  }
});

Deno.test("entry hong khong co quyen: 401 chu khong phai 200 tong hop", async () => {
  const upstream = await startUpstream((req) =>
    req.method === "POST" ? unauthorized() : undefined
  );
  try {
    const res = await handleShimRequest(
      legacyPost([{}]),
      { upstream: upstream.url },
    );

    assertEquals(res.status, 401);
    assertEquals((await res.json()).error.code, -31401);
  } finally {
    await upstream.close();
  }
});

Deno.test("ping voi phong bi sai bi tu choi thay vi nhan result rong", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "1.0", id: 70, method: "ping" }),
      { upstream: upstream.url },
    );

    const payload = await res.json();
    assertEquals(payload.error.code, -32600);
  } finally {
    await upstream.close();
  }
});

Deno.test("logging/setLevel voi level la khong hop le tra -32602", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 71,
        method: "logging/setLevel",
        params: { level: "loud" },
      }),
      { upstream: upstream.url },
    );

    const payload = await res.json();
    assertEquals(payload.error.code, -32602);
  } finally {
    await upstream.close();
  }
});

Deno.test("client roi di thi luot goi upstream cung bi huy", async () => {
  // Upstream nhận request rồi im lặng mãi: chỉ có tín hiệu huỷ mới kết thúc
  // được lượt gọi này.
  const upstream = await startUpstream((req) =>
    req.method === "POST"
      ? new Response(
        new ReadableStream<Uint8Array>({ start() {} }),
        { headers: { "Content-Type": "application/json" } },
      )
      : undefined
  );
  try {
    const controller = new AbortController();
    const req = new Request("https://erp.example/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 80, method: "tools/list" }),
      signal: controller.signal,
    });

    const pending = handleShimRequest(req, { upstream: upstream.url });
    // Huỷ trước khi upstream nhận được request thì chẳng chứng minh được gì:
    // lượt fetch còn chưa rời shim. Đợi nó tới nơi rồi mới cắt.
    while (upstream.captured.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();

    // Không nối tín hiệu huỷ thì lời gọi này treo mãi: shim vẫn giữ request,
    // thân response và socket sau khi client đã đi mất.
    const outcome = await pending.then(
      (res) => {
        res.body?.cancel();
        return "resolved";
      },
      (error) => (error as Error).name,
    );
    assertEquals(outcome, "AbortError");
  } finally {
    await upstream.close();
  }
});

Deno.test("GET SSE khong khai revision di thang, khong treo client cu", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      new Request("https://erp.example/mcp", {
        headers: { "Accept": "text/event-stream" },
      }),
      { upstream: upstream.url, heartbeatMs: 60_000 },
    );

    // `GET` mở đầu của 2024-11-05 có trước header `MCP-Protocol-Version`, nên
    // trên dây nó KHÔNG phân biệt được với một client Streamable HTTP không
    // khai. Stream tổng hợp ở đây là lời hứa về sự kiện `endpoint` không bao
    // giờ tới; 405 thì client nào cũng đọc được ngay.
    assertEquals(res.status, 405);
    assertEquals(
      (res.headers.get("Content-Type") ?? "").includes("text/event-stream"),
      false,
    );
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("protocolVersion sai kieu khong duoc coi nhu khong khai", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 7, capabilities: {} },
      }),
      { upstream: upstream.url },
    );

    // Không dịch: request đi thẳng nguyên trạng và nhận lỗi kiểm tra thật của
    // server, thay vì được shim thay số 7 bằng 2026-07-28 rồi bắt tay thành
    // công như một request đúng.
    const captured = upstream.captured[0].body as Record<string, unknown>;
    const params = captured["params"] as Record<string, unknown>;
    assertEquals(params["protocolVersion"], 7);
    assertEquals(res.status >= 400, true);
    await res.body?.cancel();
  } finally {
    await upstream.close();
  }
});

Deno.test("entry co id sai kieu nhan loi mang id null", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost([{ jsonrpc: "2.0", id: {} }]),
      { upstream: upstream.url },
    );

    const body = await res.json() as Array<Record<string, unknown>>;
    assertEquals(body[0]["id"], null);
    assertEquals(
      (body[0]["error"] as Record<string, unknown>)["code"],
      -32600,
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("ping voi params khong phai object tra -32602", async () => {
  const upstream = await startUpstream();
  try {
    const res = await handleShimRequest(
      legacyPost({ jsonrpc: "2.0", id: 4, method: "ping", params: "invalid" }),
      { upstream: upstream.url },
    );

    const body = await res.json() as Record<string, unknown>;
    assertEquals(
      (body["error"] as Record<string, unknown>)["code"],
      -32602,
    );
  } finally {
    await upstream.close();
  }
});

Deno.test("Content-Type viet hoa van duoc doc la JSON", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    const message = body as Record<string, unknown>;
    if (message?.["method"] !== "initialize") return undefined;
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message["id"],
        result: {
          protocolVersion: "2026-07-28",
          capabilities: { tools: {} },
          serverInfo: { name: "hvgerp-mcp", version: "3.3.2" },
          resultType: "complete",
        },
      }),
      { headers: { "Content-Type": "Application/JSON; charset=UTF-8" } },
    );
  });
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      }),
      { upstream: upstream.url },
    );

    const body = await res.json() as Record<string, unknown>;
    const result = body["result"] as Record<string, unknown>;
    assertEquals(result["protocolVersion"], "2025-11-25");
    assertEquals(result["resultType"], undefined);
  } finally {
    await upstream.close();
  }
});

Deno.test("response SSE cua POST da dich cung duoc dich tung message", async () => {
  const upstream = await startUpstream((req, body) => {
    if (req.method !== "POST") return undefined;
    const message = body as Record<string, unknown>;
    if (message?.["method"] !== "initialize") return undefined;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: message["id"],
      result: {
        protocolVersion: "2026-07-28",
        capabilities: { tools: {} },
        serverInfo: { name: "hvgerp-mcp", version: "3.3.2" },
        resultType: "complete",
      },
    });
    return new Response(
      `: open\n\nevent: message\ndata: ${payload}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  try {
    const res = await handleShimRequest(
      legacyPost({
        jsonrpc: "2.0",
        id: 6,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {} },
      }),
      { upstream: upstream.url },
    );

    const text = await res.text();
    // Khung sự kiện giữ nguyên, chỉ thân JSON-RPC bên trong được dịch.
    assertEquals(text.includes(": open"), true);
    assertEquals(text.includes("event: message"), true);
    const line = text.split("\n").find((entry) => entry.startsWith("data: "))!;
    const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
    const result = payload["result"] as Record<string, unknown>;
    assertEquals(result["protocolVersion"], "2025-11-25");
    assertEquals(result["resultType"], undefined);
  } finally {
    await upstream.close();
  }
});

Deno.test("translateEventStream giu nguyen khoi khong phai JSON", async () => {
  const source = new Response(
    ": heartbeat\n\nevent: ping\ndata: not-json\n\n",
  ).body!;
  const translated = new Response(translateEventStream(source, "2025-11-25"));
  assertEquals(
    await translated.text(),
    ": heartbeat\n\nevent: ping\ndata: not-json\n\n",
  );
});
