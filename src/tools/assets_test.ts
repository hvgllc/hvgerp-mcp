/**
 * Asset Tools Tests
 *
 * @module lib/erpnext/tests/tools/assets_test
 */

import { assertEquals, assertRejects } from "@std/assert";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
import { clearCallerProfileCache } from "../api/identity.ts";
import { assetsTools } from "./assets.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...args: any[]) => any;

const CALLER = "khoa.do@havigroup.com";

const USER_DOC = {
  name: CALLER,
  email: CALLER,
  full_name: "Do Khoa",
  user_type: "System User",
  enabled: 1,
  roles: [{ role: "Employee" }],
};

const EMPLOYEE_ROW = {
  name: "HR-EMP-00044",
  employee_name: "Do Khoa",
  designation: "Ky su",
  department: "Cong nghe - HVG",
  company: "Havi Group",
  reports_to: null,
  status: "Active",
  date_of_joining: "2024-01-15",
};

const NEW_ASSET = {
  asset_name: "Macbook Pro 16",
  asset_category: "Computers",
  company: "Havi Group",
  purchase_date: "2026-08-17",
  gross_purchase_amount: 65_000_000,
};

function tool(name: string): ErpNextTool {
  const found = assetsTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

function makeCtx(overrides: Record<string, AnyFn> = {}): ErpNextToolContext {
  const client = {
    callMethod: async () => CALLER,
    get: async () => USER_DOC,
    list: async (doctype: string) =>
      doctype === "Employee" ? [EMPLOYEE_ROW] : [],
    create: async (_doctype: string, data: Record<string, unknown>) => ({
      name: "ACC-ASS-2026-00001",
      ...data,
    }),
    update: async () => ({}),
    delete: async () => {},
    invalidate: () => {},
    ...overrides,
  } as unknown as FrappeClient;
  return { client };
}

Deno.test("erpnext_asset_list asks for the v16 amount columns", async () => {
  let capturedFields: string[] = [];
  const ctx = makeCtx({
    list: async (_doctype: string, options: { fields?: string[] }) => {
      capturedFields = options?.fields ?? [];
      return [];
    },
  });

  await tool("erpnext_asset_list").handler({}, ctx);

  // `gross_purchase_amount` và `current_value` là tên của v15. Trên v16 chúng không còn là cột
  // của Asset, nên hỏi chúng làm cả truy vấn chết với SQL 1054 chứ không bị bỏ qua im lặng.
  assertEquals(capturedFields.includes("purchase_amount"), true);
  assertEquals(capturedFields.includes("value_after_depreciation"), true);
  assertEquals(capturedFields.includes("gross_purchase_amount"), false);
  assertEquals(capturedFields.includes("current_value"), false);
});

Deno.test("erpnext_asset_maintenance_list filters status through the task child table", async () => {
  let capturedFilters: unknown[][] = [];
  let capturedFields: string[] = [];
  const ctx = makeCtx({
    list: async (
      _doctype: string,
      options: { filters?: unknown[][]; fields?: string[] },
    ) => {
      capturedFilters = options?.filters ?? [];
      capturedFields = options?.fields ?? [];
      return [];
    },
  });

  await tool("erpnext_asset_maintenance_list").handler(
    { maintenance_status: "Planned" },
    ctx,
  );

  // `maintenance_status` nằm trên từng dòng Asset Maintenance Task chứ không trên bản ghi cha,
  // nên chỉ bộ lọc bốn phần tử của Frappe mới chạm tới được.
  assertEquals(capturedFilters, [[
    "Asset Maintenance Task",
    "maintenance_status",
    "=",
    "Planned",
  ]]);
  assertEquals(capturedFields.includes("maintenance_status"), false);
});

Deno.test("erpnext_asset_create resolves `me` in custodian before creating", async () => {
  clearCallerProfileCache();
  let created: Record<string, unknown> | null = null;
  const ctx = makeCtx({
    create: async (_doctype: string, data: Record<string, unknown>) => {
      created = data;
      return { name: "ACC-ASS-2026-00001", ...data };
    },
  });

  await tool("erpnext_asset_create").handler(
    { ...NEW_ASSET, custodian: "me" },
    ctx,
  );

  // Trước bản vá, chuỗi `me` xuống thẳng Frappe làm giá trị của một ô Link và chết ở kiểm tra
  // liên kết - trong khi chỉ dẫn máy chủ hứa với mô hình rằng `me` dùng được ở MỌI ô nhận người.
  assertEquals(
    (created as unknown as Record<string, unknown>).custodian,
    "HR-EMP-00044",
  );
});

Deno.test("erpnext_asset_create refuses a fuzzy custodian match", async () => {
  clearCallerProfileCache();
  const ctx = makeCtx({
    get: async () => {
      throw new FrappeAPIError("Not found", 404, {});
    },
    list: async (doctype: string, options: Record<string, unknown>) => {
      if (doctype !== "Employee") return [];
      // Không hàng nào khớp CHÍNH XÁC; chỉ rung khớp mờ mới có ứng viên.
      const filters = JSON.stringify(options.filters);
      return filters.includes('"like"') ? [EMPLOYEE_ROW] : [];
    },
  });

  // Đường ghi truyền `allowPartialMatch: false`, nên một khớp mờ phải hỏng ra mặt thay vì gắn
  // nhầm người vào một tài sản thật.
  await assertRejects(
    () =>
      tool("erpnext_asset_create").handler(
        { ...NEW_ASSET, custodian: "Kho" },
        ctx,
      ),
    Error,
    "No Employee found",
  );
});

Deno.test("erpnext_asset_create leaves custodian unset when it is not given", async () => {
  clearCallerProfileCache();
  let created: Record<string, unknown> | null = null;
  const ctx = makeCtx({
    create: async (_doctype: string, data: Record<string, unknown>) => {
      created = data;
      return { name: "ACC-ASS-2026-00001", ...data };
    },
  });

  await tool("erpnext_asset_create").handler({ ...NEW_ASSET }, ctx);

  assertEquals(
    (created as unknown as Record<string, unknown>).custodian,
    undefined,
  );
});
