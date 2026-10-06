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
