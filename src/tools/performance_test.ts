/**
 * Performance tools tests
 *
 * Kiểm hai tool hiệu suất nhân sự: chặn service account trước mọi lượt gọi, luôn gửi đủ hai ngày
 * cho ERP, chỉ tìm người trong danh sách ERP cho phép, và không bao giờ trình bày phần chưa đo
 * như thể đã đo. Client là mock nên không có lượt gọi mạng nào.
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

// ── Dữ liệu mẫu ──────────────────────────────────────────────────────────────

const REPORT = "hvg_sdc_sync.personal_report";
const EMPLOYEE_TOOL = "erpnext_employee_performance_get";
const TEAM_TOOL = "erpnext_team_performance_get";
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

// ── Mock FrappeClient ────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
  opts: { httpMethod?: "GET" | "POST" } | undefined;
}

interface ErpOptions {
  actsAs?: "caller" | "service";
  context?: unknown;
  personal?: (args: Record<string, unknown>) => unknown;
  team?: (args: Record<string, unknown>) => unknown;
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
  return calls.filter((call) => call.method.startsWith(REPORT));
}

function personalCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) =>
    call.method === `${REPORT}.get_personal_report`
  );
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function runEmployee(
  input: Record<string, unknown>,
  options: ErpOptions = {},
): Promise<{ result: Json; calls: RecordedCall[] }> {
  const { ctx, calls } = erpClient(options);
  const result = await getTool(EMPLOYEE_TOOL).handler(input, ctx);
  return { result, calls };
}

const OCTOBER = { from_date: "2026-10-01", to_date: "2026-10-31" };

// ── Đăng ký ──────────────────────────────────────────────────────────────────

Deno.test("performance tools - registered read-only analytics tools", () => {
  assertEquals(
    performanceTools.map((tool) => tool.name),
    [EMPLOYEE_TOOL, TEAM_TOOL],
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
});

// ── Lớp chặn danh tính ───────────────────────────────────────────────────────

Deno.test("performance tools - a service client is refused before any call", async () => {
  for (const tool of performanceTools) {
    const { ctx, calls } = erpClient({ actsAs: "service" });
    const error = await assertRejects(
      () => tool.handler({ employee: "me" }, ctx),
      Error,
    );
    assertStringIncludes(error.message, `[${tool.name}]`);
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
});

Deno.test(`${EMPLOYEE_TOOL} - sections without volume make no report call`, async () => {
  const { result, calls } = await runEmployee({
    employee: "me",
    ...OCTOBER,
    sections: ["sku"],
  });
  assertEquals(personalCalls(calls).length, 0);
  assertEquals(Object.keys(result.sections), ["sku"]);
  assertEquals(result.sections.sku.status, "unavailable");
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

// ── Hình dạng kết quả ────────────────────────────────────────────────────────

Deno.test(`${EMPLOYEE_TOOL} - the contract envelope and its four sections`, async () => {
  const { result } = await runEmployee({ employee: "Đỗ Văn Đức", ...OCTOBER });
  assertEquals(result.contract_version, 1);
  assertEquals(result.subject, {
    user: "duc@havigroup.llc",
    full_name: "Đỗ Văn Đức",
    designation: "Chuyên viên thiết kế",
    department: "Design - HVG",
    match: "exact",
    report_sections: ["design"],
  });
  assertEquals(result.viewer, { user: VIEWER, scope: "team", is_self: false });
  assertEquals(Object.keys(result.sections), [
    "volume",
    "tasks",
    "sku",
    "quality",
  ]);
  for (const key of ["tasks", "sku", "quality"]) {
    assertEquals(result.sections[key].status, "unavailable", key);
    assertEquals(result.sections[key].reason, "erp_endpoint_missing", key);
  }
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

Deno.test(`${EMPLOYEE_TOOL} - always warns that Task and SKU work is not measured yet`, async () => {
  const { result } = await runEmployee({ employee: "me", ...OCTOBER });
  const text = JSON.stringify(result.data_quality.warnings);
  assertStringIncludes(text, "Task");
  assertStringIncludes(text, "SKU");
  assert(result.data_quality.rules.length > 0);
  assertStringIncludes(JSON.stringify(result.data_quality.rules), "ranking");
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

// ── Tool team ────────────────────────────────────────────────────────────────

function teamReport(args: Record<string, unknown>) {
  return {
    from_date: args.from_date,
    to_date: args.to_date,
    scope: "team",
    summary: totals(300, 120, 40, 150),
    members: [
      {
        user: "duc@havigroup.llc",
        full_name: "Đỗ Văn Đức",
        designation: "Chuyên viên thiết kế",
        department: "Design - HVG",
        ...totals(200, 80, 0, 90),
      },
      {
        user: "an1@havigroup.llc",
        full_name: "Nguyễn Văn An",
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
    ["Đỗ Văn Đức", "Nguyễn Văn An"].sort((a, b) => a.localeCompare(b, "vi")),
  );
  const rules = JSON.stringify(result.data_quality.rules);
  assertStringIncludes(rules, "ranking");
  assertStringIncludes(rules, "only people with");
  assertStringIncludes(JSON.stringify(result.data_quality.warnings), "SKU");
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
