/**
 * CRM Tools Tests
 *
 * @module lib/erpnext/tests/tools/crm_test
 */

import { assertEquals, assertRejects } from "@std/assert";
import { crmTools } from "./crm.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "NEW-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => null,
    invalidate: () => {},
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = crmTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

Deno.test("erpnext_campaign_list - filters by date range", async () => {
  let capturedFilters: unknown[][] = [];
  const client = makeMockClient({
    list: async (_doctype: string, opts: { filters?: unknown[][] }) => {
      capturedFilters = opts?.filters ?? [];
      return [];
    },
  });

  const tool = getTool("erpnext_campaign_list");
  await tool.handler(
    { date_from: "2026-01-01", date_to: "2026-01-31" },
    makeCtx(client),
  );

  const hasStart = capturedFilters.some((f) =>
    f[0] === "start_date" && f[1] === ">=" && f[2] === "2026-01-01"
  );
  const hasEnd = capturedFilters.some((f) =>
    f[0] === "end_date" && f[1] === "<=" && f[2] === "2026-01-31"
  );
  assertEquals(hasStart, true);
  assertEquals(hasEnd, true);
});

Deno.test("erpnext_opportunity_list - throws if party_name set without opportunity_from", async () => {
  const tool = getTool("erpnext_opportunity_list");
  await assertRejects(
    () => tool.handler({ party_name: "Acme Corp" }, makeCtx(makeMockClient())),
    Error,
    "opportunity_from",
  );
});

Deno.test("erpnext_opportunity_list - resolves party_name against the opportunity_from doctype", async () => {
  let resolvedDoctype = "";
  const client = makeMockClient({
    get: async () => {
      throw new FrappeAPIError("not found", 404, null);
    },
    list: async (doctype: string) => {
      if (doctype === "Opportunity") return [];
      resolvedDoctype = doctype;
      return [{ name: "LEAD-099" }];
    },
  });

  const tool = getTool("erpnext_opportunity_list");
  await tool.handler(
    { party_name: "Jane Prospect", opportunity_from: "Lead" },
    makeCtx(client),
  );

  assertEquals(resolvedDoctype, "Lead");
});
Deno.test("erpnext_lead_list - resolves `me` into the caller's User id before filtering", async () => {
  let capturedFilters: unknown[][] = [];
  const client = makeMockClient({
    callMethod: async (method: string) => {
      assertEquals(method, "frappe.auth.get_logged_user");
      return "khoa.do@havigroup.com";
    },
    list: async (_doctype: string, opts: { filters?: unknown[][] }) => {
      capturedFilters = opts?.filters ?? [];
      return [];
    },
  });

  await getTool("erpnext_lead_list").handler(
    { lead_owner: "me" },
    makeCtx(client),
  );

  // Chỉ dẫn của máy chủ bảo mô hình viết "me" cho mọi yêu cầu ngôi thứ nhất. Gửi thẳng chuỗi đó
  // xuống Frappe thì bộ lọc khớp một `User` không tồn tại và tool trả danh sách rỗng - một câu trả
  // lời SAI trông y hệt câu trả lời đúng, vì "bạn không có lead nào" cũng là danh sách rỗng.
  assertEquals(capturedFilters.filter((f) => f[0] === "lead_owner"), [[
    "lead_owner",
    "=",
    "khoa.do@havigroup.com",
  ]]);
});

Deno.test("erpnext_lead_list - a concrete owner is not looked up at all", async () => {
  let identityCalls = 0;
  let capturedFilters: unknown[][] = [];
  const client = makeMockClient({
    callMethod: async () => {
      identityCalls++;
      return "khoa.do@havigroup.com";
    },
    list: async (_doctype: string, opts: { filters?: unknown[][] }) => {
      capturedFilters = opts?.filters ?? [];
      return [];
    },
  });

  await getTool("erpnext_lead_list").handler(
    { lead_owner: "alice@example.com" },
    makeCtx(client),
  );

  // Đối chứng: chỉ dạng tự tham chiếu mới được dịch. Mọi giá trị khác đi thẳng xuống Frappe như cũ,
  // và không tốn lượt hỏi danh tính nào.
  assertEquals(identityCalls, 0);
  assertEquals(capturedFilters.filter((f) => f[0] === "lead_owner"), [[
    "lead_owner",
    "=",
    "alice@example.com",
  ]]);
});

Deno.test("erpnext_lead_create - resolves `me` into the caller's User id", async () => {
  let capturedDoc: Record<string, unknown> = {};
  const client = makeMockClient({
    callMethod: async () => "khoa.do@havigroup.com",
    create: async (_doctype: string, data: Record<string, unknown>) => {
      capturedDoc = data;
      return { name: "CRM-LEAD-2026-00001" };
    },
  });

  await getTool("erpnext_lead_create").handler(
    { lead_name: "Acme Corp", lead_owner: "me" },
    makeCtx(client),
  );

  // Trên đường GHI thì hậu quả nặng hơn đường đọc: `lead_owner` là một Link tới `User`, nên ghi
  // nguyên chuỗi "me" vào đó tạo ra một bản ghi trỏ tới người không tồn tại.
  assertEquals(capturedDoc.lead_owner, "khoa.do@havigroup.com");
});

Deno.test("erpnext_opportunity_list - resolves `me` into the caller's User id before filtering", async () => {
  let capturedFilters: unknown[][] = [];
  const client = makeMockClient({
    callMethod: async () => "khoa.do@havigroup.com",
    list: async (_doctype: string, opts: { filters?: unknown[][] }) => {
      capturedFilters = opts?.filters ?? [];
      return [];
    },
  });

  await getTool("erpnext_opportunity_list").handler(
    { opportunity_owner: "me" },
    makeCtx(client),
  );

  assertEquals(capturedFilters.filter((f) => f[0] === "opportunity_owner"), [[
    "opportunity_owner",
    "=",
    "khoa.do@havigroup.com",
  ]]);
});
