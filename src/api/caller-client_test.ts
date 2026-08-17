/**
 * Per-caller client selection, cache backend, and cross-caller invalidation.
 *
 * Every test here goes red on the code as it stood before the fixes, which is the point: the three
 * defects they cover were all invisible to the existing suite because they only appear when a
 * service-account call and an identity-carrying call meet in the SAME process (`optional` mode).
 *
 * @module lib/erpnext/src/api/caller-client_test
 */

import { assert, assertEquals } from "@std/assert";
import { getFrappeClient, setFrappeClient } from "./frappe-client.ts";
import { runWithCaller } from "./caller-context.ts";
import { resolveLink } from "./resolve.ts";
import { createCache, getCache, setCache } from "../cache/cache.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

interface Recorded {
  url: string;
  authorization: string | null;
}

/** Replace `fetch` with a recorder answering every request with `body`. */
function recordFetch(body: (call: number) => unknown): {
  calls: Recorded[];
  restore: () => void;
} {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get("authorization"),
    });
    return Promise.resolve(
      new Response(JSON.stringify(body(calls.length - 1)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Run `fn` with `vars` applied to the process env, restoring the previous values afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  // Drop any client left over from an earlier test, so the singletons under test start empty.
  setFrappeClient(null);
  try {
    await fn();
  } finally {
    setFrappeClient(null);
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const STATIC_ENV = {
  ERPNEXT_URL: "http://localhost:8000",
  ERPNEXT_API_KEY: "static-key",
  ERPNEXT_API_SECRET: "static-secret",
};

const listBody = () => ({ data: [{ name: "TASK-001", subject: "First" }] });

// ── Client selection ──────────────────────────────────────────────────────────

Deno.test("getFrappeClient() - a caller in scope outranks the service-account singleton", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch(listBody);
    try {
      // An anonymous call first: this is what `MCP_CALLER_IDENTITY=optional` allows, and what a
      // startup cache warm does. It builds the process-wide service-account client.
      await getFrappeClient().list("Task");
      assertEquals(calls[0].authorization, "token static-key:static-secret");

      // Now a call that DOES carry an identity. It must be served as that user.
      await runWithCaller(
        { accessToken: "tok-anh", principal: "anh.le@havigroup.com" },
        () => getFrappeClient().list("Project"),
      );

      assertEquals(
        calls[1].authorization,
        "HVGKeycloak tok-anh",
        "the forwarded identity must win over the service account; when the two roles shared one " +
          "variable, every OAuth call after the first anonymous one ran under the shared API key",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("getFrappeClient() - an injected client still outranks a caller", async () => {
  await withEnv(STATIC_ENV, async () => {
    const injected = getFrappeClient();
    setFrappeClient(injected);
    try {
      const seen = runWithCaller(
        { accessToken: "tok-khoa", principal: "khoa.do@havigroup.com" },
        () => getFrappeClient(),
      );
      assert(
        seen === injected,
        "dependency injection is the outermost override; a test that installs a client must not " +
          "have it bypassed by whatever identity happens to be in scope",
      );
    } finally {
      setFrappeClient(null);
    }
  });
});

// ── Cache backend ─────────────────────────────────────────────────────────────

Deno.test("caller client - honours MCP_CACHE_ENABLED=false", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: "false" }, async () => {
    const { calls, restore } = recordFetch(listBody);
    try {
      const caller = {
        accessToken: "tok-chi",
        principal: "chi.mai@havigroup.com",
      };
      await runWithCaller(caller, () => getFrappeClient().list("Task"));
      await runWithCaller(caller, () => getFrappeClient().list("Task"));

      assertEquals(
        calls.length,
        2,
        "caching is off, so the second identical read must reach the network; hard-coding a " +
          "MemoryCache for caller clients made the operator's switch apply to only some caches",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("caller client - caches reads when caching is left enabled (control)", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch(listBody);
    try {
      const caller = {
        accessToken: "tok-chi",
        principal: "chi.mai@havigroup.com",
      };
      await runWithCaller(caller, () => getFrappeClient().list("Task"));
      await runWithCaller(caller, () => getFrappeClient().list("Task"));

      assertEquals(
        calls.length,
        1,
        "with caching on, the second read is served from the caller's own cache",
      );
    } finally {
      restore();
    }
  });
});

// ── Cross-caller invalidation ─────────────────────────────────────────────────

Deno.test("caller clients - a write by one caller invalidates the others' cached reads", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch((call) =>
      call === 2
        ? { data: { name: "TASK-002", subject: "Written" } }
        : listBody()
    );
    try {
      const anh = { accessToken: "tok-anh", principal: "anh.le@havigroup.com" };
      const khoa = {
        accessToken: "tok-khoa",
        principal: "khoa.do@havigroup.com",
      };

      await runWithCaller(anh, () => getFrappeClient().list("Task")); // call 0
      await runWithCaller(khoa, () => getFrappeClient().list("Task")); // call 1
      assertEquals(
        calls.length,
        2,
        "each caller reads through their own cache",
      );

      await runWithCaller(
        anh,
        () => getFrappeClient().create("Task", { subject: "Written" }),
      ); // call 2
      assertEquals(calls.length, 3);

      await runWithCaller(khoa, () => getFrappeClient().list("Task"));

      assertEquals(
        calls.length,
        4,
        "the other caller must re-read after the write; per-caller caches isolate VALUES, but a " +
          "mutation still has to clear the matching keys everywhere, which the single shared " +
          "cache used to do for free",
      );
    } finally {
      restore();
    }
  });
});

Deno.test("caller clients - invalidation crosses caches without sharing values (control)", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const { calls, restore } = recordFetch(() => ({
      data: [{ name: "TASK-001", subject: `read-${Math.random()}` }],
    }));
    try {
      const anh = { accessToken: "tok-anh", principal: "anh.le@havigroup.com" };
      const khoa = {
        accessToken: "tok-khoa",
        principal: "khoa.do@havigroup.com",
      };

      const first = await runWithCaller(
        anh,
        () => getFrappeClient().list("Task"),
      );
      const second = await runWithCaller(
        khoa,
        () => getFrappeClient().list("Task"),
      );

      assertEquals(calls.length, 2);
      assert(
        first[0].subject !== second[0].subject,
        "the second caller must get their OWN read, not the first caller's cached rows - " +
          "invalidation is allowed to cross the boundary, values are not",
      );
    } finally {
      restore();
    }
  });
});

// ── The app-wide cache ────────────────────────────────────────────────────────

/**
 * Như `recordFetch`, nhưng câu trả lời được chọn theo chính request và mang mã HTTP riêng.
 * `resolveLink()` chỉ ghi mục phủ định khi `get()` trả về đúng 404, nên test dưới đây cần một 404
 * thật chứ không thể dùng bộ ghi 200-mọi-lượt ở trên.
 */
function recordFetchRouted(
  answer: (url: string, method: string) => { status: number; body: unknown },
): { calls: Recorded[]; restore: () => void } {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      authorization: headers.get("authorization"),
    });
    const { status, body } = answer(String(url), init?.method ?? "GET");
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("caller clients - a write clears resolveLink's negative entries too", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const previousCache = getCache();
    setCache(createCache());
    const { calls, restore } = recordFetchRouted((url, method) => {
      if (method === "POST") {
        return { status: 200, body: { data: { name: "TASK-502" } } };
      }
      // Một lượt đọc đơn tài liệu: định danh này không phải ID nên máy chủ trả 404.
      if (url.includes("/api/resource/Task/")) {
        return { status: 404, body: { exc_type: "DoesNotExistError" } };
      }
      return {
        status: 200,
        body: { data: [{ name: "TASK-501", subject: "Nightly backup" }] },
      };
    });
    try {
      const anh = { accessToken: "tok-anh", principal: "anh.le@havigroup.com" };

      // Lượt dò đầu tiên: get() trả 404 nên resolveLink ghi
      // `resolve:miss:Task:Nightly backup` vào cache CẤP ỨNG DỤNG, rồi mới tìm theo subject.
      const first = await runWithCaller(
        anh,
        () =>
          resolveLink(getFrappeClient(), "Task", "Nightly backup", "subject"),
      );
      assertEquals(first, "TASK-501");
      assertEquals(
        calls.length,
        2,
        "một lượt get 404 rồi một lượt tìm theo subject",
      );

      await runWithCaller(
        anh,
        () => getFrappeClient().create("Task", { subject: "Nightly backup" }),
      );
      assertEquals(calls.length, 3);

      await runWithCaller(
        anh,
        () =>
          resolveLink(getFrappeClient(), "Task", "Nightly backup", "subject"),
      );

      assert(
        calls[3]?.url.includes("/api/resource/Task/"),
        "sau khi ghi, resolveLink phải dò lại get() một lần nữa; mục phủ định nằm trong cache cấp " +
          "ứng dụng mà ở chế độ caller-identity không client nào ghi danh, nên nếu không đưa " +
          "getCache() vào managedCaches() thì một bản ghi vừa tạo vẫn bị báo không khớp gì cả " +
          `suốt 15 giây (lượt gọi thật: ${calls[3]?.url})`,
      );
    } finally {
      restore();
      setCache(previousCache);
    }
  });
});

Deno.test("caller clients - the negative entry survives when nothing is written (control)", async () => {
  await withEnv({ ...STATIC_ENV, MCP_CACHE_ENABLED: undefined }, async () => {
    const previousCache = getCache();
    setCache(createCache());
    const { calls, restore } = recordFetchRouted((url) =>
      url.includes("/api/resource/Task/")
        ? { status: 404, body: { exc_type: "DoesNotExistError" } }
        : {
          status: 200,
          body: { data: [{ name: "TASK-501", subject: "Nightly backup" }] },
        }
    );
    try {
      const anh = { accessToken: "tok-anh", principal: "anh.le@havigroup.com" };
      const probe = () =>
        runWithCaller(
          anh,
          () =>
            resolveLink(getFrappeClient(), "Task", "Nightly backup", "subject"),
        );

      await probe();
      assertEquals(calls.length, 2);

      await probe();

      assertEquals(
        calls.length,
        2,
        "không có lệnh ghi nào thì mục phủ định vẫn còn hiệu lực và lượt dò thứ hai không chạm " +
          "mạng lần nào. Đây là đối chứng: nó xanh ở cả hai phía của bản vá, cho biết test trên đo " +
          "đúng việc vô hiệu hoá chứ không phải đo một cache chưa bao giờ được ghi",
      );
    } finally {
      restore();
      setCache(previousCache);
    }
  });
});
