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
