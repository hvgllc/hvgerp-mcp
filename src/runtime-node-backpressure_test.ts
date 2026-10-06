/**
 * Cầu Node của `serveHttp` phải tôn trọng backpressure: client đọc chậm không được làm cả luồng
 * Fetch bị rút hết vào bộ đệm gửi của tiến trình.
 *
 * @module lib/erpnext/src/runtime-node-backpressure_test
 */

import { assert } from "@std/assert";
import { serveHttp } from "./runtime.node.ts";

const CHUNK_BYTES = 64 * 1024;
const TOTAL_CHUNKS = 2000; // 128 MiB nếu bị rút hết

Deno.test("serveHttp stops pulling the response body while a slow client is not reading", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  let pulled = 0;
  const chunk = new Uint8Array(CHUNK_BYTES);
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          pulled++;
          controller.enqueue(chunk);
        },
      }, { highWaterMark: 0 }),
    ));
  const { port } = await ready.promise;
  const socket = await Deno.connect({ port, hostname: "127.0.0.1" });
  // Gửi request rồi không bao giờ đọc: mô phỏng client chậm.
  await socket.write(
    new TextEncoder().encode("GET /big HTTP/1.1\r\nHost: localhost\r\n\r\n"),
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  const pulledWhileStalled = pulled;
  socket.close();
  stop.abort();
  await finished;
  assert(
    pulledWhileStalled < TOTAL_CHUNKS / 4,
    `expected the bridge to pause reads, but ${pulledWhileStalled} of ${TOTAL_CHUNKS} chunks were pulled`,
  );
});

Deno.test("serveHttp cancels the response body when the client disconnects while a read is pending", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const cancelled = Promise.withResolvers<void>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, () =>
    new Response(
      // Luồng không bao giờ có dữ liệu: `reader.read()` treo cho tới khi bị hủy.
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel: () => cancelled.resolve(),
      }, { highWaterMark: 0 }),
    ));
  const { port } = await ready.promise;
  const socket = await Deno.connect({ port, hostname: "127.0.0.1" });
  await socket.write(
    new TextEncoder().encode("GET /stall HTTP/1.1\r\nHost: localhost\r\n\r\n"),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.close();
  const timer = setTimeout(
    () => cancelled.reject(new Error("body was not cancelled after close")),
    3000,
  );
  try {
    await cancelled.promise;
  } finally {
    clearTimeout(timer);
    stop.abort();
    await finished;
  }
});

Deno.test("serveHttp cancels the response body when the client disconnects before the handler resolves", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const cancelled = Promise.withResolvers<void>();
  const handlerStarted = Promise.withResolvers<void>();
  const releaseHandler = Promise.withResolvers<void>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, async () => {
    handlerStarted.resolve();
    // Handler chậm: client đã ngắt kết nối trước khi Response được trả về.
    await releaseHandler.promise;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel: () => cancelled.resolve(),
      }, { highWaterMark: 0 }),
    );
  });
  const { port } = await ready.promise;
  const socket = await Deno.connect({ port, hostname: "127.0.0.1" });
  await socket.write(
    new TextEncoder().encode("GET /late HTTP/1.1\r\nHost: localhost\r\n\r\n"),
  );
  await handlerStarted.promise;
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  releaseHandler.resolve();
  const timer = setTimeout(
    () =>
      cancelled.reject(new Error("body was not cancelled after early close")),
    3000,
  );
  try {
    await cancelled.promise;
  } finally {
    clearTimeout(timer);
    stop.abort();
    await finished;
  }
});

Deno.test("serveHttp settles a pending request body read when the client disconnects mid-POST", async () => {
  const stop = new AbortController();
  const ready = Promise.withResolvers<{ port: number }>();
  const settled = Promise.withResolvers<string>();
  const finished = serveHttp({
    port: 0,
    hostname: "127.0.0.1",
    signal: stop.signal,
    onListen: (info) => ready.resolve({ port: info.port }),
  }, async (request) => {
    try {
      await request.text();
      settled.resolve("resolved");
    } catch {
      settled.resolve("rejected");
    }
    return new Response("done");
  });
  const { port } = await ready.promise;
  const socket = await Deno.connect({ port, hostname: "127.0.0.1" });
  // Khai báo 100 byte nhưng chỉ gửi 5 rồi ngắt: body không bao giờ đủ.
  await socket.write(
    new TextEncoder().encode(
      "POST /partial HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nhello",
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.close();
  const timer = setTimeout(
    () => settled.reject(new Error("request body read never settled")),
    3000,
  );
  try {
    assert((await settled.promise) === "rejected");
  } finally {
    clearTimeout(timer);
    stop.abort();
    await finished;
  }
});

/** Node thật (không phải lớp tương thích của Deno) mới tái hiện đúng thứ tự sự kiện `close` và `error`. */
async function nodeMajor(): Promise<number | null> {
  try {
    const { stdout, success } = await new Deno.Command("node", {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return null;
    return Number(
      new TextDecoder().decode(stdout).trim().slice(1).split(".")[0],
    );
  } catch {
    return null;
  }
}

const NODE_MID_POST_SCRIPT = `
import net from "node:net";
const { serveHttp } = await import(process.argv[1]);
const stop = new AbortController();
let port;
let outcome = "pending";
const done = serveHttp({
  port: 0, hostname: "127.0.0.1", signal: stop.signal,
  onListen: (info) => { port = info.port; },
}, async (request) => {
  try { await request.text(); outcome = "resolved"; } catch { outcome = "rejected"; }
  return new Response("x");
});
await new Promise((resolve) => setTimeout(resolve, 300));
const socket = net.connect(port, "127.0.0.1");
socket.write("POST /p HTTP/1.1\\r\\nHost: l\\r\\nContent-Length: 100\\r\\n\\r\\nhello");
await new Promise((resolve) => setTimeout(resolve, 200));
socket.destroy();
await new Promise((resolve) => setTimeout(resolve, 1000));
console.log(outcome);
stop.abort();
await done;
`;

Deno.test({
  name:
    "serveHttp on real Node settles a pending request body read when the client disconnects mid-POST",
  ignore: (await nodeMajor() ?? 0) < 22,
  async fn() {
    const runtimeUrl = new URL("./runtime.node.ts", import.meta.url);
    const { stdout, stderr, success } = await new Deno.Command("node", {
      args: [
        "--experimental-strip-types",
        "--no-warnings",
        "--input-type=module",
        "-e",
        NODE_MID_POST_SCRIPT,
        runtimeUrl.href,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(
      success,
      `node script failed: ${new TextDecoder().decode(stderr)}`,
    );
    assert(new TextDecoder().decode(stdout).trim() === "rejected");
  },
});
