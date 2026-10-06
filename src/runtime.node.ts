// deno-lint-ignore-file no-process-global
/**
 * Runtime adapter — Node.js implementation
 *
 * Selected automatically by runtime.ts (the selector) when running under
 * Node.js.
 *
 * @see runtime.deno.ts for the Deno implementation
 * @module lib/erpnext/src/runtime.node
 */

import { readdirSync, statSync as fsStatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import type {
  ContextStore,
  HttpServeHandler,
  ServeHttpOptions,
} from "./runtime-types.ts";

// ─── Environment ─────────────────────────────────────────

export function env(key: string): string | undefined {
  return process.env[key];
}

// ─── File System ─────────────────────────────────────────

export async function readTextFile(path: string): Promise<string> {
  return await readFile(path, "utf-8");
}

export function statSync(path: string): boolean {
  try {
    fsStatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readDirSync(path: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      entries.push(entry.name);
    }
  }
  return entries;
}

// ─── Process ─────────────────────────────────────────────

export function getArgs(): string[] {
  return process.argv.slice(2);
}

export function exit(code: number): never {
  process.exit(code);
}

export function onSignal(signal: string, handler: () => void): void {
  process.on(signal, handler);
}

// ─── Async context ───────────────────────────────────────

/**
 * `AsyncLocalStorage` is Node's own async-context API. The import sits in the adapter, not in
 * shared source, so `src/api/caller-context.ts` stays platform-agnostic (AGENTS.md,
 * "Dual-runtime design").
 */
export function createContextStore<T>(): ContextStore<T> {
  const storage = new AsyncLocalStorage<T>();
  return {
    run: <R>(value: T, fn: () => R): R => storage.run(value, fn),
    current: (): T | undefined => storage.getStore(),
  };
}

// ─── HTTP listener ───────────────────────────────────────

/**
 * Mở một cổng HTTP và giao mọi request cho `handler`, đổi `IncomingMessage` sang `Request` và
 * `Response` sang `ServerResponse` (phát trực tiếp từng khối, không gom cả body vào bộ nhớ).
 * Promise chỉ hoàn tất khi server đóng.
 */
export function serveHttp(
  options: ServeHttpOptions,
  handler: HttpServeHandler,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = createServer((incoming, outgoing) => {
      const abort = new AbortController();
      outgoing.on("close", () => abort.abort());
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else headers.set(name, value);
      }
      const method = incoming.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const url = `http://${
        incoming.headers.host ?? `${options.hostname}:${options.port}`
      }${incoming.url ?? "/"}`;
      // Header `Host` sai cú pháp (ví dụ `]`) làm `new Request` ném đồng bộ. Ngoài khối try này,
      // lỗi đó sẽ thoát khỏi callback của `createServer` và làm sập cả tiến trình.
      let request: Request;
      let detachBody = () => {};
      try {
        request = new Request(url, {
          method,
          headers,
          signal: abort.signal,
          ...(hasBody
            ? {
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  let finished = false;
                  const onData = (chunk: Uint8Array) => {
                    if (finished) return;
                    try {
                      controller.enqueue(chunk);
                    } catch {
                      finished = true;
                    }
                  };
                  const onEnd = () => {
                    if (finished) return;
                    finished = true;
                    try {
                      controller.close();
                    } catch { /* stream đã bị hủy */ }
                  };
                  const onError = (error: Error) => {
                    if (finished) return;
                    finished = true;
                    try {
                      controller.error(error);
                    } catch { /* stream đã bị hủy */ }
                  };
                  detachBody = () => {
                    finished = true;
                    incoming.off("data", onData);
                    incoming.off("end", onEnd);
                    incoming.off("error", onError);
                    // Bỏ phần body còn lại để phản hồi vẫn gửi được qua cùng kết nối.
                    incoming.on("error", () => {});
                    incoming.resume();
                  };
                  incoming.on("data", onData);
                  incoming.on("end", onEnd);
                  incoming.on("error", onError);
                },
                // Bên đọc hủy sớm (ví dụ body quá lớn): ngừng nhét chunk vào stream đã đóng.
                cancel() {
                  detachBody();
                },
              }),
              duplex: "half",
            }
            : {}),
        } as RequestInit);
      } catch {
        outgoing.statusCode = 400;
        outgoing.end();
        return;
      }

      Promise.resolve(handler(request)).then(async (response) => {
        outgoing.statusCode = response.status;
        response.headers.forEach((value, name) =>
          outgoing.setHeader(name, value)
        );
        if (response.body === null) {
          outgoing.end();
          return;
        }
        const reader = response.body.getReader();
        let finished = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              finished = true;
              break;
            }
            if (outgoing.destroyed) break;
            // Bộ đệm đầy thì dừng đọc luồng Fetch cho tới khi socket xả xong (hoặc đóng).
            if (!outgoing.write(value)) {
              await new Promise<void>((resolve) => {
                const settle = () => {
                  outgoing.off("drain", settle);
                  outgoing.off("close", settle);
                  resolve();
                };
                outgoing.once("drain", settle);
                outgoing.once("close", settle);
              });
            }
          }
        } finally {
          // Client bỏ đi giữa chừng: hủy nguồn để không tiếp tục sinh dữ liệu vô ích.
          if (!finished) void reader.cancel().catch(() => {});
          outgoing.end();
        }
      }).catch(() => {
        if (!outgoing.headersSent) outgoing.statusCode = 500;
        outgoing.end();
      });
    });
    server.on("error", reject);
    server.on("close", () => resolve());
    options.signal?.addEventListener("abort", () => {
      server.close();
      server.closeAllConnections();
    }, { once: true });
    server.listen(options.port, options.hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null
        ? address.port
        : options.port;
      options.onListen?.({ hostname: options.hostname, port });
    });
  });
}
