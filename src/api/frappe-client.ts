/**
 * Frappe REST API Client
 *
 * Zero-dependency HTTP client for the Frappe/ERPNext REST API.
 * Supports API Key + API Secret authentication.
 *
 * API Reference:
 *   GET  /api/resource/{doctype}              → list documents
 *   GET  /api/resource/{doctype}/{name}       → get single document
 *   POST /api/resource/{doctype}              → create document
 *   PUT  /api/resource/{doctype}/{name}       → update document
 *   DELETE /api/resource/{doctype}/{name}     → delete document
 *   POST /api/method/{method}                 → call whitelisted method
 *
 * Authentication:
 *   Authorization: token {api_key}:{api_secret}
 *   Or token-based: Authorization: Bearer {token}
 *
 * @module lib/erpnext/api/frappe-client
 */

import type {
  FrappeDoc,
  FrappeDocResponse,
  FrappeFile,
  FrappeFileUploadInput,
  FrappeListOptions,
  FrappeListResponse,
  FrappeMethodResponse,
} from "./types.ts";
import { env } from "../runtime.ts";
import type { Cache } from "../cache/types.ts";
import { MemoryCache } from "../cache/memory.ts";
import { createCache, getCache, getCacheTtlMs } from "../cache/cache.ts";
import {
  bumpInvalidationGeneration,
  getInvalidationGeneration,
} from "../cache/invalidation-generation.ts";
import { currentCaller } from "./caller-context.ts";

/**
 * Whether a number can serve as a page length at all.
 *
 * The bound is 1, not 0. ERPNext reads a page length of 0 as "no `LIMIT`
 * clause": measured against the live instance, `limit_page_length=0` returned
 * all 2235 `Account` rows while `limit_page_length=5` returned 5. So every
 * value below 1 - `0`, `0.5`, `-3` - either fetches the whole doctype or slices
 * from the wrong end, and none of them is a page length that can be honoured.
 */
export function isUsableLimit(limit: number): boolean {
  return Number.isFinite(limit) && limit >= 1;
}

/**
 * Coerce a page limit to the integer Frappe will actually apply.
 *
 * Every tool declares `limit` as a JSON `number`, so a caller may hand over
 * `2.5`. Frappe truncates that to 2 rows, which leaves the caller's own view of
 * the request out of step with the answer: any code comparing the page it got
 * back against the limit it asked for then reads 2 < 2.5 as "the result set is
 * exhausted" when it is not. Truncating here, at the single point the request
 * is built, keeps the requested limit and the applied limit the same number.
 *
 * A value below 1 throws instead of being quietly repaired. Flooring it would
 * hand ERPNext a 0 that means "every row", so `limit: 0.5` - a request for at
 * most one document - would come back with the entire doctype; and clamping it
 * up to 1 would answer a nonsensical request with an invented one. The error
 * says which number arrived and why it cannot be a page length.
 */
export function normalizeLimit(limit: number): number {
  if (!isUsableLimit(limit)) {
    throw new Error(
      `[FrappeClient] limit must be a finite number of at least 1, got ${limit}. ` +
        "ERPNext treats a page length below 1 as no limit at all, so this " +
        "request would return the entire doctype rather than the page asked for.",
    );
  }
  return Math.floor(limit);
}

/** Deterministic JSON.stringify — sorts object keys so equivalent options produce the same cache key. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${
      keys
        .map((k) =>
          `${JSON.stringify(k)}:${
            stableStringify((value as Record<string, unknown>)[k])
          }`
        )
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

export interface FrappeClientConfig {
  /** ERPNext base URL, e.g. http://localhost:8000 */
  baseUrl: string;
  /** API Key from ERPNext user settings. Omit when passing `authHeader`. */
  apiKey?: string;
  /** API Secret from ERPNext user settings. Omit when passing `authHeader`. */
  apiSecret?: string;
  /**
   * Produces the `Authorization` header value for each request, overriding `apiKey`/`apiSecret`.
   *
   * Called per request rather than once in the constructor because the value it returns is the
   * *calling user's* short-lived access token: a header captured at construction time would be
   * stale by the next refresh, and a client instance is reused across a caller's requests.
   */
  authHeader?: () => string;
  /** Request timeout in ms. Default: 30000 */
  timeoutMs?: number;
  /** Maximum decoded file upload size in bytes. Default: 10 MiB. */
  maxUploadBytes?: number;
  /**
   * Number of retry attempts on retryable failures (default: 3).
   * Set to 0 to disable retries entirely.
   */
  retries?: number;
  /**
   * HTTP status codes considered transient and worth retrying.
   * Default: [408, 429, 502, 503, 504]. Network errors (status 0) are always
   * retried regardless of this list.
   */
  retryStatuses?: number[];
  /**
   * Initial backoff delay in ms; doubled on each subsequent attempt
   * (200, 400, 800, …). A `Retry-After` response header overrides this.
   * Default: 200.
   */
  retryBackoffMs?: number;
  /**
   * HTTP methods eligible for retry. Default: ["GET"] — non-idempotent
   * methods are not retried automatically since the server may have already
   * applied the change.
   */
  retryMethods?: string[];
  /**
   * Cache used for list()/get() reads. Defaults to a fresh, unshared
   * MemoryCache per client instance — NOT the app-wide singleton — so
   * multiple FrappeClient instances (e.g. one per test) never leak cached
   * data into each other. Pass `getCache()` explicitly to share the
   * app-wide cache (see getFrappeClient()).
   */
  cache?: Cache;
  /**
   * Other caches in this process holding the same ERPNext rows, to be invalidated together with
   * `cache`.
   *
   * Needed since each caller got a cache of their own: a mutation clears the writer's cache, but
   * every OTHER caller keeps serving the document they cached before the write until their TTL
   * runs out. The old single shared cache was invalidated process-wide for free; caller isolation
   * has to buy that back explicitly.
   *
   * Deliberately a function rather than an array: the set of live caller caches changes on every
   * request (created on first use, dropped when idle or evicted), so a snapshot taken at
   * construction time would go stale immediately.
   *
   * Deliberately invalidation ONLY. Values are never read across the boundary, so a peer learns
   * that some row changed - never what it says. Peers that are not this client's `cache` are
   * skipped by identity, so nothing is cleared twice.
   */
  cachePeers?: () => Iterable<Cache>;
  /**
   * Danh tính mà client này gửi đi: `"caller"` khi mỗi request mang token của chính người gọi,
   * `"service"` khi nó mang một credential dùng chung. Mặc định `"service"`.
   *
   * Cần khai ở đây vì chỉ tầng dựng client mới biết sự thật đó. Sự có mặt của một caller context
   * KHÔNG đủ để kết luận: một ứng dụng nhúng có thể cài client tĩnh qua `setFrappeClient()` rồi
   * vẫn chạy trong `runWithCaller()`, và khi ấy lời gọi đi bằng tài khoản dịch vụ trong khi
   * `currentCaller()` vẫn trả về người thật. Đọc theo caller context sẽ dán nhãn `per-caller` cho
   * một hồ sơ của tài khoản dịch vụ, và `erpnext_whoami` bỏ mất đúng cảnh báo mà nó tồn tại để
   * phát ra.
   */
  actsAs?: FrappeClientIdentity;
}

/** Danh tính mà một `FrappeClient` gửi đi cùng mỗi request. */
export type FrappeClientIdentity = "caller" | "service";

const DEFAULT_RETRY_STATUSES = [408, 429, 502, 503, 504];
const DEFAULT_RETRY_METHODS = ["GET"];
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function decodeBase64File(contentBase64: string, maxBytes: number): Uint8Array {
  if (contentBase64.length === 0) {
    throw new Error("[FrappeClient] File content must not be empty");
  }

  const unpadded = contentBase64.replace(/=+$/, "");
  const padding = contentBase64.slice(unpadded.length);
  if (
    !/^[A-Za-z0-9+/]+$/.test(unpadded) ||
    !/^={0,2}$/.test(padding) ||
    unpadded.length % 4 === 1
  ) {
    throw new Error("[FrappeClient] File content must be valid base64");
  }

  const decodedSize = Math.floor(unpadded.length * 6 / 8);
  if (decodedSize > maxBytes) {
    throw new Error(
      `[FrappeClient] Decoded file size ${decodedSize} bytes exceeds the ${maxBytes}-byte upload limit`,
    );
  }

  const normalized = unpadded + "=".repeat((4 - unpadded.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error("[FrappeClient] File content must be valid base64");
  }

  if (binary.length === 0) {
    throw new Error("[FrappeClient] File content must not be empty");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Error thrown when a Frappe REST API request fails.
 *
 * Carries the HTTP status code and the raw response body for programmatic
 * error handling (e.g. retries on 429, user-facing messages from `exc_type`).
 *
 * @example
 * ```ts
 * try {
 *   await client.get("Sales Order", "SO-00001");
 * } catch (e) {
 *   if (e instanceof FrappeAPIError && e.status === 404) {
 *     console.log("Document not found");
 *   }
 * }
 * ```
 */
export class FrappeAPIError extends Error {
  /**
   * @param message - Human-readable error description
   * @param status - HTTP status code (0 for network errors, 408 for timeouts)
   * @param body - Raw response body (parsed JSON object or plain text string)
   * @param retryAfterMs - When the server sent a `Retry-After` header on a
   *                      retryable status (typically 429), the parsed delay
   *                      in ms. Used by the retry loop; absent otherwise.
   */
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly retryAfterMs?: number,
  ) {
    super(`[FrappeClient] ${message} (HTTP ${status})`);
    this.name = "FrappeAPIError";
  }
}

/**
 * Parse a `Retry-After` header value. The HTTP spec accepts either a number of
 * seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns the delay in ms, or `undefined` if the value can't be parsed.
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

/**
 * Extract human-readable messages from Frappe's `_server_messages` field.
 * Frappe returns a JSON-encoded array of JSON-encoded strings, each containing a `message` field.
 * Returns a concatenated string of all messages, or undefined if parsing fails.
 */
function extractServerMessages(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try {
    const outer = JSON.parse(raw);
    if (!Array.isArray(outer)) return undefined;
    const msgs: string[] = [];
    for (const item of outer) {
      try {
        const inner = JSON.parse(item);
        if (typeof inner === "object" && inner?.message) {
          msgs.push(inner.message);
        } else if (typeof inner === "string") {
          msgs.push(inner);
        }
      } catch {
        if (typeof item === "string") msgs.push(item);
      }
    }
    return msgs.length > 0 ? msgs.join("; ") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Frappe REST API client.
 * Follows no-silent-fallbacks policy — throws FrappeAPIError on any HTTP error.
 */
export class FrappeClient {
  private baseUrl: string;
  private resolveAuthHeader: () => string;
  private timeoutMs: number;
  private maxUploadBytes: number;
  private retries: number;
  private retryStatuses: number[];
  private retryBackoffMs: number;
  private retryMethods: string[];
  private cache: Cache;
  private cachePeers?: () => Iterable<Cache>;
  /** Xem {@link FrappeClientConfig.actsAs}. Chỉ đọc: không đường nào đổi danh tính giữa chừng. */
  readonly actsAs: FrappeClientIdentity;

  constructor(config: FrappeClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    if (config.authHeader) {
      this.resolveAuthHeader = config.authHeader;
    } else if (config.apiKey && config.apiSecret) {
      const staticHeader = `token ${config.apiKey}:${config.apiSecret}`;
      this.resolveAuthHeader = () => staticHeader;
    } else {
      // No silent fallback: a client with no credentials would issue unauthenticated requests and
      // Frappe would answer as Guest, which reads as "empty result" rather than as an error.
      throw new Error(
        "[FrappeClient] either apiKey + apiSecret or authHeader is required",
      );
    }
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxUploadBytes = config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (!Number.isInteger(this.maxUploadBytes) || this.maxUploadBytes <= 0) {
      throw new Error(
        "[FrappeClient] maxUploadBytes must be a positive integer",
      );
    }
    this.retries = config.retries ?? 3;
    this.retryStatuses = config.retryStatuses ?? DEFAULT_RETRY_STATUSES;
    this.retryBackoffMs = config.retryBackoffMs ?? 200;
    this.retryMethods = config.retryMethods ?? DEFAULT_RETRY_METHODS;
    this.cache = config.cache ?? new MemoryCache();
    this.cachePeers = config.cachePeers;
    this.actsAs = config.actsAs ?? "service";
  }

  // ── Private HTTP helpers ────────────────────────────────────────────────────

  private buildHeaders(includeJsonContentType = true): HeadersInit {
    const headers: Record<string, string> = {
      "Authorization": this.resolveAuthHeader(),
      "Accept": "application/json",
    };
    if (includeJsonContentType) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Decide whether an error is worth retrying.
   * Network errors (status 0) and timeouts (status 408) are always retryable;
   * other statuses are checked against `retryStatuses`.
   */
  private isRetryable(err: unknown, method: string): boolean {
    if (!this.retryMethods.includes(method)) return false;
    if (!(err instanceof FrappeAPIError)) return false;
    if (err.status === 0) return true;
    return this.retryStatuses.includes(err.status);
  }

  /** Compute the backoff delay for a given attempt (0-indexed). */
  private computeBackoff(attempt: number, err: unknown): number {
    if (
      err instanceof FrappeAPIError && err.retryAfterMs !== undefined
    ) {
      return err.retryAfterMs;
    }
    return this.retryBackoffMs * 2 ** attempt;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    multipart = false,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, body, multipart);
      } catch (err) {
        lastError = err;
        if (
          attempt === this.retries || !this.isRetryable(err, method)
        ) {
          throw err;
        }
        const delay = this.computeBackoff(attempt, err);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    // Defensive: the loop above either returns or throws.
    throw lastError;
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    body?: unknown,
    multipart = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(!multipart),
        body: body === undefined
          ? undefined
          : multipart
          ? body as BodyInit
          : JSON.stringify(body),
        signal: controller.signal,
      });
      // Keep the timeout active until the response body has been consumed.
      // Read as text first to tolerate incorrect JSON content-type headers.
      const rawText = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      let responseBody: unknown = rawText;
      if (contentType.includes("application/json") && rawText.length > 0) {
        try {
          responseBody = JSON.parse(rawText);
        } catch {
          // Server sent invalid JSON despite the content-type - keep the raw
          // text so the FrappeAPIError carries something useful instead of
          // crashing the whole request.
          responseBody = rawText;
        }
      }

      if (!response.ok) {
        let msg = response.statusText;
        if (typeof responseBody === "object" && responseBody !== null) {
          const rb = responseBody as Record<string, unknown>;
          const excType = rb.exc_type as string | undefined;
          const baseMsg = (rb.message as string) ?? excType ??
            response.statusText;

          // Parse _server_messages: Frappe returns a JSON-encoded array of JSON-encoded strings
          // e.g. "[\"{ \\\"message\\\": \\\"Row #1: Warehouse is required\\\" }\"]"
          const serverDetails = extractServerMessages(rb._server_messages);
          msg = serverDetails ? `${baseMsg}: ${serverDetails}` : baseMsg;
        } else if (
          typeof responseBody === "string" && responseBody.length > 0
        ) {
          // Truncate raw HTML / text bodies so error messages stay readable.
          msg = responseBody.slice(0, 200);
        }
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        throw new FrappeAPIError(
          `${method} ${path} failed: ${msg}`,
          response.status,
          responseBody,
          retryAfterMs,
        );
      }

      return responseBody as T;
    } catch (err) {
      if (err instanceof FrappeAPIError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new FrappeAPIError(
          `Request timed out after ${this.timeoutMs}ms: ${method} ${path}`,
          408,
          null,
        );
      }
      throw new FrappeAPIError(
        `Network error on ${method} ${path}: ${(err as Error).message}`,
        0,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Resource CRUD ───────────────────────────────────────────────────────────

  /**
   * List documents of a DocType.
   * Frappe list API: GET /api/resource/{doctype}?fields=...&filters=...
   *
   * Pass `{ skipCache: true }` to force a fresh read — e.g. for aggregate/KPI
   * tools that read across doctypes other than the one a preceding mutation
   * invalidated (see `invalidate()` below for why that gap exists). The fresh
   * result still refreshes the cache for subsequent normal reads.
   */
  async list<T extends FrappeDoc = FrappeDoc>(
    doctype: string,
    rawOptions: FrappeListOptions = {},
    opts: { skipCache?: boolean } = {},
  ): Promise<T[]> {
    // Normalise before the cache key so a fractional limit and the integer
    // Frappe would coerce it to are the same query, not two.
    const options: FrappeListOptions = {
      ...rawOptions,
      ...(rawOptions.limit === undefined
        ? {}
        : { limit: normalizeLimit(rawOptions.limit) }),
    };
    const cacheKey = `list:${doctype}:${stableStringify(options)}`;
    if (!opts.skipCache) {
      const cached = this.cache.get<T[]>(cacheKey);
      if (cached !== undefined) return cached;
    }

    const params = new URLSearchParams();

    if (options.fields && options.fields.length > 0) {
      params.set("fields", JSON.stringify(options.fields));
    }
    if (options.filters && options.filters.length > 0) {
      params.set("filters", JSON.stringify(options.filters));
    }
    if (options.order_by) {
      params.set("order_by", options.order_by);
    }
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.limit_start !== undefined) {
      params.set("limit_start", String(options.limit_start));
    }
    params.set("as_dict", "1");

    const query = params.toString() ? `?${params.toString()}` : "";
    const generation = getInvalidationGeneration(this.cache, doctype);
    const res = await this.request<FrappeListResponse<T>>(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}${query}`,
    );
    const docs = res.data ?? [];
    if (generation === getInvalidationGeneration(this.cache, doctype)) {
      this.cache.set(cacheKey, docs, getCacheTtlMs());
    }
    return docs;
  }

  /**
   * Get a single document by name.
   * GET /api/resource/{doctype}/{name}
   *
   * Pass `{ skipCache: true }` to force a fresh read — required before any
   * operation relying on the doc's `modified` timestamp for optimistic
   * locking (see erpnext_doc_submit/erpnext_doc_cancel in operations.ts).
   * The fresh result still refreshes the cache for subsequent normal reads.
   */
  async get<T extends FrappeDoc = FrappeDoc>(
    doctype: string,
    name: string,
    opts: { skipCache?: boolean } = {},
  ): Promise<T> {
    const cacheKey = `get:${doctype}:${name}`;
    if (!opts.skipCache) {
      const cached = this.cache.get<T>(cacheKey);
      if (cached !== undefined) return cached;
    }

    const generation = getInvalidationGeneration(this.cache, doctype);
    const res = await this.request<FrappeDocResponse<T>>(
      "GET",
      `/api/resource/${encodeURIComponent(doctype)}/${
        encodeURIComponent(name)
      }`,
    );
    if (generation === getInvalidationGeneration(this.cache, doctype)) {
      this.cache.set(cacheKey, res.data, getCacheTtlMs());
    }
    return res.data;
  }

  /**
   * Clear cached entries for a doctype (list results, resolveLink's
   * negative-match cache) and, if `name` is given, the cached single-document
   * read too. Called automatically after create/update/delete; call explicitly
   * after any mutation that bypasses those methods (e.g.
   * frappe.client.submit/cancel via callMethod).
   *
   * Known limitation: this only clears the mutated doctype. Frappe mutations
   * commonly cascade — submitting a Sales Order also writes Bin/GL
   * Entry/Sales Invoice rows — and those doctypes' cached `list()` results
   * aren't invalidated here. Aggregate/KPI tools that read across doctypes
   * can therefore serve up-to-TTL-stale numbers right after a mutation; pass
   * `{ skipCache: true }` to `list()` in those tools if that staleness isn't
   * acceptable for a given call site.
   */
  invalidate(doctype: string, name?: string): void {
    const clear = (cache: Cache): void => {
      // Chặn cả read đang bay: xóa các entry đã có không ngăn response cũ ghi lại.
      bumpInvalidationGeneration(cache, doctype);
      cache.deleteByPrefix(`list:${doctype}:`);
      cache.deleteByPrefix(`resolve:miss:${doctype}:`);
      if (name) cache.delete(`get:${doctype}:${name}`);
    };

    clear(this.cache);
    if (!this.cachePeers) return;
    for (const peer of this.cachePeers()) {
      // Identity check, not equality: `cachePeers()` normally includes this client's own cache.
      if (peer !== this.cache) clear(peer);
    }
  }

  /**
   * Create a new document.
   * POST /api/resource/{doctype}
   */
  async create<T extends FrappeDoc = FrappeDoc>(
    doctype: string,
    data: Partial<T>,
  ): Promise<T> {
    const res = await this.request<FrappeDocResponse<T>>(
      "POST",
      `/api/resource/${encodeURIComponent(doctype)}`,
      { data: { ...data, doctype } },
    );
    this.invalidate(doctype, res.data.name as string | undefined);
    return res.data;
  }

  /**
   * Update an existing document (partial update).
   * PUT /api/resource/{doctype}/{name}
   */
  async update<T extends FrappeDoc = FrappeDoc>(
    doctype: string,
    name: string,
    data: Partial<T>,
  ): Promise<T> {
    const res = await this.request<FrappeDocResponse<T>>(
      "PUT",
      `/api/resource/${encodeURIComponent(doctype)}/${
        encodeURIComponent(name)
      }`,
      { data },
    );
    this.invalidate(doctype, name);
    return res.data;
  }

  /**
   * Delete a document.
   * DELETE /api/resource/{doctype}/{name}
   */
  async delete(doctype: string, name: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/api/resource/${encodeURIComponent(doctype)}/${
        encodeURIComponent(name)
      }`,
    );
    this.invalidate(doctype, name);
  }

  /**
   * Upload file bytes and attach the native File document to another document.
   * POST /api/method/upload_file
   */
  async uploadFile(input: FrappeFileUploadInput): Promise<FrappeFile> {
    const fileName = input.fileName.trim();
    const attachedToDoctype = input.attachedToDoctype.trim();
    const attachedToName = input.attachedToName.trim();
    const attachedToField = input.attachedToField?.trim();
    if (!fileName || /[\\/\0]/.test(fileName)) {
      throw new Error(
        "[FrappeClient] fileName must be a filename without path separators",
      );
    }
    if (!attachedToDoctype) {
      throw new Error("[FrappeClient] attachedToDoctype must not be empty");
    }
    if (!attachedToName) {
      throw new Error("[FrappeClient] attachedToName must not be empty");
    }

    const bytes = decodeBase64File(
      input.contentBase64,
      this.maxUploadBytes,
    );
    const fileBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(fileBuffer).set(bytes);
    const form = new FormData();
    form.append("file", new Blob([fileBuffer]), fileName);
    form.append("doctype", attachedToDoctype);
    form.append("docname", attachedToName);
    if (attachedToField) {
      form.append("fieldname", attachedToField);
    }
    form.append("is_private", input.isPrivate === false ? "0" : "1");

    const res = await this.request<FrappeMethodResponse<FrappeFile>>(
      "POST",
      "/api/method/upload_file",
      form,
      true,
    );
    const file = res.message;
    this.invalidate("File", file.name);
    this.invalidate(attachedToDoctype, attachedToName);

    // Frappe records fieldname on File but does not populate the target Attach
    // field itself, so mirror the Desk uploader's second mutation here.
    if (attachedToField) {
      await this.update(attachedToDoctype, attachedToName, {
        [attachedToField]: file.file_url,
      });
    }

    return file;
  }

  /**
   * Call a whitelisted Frappe method.
   * POST /api/method/{method}
   *
   * Pass `{ httpMethod: "GET" }` for methods whitelisted read-only
   * (`@frappe.whitelist(methods=["GET"])`), which reject POST. Arguments then
   * travel as query params; non-string values are JSON-encoded, matching how
   * Frappe parses `form_dict`.
   */
  async callMethod<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
    opts: { httpMethod?: "GET" | "POST" } = {},
  ): Promise<T> {
    const res = await this.callMethodRaw<FrappeMethodResponse<T>>(
      method,
      args,
      opts,
    );
    return res.message;
  }

  /**
   * Call a whitelisted Frappe method and return the whole response envelope.
   *
   * Most Frappe methods answer through `message`, which `callMethod` unwraps.
   * A few write their payload onto other keys of `frappe.response` instead and
   * return `None` — `frappe.desk.form.load.getdoctype` puts the meta bundle in
   * `docs`, so unwrapping `message` would yield `undefined`. Those callers need
   * the envelope.
   */
  async callMethodRaw<T = Record<string, unknown>>(
    method: string,
    args: Record<string, unknown> = {},
    opts: { httpMethod?: "GET" | "POST" } = {},
  ): Promise<T> {
    if (opts.httpMethod === "GET") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined) continue;
        params.set(
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      const query = params.toString() ? `?${params.toString()}` : "";
      return await this.request<T>("GET", `/api/method/${method}${query}`);
    }

    return await this.request<T>("POST", `/api/method/${method}`, args);
  }
}

// ── Client resolution ──────────────────────────────────────────────────────

/**
 * Authorization scheme used when forwarding the caller's own Keycloak access token.
 *
 * Deliberately not `Bearer`: Frappe's native handlers ignore an unknown scheme, so accepting a
 * realm token becomes an explicit decision made by `hvg_workspace.mcp_auth` rather than something
 * every Frappe endpoint does implicitly. Same shape as `HVGToken` in `hvg_vault/auth.py`.
 */
const CALLER_AUTH_SCHEME = "HVGKeycloak";

/**
 * How many per-caller clients to keep. Each holds only a small cache, so the cap exists to
 * bound memory on a long-lived process, not because clients are expensive.
 */
const MAX_CALLER_CLIENTS = 64;

/** Drop a caller's client (and therefore its cached reads) after this long without a request. */
const CALLER_CLIENT_IDLE_MS = 15 * 60 * 1000;

interface CallerClientEntry {
  client: FrappeClient;
  cache: Cache;
  lastUsedAt: number;
}

/**
 * A client handed in from outside (`setFrappeClient`) - tests and dependency injection.
 *
 * Kept apart from `_staticClient` on purpose. When both roles shared one variable, the process-wide
 * service-account client got parked in the same slot an injected client uses, and from then on it
 * was returned BEFORE `currentCaller()` was ever consulted: every OAuth call after the first
 * anonymous call (or after a startup cache warm) silently ran under the shared API key instead of
 * the caller's forwarded identity. The bug was invisible in `required` mode and only appeared in
 * `optional` mode, where both kinds of call reach the same process.
 */
let _injectedClient: FrappeClient | null = null;

/** The process-wide service-account client, built lazily from ERPNEXT_API_KEY / ERPNEXT_API_SECRET. */
let _staticClient: FrappeClient | null = null;

const _callerClients = new Map<string, CallerClientEntry>();

/**
 * Every cache this module handed to a client, so a mutation through any one of them can clear the
 * matching entries in all the others (`cachePeers`).
 *
 * Membership is managed here rather than inside the caches because this module is what creates and
 * drops them: a caller cache joins when its client is built and leaves when the client is evicted
 * (idle sweep, LRU cap, or `setFrappeClient`). A cache that stayed registered after eviction would
 * be a slow leak on a long-lived process.
 */
const _managedCaches = new Set<Cache>();

/**
 * Caches to invalidate alongside the one doing the writing. Read fresh on every mutation.
 *
 * `getCache()` luôn có mặt trong tập này, kể cả khi chưa client tĩnh nào được dựng. Lý do:
 * `resolveLink()` ghi các mục phủ định `resolve:miss:{doctype}:{identifier}` vào đúng cache cấp
 * ứng dụng đó, bất kể client nào đi dò. Ở chế độ caller-identity thì không còn chỗ nào khác ghi
 * danh nó, nên nếu bỏ ra thì một bản ghi vừa được tạo vẫn bị báo "không khớp gì cả" suốt 15 giây.
 */
function managedCaches(): Iterable<Cache> {
  return new Set([..._managedCaches, getCache()]);
}

function requireBaseUrl(): string {
  const url = env("ERPNEXT_URL");
  if (!url) {
    throw new Error(
      "[lib/erpnext] ERPNEXT_URL is required. " +
        "Set it to your ERPNext instance URL, e.g. http://localhost:8000",
    );
  }
  return url;
}

function configuredUploadLimit(): number | undefined {
  const raw = env("ERPNEXT_MAX_UPLOAD_BYTES");
  return raw?.trim() ? Number(raw) : undefined;
}

/**
 * The client for the caller currently being served.
 *
 * Each principal gets its OWN cache. Sharing the app-wide cache here would be a cross-user data
 * leak rather than a performance win: two callers with different ERPNext permissions issue
 * identical cache keys for the same list query, so whoever asked first would decide what the second
 * one sees.
 *
 * Isolated in what they HOLD, joined in what they DROP: every cache this module builds is
 * registered in `_managedCaches` and passed as `cachePeers`, so a write by one caller clears the
 * matching keys everywhere. Without that, the other callers would keep serving the pre-write
 * document until their TTL ran out - a regression against the old single shared cache, which one
 * `invalidate()` reached in full.
 *
 * The `Authorization` value is resolved per request, not captured here, because access tokens are
 * short-lived: a header frozen at construction time would keep presenting the token the caller
 * happened to hold on their first call.
 */
function callerClient(principal: string): FrappeClient {
  const now = Date.now();
  for (const [key, entry] of _callerClients) {
    if (now - entry.lastUsedAt > CALLER_CLIENT_IDLE_MS) {
      _callerClients.delete(key);
      _managedCaches.delete(entry.cache);
    }
  }

  const existing = _callerClients.get(principal);
  if (existing) {
    existing.lastUsedAt = now;
    // Re-insert so Map iteration order stays least-recently-used first.
    _callerClients.delete(principal);
    _callerClients.set(principal, existing);
    return existing.client;
  }

  // `createCache()`, not `new MemoryCache()`: a per-caller cache is still a cache, so
  // MCP_CACHE_ENABLED=false has to switch it off too. Hard-coding the memory backend here meant an
  // operator who disabled caching kept getting cached caller-scoped reads.
  const cache = createCache();
  const client = new FrappeClient({
    baseUrl: requireBaseUrl(),
    authHeader: () => {
      const caller = currentCaller();
      if (!caller) {
        throw new Error(
          "[lib/erpnext] no caller identity in scope while building a request. " +
            "This client only exists inside a request served for a specific user.",
        );
      }
      return `${CALLER_AUTH_SCHEME} ${caller.accessToken}`;
    },
    cache,
    cachePeers: managedCaches,
    maxUploadBytes: configuredUploadLimit(),
    actsAs: "caller",
  });

  while (_callerClients.size >= MAX_CALLER_CLIENTS) {
    const oldest = _callerClients.entries().next();
    if (oldest.done) break;
    const [oldestKey, oldestEntry] = oldest.value;
    _callerClients.delete(oldestKey);
    _managedCaches.delete(oldestEntry.cache);
  }
  _callerClients.set(principal, { client, cache, lastUsedAt: now });
  _managedCaches.add(cache);
  return client;
}

/**
 * Get the FrappeClient to use for the work in progress.
 *
 * Three modes, in precedence order:
 *
 *  1. an explicitly injected client (`setFrappeClient`) — tests and dependency injection;
 *  2. a per-caller client, when the request carries an end-user identity (HTTP transport with the
 *     caller-identity middleware). The server then acts *as that user*, so ERPNext applies that
 *     user's own roles and row-level permissions;
 *  3. a process-wide client built from `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` — the stdio
 *     transport, where the operator running the process IS the identity.
 *
 * Follows no-silent-fallbacks: with neither an identity nor static credentials it throws instead of
 * issuing an unauthenticated request, which Frappe would answer as Guest — an empty result that
 * reads like "no data" rather than like a failure.
 */
export function getFrappeClient(): FrappeClient {
  if (_injectedClient) return _injectedClient;

  const caller = currentCaller();
  if (caller) return callerClient(caller.principal);

  if (_staticClient) return _staticClient;

  const apiKey = env("ERPNEXT_API_KEY");
  const apiSecret = env("ERPNEXT_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error(
      "[lib/erpnext] no caller identity and no static credentials. " +
        "Over HTTP this server acts as the calling user, so the request must carry a user access " +
        "token. For stdio, set ERPNEXT_API_KEY and ERPNEXT_API_SECRET " +
        "(ERPNext: User Settings \u2192 API Access).",
    );
  }

  const cache = getCache();
  _staticClient = new FrappeClient({
    baseUrl: requireBaseUrl(),
    apiKey,
    apiSecret,
    cache,
    cachePeers: managedCaches,
    maxUploadBytes: configuredUploadLimit(),
  });
  _managedCaches.add(cache);
  return _staticClient;
}

/** Override the singleton (useful for tests or dependency injection) */
export function setFrappeClient(client: FrappeClient | null): void {
  _injectedClient = client;
  // Per-caller and service-account clients would otherwise outlive the override and keep serving a
  // previous test's cached reads. `setFrappeClient(null)` is the reset, so it must drop both.
  _callerClients.clear();
  _managedCaches.clear();
  _staticClient = null;
}
