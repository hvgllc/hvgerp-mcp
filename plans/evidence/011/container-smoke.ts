type Message = {
  jsonrpc?: unknown;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};
type Reply = { id: number; result?: unknown; error?: { message: string } };
type Failure =
  | "none"
  | "network"
  | "json"
  | "body"
  | "html"
  | "401"
  | "403"
  | "304";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const headers = {
  "Access-Control-Allow-Origin": "https://client.example",
  "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Protocol-Version",
  "WWW-Authenticate": 'Bearer realm="fixture"',
};
let calls: Message[] = [];
let mutations = 0;
let failure: Failure = "none";
let failAt = 2;
let assertions = 0;
let cases = 0;

function check(condition: unknown, message: string) {
  assertions += 1;
  assert(condition, message);
}

async function handleUpstream(
  request: Request,
  conn: Deno.Conn,
): Promise<Response | undefined> {
  const message: Message = await request.json();
  calls.push(message);
  if (message.jsonrpc !== "2.0") {
    return Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    }, { status: 400 });
  }
  check(
    request.headers.get("Mcp-Method") === message.method,
    "Translated method mismatch",
  );
  check(
    request.headers.get("MCP-Protocol-Version") === "2026-07-28",
    "Translated revision mismatch",
  );
  const meta = message.params?._meta as Record<string, unknown> | undefined;
  check(
    meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28",
    "Translated metadata mismatch",
  );
  const probe = message.id === "shim-authorization-probe";
  const failing = failure !== "none" && calls.length === failAt;
  if (!probe && !(failing && (failure === "401" || failure === "403"))) {
    mutations += 1;
  }

  if (failing) {
    if (failure === "304") {
      check(
        request.headers.get("If-None-Match") === '"fixture"',
        "Conditional auth request header",
      );
      return new Response(null, { status: 304, headers });
    }
    if (failure === "network" || failure === "body") {
      if (failure === "body") {
        await conn.write(new TextEncoder().encode(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nAccess-Control-Allow-Origin: https://client.example\r\n\r\n{",
        ));
      }
      return undefined;
    }
    if (failure === "json") {
      return new Response("{private malformed", {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    return new Response("private upstream error", {
      status: failure === "html" ? 502 : Number(failure),
      headers,
    });
  }

  if (probe) {
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }, { status: 404, headers });
  }
  return message.id === undefined
    ? new Response(null, { status: 202, headers })
    : Response.json(
      { jsonrpc: "2.0", id: message.id, result: { saved: true } },
      { headers },
    );
}

// TCP fixture đóng socket trước header hoặc giữa thân để tạo lỗi mạng thật.
const listener = Deno.listen({ hostname: "127.0.0.1", port: 17655 });
const pending = new Set<Promise<void>>();
const connections = new Set<Deno.Conn>();
let closing = false;
const serverErrors: unknown[] = [];

async function writeAll(conn: Deno.Conn, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function serveConnection(conn: Deno.Conn) {
  connections.add(conn);
  try {
    let raw = "";
    const buffer = new Uint8Array(4096);
    const decoder = new TextDecoder();
    let headerEnd = -1;
    while (headerEnd < 0) {
      const size = await conn.read(buffer);
      assert(size !== null, "Missing HTTP request headers");
      raw += decoder.decode(buffer.subarray(0, size));
      assert(raw.length < 1024 * 1024, "Oversized fixture request");
      headerEnd = raw.indexOf("\r\n\r\n");
    }
    const lines = raw.slice(0, headerEnd).split("\r\n");
    const requestHeaders = new Headers(
      lines.slice(1).map((line) => {
        const split = line.indexOf(":");
        return [line.slice(0, split), line.slice(split + 1).trim()];
      }),
    );
    const length = Number(requestHeaders.get("Content-Length"));
    assert(
      Number.isInteger(length) && length > 0 && length < 1024 * 1024,
      "Invalid fixture content length",
    );
    let body = raw.slice(headerEnd + 4);
    while (body.length < length) {
      const size = await conn.read(buffer);
      assert(size !== null, "Incomplete HTTP request body");
      body += decoder.decode(buffer.subarray(0, size));
    }
    const response = await handleUpstream(
      new Request("http://127.0.0.1:17655/mcp", {
        method: "POST",
        headers: requestHeaders,
        body,
      }),
      conn,
    );
    if (response === undefined) return;
    const responseBody = new Uint8Array(await response.arrayBuffer());
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Content-Length", String(responseBody.length));
    responseHeaders.set("Connection", "close");
    const head = `HTTP/1.1 ${response.status} ${response.statusText}\r\n` +
      [...responseHeaders].map(([name, value]) => `${name}: ${value}\r\n`).join(
        "",
      ) + "\r\n";
    await writeAll(conn, new TextEncoder().encode(head));
    await writeAll(conn, responseBody);
  } finally {
    connections.delete(conn);
    conn.close();
  }
}

const serverLoop = (async () => {
  try {
    for await (const conn of listener) {
      const task = serveConnection(conn).catch((error) => {
        serverErrors.push(error);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  } catch (error) {
    if (!closing) throw error;
  }
})();

function write(id?: number): Message {
  return {
    ...(id === undefined ? {} : { id }),
    method: "tools/call",
    params: { name: "test_write" },
  };
}

async function send(messages: Message | Message[]): Promise<Response> {
  const envelope = (message: Message) => ({ jsonrpc: "2.0", ...message });
  return await fetch("http://127.0.0.1:7654/mcp", {
    method: "POST",
    signal: AbortSignal.timeout(5000),
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      Accept: "application/json",
      "If-None-Match": '"fixture"',
    },
    body: JSON.stringify(
      Array.isArray(messages) ? messages.map(envelope) : envelope(messages),
    ),
  });
}

function reset(nextFailure: Failure = "none", nextFailAt = 2) {
  calls = [];
  mutations = 0;
  failure = nextFailure;
  failAt = nextFailAt;
}

try {
  reset();
  const ping = await send({ id: 100, method: "ping" });
  check(ping.status === 200, "Control ping HTTP status");
  check((await ping.json()).id === 100, "Control ping response");
  check(
    calls.length === 1 && mutations === 0,
    "Control ping authorization only",
  );
  cases += 1;

  reset();
  const success = await send([write(1), write(), write(3)]);
  check(success.status === 200, "Success batch HTTP status");
  check(
    JSON.stringify((await success.json()).map((reply: Reply) => reply.id)) ===
      "[1,3]",
    "Success batch IDs",
  );
  check(calls.length === 3 && mutations === 3, "Success batch mutations");
  cases += 1;

  const localEntries: Message[] = [{ id: 2 }, { id: 2, method: "ping" }, {
    id: 2,
    method: "tools/call",
    params: [] as unknown as Record<string, unknown>,
  }];
  for (const notificationFirst of [false, true]) {
    for (
      const nextFailure of [
        "network",
        "json",
        "body",
        "html",
        "401",
        "403",
      ] as const
    ) {
      reset(nextFailure);
      const response = await send([
        write(notificationFirst ? undefined : 1),
        write(2),
        write(),
        write(3),
      ]);
      const expectedStatus = nextFailure === "401" || nextFailure === "403"
        ? Number(nextFailure)
        : 502;
      check(
        response.status === expectedStatus && !response.ok,
        `Forward ${nextFailure} HTTP status`,
      );
      check(
        response.headers.get("MCP-Protocol-Version") === "2025-06-18",
        "Forward legacy revision",
      );
      check(
        response.headers.get("Access-Control-Allow-Origin") ===
          headers["Access-Control-Allow-Origin"],
        "Forward CORS",
      );
      if (nextFailure === "401" || nextFailure === "403") {
        check(
          response.headers.get("WWW-Authenticate") ===
            headers["WWW-Authenticate"],
          "Forward challenge",
        );
      }
      const text = await response.text();
      check(
        !text.includes("private") && !text.includes("127.0.0.1"),
        "Forward error redaction",
      );
      const replies: Reply[] = JSON.parse(text);
      check(
        JSON.stringify(replies.map((reply) => reply.id)) ===
          (notificationFirst ? "[2,3]" : "[1,2,3]"),
        "Forward batch IDs",
      );
      if (!notificationFirst) {
        check(
          JSON.stringify(replies.shift()?.result) === '{"saved":true}',
          "Preserved completed write",
        );
      }
      check(
        replies[0].error?.message.includes("Outcome unknown"),
        "Forward unknown outcome",
      );
      check(
        replies[1].error?.message.includes("Not executed"),
        "Forward skipped entry",
      );
      check(
        calls.length === 2 &&
          mutations ===
            (expectedStatus === 401 || expectedStatus === 403 ? 1 : 2),
        "Forward no replay or later mutation",
      );
      console.log(
        `PASS forward ${nextFailure} notification=${notificationFirst} status=${response.status} calls=${calls.length} mutations=${mutations}`,
      );
      cases += 1;
    }
    for (const local of localEntries) {
      for (const nextFailure of ["network", "401", "403", "304"] as const) {
        reset(nextFailure);
        const response = await send([
          write(notificationFirst ? undefined : 1),
          local,
          write(3),
          write(),
        ]);
        check(
          response.status ===
            (nextFailure === "network" || nextFailure === "304"
              ? 502
              : Number(nextFailure)),
          "Local auth HTTP status",
        );
        check(
          response.headers.get("MCP-Protocol-Version") === "2025-06-18",
          "Local legacy revision",
        );
        check(
          response.headers.get("Access-Control-Allow-Origin") ===
            headers["Access-Control-Allow-Origin"],
          "Local CORS",
        );
        if (nextFailure !== "network") {
          check(
            response.headers.get("WWW-Authenticate") ===
              headers["WWW-Authenticate"],
            "Local challenge",
          );
        }
        const text = await response.text();
        check(
          !text.includes("private") && !text.includes("127.0.0.1"),
          "Local error redaction",
        );
        const replies: Reply[] = JSON.parse(text);
        check(
          JSON.stringify(replies.map((reply) => reply.id)) ===
            (notificationFirst ? "[2,3]" : "[1,2,3]"),
          "Local batch IDs",
        );
        if (!notificationFirst) {
          check(
            JSON.stringify(replies.shift()?.result) === '{"saved":true}',
            "Local preserved completed write",
          );
        }
        check(
          replies.every((reply) =>
            reply.error?.message.includes("Not executed")
          ),
          "Local and later entries not executed",
        );
        check(
          calls.length === 2 && mutations === 1,
          "Local no replay or later mutation",
        );
        console.log(
          `PASS local ${
            local.method ?? "missing"
          } ${nextFailure} notification=${notificationFirst} status=${response.status} calls=${calls.length} mutations=${mutations}`,
        );
        cases += 1;
      }
    }
  }
  for (const local of localEntries) {
    reset("304", 1);
    const response = await send([local, write(3)]);
    check(response.status === 304, "First auth 304 remains unchanged");
    check(await response.text() === "", "First auth 304 has no body");
    check(
      response.headers.get("WWW-Authenticate") === headers["WWW-Authenticate"],
      "First auth 304 challenge",
    );
    check(
      calls.length === 1 && mutations === 0,
      "First auth 304 stops before writes",
    );
    cases += 1;
  }

  for (const revision of [undefined, "1.0", null, 2]) {
    for (const mixed of [false, true]) {
      reset();
      const malformed = { jsonrpc: revision, method: "tools/list" };
      const response = await send(
        mixed ? [write(1), malformed, write(3)] : [malformed],
      );
      check(response.status === 200, "Invalid idless envelope HTTP status");
      const replies = await response.json();
      check(
        JSON.stringify(replies.map((reply: Reply) => reply.id)) ===
          (mixed ? "[1,null,3]" : "[null]"),
        "Invalid idless envelope IDs",
      );
      check(
        replies[mixed ? 1 : 0].error.code === -32600,
        "Invalid idless envelope error",
      );
      check(
        JSON.stringify(calls.map((call) => call.id)) ===
          (mixed
            ? '[1,"shim-authorization-probe",3]'
            : '["shim-authorization-probe"]'),
        "Invalid envelope never forwarded",
      );
      check(mutations === (mixed ? 2 : 0), "Invalid envelope does not mutate");
      console.log(
        `PASS invalid idless revision=${String(revision)} mixed=${mixed}`,
      );
      cases += 1;
    }
  }

  reset();
  const notification = await send([write()]);
  check(notification.status === 202, "Valid notification HTTP status");
  check(await notification.text() === "", "Valid notification has no reply");
  check(
    calls.length === 1 && mutations === 1,
    "Valid notification still forwarded",
  );
  cases += 1;

  reset("304");
  const notificationBlocked = await send([write(), {
    method: "tools/list",
    params: [] as unknown as Record<string, unknown>,
  }, write()]);
  check(notificationBlocked.status === 502, "Notification-only 304 normalized");
  check(
    await notificationBlocked.text() === "",
    "Notification-only blocked batch has no reply",
  );
  check(
    calls.length === 2 && mutations === 1,
    "Notification-only blocked batch stops",
  );
  cases += 1;

  check(serverErrors.length === 0, "Fixture server failed");
  console.log(`PASS container smoke: ${cases} cases, ${assertions} assertions`);
} finally {
  closing = true;
  listener.close();
  for (const conn of connections) conn.close();
  await serverLoop;
  await Promise.all(pending);
}
