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
