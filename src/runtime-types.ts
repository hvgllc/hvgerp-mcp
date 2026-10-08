/**
 * Runtime adapter — shared types
 *
 * Lives in its own module so both adapters (`runtime.deno.ts`, `runtime.node.ts`) and the selector
 * (`runtime.ts`) can name the same types without importing each other.
 *
 * @module lib/erpnext/src/runtime-types
 */

/**
 * A value scoped to one async call tree.
 *
 * The point of the abstraction is that a module-level "current value" variable is silently wrong
 * under concurrency: two overlapping requests clobber each other. Both runtimes implement this with
 * `AsyncLocalStorage`, but that import belongs in the adapters, not in shared source.
 */
export interface ContextStore<T> {
  /** Run `fn` with `value` visible to `current()` anywhere in its async tree. */
  run<R>(value: T, fn: () => R): R;
  /** The value for the call tree in progress, or `undefined` outside one. */
  current(): T | undefined;
}

/** Tuỳ chọn mở cổng HTTP của {@link HttpServeHandler}. */
export interface ServeHttpOptions {
  port: number;
  hostname: string;
  /** Gọi một lần khi cổng đã mở, với địa chỉ thực tế đang lắng nghe. */
  onListen?: (info: { hostname: string; port: number }) => void;
  /** Huỷ tín hiệu này thì đóng cổng và hoàn tất promise. Dùng cho tắt êm và cho test. */
  signal?: AbortSignal;
}

/** Hàm xử lý theo chuẩn Fetch, cùng hình dạng với `FetchHandler` của SDK. */
export type HttpServeHandler = (
  request: Request,
) => Response | Promise<Response>;
