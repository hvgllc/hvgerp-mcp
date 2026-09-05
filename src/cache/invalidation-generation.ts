import type { Cache } from "./types.ts";

// Cache là ranh giới ownership: cùng cache dùng chung generation, nhưng registry
// không giữ cache đã bị loại khỏi danh sách caller sống tiếp. Symbol tránh tràn bộ đếm.
const generations = new WeakMap<Cache, Map<string, symbol>>();

export function getInvalidationGeneration(
  cache: Cache,
  doctype: string,
): symbol | undefined {
  return generations.get(cache)?.get(doctype);
}

export function bumpInvalidationGeneration(
  cache: Cache,
  doctype: string,
): void {
  let byDoctype = generations.get(cache);
  if (byDoctype === undefined) {
    byDoctype = new Map();
    generations.set(cache, byDoctype);
  }
  byDoctype.set(doctype, Symbol());
}
