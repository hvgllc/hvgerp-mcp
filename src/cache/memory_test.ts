/**
 * MemoryCache Tests
 *
 * @module lib/erpnext/tests/cache/memory_test
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { MemoryCache } from "./memory.ts";

function storedKeys(cache: MemoryCache): string[] {
  const store = Reflect.get(cache, "store") as Map<string, unknown>;
  return [...store.keys()];
}

Deno.test("MemoryCache - set isolates nested objects and arrays from the writer", () => {
  const cache = new MemoryCache();
  const original = { details: { status: "Open" }, rows: [{ qty: 1 }] };
  cache.set("doc", original, 60000);
  original.details.status = "Changed";
  original.rows[0].qty = 99;
  original.rows.push({ qty: 2 });
  const first = cache.get<typeof original>("doc")!;
  assertEquals(first, { details: { status: "Open" }, rows: [{ qty: 1 }] });
  first.rows[0].qty = 200;
  assertEquals(cache.get("doc"), {
    details: { status: "Open" },
    rows: [{ qty: 1 }],
  });

  const rows = [{ nested: { value: 1 } }, { nested: { value: 2 } }];
  cache.set("rows", rows, 60000);
  rows[0].nested.value = 99;
  rows.reverse();
  rows.pop();
  assertEquals(cache.get("rows"), [{ nested: { value: 1 } }, {
    nested: { value: 2 },
  }]);
});

Deno.test("MemoryCache - write snapshots preserve structured clone types and cycles", () => {
  const cache = new MemoryCache();
  const original = {
    date: new Date("2026-09-05T00:00:00Z"),
    map: new Map([["key", { value: 1 }]]),
    set: new Set([1, 2]),
    bytes: new Uint8Array([1, 2]),
    missing: undefined,
    self: null as unknown,
  };
  original.self = original;
  cache.set("rich", original, 60000);
  original.date.setUTCFullYear(2000);
  original.map.get("key")!.value = 99;
  original.set.add(3);
  original.bytes[0] = 99;
  const snapshot = cache.get<typeof original>("rich")!;
  assertEquals(snapshot.date.toISOString(), "2026-09-05T00:00:00.000Z");
  assertEquals(snapshot.map, new Map([["key", { value: 1 }]]));
  assertEquals(snapshot.set, new Set([1, 2]));
  assertEquals(snapshot.bytes, new Uint8Array([1, 2]));
  assert(Object.hasOwn(snapshot, "missing"));
  assert(snapshot.self === snapshot);
});

for (const cap of [1, 2]) {
  for (const existing of [false, true]) {
    for (const nested of [false, true]) {
      Deno.test(`MemoryCache - clone failure preserves live entries expiry and FIFO cap=${cap} existing=${existing} nested=${nested}`, () => {
        const originalNow = Date.now;
        let now = 1000;
        Date.now = () => now;
        try {
          const cache = new MemoryCache(cap);
          cache.set("oldest", { value: 1 }, 100);
          if (cap === 2) cache.set("second", { value: 2 }, 200);
          now = 1020;
          const uncloneable = nested
            ? { nested: { callback: () => 1 } }
            : () => 1;
          const error = assertThrows(() =>
            cache.set(existing ? "oldest" : "new", uncloneable, 999)
          );
          assert(error instanceof DOMException);
          assertEquals(error.name, "DataCloneError");
          assertEquals(
            storedKeys(cache),
            cap === 1 ? ["oldest"] : ["oldest", "second"],
          );
          assertEquals(cache.get("oldest"), { value: 1 });
          const entries = Reflect.get(cache, "store") as Map<
            string,
            { expiresAt: number }
          >;
          assertEquals(entries.get("oldest")!.expiresAt, 1100);
          if (cap === 2) {
            assertEquals(cache.get("second"), { value: 2 });
            cache.set("third", { value: 3 }, 1000);
            assertEquals(storedKeys(cache), ["second", "third"]);
          } else {
            now = 1100;
            assertEquals(cache.get("oldest"), undefined);
          }
        } finally {
          Date.now = originalNow;
        }
      });
    }
  }
}

Deno.test("MemoryCache - nonpositive TTL deletes without cloning unsupported values", () => {
  for (const ttl of [0, -1]) {
    const cache = new MemoryCache(2);
    cache.set("keep", 1, 60000);
    cache.set("remove", 2, 60000);
    cache.set("absent", () => 1, ttl);
    assertEquals(storedKeys(cache), ["keep", "remove"]);
    cache.set("remove", { callback: () => 1 }, ttl);
    assertEquals(storedKeys(cache), ["keep"]);
    assertEquals(cache.get("keep"), 1);
  }
});

Deno.test("MemoryCache - writing reclaims expired keys that were never read", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const cache = new MemoryCache();
    for (let index = 0; index < 1001; index++) {
      cache.set(`expired:${index}`, index, 10);
    }
    now += 10;
    cache.set("fresh", 42, 1000);
    assertEquals(storedKeys(cache).length, 1);
    assertEquals(storedKeys(cache), ["fresh"]);
    assertEquals(cache.get("fresh"), 42);
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("MemoryCache - default capacity retains the latest 1000 writes", () => {
  const originalNow = Date.now;
  Date.now = () => 1000;
  try {
    const cache = new MemoryCache();
    for (let index = 0; index < 1001; index++) {
      cache.set(`key:${index}`, index, 1000);
    }
    assertEquals(storedKeys(cache).length, 1000);
    assertEquals(cache.get("key:0"), undefined);
    assertEquals(cache.get("key:1"), 1);
    assertEquals(cache.get("key:1000"), 1000);
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("MemoryCache - capacity one replaces the oldest write", () => {
  const cache = new MemoryCache(1);
  cache.set("a", 1, 60_000);
  cache.set("a", 2, 60_000);
  assertEquals(storedKeys(cache), ["a"]);
  assertEquals(cache.get("a"), 2);
  cache.set("b", 3, 60_000);
  assertEquals(storedKeys(cache), ["b"]);
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), 3);
});

Deno.test("MemoryCache - writes update FIFO order but reads do not", () => {
  const cache = new MemoryCache(2);
  cache.set("a", 1, 60_000);
  cache.set("b", 2, 60_000);
  cache.set("a", 3, 60_000);
  assertEquals(storedKeys(cache), ["b", "a"]);
  assertEquals(cache.get("b"), 2);
  cache.set("c", 4, 60_000);
  assertEquals(storedKeys(cache), ["a", "c"]);
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("a"), 3);
});

Deno.test("MemoryCache - expired entries are reclaimed before live eviction", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const cache = new MemoryCache(2);
    cache.set("old-live", 1, 1000);
    cache.set("new-expired", 2, 10);
    now += 10;
    cache.set("fresh", 3, 1000);
    assertEquals(storedKeys(cache), ["old-live", "fresh"]);
    assertEquals(cache.get("old-live"), 1);
    assertEquals(cache.get("fresh"), 3);
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("MemoryCache - zero and negative TTL remove old values without evicting live keys", () => {
  for (const ttlMs of [0, -1]) {
    const cache = new MemoryCache(2);
    cache.set("keep", 1, 60_000);
    cache.set("replace", 2, 60_000);
    cache.set("absent", 3, ttlMs);
    assertEquals(storedKeys(cache), ["keep", "replace"]);
    cache.set("replace", 4, ttlMs);
    assertEquals(storedKeys(cache), ["keep"]);
    assertEquals(cache.get("replace"), undefined);
    assertEquals(cache.get("absent"), undefined);
    assertEquals(cache.get("keep"), 1);
  }
});

Deno.test("MemoryCache - invalid entry capacities are rejected", () => {
  for (const maxEntries of [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity]) {
    assertThrows(
      () => new MemoryCache(maxEntries),
      RangeError,
      "maxEntries must be a positive finite integer",
    );
  }
});

Deno.test("MemoryCache - 10000 writes never retain more than 100 entries", () => {
  const originalNow = Date.now;
  Date.now = () => 1000;
  try {
    const cache = new MemoryCache(100);
    for (let index = 0; index < 10_000; index++) {
      cache.set(`key:${index}`, index, 1000);
      assert(storedKeys(cache).length <= 100);
    }
    assertEquals(storedKeys(cache).length, 100);
    assertEquals(cache.get("key:9899"), undefined);
    assertEquals(cache.get("key:9900"), 9900);
    assertEquals(cache.get("key:9999"), 9999);
  } finally {
    Date.now = originalNow;
  }
});

Deno.test("MemoryCache - prefix invalidation and clear remain correct after eviction", () => {
  const cache = new MemoryCache(3);
  cache.set("evicted", 0, 60_000);
  cache.set("list:Customer:a", 1, 60_000);
  cache.set("get:Customer:a", 2, 60_000);
  cache.set("list:Customer:b", 3, 60_000);
  assertEquals(cache.get("evicted"), undefined);
  cache.deleteByPrefix("list:Customer:");
  assertEquals(storedKeys(cache), ["get:Customer:a"]);
  assertEquals(cache.get("get:Customer:a"), 2);
  cache.set("new", 4, 60_000);
  cache.clear();
  assertEquals(storedKeys(cache), []);
  cache.set("after-clear", 5, 60_000);
  assertEquals(storedKeys(cache), ["after-clear"]);
  assertEquals(cache.get("after-clear"), 5);
});

Deno.test("MemoryCache - set/get round trip", () => {
  const cache = new MemoryCache();
  cache.set("a", { foo: "bar" }, 1000);
  assertEquals(cache.get<{ foo: string }>("a"), { foo: "bar" });
});

Deno.test("MemoryCache - get returns undefined for missing key", () => {
  const cache = new MemoryCache();
  assertEquals(cache.get("missing"), undefined);
});

Deno.test("MemoryCache - entry expires after ttlMs", async () => {
  const cache = new MemoryCache();
  cache.set("a", "value", 10);
  assertEquals(cache.get("a"), "value");
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(cache.get("a"), undefined);
});

Deno.test("MemoryCache - delete removes a single key", () => {
  const cache = new MemoryCache();
  cache.set("a", 1, 1000);
  cache.set("b", 2, 1000);
  cache.delete("a");
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), 2);
});

Deno.test("MemoryCache - deleteByPrefix clears only matching keys", () => {
  const cache = new MemoryCache();
  cache.set("list:Customer:x", [1], 1000);
  cache.set("list:Customer:y", [2], 1000);
  cache.set("get:Customer:CUST-001", { name: "CUST-001" }, 1000);
  cache.deleteByPrefix("list:Customer:");
  assertEquals(cache.get("list:Customer:x"), undefined);
  assertEquals(cache.get("list:Customer:y"), undefined);
  assertEquals(cache.get("get:Customer:CUST-001"), { name: "CUST-001" });
});

Deno.test("MemoryCache - get() returns an independent copy, so mutating it doesn't corrupt later reads", () => {
  const cache = new MemoryCache();
  const original = [{ name: "A" }, { name: "B" }];
  cache.set("docs", original, 1000);

  const firstRead = cache.get<{ name: string }[]>("docs")!;
  firstRead.sort((a, b) => b.name.localeCompare(a.name));
  firstRead[0].name = "mutated";

  const secondRead = cache.get<{ name: string }[]>("docs")!;
  assertEquals(secondRead, [{ name: "A" }, { name: "B" }]);
});

Deno.test("MemoryCache - clear removes everything", () => {
  const cache = new MemoryCache();
  cache.set("a", 1, 1000);
  cache.set("b", 2, 1000);
  cache.clear();
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), undefined);
});
