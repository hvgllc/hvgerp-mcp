/**
 * Test cho cổng HTTP của runtime port và cho việc `server.ts` chỉ đi qua adapter khi bật cờ.
 *
 * @module lib/erpnext/src/events/serve-http_test
 */

import { assert, assertEquals } from "@std/assert";
import { serveHttp } from "../runtime.ts";

Deno.test("serveHttp serves a Fetch handler and stops when its signal aborts", async () => {
  const stop = new AbortController();
  let address: { hostname: string; port: number } | undefined;
  const ready = Promise.withResolvers<void>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => {
      address = info;
      ready.resolve();
    },
  }, async (request) => {
    const body = request.method === "POST" ? await request.text() : "";
    return Response.json({
      method: request.method,
      path: new URL(request.url).pathname,
      body,
    }, {
      status: 201,
      headers: { "x-test": "yes" },
    });
  });
  await ready.promise;
  assert(address !== undefined && address.port > 0);
  const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    body: "hello",
  });
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("x-test"), "yes");
  assertEquals(await res.json(), {
    method: "POST",
    path: "/mcp",
    body: "hello",
  });
  stop.abort();
  await finished;
});

// ── Runtime Node: request hỏng không được làm sập tiến trình ───────────────────

async function withNodeServer(
  handler: (request: Request) => Response | Promise<Response>,
  body: (port: number) => Promise<void>,
) {
  const { serveHttp: serveNode } = await import("../runtime.node.ts");
  const stop = new AbortController();
  const ready = Promise.withResolvers<number>();
  const finished = serveNode({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve(info.port),
  }, handler);
  const port = await ready.promise;
  try {
    await body(port);
  } finally {
    stop.abort();
    await finished;
  }
}

async function rawExchange(port: number, text: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await conn.write(new TextEncoder().encode(text));
    const buffer = new Uint8Array(4096);
    const read = await conn.read(buffer);
    return new TextDecoder().decode(buffer.subarray(0, read ?? 0));
  } finally {
    conn.close();
  }
}

Deno.test("node serveHttp answers 400 to a malformed Host header and keeps serving", async () => {
  await withNodeServer(() => new Response("ok"), async (port) => {
    const reply = await rawExchange(
      port,
      "GET / HTTP/1.1\r\nHost: ]\r\nConnection: close\r\n\r\n",
    );
    assert(reply.startsWith("HTTP/1.1 400"), reply);
    // Tiến trình còn sống và phục vụ request kế tiếp.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(await res.text(), "ok");
  });
});

Deno.test("node serveHttp closes the connection of a malformed-Host request instead of draining its body", async () => {
  await withNodeServer(() => new Response("ok"), async (port) => {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    try {
      // Khai báo 8 MB nhưng chỉ gửi một ít: kẻ nhỏ giọt phần còn lại không được giữ socket, nên server phải đóng kết nối.
      await conn.write(new TextEncoder().encode(
        "POST / HTTP/1.1\r\nHost: ]\r\nContent-Length: 8388608\r\n\r\npartial",
      ));
      const chunks: string[] = [];
      const buffer = new Uint8Array(4096);
      const deadline = Date.now() + 3000;
      let closed = false;
      while (Date.now() < deadline) {
        const read = await conn.read(buffer);
        if (read === null) {
          closed = true;
          break;
        }
        chunks.push(new TextDecoder().decode(buffer.subarray(0, read)));
      }
      const reply = chunks.join("");
      assert(reply.startsWith("HTTP/1.1 400"), reply);
      assert(/connection: close/i.test(reply), reply);
      assertEquals(closed, true);
    } finally {
      conn.close();
    }
  });
});

Deno.test("node serveHttp survives data sent after the handler canceled the body", async () => {
  await withNodeServer(async (request) => {
    // Bên xử lý hủy body sớm, như khi từ chối body quá lớn.
    await request.body?.cancel();
    return new Response("rejected", { status: 413 });
  }, async (port) => {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    try {
      const enc = new TextEncoder();
      await conn.write(enc.encode(
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 20\r\n\r\nhello",
      ));
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Phần body còn lại tới sau khi stream đã bị hủy.
      await conn.write(enc.encode("0123456789ABCDE"));
      const buffer = new Uint8Array(4096);
      const read = await conn.read(buffer);
      assert(
        new TextDecoder().decode(buffer.subarray(0, read ?? 0)).startsWith(
          "HTTP/1.1 413",
        ),
      );
    } finally {
      conn.close();
    }
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(res.status, 413);
    await res.body?.cancel();
  });
});

Deno.test("node serveHttp drains a body the handler never read once it has responded", async () => {
  await withNodeServer(
    // Từ chối ngay, không đọc body (như khi xác thực thất bại).
    () => new Response("denied", { status: 401 }),
    async (port) => {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      try {
        const total = 8 * 1024 * 1024;
        await conn.write(new TextEncoder().encode(
          `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\n\r\n`,
        ));
        const chunk = new Uint8Array(64 * 1024);
        let sent = 0;
        const sender = (async () => {
          while (sent < total) {
            sent += await conn.write(
              chunk.subarray(0, Math.min(chunk.length, total - sent)),
            );
          }
        })().catch(() => {});
        const deadline = Date.now() + 3000;
        while (sent < total && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        // Server không còn giữ socket ở trạng thái tạm dừng: toàn bộ body đã được xả.
        assertEquals(sent, total);
        await sender;
      } finally {
        conn.close();
      }
    },
  );
});

// ── Dây nối trong server.ts ─────────────────────────────────────────────────

const SERVER_SOURCE = await Deno.readTextFile(
  new URL("../../server.ts", import.meta.url),
);

Deno.test("server.ts reads the flag and refuses a weak config before any listener starts", () => {
  assert(SERVER_SOURCE.includes("eventsFlagEnabled()"));
  assert(
    SERVER_SOURCE.includes(
      "assertEventsPolicy({ callerIdentity, authConfig })",
    ),
  );
  assert(
    SERVER_SOURCE.indexOf("assertEventsPolicy(") <
      SERVER_SOURCE.indexOf("createEventsAdapter("),
  );
  assert(SERVER_SOURCE.includes("--http"), "the flag must demand HTTP");
});

Deno.test("server.ts uses the adapter only when the flag is on, else the original startHttp", () => {
  assert(SERVER_SOURCE.includes("if (eventsEnabled && authProvider) {"));
  const adapterAt = SERVER_SOURCE.indexOf("createEventsAdapter({");
  const elseAt = SERVER_SOURCE.indexOf("} else {", adapterAt);
  const startHttpAt = SERVER_SOURCE.indexOf("server.startHttp({", adapterAt);
  assert(adapterAt > 0 && elseAt > adapterAt && startHttpAt > elseAt);
  // Chỉ có một chỗ dựng adapter và nó nằm trước nhánh else.
  assertEquals(SERVER_SOURCE.split("createEventsAdapter({").length, 2);
});

Deno.test("server.ts exposes the events tool only behind the flag", () => {
  assert(SERVER_SOURCE.includes("includeEventsTools: eventsEnabled"));
});
