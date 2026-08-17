/**
 * Runtime adapter — Deno implementation
 *
 * Abstracts Deno-specific APIs behind platform-agnostic functions.
 * Selected automatically by runtime.ts (the selector) when running under Deno.
 *
 * @see runtime.node.ts for the Node.js implementation
 * @module lib/erpnext/src/runtime.deno
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ContextStore } from "./runtime-types.ts";

// ─── Environment ─────────────────────────────────────────

export function env(key: string): string | undefined {
  return Deno.env.get(key);
}

// ─── File System ─────────────────────────────────────────

export async function readTextFile(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

export function statSync(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readDirSync(path: string): string[] {
  const entries: string[] = [];
  for (const entry of Deno.readDirSync(path)) {
    if (entry.isDirectory) {
      entries.push(entry.name);
    }
  }
  return entries;
}

// ─── Process ─────────────────────────────────────────────

export function getArgs(): string[] {
  return Deno.args;
}

export function exit(code: number): never {
  Deno.exit(code);
}

export function onSignal(signal: string, handler: () => void): void {
  Deno.addSignalListener(signal as Deno.Signal, handler);
}

// ─── Async context ───────────────────────────

/**
 * Deno has no async-context API of its own: `AsyncLocalStorage` from `node:async_hooks` is the
 * supported way, and it is stable here. The import sits in the adapter precisely so shared source
 * never names a `node:` module (AGENTS.md, "Dual-runtime design").
 */
export function createContextStore<T>(): ContextStore<T> {
  const storage = new AsyncLocalStorage<T>();
  return {
    run: <R>(value: T, fn: () => R): R => storage.run(value, fn),
    current: (): T | undefined => storage.getStore(),
  };
}
