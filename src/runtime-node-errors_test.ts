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
