/**
 * Performance tools tests
 *
 * Kiểm ba tool hiệu suất nhân sự: chặn service account trước mọi lượt gọi, luôn gửi đủ hai ngày
 * cho ERP, chỉ tìm người trong danh sách ERP cho phép, chỉ nhận số liệu Task/SKU đúng hợp đồng v2,
 * và không bao giờ trình bày phần chưa đo như thể đã đo. Client là mock nên không có lượt gọi
 * mạng nào; phản hồi v2 dựng từ payload mẫu dùng chung với ERP.
 *
 * @module lib/erpnext/tests/tools/performance_test
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  MAX_PERIOD_DAYS,
  performancePeriod,
  performanceTools,
  previousPeriod,
} from "./performance.ts";
import { allTools, toolsByCategory } from "./mod.ts";
import { siteToday } from "./site-date.ts";
import { FrappeAPIError } from "../api/frappe-client.ts";
import { AmbiguousLinkError } from "../api/resolve.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";
import {
  checkRowsResponse,
  checkSummaryResponse,
  firstEvaluableTo,
  periodDays,
} from "./person-performance-contract.ts";
import examples from "./contract/fixtures/person-performance.v2.examples.json" with {
  type: "json",
};

// ── Dữ liệu mẫu ──────────────────────────────────────────────────────────────

const REPORT = "hvg_sdc_sync.personal_report";
const EMPLOYEE_TOOL = "erpnext_employee_performance_get";
const TEAM_TOOL = "erpnext_team_performance_get";
const DETAIL_TOOL = "erpnext_employee_performance_detail_list";
const PERFORMANCE = "hvg_sdc_sync.person_performance";
const SUMMARY_METHOD = `${PERFORMANCE}.get_person_performance`;
const ROWS_METHOD = `${PERFORMANCE}.list_person_performance_rows`;
const VIEWER = "lead01@havigroup.llc";

const PEOPLE = [
  {
    user: VIEWER,
    full_name: "Trần Văn Lực",
    designation: "Trưởng nhóm thiết kế",
    department: "Design - HVG",
  },
  {
    user: "duc@havigroup.llc",
    full_name: "Đỗ Văn Đức",
    designation: "Chuyên viên thiết kế",
    department: "Design - HVG",
  },
  {
    user: "an1@havigroup.llc",
    full_name: "Nguyễn Văn An",
    designation: "Chuyên viên thiết kế",
    department: "Design - HVG",
  },
  {
    user: "an2@havigroup.llc",
    full_name: "Nguyễn Văn An",
    designation: "Nhân viên bán hàng",
    department: "Team Hòa",
  },
];

function reportContext(overrides: Record<string, unknown> = {}) {
  return {
    viewer: VIEWER,
    scope: "team",
    can_view_others: true,
    people: PEOPLE,
    sections: ["design"],
    ...overrides,
  };
}

function totals(
  points: number,
  design: number,
  fulfill: number,
  orders: number,
) {
  return {
    design_points: points,
    design_lines: design,
    fulfill_lines: fulfill,
    orders,
  };
}

/** Một dòng chi tiết đúng hình dạng `_record` của ERP. */
function detail(
  kind: "design" | "fulfill",
  at: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    user: "duc@havigroup.llc",
    sales_order: `SO-${at.slice(0, 10)}`,
    row_name: `row-${at}`,
    source_order_id: `SRC-${at.slice(0, 10)}`,
    teams: ["Team Etsy 1"],
    item_code: "HVG-TS-0412",
    item_name: "Áo thun in mẫu 0412",
    at,
    date: at.slice(0, 10),
    point: kind === "design" ? 3 : 0,
    seconds: kind === "design" ? 2400 : 0,
    vendor: kind === "fulfill" ? "Printify" : null,
    ...extra,
  };
}

/** Báo cáo cá nhân đúng hình dạng `get_personal_report`, cho người và kỳ được hỏi. */
function personalReport(
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    user: args.user,
    full_name: "Đỗ Văn Đức",
    from_date: args.from_date,
    to_date: args.to_date,
    sections: ["design"],
    summary: totals(146, 58, 0, 51),
    by_team: [{ team: "Team Etsy 1", ...totals(146, 58, 0, 51) }],
    by_day: [{ date: args.to_date, ...totals(9, 4, 0, 4) }],
    design: [
      detail("design", "2026-10-31 09:00:00"),
      detail("design", "2026-10-30 08:00:00"),
    ],
    fulfill: [detail("fulfill", "2026-10-31 16:02:11")],
    truncated: false,
    ...overrides,
  };
}

// deno-lint-ignore no-explicit-any
type Json = any;

/**
 * Phản hồi `get_person_performance` hợp lệ cho đúng câu hỏi đã gửi, dựng từ payload mẫu dùng chung.
 *
 * Payload mẫu nằm ở tháng 12/2026, tức tương lai so với ngày chạy test, nên đổi người, kỳ, kỳ so
 * sánh và phạm vi SKU theo lượt gọi, rồi chỉnh phần tăng trưởng cho đúng luật: không so thì
 * `not_requested`, kỳ so sánh bắt đầu trước `order_kpi_since` thì `insufficient_baseline`.
 */
function summaryFor(args: Record<string, unknown>): Json {
  const value: Json = structuredClone(examples.summary_full);
  value.user = args.user;
  value.from_date = args.from_date;
  value.to_date = args.to_date;
  value.compare = {
    from_date: args.compare_from_date ?? null,
    to_date: args.compare_to_date ?? null,
  };
  const sku = value.sections.sku;
  const since = sku.data_coverage.order_kpi_since;
  sku.scope = args.sku_scope;
  sku.growth.first_evaluable_to = firstEvaluableTo(
    since,
    periodDays(args.from_date as string, args.to_date as string),
  );
  if (value.compare.from_date === null) {
    sku.summary.previous_qty = null;
    sku.summary.previous_orders = null;
    for (const line of sku.summary.revenue) line.previous_amount = null;
    for (const row of sku.rows) {
      row.previous_qty = null;
      row.previous_orders = null;
      row.trend = null;
    }
    sku.growth = { ...sku.growth, status: "not_requested", trend: null };
  } else if (value.compare.from_date < since) {
    for (const row of sku.rows) row.trend = null;
    sku.growth = {
      ...sku.growth,
      status: "insufficient_baseline",
      trend: null,
    };
  }
  const requested = new Set(args.sections as string[]);
  for (const key of Object.keys(value.sections)) {
    if (!requested.has(key)) delete value.sections[key];
  }
  return value;
}

/** Một trang `list_person_performance_rows` hợp lệ cho đúng câu hỏi đã gửi. */
function rowsFor(args: Record<string, unknown>): Json {
  const value: Json = structuredClone(
    args.section === "sku" ? examples.rows_sku : examples.rows_tasks,
  );
  value.user = args.user;
  value.from_date = args.from_date;
  value.to_date = args.to_date;
  if (args.section === "sku" && args.compare_from_date == null) {
    for (const row of value.rows) {
      row.previous_qty = null;
      row.previous_orders = null;
      row.trend = null;
    }
  }
  return value;
}

// ── Mock FrappeClient ────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
  opts: { httpMethod?: "GET" | "POST" } | undefined;
}

interface ErpOptions {
  actsAs?: "caller" | "service";
  /**
   * `fallback`: người gọi không đọc được System Settings, nên múi giờ chỉ lấy được ở bậc dưới,
   * tức ngày hôm nay không chắc là ngày của site.
   */
  zone?: "authoritative" | "fallback";
  context?: unknown;
  personal?: (args: Record<string, unknown>) => unknown;
  team?: (args: Record<string, unknown>) => unknown;
  /** Trả lời `get_person_performance`; mặc định là `summaryFor`. Ném lỗi để giả lập ERP từ chối. */
  measured?: (args: Record<string, unknown>) => unknown;
  /** Trả lời `list_person_performance_rows`; mặc định là `rowsFor`. */
  rows?: (args: Record<string, unknown>) => unknown;
}

/**
 * Client giả định tuyến theo tên hàm.
 *
 * `siteToday` hỏi múi giờ trước mọi thứ khác, nên nó được trả lời ở đây; để nó rơi xuống
 * nhánh lỗi thì ngày mặc định tính theo UTC, và test ngày mặc định thành test phụ thuộc
 * múi giờ của máy chạy test.
 */
function erpClient(options: ErpOptions = {}): {
  ctx: ErpNextToolContext;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client = {
    actsAs: options.actsAs ?? "caller",
    list: async () => [],
    get: async () => ({}),
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    invalidate: () => {},
    callMethod: async (
      method: string,
      args: Record<string, unknown>,
      opts?: { httpMethod?: "GET" | "POST" },
    ) => {
      calls.push({ method, args, opts });
      if (method === "frappe.client.get_value") {
        if (options.zone === "fallback") {
          throw new FrappeAPIError("No permission for System Settings", 403, {
            exc_type: "PermissionError",
          });
        }
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      if (method === "frappe.client.get_time_zone") {
        return { time_zone: "Asia/Ho_Chi_Minh" };
      }
      if (method === `${REPORT}.get_report_context`) {
        return options.context ?? reportContext();
      }
      if (method === `${REPORT}.get_personal_report`) {
        return (options.personal ?? personalReport)(args);
      }
      if (method === `${REPORT}.get_team_report`) {
        if (!options.team) throw new Error("unexpected team report call");
        return options.team(args);
      }
      if (method === SUMMARY_METHOD) {
        return (options.measured ?? summaryFor)(args);
      }
      if (method === ROWS_METHOD) {
        return (options.rows ?? rowsFor)(args);
      }
      throw new Error(`unexpected call: ${method}`);
    },
  } as unknown as FrappeClient;
  return { ctx: { client }, calls };
}

function getTool(name: string) {
  const tool = performanceTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

/** Chỉ các lượt gọi vào báo cáo ERP, bỏ qua lượt hỏi múi giờ của `siteToday`. */
function reportCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) =>
    call.method.startsWith(REPORT) || call.method.startsWith(PERFORMANCE)
  );
}

function measuredCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method === SUMMARY_METHOD);
}

function personalCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) =>
    call.method === `${REPORT}.get_personal_report`
  );
}

async function runEmployee(
  input: Record<string, unknown>,
  options: ErpOptions = {},
): Promise<{ result: Json; calls: RecordedCall[] }> {
  const { ctx, calls } = erpClient(options);
  const result = await getTool(EMPLOYEE_TOOL).handler(input, ctx);
  return { result, calls };
}

const OCTOBER = { from_date: "2026-10-01", to_date: "2026-10-31" };

/** Kỳ 7 ngày có kỳ so sánh nằm trọn sau `order_kpi_since` (12/10/2026), nên tăng trưởng đo được. */
const LATE_OCTOBER = { from_date: "2026-10-26", to_date: "2026-11-01" };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function runDetail(
  input: Record<string, unknown>,
  options: ErpOptions = {},
): Promise<{ result: Json; calls: RecordedCall[] }> {
  const { ctx, calls } = erpClient(options);
  const result = await getTool(DETAIL_TOOL).handler(input, ctx);
  return { result, calls };
}

function permissionDenied(): FrappeAPIError {
  return new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: Bạn không có quyền xem hiệu suất của người này. (HTTP 403)",
    403,
    { exc_type: "PermissionError" },
  );
}

function methodMissing(): FrappeAPIError {
  return new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: ValidationError (HTTP 404)",
    404,
    {
      exc_type: "ValidationError",
      exception:
        "frappe.exceptions.ValidationError: Failed to get method for command hvg_sdc_sync.person_performance.get_person_performance",
    },
  );
}

/** Cộng ngày trên chuỗi `YYYY-MM-DD`, tính theo UTC để không lệch vì múi giờ máy chạy test. */
function shiftDate(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// ── Đăng ký ──────────────────────────────────────────────────────────────────

Deno.test("performance tools - registered read-only analytics tools", () => {
  assertEquals(
    performanceTools.map((tool) => tool.name),
    [EMPLOYEE_TOOL, DETAIL_TOOL, TEAM_TOOL],
  );
  for (const tool of performanceTools) {
    assertEquals(tool.category, "analytics", tool.name);
    assertEquals(tool.annotations?.readOnlyHint, true, tool.name);
    assert(/^erpnext_[a-z]+(_[a-z]+)*$/.test(tool.name), tool.name);
    assertEquals(tool.inputSchema.additionalProperties, false, tool.name);
    assert(allTools.includes(tool), `${tool.name} missing from allTools`);
    assert(
      toolsByCategory.analytics.includes(tool),
      `${tool.name} missing from the analytics category`,
    );
  }
  assertEquals(getTool(EMPLOYEE_TOOL).inputSchema.required, ["employee"]);
  assertEquals(getTool(DETAIL_TOOL).inputSchema.required, [
    "employee",
    "section",
  ]);
});

// ── Lớp chặn danh tính ───────────────────────────────────────────────────────

Deno.test("performance tools - a service client is refused before any call", async () => {
  for (const tool of performanceTools) {
    const { ctx, calls } = erpClient({ actsAs: "service" });
    // Mỗi tool nhận đúng đầu vào hợp lệ của nó: đầu vào sai bị từ chối ở bước kiểm khoá, và test
    // sẽ qua dù lớp chặn có bị gỡ.
    const input = tool.name === TEAM_TOOL
      ? {}
      : tool.name === DETAIL_TOOL
      ? { employee: "me", section: "tasks" }
      : { employee: "me" };
    const error = await assertRejects(() => tool.handler(input, ctx), Error);
    assertStringIncludes(error.message, `[${tool.name}]`);
    assertStringIncludes(error.message, "shared service account");
    assertEquals(calls.length, 0, tool.name);
  }
});

// ── Khoảng ngày ──────────────────────────────────────────────────────────────

Deno.test("performancePeriod - defaults to the 30 days ending yesterday", () => {
  assertEquals(performancePeriod({}, "2026-11-02", EMPLOYEE_TOOL), {
    from_date: "2026-10-03",
    to_date: "2026-11-01",
    days: 30,
  });
  // Qua ranh giới năm và tháng hai năm nhuận.
  assertEquals(performancePeriod({}, "2028-03-01", EMPLOYEE_TOOL), {
    from_date: "2028-01-31",
    to_date: "2028-02-29",
    days: 30,
  });
});

Deno.test("performancePeriod - fills the missing end of a half-open range", () => {
  // Chỉ có ngày kết thúc: 30 ngày tính lùi từ đó.
  assertEquals(
    performancePeriod({ to_date: "2026-10-31" }, "2026-11-02", EMPLOYEE_TOOL),
    { from_date: "2026-10-02", to_date: "2026-10-31", days: 30 },
  );
  // Chỉ có ngày bắt đầu: "từ ngày X" nghĩa là tới hôm nay.
  assertEquals(
    performancePeriod({ from_date: "2026-10-20" }, "2026-11-02", EMPLOYEE_TOOL),
    { from_date: "2026-10-20", to_date: "2026-11-02", days: 14 },
  );
});

Deno.test("performancePeriod - allows exactly 93 days and refuses 94", () => {
  assertEquals(
    performancePeriod(
      { from_date: "2026-08-01", to_date: "2026-11-01" },
      "2026-11-02",
      EMPLOYEE_TOOL,
    ).days,
    MAX_PERIOD_DAYS,
  );
  const error = assertThrows(() =>
    performancePeriod(
      { from_date: "2026-07-31", to_date: "2026-11-01" },
      "2026-11-02",
      EMPLOYEE_TOOL,
    )
  );
  assertStringIncludes((error as Error).message, "94 days");
  assertStringIncludes((error as Error).message, "93");
});

Deno.test("performancePeriod - refuses a reversed range instead of swapping it", () => {
  // ERP tự đảo hai ngày; MCP từ chối, vì kỳ ngược thường là mô hình đọc nhầm ngày người dùng
  // nói, và đảo lặng lẽ là trả lời cho một câu hỏi khác.
  const error = assertThrows(() =>
    performancePeriod(
      { from_date: "2026-10-31", to_date: "2026-10-01" },
      "2026-11-02",
      EMPLOYEE_TOOL,
    )
  );
  assertStringIncludes((error as Error).message, "from_date");
});

Deno.test("performancePeriod - refuses dates after the site's today", () => {
  const error = assertThrows(() =>
    performancePeriod(
      { from_date: "2026-10-20", to_date: "2026-11-03" },
      "2026-11-02",
      EMPLOYEE_TOOL,
    )
  );
  assertStringIncludes((error as Error).message, "2026-11-02");
});

Deno.test("performancePeriod - allows one extra day when the site's today is uncertain", () => {
  // Hôm nay tính ra là 02/11 nhưng có thể site đã sang 03/11: nhận 03/11, vẫn từ chối 04/11.
  assertEquals(
    performancePeriod(
      { from_date: "2026-11-03" },
      "2026-11-02",
      EMPLOYEE_TOOL,
      "2026-11-03",
    ),
    { from_date: "2026-11-03", to_date: "2026-11-03", days: 1 },
  );
  assertEquals(
    performancePeriod(
      { from_date: "2026-11-01", to_date: "2026-11-03" },
      "2026-11-02",
      EMPLOYEE_TOOL,
      "2026-11-03",
    ).days,
    3,
  );
  const error = assertThrows(() =>
    performancePeriod(
      { to_date: "2026-11-04" },
      "2026-11-02",
      EMPLOYEE_TOOL,
      "2026-11-03",
    )
  );
  assertStringIncludes((error as Error).message, "2026-11-04");
  // Ngày mặc định vẫn tính theo hôm nay đã biết, không theo ngày được nới.
  assertEquals(
    performancePeriod({}, "2026-11-02", EMPLOYEE_TOOL, "2026-11-03").to_date,
    "2026-11-01",
  );
});

Deno.test("performancePeriod - refuses malformed or impossible dates", () => {
  for (
    const bad of [
      "2026-13-01",
      "2026-02-30",
      "01/10/2026",
      "2026-1-1",
      20261001,
    ]
  ) {
    assertThrows(
      () =>
        performancePeriod(
          { from_date: bad, to_date: "2026-10-31" },
          "2026-11-02",
          EMPLOYEE_TOOL,
        ),
      Error,
      undefined,
      String(bad),
    );
  }
});

Deno.test("previousPeriod - the equal-length period right before", () => {
  assertEquals(
    previousPeriod({
      from_date: "2026-10-01",
      to_date: "2026-10-31",
      days: 31,
    }),
    { from_date: "2026-08-31", to_date: "2026-09-30", days: 31 },
  );
});

Deno.test(`${EMPLOYEE_TOOL} - default dates come from the site's today and are always sent`, async () => {
  const { ctx } = erpClient();
  const expected = performancePeriod({}, await siteToday(ctx), EMPLOYEE_TOOL);
  const { result, calls } = await runEmployee({
    employee: "me",
    compare: "none",
  });
  const sent = personalCalls(calls);
  assertEquals(sent.length, 1);
  // ERP lấy HÔM NAY khi thiếu ngày, tức chỉ một ngày chứ không phải 30: phải gửi đủ cả hai.
  assertEquals(sent[0].args.from_date, expected.from_date);
  assertEquals(sent[0].args.to_date, expected.to_date);
  const measured = measuredCalls(calls);
  assertEquals(measured.length, 1);
  assertEquals(measured[0].args.from_date, expected.from_date);
  assertEquals(measured[0].args.to_date, expected.to_date);
  assertEquals(result.period.from_date, expected.from_date);
  assertEquals(result.period.days, 30);
  assertEquals(result.period.date_basis, "site_timezone");
});

Deno.test(`${EMPLOYEE_TOOL} - an invalid range never reaches ERP`, async () => {
  for (
    const range of [
      { from_date: "2026-07-01", to_date: "2026-10-31" },
      { from_date: "2026-10-31", to_date: "2026-10-01" },
    ]
  ) {
    const { ctx, calls } = erpClient();
    await assertRejects(() =>
      getTool(EMPLOYEE_TOOL).handler({ employee: "me", ...range }, ctx)
    );
    assertEquals(reportCalls(calls).length, 0);
  }
});

// ── Đầu vào ──────────────────────────────────────────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - unknown keys are refused without echoing them`, async () => {
  const { ctx, calls } = erpClient();
  const error = await assertRejects(() =>
    getTool(EMPLOYEE_TOOL).handler(
      { employee: "me", user_id: "ceo@havigroup.llc" },
      ctx,
    )
  );
  assert(!(error as Error).message.includes("ceo@havigroup.llc"));
  assertEquals(calls.length, 0);
});

Deno.test(`${EMPLOYEE_TOOL} - bad option values are refused before any call`, async () => {
  for (
    const input of [
      {},
      { employee: "" },
      { employee: "x".repeat(141) },
      { employee: "me", compare: "last_year" },
      { employee: "me", sections: ["volume", "mood"] },
      { employee: "me", sections: ["volume", "volume"] },
      { employee: "me", sections: [] },
      { employee: "me", detail_limit: 51 },
      { employee: "me", detail_limit: 2.5 },
      { employee: "me", sku_scope: "everything" },
      { employee: "me", sku_scope: 1 },
    ]
  ) {
    const { ctx, calls } = erpClient();
    await assertRejects(
      () => getTool(EMPLOYEE_TOOL).handler(input, ctx),
      Error,
      undefined,
      JSON.stringify(input),
    );
    assertEquals(calls.length, 0, JSON.stringify(input));
  }
});

// ── Gọi ERP ──────────────────────────────────────────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - every ERP report call is a POST`, async () => {
  const { calls } = await runEmployee({ employee: "Đỗ Văn Đức", ...OCTOBER });
  const sent = reportCalls(calls);
  assertEquals(sent.map((call) => call.method), [
    `${REPORT}.get_report_context`,
    `${REPORT}.get_personal_report`,
    `${REPORT}.get_personal_report`,
    SUMMARY_METHOD,
  ]);
  for (const call of sent) {
    assertEquals(call.opts?.httpMethod, "POST", call.method);
  }
});

Deno.test(`${EMPLOYEE_TOOL} - the previous period is fetched for the same person`, async () => {
  const { result, calls } = await runEmployee({
    employee: "duc@havigroup.llc",
    ...OCTOBER,
    detail_limit: 0,
  });
  assertEquals(personalCalls(calls).map((call) => call.args), [
    { user: "duc@havigroup.llc", ...OCTOBER },
    {
      user: "duc@havigroup.llc",
      from_date: "2026-08-31",
      to_date: "2026-09-30",
    },
  ]);
  assertEquals(result.period.compare, {
    mode: "previous_period",
    from_date: "2026-08-31",
    to_date: "2026-09-30",
  });
  const [measured] = measuredCalls(calls);
  const { request_id: requestId, ...args } = measured.args;
  assert(UUID.test(String(requestId)), String(requestId));
  assertEquals(args, {
    user: "duc@havigroup.llc",
    ...OCTOBER,
    sections: ["tasks", "sku", "quality"],
    compare_from_date: "2026-08-31",
    compare_to_date: "2026-09-30",
    sku_scope: "completed_in_period",
    // ERP kẹp `row_limit` về 1..50, nên 0 gửi thành 1 thay vì để ERP đổi lặng lẽ.
    row_limit: 1,
    contract_version: 2,
  });
});

Deno.test(`${EMPLOYEE_TOOL} - compare none skips the previous period`, async () => {
  const { result, calls } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    compare: "none",
  });
  assertEquals(personalCalls(calls).length, 1);
  assertEquals(result.period.compare, { mode: "none" });
  assertEquals(result.sections.volume.previous, undefined);
  assertEquals(result.sections.volume.change, undefined);
  const [measured] = measuredCalls(calls);
  assertEquals(measured.args.compare_from_date, null);
  assertEquals(measured.args.compare_to_date, null);
  assertEquals(result.sections.sku.growth.status, "not_requested");
});

Deno.test(`${EMPLOYEE_TOOL} - sections without volume make no report call`, async () => {
  const { result, calls } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    sections: ["sku"],
    sku_scope: "portfolio",
  });
  assertEquals(personalCalls(calls).length, 0);
  const [measured] = measuredCalls(calls);
  assertEquals(measured.args.sections, ["sku"]);
  assertEquals(measured.args.sku_scope, "portfolio");
  assertEquals(Object.keys(result.sections), ["sku"]);
  assertEquals(result.sections.sku.status, "ok");
  assertEquals(result.sections.sku.scope, "portfolio");
});

Deno.test(`${EMPLOYEE_TOOL} - volume alone makes no call to the v2 endpoint`, async () => {
  const { result, calls } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    sections: ["volume"],
  });
  assertEquals(measuredCalls(calls).length, 0);
  assertEquals(Object.keys(result.sections), ["volume"]);
  assertEquals(result.data_quality.coverage, null);
  assert(
    !JSON.stringify(result.data_quality.warnings).includes("unavailable"),
  );
});

// ── Phân giải người ──────────────────────────────────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - resolves me, an email and a name within the viewable people`, async () => {
  const cases: [string, string, string][] = [
    ["me", VIEWER, "self"],
    ["DUC@havigroup.llc", "duc@havigroup.llc", "email"],
    ["Đỗ Văn Đức", "duc@havigroup.llc", "exact"],
    ["Do Van Duc", "duc@havigroup.llc", "folded"],
    // Chuỗi NFD có khoảng trắng thừa: chuẩn hoá trước khi so, không gửi nguyên văn.
    ["  Đỗ   Văn Đức ".normalize("NFD"), "duc@havigroup.llc", "exact"],
  ];
  for (const [employee, user, match] of cases) {
    const { result, calls } = await runEmployee({
      employee,
      ...OCTOBER,
      compare: "none",
    });
    assertEquals(personalCalls(calls)[0].args.user, user, employee);
    assertEquals(result.subject.user, user, employee);
    assertEquals(result.subject.match, match, employee);
  }
});

Deno.test(`${EMPLOYEE_TOOL} - namesakes raise an MRTR ambiguity before any report call`, async () => {
  const { ctx, calls } = erpClient();
  const error = await assertRejects(() =>
    getTool(EMPLOYEE_TOOL).handler(
      { employee: "Nguyễn Văn An", ...OCTOBER },
      ctx,
    )
  );
  assertInstanceOf(error, AmbiguousLinkError);
  assertEquals(error.inputPath, "employee");
  assertEquals(
    error.candidates.map((candidate) => candidate.id),
    ["an1@havigroup.llc", "an2@havigroup.llc"],
  );
  assertStringIncludes(error.candidates[1].label, "Nhân viên bán hàng");
  assertEquals(personalCalls(calls).length, 0);
});

Deno.test(`${EMPLOYEE_TOOL} - a chosen candidate id resolves on the retry`, async () => {
  // MRTR chạy lại với `employee` = mã ứng viên đã chọn; mã đó phải tự phân giải được.
  const { result } = await runEmployee({
    employee: "an2@havigroup.llc",
    ...OCTOBER,
    compare: "none",
  });
  assertEquals(result.subject.user, "an2@havigroup.llc");
});

Deno.test(`${EMPLOYEE_TOOL} - someone outside the viewable people is not found and not fetched`, async () => {
  const { ctx, calls } = erpClient();
  const error = await assertRejects(() =>
    getTool(EMPLOYEE_TOOL).handler(
      { employee: "ceo@havigroup.llc", ...OCTOBER },
      ctx,
    )
  );
  assert(!(error instanceof AmbiguousLinkError));
  assertStringIncludes((error as Error).message, `[${EMPLOYEE_TOOL}]`);
  assertEquals(personalCalls(calls).length, 0);
});

// ── Lỗi ERP ──────────────────────────────────────────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - an ERP PermissionError fails the whole tool`, async () => {
  const denied = new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: Bạn không có quyền xem báo cáo của người này. (HTTP 403)",
    403,
    { exc_type: "PermissionError" },
  );
  const { ctx } = erpClient({
    personal: () => {
      throw denied;
    },
  });
  const error = await assertRejects(() =>
    getTool(EMPLOYEE_TOOL).handler({ employee: "me", ...OCTOBER }, ctx)
  );
  // Không hạ thành `status` của một phần: quyền bị từ chối là câu trả lời cho cả lượt hỏi.
  assertEquals(error, denied);
});

Deno.test(`${EMPLOYEE_TOOL} - a site without the report names the missing app`, async () => {
  const { ctx } = erpClient({
    context: undefined,
  });
  const missing = new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: Failed to get method for command (HTTP 404)",
    404,
    { exc_type: "ValidationError" },
  );
  ctx.client.callMethod = (async (method: string) => {
    if (method === "frappe.client.get_value") {
      return { time_zone: "Asia/Ho_Chi_Minh" };
    }
    throw missing;
  }) as FrappeClient["callMethod"];
  const error = await assertRejects(
    () => getTool(EMPLOYEE_TOOL).handler({ employee: "me", ...OCTOBER }, ctx),
    Error,
  );
  assertStringIncludes(error.message, "hvg_sdc_sync");
  assertStringIncludes(error.message, `[${EMPLOYEE_TOOL}]`);
});

// ── Kỳ chứa hôm nay và ngày site không chắc chắn ─────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - a period ending today warns that change understates it`, async () => {
  const { ctx } = erpClient();
  const today = await siteToday(ctx);
  // "Tháng này" vào ngày 2: kỳ hai ngày mà ngày thứ hai mới qua vài giờ, đem so với hai ngày trọn.
  const { result } = await runEmployee({
    employee: "me",
    from_date: shiftDate(today, -1),
  });
  assertEquals(result.period.to_date, today);
  assertEquals(result.period.includes_today, true);
  const warnings = JSON.stringify(result.data_quality.warnings);
  assertStringIncludes(warnings, "still in progress");
  assertStringIncludes(warnings, "decline");

  // Không so kỳ trước thì không có câu về 'change', nhưng vẫn nói hôm nay chưa trọn.
  const alone = await runEmployee({
    employee: "me",
    to_date: today,
    compare: "none",
  });
  assertEquals(alone.result.period.includes_today, true);
  const aloneWarnings = JSON.stringify(alone.result.data_quality.warnings);
  assertStringIncludes(aloneWarnings, "still in progress");
  assert(!aloneWarnings.includes("decline"), aloneWarnings);
});

Deno.test(`${EMPLOYEE_TOOL} - the default period holds only complete days and says so`, async () => {
  const { result } = await runEmployee({ employee: "me" });
  assertEquals(result.period.includes_today, false);
  assert(
    !JSON.stringify(result.data_quality.warnings).includes("still in progress"),
  );
});

Deno.test(`${TEAM_TOOL} - a period ending today is flagged as partial`, async () => {
  const { ctx } = erpClient({ team: teamReport });
  const today = await siteToday(ctx);
  const result: Json = await getTool(TEAM_TOOL).handler(
    { from_date: shiftDate(today, -6) },
    ctx,
  );
  assertEquals(result.period.includes_today, true);
  assertStringIncludes(
    JSON.stringify(result.data_quality.warnings),
    "still in progress",
  );

  const complete: Json = await getTool(TEAM_TOOL).handler(OCTOBER, ctx);
  assertEquals(complete.period.includes_today, false);
});

Deno.test(`${EMPLOYEE_TOOL} - an uncertain site date accepts the next day but no further`, async () => {
  // Không đọc được System Settings thì múi giờ lấy ở bậc dưới và có thể chậm hơn site vài giờ:
  // lúc 00:45 ở site, "hôm nay" của người dùng có thể là "ngày mai" theo con số tính được.
  const { ctx } = erpClient({ zone: "fallback" });
  const today = await siteToday(ctx);
  const tomorrow = shiftDate(today, 1);
  const { result } = await runEmployee(
    { employee: "me", from_date: tomorrow },
    { zone: "fallback" },
  );
  assertEquals(result.period.from_date, tomorrow);
  assertEquals(result.period.to_date, tomorrow);
  assertEquals(result.period.includes_today, true);

  await assertRejects(
    () =>
      runEmployee({ employee: "me", from_date: shiftDate(today, 2) }, {
        zone: "fallback",
      }),
    Error,
    "after",
  );
  // Đọc được múi giờ thật thì không nới.
  await assertRejects(
    () => runEmployee({ employee: "me", from_date: tomorrow }),
    Error,
    "after the site's today",
  );
});

// ── Hình dạng kết quả ────────────────────────────────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - the contract envelope and its four sections`, async () => {
  const { result, calls } = await runEmployee({
    employee: "Đỗ Văn Đức",
    ...OCTOBER,
  });
  assertEquals(result.contract_version, 2);
  // Hướng dẫn và chất lượng dữ liệu đứng TRƯỚC số liệu: client cắt bớt phản hồi dài thì phần bị
  // mất là dòng chi tiết, không phải lời dặn cách trình bày.
  assertEquals(Object.keys(result), [
    "contract_version",
    "subject",
    "viewer",
    "period",
    "how_to_present",
    "data_quality",
    "next_questions",
    "sections",
  ]);
  assertEquals(Object.keys(result.data_quality), [
    "rules",
    "coverage",
    "warnings",
  ]);
  assertEquals(result.subject, {
    user: "duc@havigroup.llc",
    full_name: "Đỗ Văn Đức",
    designation: "Chuyên viên thiết kế",
    department: "Design - HVG",
    match: "exact",
    report_sections: ["design"],
    summary: {
      tasks_assigned: 8,
      tasks_completed: 5,
      tasks_open: 2,
      tasks_with_sku: 3,
      skus: 3,
      skus_with_item: 2,
      skus_sold: 2,
      qty_sold: 42,
    },
  });
  assertEquals(result.viewer, { user: VIEWER, scope: "team", is_self: false });
  assertEquals(Object.keys(result.sections), [
    "volume",
    "tasks",
    "sku",
    "quality",
  ]);
  // Các section v2 đi nguyên văn từ ERP: MCP không đếm lại, không làm tròn lại.
  const expected = summaryFor(measuredCalls(calls)[0].args);
  for (const key of ["tasks", "sku", "quality"]) {
    assertEquals(result.sections[key], expected.sections[key], key);
  }
  assertStringIncludes(result.how_to_present, "coverage");
  assertStringIncludes(result.how_to_present, "ranking");
  const volume = result.sections.volume;
  assertEquals(volume.status, "ok");
  assertEquals(volume.source, `${REPORT}.get_personal_report`);
  assertEquals(volume.summary, totals(146, 58, 0, 51));
  assertEquals(volume.previous, totals(146, 58, 0, 51));
  assertEquals(volume.change, totals(0, 0, 0, 0));
  assertEquals(volume.by_team, [{
    team: "Team Etsy 1",
    ...totals(146, 58, 0, 51),
  }]);
  assertEquals(volume.truncated, false);
  // Hai nghìn dòng chi tiết không bao giờ được chuyển nguyên cho mô hình.
  assertEquals(volume.design, undefined);
  assertEquals(volume.fulfill, undefined);
});

Deno.test(`${EMPLOYEE_TOOL} - change is current minus previous`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER }, {
    personal: (args) =>
      personalReport(args, {
        summary: args.from_date === OCTOBER.from_date
          ? totals(146, 58, 2, 51)
          : totals(120, 49, 5, 44),
      }),
  });
  assertEquals(result.sections.volume.previous, totals(120, 49, 5, 44));
  assertEquals(result.sections.volume.change, totals(26, 9, -3, 7));
});

Deno.test(`${EMPLOYEE_TOOL} - recent merges both kinds, newest first, capped by detail_limit`, async () => {
  const { result } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    detail_limit: 2,
  });
  const recent = result.sections.volume.recent;
  assertEquals(recent.map((row: Json) => [row.kind, row.at]), [
    ["fulfill", "2026-10-31 16:02:11"],
    ["design", "2026-10-31 09:00:00"],
  ]);
  assertEquals(recent[0].vendor, "Printify");
  assertEquals(recent[1].point, 3);
  assertEquals(recent[1].user, undefined);

  const none = await runEmployee({
    employee: "me",
    ...OCTOBER,
    detail_limit: 0,
  });
  assertEquals(none.result.sections.volume.recent, []);
});

Deno.test(`${EMPLOYEE_TOOL} - says when a lead sees only their team's part of someone's work`, async () => {
  const other = await runEmployee({ employee: "Đỗ Văn Đức", ...OCTOBER });
  assertEquals(
    other.result.sections.volume.visibility.filtered_to_viewer_order_scope,
    true,
  );
  const otherText = JSON.stringify(other.result.data_quality.warnings);
  assertStringIncludes(otherText, "order scope");
  assertStringIncludes(otherText, "not visible");

  // Tự xem: ERP giữ mọi dòng của chính người xem, không có gì bị lọc.
  const self = await runEmployee({ employee: "me", ...OCTOBER });
  assertEquals(
    self.result.sections.volume.visibility.filtered_to_viewer_order_scope,
    false,
  );
  assert(
    !JSON.stringify(self.result.data_quality.warnings).includes("order scope"),
  );

  // Mức `all`: ERP không lọc theo phạm vi đơn.
  const all = await runEmployee({ employee: "Đỗ Văn Đức", ...OCTOBER }, {
    context: reportContext({ scope: "all" }),
  });
  assertEquals(
    all.result.sections.volume.visibility.filtered_to_viewer_order_scope,
    false,
  );
});

Deno.test(`${EMPLOYEE_TOOL} - the not-measured warning appears only when a section is unavailable`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER });
  assert(
    !JSON.stringify(result.data_quality.warnings).includes("unavailable"),
  );
  assertStringIncludes(JSON.stringify(result.data_quality.rules), "ranking");

  const older = await runEmployee({ employee: "me", ...OCTOBER }, {
    measured: () => {
      throw methodMissing();
    },
  });
  const warnings = older.result.data_quality.warnings;
  // Đứng đầu danh sách: đây là điều mô hình phải nói trước mọi con số.
  assertStringIncludes(warnings[0], "unavailable");
  assertStringIncludes(warnings[0], "erpnext_task_list");
});

Deno.test(`${EMPLOYEE_TOOL} - zero design and fulfill lines get an explicit warning`, async () => {
  // Nhân viên bán hàng không làm design hay fulfill: số 0 ở đây không nói gì về khối lượng việc
  // của họ, và mô hình phải được dặn đừng đọc nó thành "không làm gì".
  const { result } = await runEmployee({
    employee: "an2@havigroup.llc",
    ...OCTOBER,
  }, {
    personal: (args) =>
      personalReport(args, {
        sections: ["design", "fulfill"],
        summary: totals(0, 0, 0, 0),
        design: [],
        fulfill: [],
        by_team: [],
        by_day: [],
      }),
  });
  assertEquals(result.subject.report_sections, ["design", "fulfill"]);
  assertEquals(result.sections.volume.recent, []);
  const text = JSON.stringify(result.data_quality.warnings);
  assertStringIncludes(text, "No design or fulfill lines");
  assertStringIncludes(text, "says nothing about their workload");

  // Có việc thì không cảnh báo.
  const busy = await runEmployee({ employee: "me", ...OCTOBER });
  assert(
    !JSON.stringify(busy.result.data_quality.warnings).includes(
      "No design or fulfill lines",
    ),
  );
});

Deno.test(`${EMPLOYEE_TOOL} - subject report_sections is null when volume was not fetched`, async () => {
  const { result } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    sections: ["tasks"],
  });
  assertEquals(result.subject.report_sections, null);
  assertEquals(result.subject.match, "self");
  assertEquals(result.viewer.is_self, true);
});

Deno.test(`${EMPLOYEE_TOOL} - ERP's truncation is reported`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER }, {
    personal: (args) => personalReport(args, { truncated: true }),
  });
  assertEquals(result.sections.volume.truncated, true);
  assertStringIncludes(JSON.stringify(result.data_quality.warnings), "2000");
});

// ── Hợp đồng v2: Task, SKU, chất lượng ───────────────────────────────────────

Deno.test("the mocked ERP answers satisfy contract v2 themselves", () => {
  const base = {
    user: "duc@havigroup.llc",
    sections: ["tasks", "sku", "quality"],
    sku_scope: "completed_in_period",
  };
  for (
    const [from, to, compareFrom, compareTo] of [
      ["2026-10-01", "2026-10-31", "2026-08-31", "2026-09-30"],
      ["2026-10-26", "2026-11-01", "2026-10-19", "2026-10-25"],
      ["2026-10-01", "2026-10-31", null, null],
    ]
  ) {
    const args = {
      ...base,
      from_date: from,
      to_date: to,
      compare_from_date: compareFrom,
      compare_to_date: compareTo,
    };
    assertEquals(checkSummaryResponse(summaryFor(args)), [], `${from}..${to}`);
    for (const section of ["tasks", "sku"]) {
      assertEquals(
        checkRowsResponse(rowsFor({ ...args, section })),
        [],
        `${section} ${from}..${to}`,
      );
    }
  }
});

Deno.test(`${EMPLOYEE_TOOL} - each call carries its own request id`, async () => {
  const first = await runEmployee({ employee: "me", ...OCTOBER });
  const second = await runEmployee({ employee: "me", ...OCTOBER });
  const ids = [first, second].map(({ calls }) => {
    const sent = measuredCalls(calls);
    assertEquals(sent.length, 1);
    return String(sent[0].args.request_id);
  });
  for (const id of ids) assert(UUID.test(id), id);
  assert(ids[0] !== ids[1], "request ids must differ between calls");
});

Deno.test(`${EMPLOYEE_TOOL} - row_limit follows detail_limit`, async () => {
  const { calls } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    detail_limit: 7,
  });
  assertEquals(measuredCalls(calls)[0].args.row_limit, 7);
});

Deno.test(`${EMPLOYEE_TOOL} - an older ERP without the endpoint keeps volume and marks the rest unavailable`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER }, {
    measured: () => {
      throw methodMissing();
    },
  });
  assertEquals(result.sections.volume.status, "ok");
  for (const key of ["tasks", "sku", "quality"]) {
    assertEquals(result.sections[key].status, "unavailable", key);
    assertEquals(result.sections[key].reason, "erp_endpoint_missing", key);
    assertStringIncludes(
      result.sections[key].note,
      "Not measured by this ERP release",
    );
  }
  assertEquals(result.subject.summary.tasks_assigned, null);
  assertEquals(result.subject.summary.qty_sold, null);
  assertEquals(result.data_quality.coverage, null);
});

Deno.test(`${EMPLOYEE_TOOL} - a PermissionError on Task and SKU figures is reported, not thrown`, async () => {
  const { result } = await runEmployee({ employee: "Đỗ Văn Đức", ...OCTOBER }, {
    measured: () => {
      throw permissionDenied();
    },
  });
  assertEquals(result.sections.volume.status, "ok");
  for (const key of ["tasks", "sku", "quality"]) {
    assertEquals(result.sections[key].status, "unavailable", key);
    assertEquals(result.sections[key].reason, "not_permitted", key);
  }
});

Deno.test(`${EMPLOYEE_TOOL} - other v2 errors fail the whole tool`, async () => {
  const broken = new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: boom (HTTP 500)",
    500,
    { exc_type: "ValidationError" },
  );
  const { ctx } = erpClient({
    measured: () => {
      throw broken;
    },
  });
  const error = await assertRejects(() =>
    getTool(EMPLOYEE_TOOL).handler({ employee: "me", ...OCTOBER }, ctx)
  );
  assertEquals(error, broken);
});

Deno.test(`${EMPLOYEE_TOOL} - an answer that breaks the contract is withheld, without echoing values`, async () => {
  const cases: Array<[string, (args: Record<string, unknown>) => Json]> = [
    ["counting rule", (args) => {
      const value = summaryFor(args);
      value.sections.tasks.summary.assigned = 99;
      return value;
    }],
    ["schema", (args) => {
      const value = summaryFor(args);
      value.contract_version = 3;
      return value;
    }],
    ["another person", (args) => {
      const value = summaryFor(args);
      value.user = "ceo@havigroup.llc";
      return value;
    }],
    ["another period", (args) => {
      const value = summaryFor(args);
      value.from_date = "2026-10-02";
      value.compare = { from_date: "2026-09-01", to_date: "2026-10-01" };
      return value;
    }],
    ["no comparison although one was asked", (args) =>
      summaryFor({
        ...args,
        compare_from_date: null,
        compare_to_date: null,
      })],
    [
      "a section that was not asked for",
      (args) => summaryFor({ ...args, sections: ["tasks", "sku", "quality"] }),
    ],
    [
      "a missing section",
      (args) => summaryFor({ ...args, sections: ["tasks"] }),
    ],
    [
      "another SKU scope",
      (args) => summaryFor({ ...args, sku_scope: "portfolio" }),
    ],
    ["not an object", () => "ok"],
  ];
  for (const [label, measured] of cases) {
    const { result } = await runEmployee({
      employee: "me",
      ...OCTOBER,
      sections: ["volume", "tasks", "sku"],
    }, { measured });
    assertEquals(result.sections.volume.status, "ok", label);
    assertEquals(Object.keys(result.sections), ["volume", "tasks", "sku"]);
    for (const key of ["tasks", "sku"]) {
      const section = result.sections[key];
      assertEquals(section.status, "unavailable", `${label}: ${key}`);
      assertEquals(section.reason, "erp_contract_mismatch", `${label}: ${key}`);
      assert(!section.note.includes("ceo@havigroup.llc"), label);
      assert(!section.note.includes("99"), label);
    }
  }
});

Deno.test(`${EMPLOYEE_TOOL} - a person without a design or fulfill role gets no volume zero`, async () => {
  const empty = (args: Record<string, unknown>) =>
    personalReport(args, {
      summary: totals(0, 0, 0, 0),
      design: [],
      fulfill: [],
      by_team: [],
      by_day: [],
    });
  const { result } = await runEmployee({
    employee: "an2@havigroup.llc",
    ...OCTOBER,
  }, {
    personal: empty,
    measured: (args) => ({ ...summaryFor(args), volume_applies: false }),
  });
  assertEquals(result.sections.volume.status, "not_applicable");
  assertEquals(result.sections.volume.reason, "no_design_or_fulfill_role");
  assertEquals(result.sections.volume.summary, undefined);
  assert(
    !JSON.stringify(result.data_quality.warnings).includes(
      "No design or fulfill lines",
    ),
  );

  // Có dòng thì vẫn báo số, dù ERP nói không có vai trò: số đo được thắng suy luận.
  const busy = await runEmployee(
    { employee: "an2@havigroup.llc", ...OCTOBER },
    {
      measured: (args) => ({ ...summaryFor(args), volume_applies: false }),
    },
  );
  assertEquals(busy.result.sections.volume.status, "ok");

  // ERP cũ không trả `volume_applies`: không đoán, giữ số 0 kèm cảnh báo như trước.
  const older = await runEmployee({
    employee: "an2@havigroup.llc",
    ...OCTOBER,
  }, {
    personal: empty,
    measured: () => {
      throw methodMissing();
    },
  });
  assertEquals(older.result.sections.volume.status, "ok");
  assertStringIncludes(
    JSON.stringify(older.result.data_quality.warnings),
    "No design or fulfill lines",
  );
});

Deno.test(`${EMPLOYEE_TOOL} - coverage puts each count next to what it is out of`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER });
  assertEquals(result.data_quality.coverage, {
    tasks_with_sku: { count: 3, of: 5 },
    task_titles_visible: { count: 7, of: 8 },
    skus_with_item: { count: 2, of: 3 },
    skus_sold: { count: 2, of: 3 },
  });

  const skuOnly = await runEmployee({
    employee: "me",
    ...OCTOBER,
    sections: ["sku"],
  });
  assertEquals(skuOnly.result.data_quality.coverage, {
    tasks_with_sku: null,
    task_titles_visible: null,
    skus_with_item: { count: 2, of: 3 },
    skus_sold: { count: 2, of: 3 },
  });
});

Deno.test(`${EMPLOYEE_TOOL} - next questions are coaching prompts, never a ranking`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER });
  const questions: string[] = result.next_questions;
  assert(questions.length > 0 && questions.length <= 5, String(questions));
  const text = questions.join(" ").toLowerCase();
  for (const word of ["score", "grade", "rank", "rating"]) {
    assert(!text.includes(word), word);
  }
  assertStringIncludes(text, "open");

  // Không có Task nào: câu hỏi đầu tiên là việc của họ có nằm trong ERP hay không.
  const idle = await runEmployee({ employee: "me", ...OCTOBER }, {
    measured: (args) => {
      const value = summaryFor(args);
      value.sections.tasks = structuredClone(
        examples.summary_no_compare.sections.tasks,
      );
      return value;
    },
  });
  assertStringIncludes(idle.result.next_questions[0], "No task");

  // Section không có thì không có câu hỏi về nó.
  const older = await runEmployee({ employee: "me", ...OCTOBER }, {
    measured: () => {
      throw methodMissing();
    },
  });
  assertEquals(older.result.next_questions, []);
});

Deno.test(`${EMPLOYEE_TOOL} - SKU sales cover every order while volume follows the viewer's scope`, async () => {
  // QĐ-8 phương án C: số bán SKU đếm mọi đơn, còn khối lượng vẫn lọc theo phạm vi đơn của người
  // xem. Hai phần cạnh nhau mà đếm theo hai cách thì phải nói ra, kẻo mô hình đem chia cho nhau.
  const { result } = await runEmployee({ employee: "Đỗ Văn Đức", ...OCTOBER });
  const warnings = JSON.stringify(result.data_quality.warnings);
  assertStringIncludes(warnings, "order scope");
  assertStringIncludes(warnings, "SKU sales are not");
  assertStringIncludes(
    JSON.stringify(result.data_quality.rules),
    "every submitted order",
  );

  const volumeOnly = await runEmployee({
    employee: "Đỗ Văn Đức",
    ...OCTOBER,
    sections: ["volume"],
  });
  assert(
    !JSON.stringify(volumeOnly.result.data_quality.warnings).includes(
      "SKU sales are not",
    ),
  );
});

Deno.test(`${EMPLOYEE_TOOL} - growth without a baseline says when it becomes available`, async () => {
  // Kỳ so sánh của tháng 10 bắt đầu 31/08, trước khi dữ liệu đơn đủ (12/10).
  const { result } = await runEmployee({ employee: "me", ...OCTOBER });
  assertEquals(result.sections.sku.growth.status, "insufficient_baseline");
  const text = JSON.stringify(result.data_quality.warnings);
  assertStringIncludes(text, "Do not say");
  assertStringIncludes(text, result.sections.sku.growth.first_evaluable_to);

  // Kỳ so sánh nằm trọn sau mốc đó: có xu hướng, không cảnh báo.
  const late = await runEmployee({ employee: "me", ...LATE_OCTOBER });
  assertEquals(late.result.sections.sku.growth.status, "ok");
  assertEquals(late.result.sections.sku.growth.trend, "growing");
  assert(
    !JSON.stringify(late.result.data_quality.warnings).includes("Do not say"),
  );
});

Deno.test(`${EMPLOYEE_TOOL} - rules from ERP and the SKU caveats reach the model`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER });
  const rules = JSON.stringify(result.data_quality.rules);
  assertStringIncludes(rules, examples.summary_full.rules[0].text);
  assertStringIncludes(rules, "people_sharing");
  assertStringIncludes(rules, "sold_before_first_completion");
  assertStringIncludes(rules, "not instructions");
  assertStringIncludes(rules, "with_sku");
});

// ── Tool chi tiết ────────────────────────────────────────────────────────────

Deno.test(`${DETAIL_TOOL} - pages tasks with the cursor passed through untouched`, async () => {
  const cursor = "eyJzZWN0aW9uIjoidGFza3MiLCJvZmZzZXQiOjJ9";
  const { result, calls } = await runDetail({
    employee: "Đỗ Văn Đức",
    ...OCTOBER,
    section: "tasks",
    cursor,
    limit: 5,
  });
  const sent = reportCalls(calls);
  assertEquals(sent.map((call) => call.method), [
    `${REPORT}.get_report_context`,
    ROWS_METHOD,
  ]);
  for (const call of sent) assertEquals(call.opts?.httpMethod, "POST");
  const { request_id: requestId, ...args } = sent[1].args;
  assert(UUID.test(String(requestId)));
  assertEquals(args, {
    user: "duc@havigroup.llc",
    ...OCTOBER,
    section: "tasks",
    compare_from_date: "2026-08-31",
    compare_to_date: "2026-09-30",
    sku_scope: "completed_in_period",
    cursor,
    limit: 5,
    contract_version: 2,
  });
  assertEquals(result.contract_version, 2);
  assertEquals(result.subject, {
    user: "duc@havigroup.llc",
    full_name: "Đỗ Văn Đức",
    match: "exact",
  });
  assertEquals(result.section, "tasks");
  assertEquals(result.rows, examples.rows_tasks.rows);
  assertEquals(result.next_cursor, null);
  assertEquals(result.sales_visibility, undefined);
  assertStringIncludes(
    JSON.stringify(result.data_quality.rules),
    "not instructions",
  );
});

Deno.test(`${DETAIL_TOOL} - a SKU page carries sales visibility and the next cursor`, async () => {
  const { result, calls } = await runDetail({
    employee: "me",
    ...OCTOBER,
    section: "sku",
    compare: "none",
  });
  const [sent] = calls.filter((call) => call.method === ROWS_METHOD);
  assertEquals(sent.args.compare_from_date, null);
  assertEquals(sent.args.compare_to_date, null);
  assertEquals(sent.args.cursor, null);
  assertEquals(sent.args.limit, 25);
  assertEquals(result.sales_visibility, {
    mode: "all_orders",
    partial: false,
  });
  assertEquals(result.next_cursor, examples.rows_sku.next_cursor);
  assertStringIncludes(
    JSON.stringify(result.data_quality.rules),
    "every submitted order",
  );
  // Trang chi tiết không có trạng thái tăng trưởng, nên phải dặn đọc xu hướng từ tool tổng.
  assertStringIncludes(
    JSON.stringify(result.data_quality.rules),
    "growth.status",
  );
});

Deno.test(`${DETAIL_TOOL} - bad input is refused before any call`, async () => {
  for (
    const input of [
      { employee: "me" },
      { employee: "me", section: "quality" },
      { section: "tasks" },
      { employee: "me", section: "tasks", cursor: "" },
      { employee: "me", section: "tasks", cursor: "c".repeat(1001) },
      { employee: "me", section: "tasks", limit: 0 },
      { employee: "me", section: "tasks", limit: 51 },
      { employee: "me", section: "tasks", sku_scope: "all" },
      { employee: "me", section: "tasks", detail_limit: 5 },
    ]
  ) {
    const { ctx, calls } = erpClient();
    await assertRejects(
      () => getTool(DETAIL_TOOL).handler(input, ctx),
      Error,
      undefined,
      JSON.stringify(input),
    );
    assertEquals(calls.length, 0, JSON.stringify(input));
  }
  const { result } = await runDetail({
    employee: "me",
    ...OCTOBER,
    section: "tasks",
    cursor: "c".repeat(1000),
    limit: 50,
  });
  assertEquals(result.section, "tasks");
});

Deno.test(`${DETAIL_TOOL} - every ERP failure is an error, never an empty page`, async () => {
  const cases: Array<[string, () => never | Json, string]> = [
    ["permission", () => {
      throw permissionDenied();
    }, "not allowed"],
    ["missing", () => {
      throw methodMissing();
    }, "does not expose"],
    [
      "mismatch",
      () => ({ ...rowsFor({ section: "tasks" }), user: "x@y" }),
      "contract",
    ],
  ];
  for (const [label, rows, expected] of cases) {
    const { ctx } = erpClient({ rows });
    const error = await assertRejects(
      () =>
        getTool(DETAIL_TOOL).handler(
          { employee: "me", ...OCTOBER, section: "tasks" },
          ctx,
        ),
      Error,
      undefined,
      label,
    );
    assertStringIncludes(error.message, `[${DETAIL_TOOL}]`, label);
    assertStringIncludes(error.message, expected, label);
  }
});

Deno.test(`${DETAIL_TOOL} - only people the caller may view are fetched`, async () => {
  const { ctx, calls } = erpClient();
  await assertRejects(() =>
    getTool(DETAIL_TOOL).handler(
      { employee: "ceo@havigroup.llc", ...OCTOBER, section: "sku" },
      ctx,
    )
  );
  assertEquals(calls.filter((call) => call.method === ROWS_METHOD).length, 0);
});

// ── Tool team ────────────────────────────────────────────────────────────────

function teamReport(args: Record<string, unknown>) {
  return {
    from_date: args.from_date,
    to_date: args.to_date,
    scope: "team",
    summary: totals(300, 120, 40, 150),
    // Đúng thứ tự ERP trả: điểm design giảm dần. Người nhiều điểm hơn có tên xếp SAU, để thứ tự
    // theo điểm và thứ tự theo tên khác nhau và test bắt được việc thiếu bước xếp lại.
    members: [
      {
        user: "an1@havigroup.llc",
        full_name: "Nguyễn Văn An",
        designation: "Chuyên viên thiết kế",
        department: "Design - HVG",
        ...totals(200, 80, 0, 90),
      },
      {
        user: "duc@havigroup.llc",
        full_name: "Đỗ Văn Đức",
        designation: "Chuyên viên thiết kế",
        department: "Design - HVG",
        ...totals(100, 40, 40, 60),
      },
    ],
    by_team: [{ team: "Team Etsy 1", ...totals(300, 120, 40, 150) }],
  };
}

Deno.test(`${TEAM_TOOL} - sends both dates by POST and lists members by name, not by points`, async () => {
  const { ctx, calls } = erpClient({ team: teamReport });
  const result: Json = await getTool(TEAM_TOOL).handler(OCTOBER, ctx);
  const sent = reportCalls(calls);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].method, `${REPORT}.get_team_report`);
  assertEquals(sent[0].args, OCTOBER);
  assertEquals(sent[0].opts?.httpMethod, "POST");

  assertEquals(result.contract_version, 1);
  assertEquals(result.viewer, { scope: "team" });
  assertEquals(result.period.days, 31);
  // ERP xếp theo điểm; tool kèm cặp không xếp hạng, nên xếp theo tên.
  assertEquals(
    result.members.map((member: Json) => member.full_name),
    ["Đỗ Văn Đức", "Nguyễn Văn An"],
  );
  const rules = JSON.stringify(result.data_quality.rules);
  assertStringIncludes(rules, "ranking");
  assertStringIncludes(rules, "only people with");
  const warnings = JSON.stringify(result.data_quality.warnings);
  assertStringIncludes(warnings, "SKU");
  assertStringIncludes(warnings, EMPLOYEE_TOOL);
});

Deno.test(`${TEAM_TOOL} - default dates and range limits match the employee tool`, async () => {
  const { ctx, calls } = erpClient({ team: teamReport });
  const expected = performancePeriod({}, await siteToday(ctx), TEAM_TOOL);
  await getTool(TEAM_TOOL).handler({}, ctx);
  assertEquals(reportCalls(calls)[0].args, {
    from_date: expected.from_date,
    to_date: expected.to_date,
  });

  const bad = erpClient({ team: teamReport });
  await assertRejects(() =>
    getTool(TEAM_TOOL).handler(
      { from_date: "2026-07-01", to_date: "2026-10-31" },
      bad.ctx,
    )
  );
  assertEquals(reportCalls(bad.calls).length, 0);

  const unknown = erpClient({ team: teamReport });
  await assertRejects(() =>
    getTool(TEAM_TOOL).handler({ employee: "me" }, unknown.ctx)
  );
  assertEquals(unknown.calls.length, 0);
});

Deno.test(`${TEAM_TOOL} - a viewer limited to themselves gets a clear refusal`, async () => {
  const denied = new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: Bạn không có quyền xem báo cáo của nhóm. (HTTP 403)",
    403,
    { exc_type: "PermissionError" },
  );
  const { ctx } = erpClient({
    team: () => {
      throw denied;
    },
  });
  const error = await assertRejects(
    () => getTool(TEAM_TOOL).handler(OCTOBER, ctx),
    Error,
  );
  assertStringIncludes(error.message, `[${TEAM_TOOL}]`);
  assertStringIncludes(error.message, EMPLOYEE_TOOL);
  assertEquals(error.cause, denied);
});

Deno.test(`${TEAM_TOOL} - other ERP errors pass through unchanged`, async () => {
  const broken = new FrappeAPIError(
    "[FrappeClient] POST /api/method/x failed: boom (HTTP 500)",
    500,
    { exc_type: "ValidationError" },
  );
  const { ctx } = erpClient({
    team: () => {
      throw broken;
    },
  });
  const error = await assertRejects(() =>
    getTool(TEAM_TOOL).handler(OCTOBER, ctx)
  );
  assertEquals(error, broken);
});
