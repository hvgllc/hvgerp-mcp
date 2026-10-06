/**
 * Cầu Node của `serveHttp` phải chịu được handler hỏng và tín hiệu hủy đến sớm mà không làm sập tiến trình
 * hay rò listener.
 *
 * @module lib/erpnext/src/runtime-node-errors_test
 */

import { assertEquals } from "@std/assert";
import { serveHttp } from "./runtime.node.ts";

Deno.test("serveHttp answers 500 when the handler throws synchronously", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () => {
    throw new Error("sync failure");
  });
  const { port } = await ready.promise;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  await response.body?.cancel();
  stop.abort();
  await finished;
  assertEquals(response.status, 500);
});

Deno.test("serveHttp does not listen when the signal is already aborted", async () => {
  const stop = new AbortController();
  stop.abort();
  let listened = false;
  await serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: () => {
      listened = true;
    },
  }, () => new Response("unreachable"));
  assertEquals(listened, false);
});

Deno.test("serveHttp answers 500 when the response stream errors before its first chunk", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () =>
    new Response(
      new ReadableStream({
        pull() {
          throw new Error("stream failure");
        },
      }),
      { status: 200, headers: { "content-type": "text/plain" } },
    ));
  const { port } = await ready.promise;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  await response.body?.cancel();
  stop.abort();
  await finished;
  assertEquals(response.status, 500);
});

Deno.test("serveHttp cuts the connection when the response stream errors after partial output", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () => {
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode("partial"));
            return;
          }
          throw new Error("stream failure");
        },
      }),
      { status: 200 },
    );
  });
  const { port } = await ready.promise;
  let readFailed = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    await response.text();
  } catch {
    readFailed = true;
  }
  stop.abort();
  await finished;
  assertEquals(readFailed, true);
});

Deno.test("serveHttp rejects a GET that declares a body and closes the connection", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  let handled = false;
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () => {
    handled = true;
    return new Response("ok");
  });
  const { port } = await ready.promise;
  const connection = await Deno.connect({ hostname: "127.0.0.1", port });
  // Khai báo 1 MB body nhưng không gửi: kết nối vẫn phải được đóng sau phản hồi.
  await connection.write(
    new TextEncoder().encode(
      "GET /health HTTP/1.1\r\nHost: x\r\nContent-Length: 1048576\r\n\r\n",
    ),
  );
  const chunks: string[] = [];
  const buffer = new Uint8Array(4096);
  while (true) {
    const read = await connection.read(buffer);
    if (read === null) break;
    chunks.push(new TextDecoder().decode(buffer.subarray(0, read)));
  }
  connection.close();
  stop.abort();
  await finished;
  const text = chunks.join("");
  assertEquals(text.startsWith("HTTP/1.1 400"), true);
  assertEquals(/connection: close/i.test(text), true);
  assertEquals(handled, false);
});

Deno.test("serveHttp closes the connection after rejecting a malformed Host with an unfinished body", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  let handled = false;
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () => {
    handled = true;
    return new Response("ok");
  });
  const { port } = await ready.promise;
  const connection = await Deno.connect({ hostname: "127.0.0.1", port });
  // `Host: ]` làm `new Request` ném; body khai báo 1 MB không bao giờ tới đủ nhưng kết nối vẫn phải đóng sau phản hồi.
  await connection.write(
    new TextEncoder().encode(
      "POST /mcp HTTP/1.1\r\nHost: ]\r\nContent-Length: 1048576\r\n\r\npartial",
    ),
  );
  const chunks: string[] = [];
  const buffer = new Uint8Array(4096);
  while (true) {
    const read = await connection.read(buffer);
    if (read === null) break;
    chunks.push(new TextDecoder().decode(buffer.subarray(0, read)));
  }
  connection.close();
  stop.abort();
  await finished;
  const text = chunks.join("");
  assertEquals(text.startsWith("HTTP/1.1 400"), true);
  assertEquals(/connection: close/i.test(text), true);
  assertEquals(handled, false);
});
