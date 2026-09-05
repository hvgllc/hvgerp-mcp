/**
 * Frappe Client Tests
 *
 * Tests for the FrappeClient HTTP client.
 * Uses mock fetch to avoid real network calls.
 *
 * @module lib/erpnext/tests/api/frappe-client_test
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  FrappeAPIError,
  FrappeClient,
  getFrappeClient,
  isUsableLimit,
  normalizeLimit,
  setFrappeClient,
} from "./frappe-client.ts";
import { MemoryCache } from "../cache/memory.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

interface MockResponse {
  status: number;
  body: unknown;
  contentType?: string;
  /** Raw body string — overrides `body` when provided (for malformed JSON tests). */
  rawBody?: string;
  /** Extra response headers (e.g. retry-after). */
  headers?: Record<string, string>;
}

const callCountRef: { current: number } = { current: 0 };

function mockFetch(responses: Array<MockResponse>) {
  callCountRef.current = 0;
  const original = globalThis.fetch;

  globalThis.fetch = async (
    _url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const config = responses[callCountRef.current++];
    if (!config) throw new Error("No more mock responses configured");

    const body = config.rawBody ?? JSON.stringify(config.body);
    return new Response(body, {
      status: config.status,
      headers: {
        "content-type": config.contentType ?? "application/json",
        ...(config.headers ?? {}),
      },
    });
  };

  return () => {
    globalThis.fetch = original;
  };
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return new FrappeClient({
    baseUrl: "http://localhost:8000",
    apiKey: "test-key",
    apiSecret: "test-secret",
    // Tests run with very short backoff so they stay fast.
    retryBackoffMs: 1,
    ...overrides,
  });
}

function withEnv(
  key: string,
  value: string | undefined,
  fn: () => void,
) {
  const original = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  try {
    fn();
  } finally {
    if (original === undefined) Deno.env.delete(key);
    else Deno.env.set(key, original);
  }
}

// ── Auth header ───────────────────────────────────────────────────────────────

Deno.test("FrappeClient - sends correct auth header", async () => {
  let capturedHeaders: Record<string, string> = {};
  const original = globalThis.fetch;

  globalThis.fetch = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedHeaders = Object.fromEntries(
      new Headers(init?.headers).entries(),
    );
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = makeClient();
  await client.list("Customer");

  assertEquals(capturedHeaders["authorization"], "token test-key:test-secret");

  globalThis.fetch = original;
});

// ── list() ────────────────────────────────────────────────────────────────────

Deno.test("FrappeClient.list() - returns data array", async () => {
  const restore = mockFetch([
    {
      status: 200,
      body: {
        data: [
          { name: "CUST-001", customer_name: "Acme Corp" },
          { name: "CUST-002", customer_name: "Globex" },
        ],
      },
    },
  ]);

  try {
    const client = makeClient();
    const result = await client.list("Customer", {
      fields: ["name", "customer_name"],
      limit: 10,
    });
    assertEquals(result.length, 2);
    assertEquals(result[0].name, "CUST-001");
    assertEquals(result[1].customer_name, "Globex");
  } finally {
    restore();
  }
});

Deno.test("FrappeClient.list() - builds correct query string", async () => {
  let capturedUrl = "";
  const original = globalThis.fetch;

  globalThis.fetch = async (
    url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = makeClient();
  await client.list("Sales Order", {
    fields: ["name", "customer"],
    filters: [["customer", "=", "CUST-001"]],
    limit: 5,
    order_by: "modified desc",
  });

  const url = new URL(capturedUrl);
  assertEquals(url.pathname, "/api/resource/Sales%20Order");
  assertEquals(url.searchParams.get("limit"), "5");
  assertEquals(url.searchParams.get("order_by"), "modified desc");
  assertEquals(url.searchParams.get("as_dict"), "1");

  globalThis.fetch = original;
});

Deno.test("FrappeClient.list() - sends the integer limit Frappe would apply", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (
    url: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    seen.push(new URL(url.toString()).searchParams.get("limit") ?? "");
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = makeClient();
  await client.list("Account", { limit: 2.5 });
  // Same query once normalised, so it must come out of the cache rather than
  // hitting the network a second time under a different key.
  await client.list("Account", { limit: 2 });

  assertEquals(seen, ["2"]);

  globalThis.fetch = original;
});

Deno.test("normalizeLimit - truncates fractions to the page Frappe applies", () => {
  assertEquals(normalizeLimit(2.5), 2);
  assertEquals(normalizeLimit(20), 20);
  assertEquals(normalizeLimit(1), 1);
});

Deno.test("normalizeLimit - refuses every page length below 1", () => {
  // Flooring these would hand ERPNext a 0, which it reads as "no LIMIT": on the
  // live instance `limit_page_length=0` returned all 2235 Account rows. A
  // request for at most one document must never come back with the doctype.
  for (const limit of [0, 0.5, -3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertThrows(
      () => normalizeLimit(limit),
      Error,
      "limit must be a finite number of at least 1",
    );
  }
});

Deno.test("isUsableLimit - accepts only a finite page length of at least 1", () => {
  assertEquals(isUsableLimit(1), true);
  assertEquals(isUsableLimit(2.5), true);
  assertEquals(isUsableLimit(0.5), false);
  assertEquals(isUsableLimit(0), false);
  assertEquals(isUsableLimit(-1), false);
  assertEquals(isUsableLimit(Number.NaN), false);
  assertEquals(isUsableLimit(Number.POSITIVE_INFINITY), false);
});

// ── get() ─────────────────────────────────────────────────────────────────────

Deno.test("FrappeClient.get() - returns single document", async () => {
  const restore = mockFetch([
    {
      status: 200,
      body: {
        data: { name: "SINV-001", customer: "CUST-001", grand_total: 1500.0 },
      },
    },
  ]);

  try {
    const client = makeClient();
    const result = await client.get("Sales Invoice", "SINV-001");
    assertEquals(result.name, "SINV-001");
    assertEquals(result.grand_total, 1500.0);
  } finally {
    restore();
  }
});

// ── create() ─────────────────────────────────────────────────────────────────

Deno.test("FrappeClient.create() - sends POST with data", async () => {
  let capturedBody: unknown;
  const original = globalThis.fetch;

  globalThis.fetch = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(
      JSON.stringify({ data: { name: "SO-001", customer: "CUST-001" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = makeClient();
  const result = await client.create("Sales Order", {
    customer: "CUST-001",
    transaction_date: "2026-02-18",
  });

  assertEquals(result.name, "SO-001");
  assertEquals(
    (capturedBody as { data: { customer: string } }).data.customer,
    "CUST-001",
  );

  globalThis.fetch = original;
});

// ── uploadFile() ─────────────────────────────────────────────────────────────

Deno.test("FrappeClient.uploadFile() - sends native multipart attachment", async () => {
  const requests: Array<{
    url: string;
    method: string;
    headers: Headers;
    body: FormData | string | undefined;
  }> = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({
      url: url.toString(),
      method: init?.method ?? "",
      headers: new Headers(init?.headers),
      body: init?.body as FormData | string | undefined,
    });
    if (requests.length === 2) {
      return new Response(
        JSON.stringify({
          data: {
            name: "CRM-DEAL-0001",
            proposal: "/private/files/proposal.pdf",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        message: {
          doctype: "File",
          name: "a1b2c3",
          file_name: "proposal.pdf",
          file_url: "/private/files/proposal.pdf",
          is_private: 1,
          attached_to_doctype: "CRM Deal",
          attached_to_name: "CRM-DEAL-0001",
          attached_to_field: "proposal",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    const result = await client.uploadFile({
      fileName: "proposal.pdf",
      contentBase64: btoa("PDF bytes"),
      attachedToDoctype: "CRM Deal",
      attachedToName: "CRM-DEAL-0001",
      attachedToField: "proposal",
    });

    const upload = requests[0];
    assertEquals(new URL(upload.url).pathname, "/api/method/upload_file");
    assertEquals(upload.method, "POST");
    assertEquals(
      upload.headers.get("authorization"),
      "token test-key:test-secret",
    );
    assertEquals(upload.headers.get("accept"), "application/json");
    assertEquals(upload.headers.has("content-type"), false);
    if (!(upload.body instanceof FormData)) {
      throw new Error("Expected FormData");
    }
    assertEquals(upload.body.get("doctype"), "CRM Deal");
    assertEquals(upload.body.get("docname"), "CRM-DEAL-0001");
    assertEquals(upload.body.get("fieldname"), "proposal");
    assertEquals(upload.body.get("is_private"), "1");

    const file = upload.body.get("file");
    if (!(file instanceof File)) throw new Error("Expected multipart File");
    assertEquals(file.name, "proposal.pdf");
    assertEquals(await file.text(), "PDF bytes");

    const fieldUpdate = requests[1];
    assertEquals(
      new URL(fieldUpdate.url).pathname,
      "/api/resource/CRM%20Deal/CRM-DEAL-0001",
    );
    assertEquals(fieldUpdate.method, "PUT");
    assertEquals(
      JSON.parse(fieldUpdate.body as string),
      { data: { proposal: "/private/files/proposal.pdf" } },
    );
    assertEquals(result.name, "a1b2c3");
    assertEquals(result.file_url, "/private/files/proposal.pdf");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.uploadFile() - sends explicit public privacy", async () => {
  let capturedBody: FormData | undefined;
  const original = globalThis.fetch;

  globalThis.fetch = async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body as FormData;
    return new Response(
      JSON.stringify({
        message: {
          name: "public-file",
          file_name: "brochure.pdf",
          file_url: "/files/brochure.pdf",
          is_private: 0,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.uploadFile({
      fileName: "brochure.pdf",
      contentBase64: btoa("public"),
      attachedToDoctype: "Lead",
      attachedToName: "LEAD-0001",
      isPrivate: false,
    });

    assertEquals(capturedBody?.get("is_private"), "0");
    assertEquals(capturedBody?.has("fieldname"), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.uploadFile() - rejects malformed or empty base64", async () => {
  const client = makeClient();
  const input = {
    fileName: "proposal.pdf",
    attachedToDoctype: "CRM Deal",
    attachedToName: "CRM-DEAL-0001",
  };

  await assertRejects(
    () => client.uploadFile({ ...input, contentBase64: "not-base64!" }),
    Error,
    "valid base64",
  );
  await assertRejects(
    () => client.uploadFile({ ...input, contentBase64: "" }),
    Error,
    "must not be empty",
  );
});

Deno.test("FrappeClient.uploadFile() - rejects decoded content over configured limit", async () => {
  const client = makeClient({ maxUploadBytes: 2 });

  await assertRejects(
    () =>
      client.uploadFile({
        fileName: "proposal.pdf",
        contentBase64: btoa("abc"),
        attachedToDoctype: "CRM Deal",
        attachedToName: "CRM-DEAL-0001",
      }),
    Error,
    "exceeds",
  );
});

Deno.test("FrappeClient - rejects a non-positive upload limit", () => {
  assertThrows(
    () => makeClient({ maxUploadBytes: 0 }),
    Error,
    "maxUploadBytes",
  );
});

Deno.test("FrappeClient.uploadFile() - preserves Frappe permission errors", async () => {
  const restore = mockFetch([
    {
      status: 403,
      body: { message: "Not permitted", exc_type: "PermissionError" },
    },
  ]);

  try {
    const client = makeClient();
    await assertRejects(
      () =>
        client.uploadFile({
          fileName: "proposal.pdf",
          contentBase64: btoa("PDF bytes"),
          attachedToDoctype: "CRM Deal",
          attachedToName: "CRM-DEAL-0001",
        }),
      FrappeAPIError,
      "HTTP 403",
    );
  } finally {
    restore();
  }
});

Deno.test("FrappeClient.uploadFile() - invalidates File and target caches", async () => {
  const restore = mockFetch([
    { status: 200, body: { data: [{ name: "FILE-OLD" }] } },
    { status: 200, body: { data: { name: "TASK-001", subject: "Before" } } },
    {
      status: 200,
      body: {
        message: {
          name: "FILE-NEW",
          file_name: "report.pdf",
          file_url: "/private/files/report.pdf",
          is_private: 1,
        },
      },
    },
    { status: 200, body: { data: [{ name: "FILE-NEW" }] } },
    { status: 200, body: { data: { name: "TASK-001", subject: "After" } } },
  ]);

  try {
    const client = makeClient({ cache: new MemoryCache() });
    await client.list("File");
    await client.get("Task", "TASK-001");
    await client.uploadFile({
      fileName: "report.pdf",
      contentBase64: btoa("report"),
      attachedToDoctype: "Task",
      attachedToName: "TASK-001",
    });

    const files = await client.list("File");
    const task = await client.get("Task", "TASK-001");
    assertEquals(files[0].name, "FILE-NEW");
    assertEquals(task.subject, "After");
    assertEquals(callCountRef.current, 5);
  } finally {
    restore();
  }
});

Deno.test("getFrappeClient() - treats a blank upload limit as unset", () => {
  withEnv("ERPNEXT_URL", "http://localhost:8000", () => {
    withEnv("ERPNEXT_API_KEY", "test-key", () => {
      withEnv("ERPNEXT_API_SECRET", "test-secret", () => {
        withEnv("ERPNEXT_MAX_UPLOAD_BYTES", "  ", () => {
          setFrappeClient(null);
          try {
            assertEquals(getFrappeClient() instanceof FrappeClient, true);
          } finally {
            setFrappeClient(null);
          }
        });
      });
    });
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

Deno.test("FrappeClient - throws FrappeAPIError on HTTP 404", async () => {
  const restore = mockFetch([
    {
      status: 404,
      body: { message: "Document not found" },
    },
  ]);

  try {
    const client = makeClient();
    await assertRejects(
      () => client.get("Customer", "NONEXISTENT"),
      FrappeAPIError,
      "HTTP 404",
    );
  } finally {
    restore();
  }
});

Deno.test("FrappeClient - throws FrappeAPIError on HTTP 403", async () => {
  const restore = mockFetch([
    {
      status: 403,
      body: { message: "Permission denied", exc_type: "PermissionError" },
    },
  ]);

  try {
    const client = makeClient();
    await assertRejects(
      () => client.list("Payroll Entry"),
      FrappeAPIError,
      "HTTP 403",
    );
  } finally {
    restore();
  }
});

Deno.test("FrappeClient - throws FrappeAPIError on HTTP 500 (POST not retried)", async () => {
  const restore = mockFetch([
    {
      status: 500,
      body: { message: "Internal Server Error" },
    },
  ]);

  try {
    const client = makeClient();
    await assertRejects(
      () => client.callMethod("frappe.client.get_list"),
      FrappeAPIError,
      "HTTP 500",
    );
    // POST is not in the retry method list by default — single call expected.
    assertEquals(callCountRef.current, 1);
  } finally {
    restore();
  }
});

// ── Retry / backoff ───────────────────────────────────────────────────────────

function mockPendingResponse(beforeHeaders = false) {
  const original = globalThis.fetch;
  const started = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const cleanups: Array<() => void> = [];
  let disposed = false;
  globalThis.fetch = (_url, init) => {
    if (disposed) return Promise.reject(new Error("Fixture cleanup"));
    const signal = init?.signal;
    if (!signal) throw new Error("Missing request signal");
    signals.push(signal);
    if (beforeHeaders) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        cleanups.push(() => {
          signal.removeEventListener("abort", abort);
          reject(new Error("Fixture cleanup"));
        });
        started.resolve();
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => controller.error(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        cleanups.push(() => {
          signal.removeEventListener("abort", abort);
          controller.error(new Error("Fixture cleanup"));
        });
        started.resolve();
      },
    });
    return Promise.resolve(new Response(stream));
  };
  return {
    started: started.promise,
    signals,
    async restore(pending: Promise<unknown>) {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      try {
        await pending;
      } finally {
        globalThis.fetch = original;
      }
    },
  };
}

const timeoutOperations = [
  {
    name: "GET",
    run: (client: FrappeClient) => client.get("Customer", "CUST-001"),
  },
  {
    name: "POST",
    run: (client: FrappeClient) => client.create("Customer", {}),
  },
  {
    name: "PUT",
    run: (client: FrappeClient) => client.update("Customer", "CUST-001", {}),
  },
  {
    name: "multipart",
    run: (client: FrappeClient) =>
      client.uploadFile({
        attachedToDoctype: "Customer",
        attachedToName: "CUST-001",
        fileName: "test.txt",
        contentBase64: "dGVzdA==",
      }),
  },
];

for (
  const scenario of [
    {
      status: 200,
      contentType: "application/json",
      body: '{"data":{"name":"CUST-001"}}',
    },
    {
      status: 403,
      contentType: "application/json",
      body: '{"message":"Permission denied"}',
    },
    {
      status: 503,
      contentType: "application/json",
      body: '{"message":"Unavailable"}',
    },
    { status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" },
    {
      status: 500,
      contentType: "application/json",
      body: "<html>Invalid JSON</html>",
    },
  ]
) {
  Deno.test(`FrappeClient body - preserves status ${scenario.status} and ${scenario.contentType}`, async () => {
    const original = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (_url, init) => {
      signal = init?.signal;
      return Promise.resolve(
        new Response(scenario.body, {
          status: scenario.status,
          headers: { "content-type": scenario.contentType, "retry-after": "7" },
        }),
      );
    };
    try {
      const client = makeClient({ retries: 0, timeoutMs: 20 });
      if (scenario.status === 200) {
        assertEquals(await client.get("Customer", "CUST-001"), {
          name: "CUST-001",
        });
      } else {
        const error = await assertRejects(
          () => client.get("Customer", "CUST-001"),
          FrappeAPIError,
        );
        assertEquals(error.status, scenario.status);
        assertEquals(error.retryAfterMs, 7000);
        assertEquals(
          error.body,
          scenario.body.startsWith("{")
            ? JSON.parse(scenario.body)
            : scenario.body,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      assertEquals(signal?.aborted, false);
    } finally {
      globalThis.fetch = original;
    }
  });
}

for (const beforeHeaders of [true, false]) {
  for (const retries of [0, 1]) {
    for (const operation of timeoutOperations) {
      Deno.test(`FrappeClient timeout - ${operation.name} ${beforeHeaders ? "headers" : "body"} retries=${retries}`, async () => {
        const fixture = mockPendingResponse(beforeHeaders);
        const client = makeClient({
          timeoutMs: 20,
          retries,
          retryBackoffMs: 0,
        });
        const pending = operation.run(client).then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          await fixture.started;
          const outcome = await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              watchdog = setTimeout(
                () =>
                  reject(
                    new Error("Request did not time out before body release"),
                  ),
                1000,
              );
            }),
          ]);
          assertEquals(outcome.error instanceof FrappeAPIError, true);
          assertEquals((outcome.error as FrappeAPIError).status, 408);
          assertEquals(
            fixture.signals.length,
            operation.name === "GET" ? retries + 1 : 1,
          );
          assertEquals(fixture.signals.every((signal) => signal.aborted), true);
        } finally {
          clearTimeout(watchdog);
          await fixture.restore(pending);
        }
      });
    }
  }
}

for (const operation of timeoutOperations) {
  Deno.test(`FrappeClient stream error - ${operation.name} preserves retry policy`, async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls++;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(
                () => controller.error(new TypeError("Body connection closed")),
                0,
              );
            },
          }),
        ),
      );
    };
    try {
      const client = makeClient({ retries: 1, retryBackoffMs: 0 });
      const error = await assertRejects(
        () => operation.run(client),
        FrappeAPIError,
        "Body connection closed",
      );
      assertEquals(error.status, 0);
      assertEquals(calls, operation.name === "GET" ? 2 : 1);
    } finally {
      globalThis.fetch = original;
    }
  });
}

Deno.test("FrappeClient retry - GET 503 succeeds on second attempt", async () => {
  const restore = mockFetch([
    { status: 503, body: { message: "Service Unavailable" } },
    {
      status: 200,
      body: { data: [{ name: "CUST-001", customer_name: "Acme" }] },
    },
  ]);

  try {
    const client = makeClient();
    const result = await client.list("Customer");
    assertEquals(result.length, 1);
    assertEquals(result[0].name, "CUST-001");
    assertEquals(callCountRef.current, 2);
  } finally {
    restore();
  }
});

Deno.test("FrappeClient retry - GET retries up to configured max then throws", async () => {
  const restore = mockFetch([
    { status: 503, body: { message: "Service Unavailable" } },
    { status: 503, body: { message: "Service Unavailable" } },
    { status: 503, body: { message: "Service Unavailable" } },
    { status: 503, body: { message: "Service Unavailable" } },
  ]);

  try {
    const client = makeClient({ retries: 2 });
    await assertRejects(
      () => client.list("Customer"),
      FrappeAPIError,
      "HTTP 503",
    );
    // 1 initial attempt + 2 retries = 3 calls total
    assertEquals(callCountRef.current, 3);
  } finally {
    restore();
  }
});

Deno.test("FrappeClient retry - 404 is not retried", async () => {
  const restore = mockFetch([
    { status: 404, body: { message: "Document not found" } },
  ]);

  try {
    const client = makeClient();
    await assertRejects(
      () => client.get("Customer", "MISSING"),
      FrappeAPIError,
      "HTTP 404",
    );
    assertEquals(callCountRef.current, 1);
  } finally {
    restore();
  }
});

Deno.test("FrappeClient retry - retries disabled when retries=0", async () => {
  const restore = mockFetch([
    { status: 503, body: { message: "Service Unavailable" } },
  ]);

  try {
    const client = makeClient({ retries: 0 });
    await assertRejects(
      () => client.list("Customer"),
      FrappeAPIError,
      "HTTP 503",
    );
    assertEquals(callCountRef.current, 1);
  } finally {
    restore();
  }
});

Deno.test("FrappeClient retry - 429 surfaces Retry-After header on FrappeAPIError", async () => {
  const restore = mockFetch([
    {
      status: 429,
      body: { message: "Too Many Requests" },
      headers: { "retry-after": "0" },
    },
    {
      status: 200,
      body: { data: [] },
    },
  ]);

  try {
    const client = makeClient();
    const result = await client.list("Customer");
    assertEquals(result.length, 0);
    assertEquals(callCountRef.current, 2);
  } finally {
    restore();
  }
});

// ── Robust JSON parsing ──────────────────────────────────────────────────────

Deno.test("FrappeClient parsing - malformed JSON in error body falls back to text", async () => {
  const restore = mockFetch([
    {
      status: 500,
      // Server claims JSON but returns broken markup (HTML error page is common)
      contentType: "application/json",
      body: null,
      rawBody: "<html><body>500 Internal Server Error</body></html>",
    },
  ]);

  try {
    const client = makeClient({ retries: 0 });
    const error = await assertRejects(
      () => client.get("Customer", "ANY"),
      FrappeAPIError,
      "HTTP 500",
    );
    // Body must surface the raw text rather than crashing on JSON.parse
    assertEquals(typeof error.body, "string");
  } finally {
    restore();
  }
});

// ── Caching ──────────────────────────────────────────────────────────────────

Deno.test("FrappeClient.get() - caches result, second call skips fetch", async () => {
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({ data: { name: "CUST-001" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.get("Customer", "CUST-001");
    await client.get("Customer", "CUST-001");
    assertEquals(fetchCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.get() - skipCache bypasses the cached read", async () => {
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({ data: { name: "CUST-001" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.get("Customer", "CUST-001");
    await client.get("Customer", "CUST-001", { skipCache: true });
    assertEquals(fetchCount, 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.list() - caches result for identical options", async () => {
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({ data: [{ name: "CUST-001" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.list("Customer", { limit: 10 });
    await client.list("Customer", { limit: 10 });
    assertEquals(fetchCount, 1);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.list() - skipCache bypasses the cached read", async () => {
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({ data: [{ name: "CUST-001" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.list("Customer", { limit: 10 });
    await client.list("Customer", { limit: 10 }, { skipCache: true });
    assertEquals(fetchCount, 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.create() - invalidates the list cache for that doctype", async () => {
  let fetchCount = 0;
  let created = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init?: RequestInit) => {
    fetchCount++;
    if (init?.method === "POST") {
      created = true;
      return new Response(
        JSON.stringify({ data: { name: "CUST-002" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        data: created ? [{ name: "CUST-001" }, { name: "CUST-002" }] : [{
          name: "CUST-001",
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    const before = await client.list("Customer", { limit: 10 });
    assertEquals(before.length, 1);

    await client.create("Customer", { customer_name: "New Corp" });

    const after = await client.list("Customer", { limit: 10 });
    assertEquals(after.length, 2);
    assertEquals(fetchCount, 3); // initial list, create, refreshed list
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.delete() - invalidates both the list cache and the cached get() for that name", async () => {
  let fetchCount = 0;
  let deleted = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init?: RequestInit) => {
    fetchCount++;
    if (init?.method === "DELETE") {
      deleted = true;
      return new Response("", { status: 202 });
    }
    if (deleted) {
      return new Response(
        JSON.stringify({ message: "Document not found" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ data: { name: "CUST-001" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.get("Customer", "CUST-001");
    await client.delete("Customer", "CUST-001");

    await assertRejects(
      () => client.get("Customer", "CUST-001"),
      FrappeAPIError,
      "HTTP 404",
    );
    assertEquals(fetchCount, 3); // initial get, delete, refreshed (now-404) get
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.update() - invalidates the cached get() for that name", async () => {
  let fetchCount = 0;
  let updated = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init?: RequestInit) => {
    fetchCount++;
    if (init?.method === "PUT") {
      updated = true;
      return new Response(
        JSON.stringify({
          data: { name: "CUST-001", customer_name: "Updated" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        data: {
          name: "CUST-001",
          customer_name: updated ? "Updated" : "Original",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    const before = await client.get("Customer", "CUST-001");
    assertEquals(before.customer_name, "Original");

    await client.update("Customer", "CUST-001", { customer_name: "Updated" });

    const after = await client.get("Customer", "CUST-001");
    assertEquals(after.customer_name, "Updated");
    assertEquals(fetchCount, 3); // initial get, update, refreshed get
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.invalidate() - clears list cache for a doctype", async () => {
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({ data: [{ name: "CUST-001" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = makeClient();
    await client.list("Customer", { limit: 10 });
    client.invalidate("Customer");
    await client.list("Customer", { limit: 10 });
    assertEquals(fetchCount, 2);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("FrappeClient.invalidate() - clears resolveLink's negative-match cache for a doctype", () => {
  const cache = new MemoryCache();
  const client = makeClient({ cache });
  cache.set("resolve:miss:Customer:Acme", true, 15_000);

  client.invalidate("Customer");

  assertEquals(cache.get("resolve:miss:Customer:Acme"), undefined);
});
