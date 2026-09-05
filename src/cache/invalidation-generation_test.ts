import { assertEquals, assertNotEquals } from "@std/assert";
import { MemoryCache } from "./memory.ts";
import { NoopCache } from "./noop.ts";
import {
  bumpInvalidationGeneration,
  getInvalidationGeneration,
} from "./invalidation-generation.ts";

Deno.test("invalidation generation changes on every invalidation of the same cache and doctype", () => {
  const cache = new MemoryCache();
  const initial = getInvalidationGeneration(cache, "Task");
  assertEquals(initial, undefined);
  bumpInvalidationGeneration(cache, "Task");
  const first = getInvalidationGeneration(cache, "Task");
  assertNotEquals(first, initial);
  assertEquals(getInvalidationGeneration(cache, "Task"), first);
  bumpInvalidationGeneration(cache, "Task");
  assertNotEquals(getInvalidationGeneration(cache, "Task"), first);
});

Deno.test("invalidation generations isolate cache objects and doctypes", () => {
  const first = new MemoryCache();
  const second = new MemoryCache();
  bumpInvalidationGeneration(first, "Task");
  const generation = getInvalidationGeneration(first, "Task");
  assertEquals(getInvalidationGeneration(second, "Task"), undefined);
  assertEquals(getInvalidationGeneration(first, "Customer"), undefined);
  bumpInvalidationGeneration(first, "Customer");
  bumpInvalidationGeneration(second, "Task");
  assertEquals(getInvalidationGeneration(first, "Task"), generation);
  assertNotEquals(getInvalidationGeneration(second, "Task"), generation);
});

Deno.test("invalidation generation supports NoopCache without storing cached values", () => {
  const cache = new NoopCache();
  bumpInvalidationGeneration(cache, "Task");
  const first = getInvalidationGeneration(cache, "Task");
  bumpInvalidationGeneration(cache, "Task");
  assertNotEquals(getInvalidationGeneration(cache, "Task"), first);
  assertEquals(cache.get("Task"), undefined);
});
