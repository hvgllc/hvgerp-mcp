/**
 * Caller guard tests
 *
 * Tool nào trả lời "người đang hỏi được xem gì" thì chỉ được chạy dưới danh tính của chính người
 * đó. Chạy dưới service account là trả lời bằng tầm nhìn của tài khoản dùng chung, và câu trả lời
 * sai ấy trông y hệt câu đúng, nên phải bị chặn trước mọi lượt gọi ERP.
 *
 * @module lib/erpnext/tests/tools/caller-guard_test
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { requireCallerClient } from "./caller-guard.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

/** Client giả đếm mọi lượt gọi, để chứng minh lớp chặn đứng trước tất cả. */
function countingCtx(actsAs: "caller" | "service" | undefined): {
  ctx: ErpNextToolContext;
  calls: () => number;
} {
  let count = 0;
  const bump = () => {
    count++;
    return Promise.resolve(null);
  };
  const client = {
    actsAs,
    list: bump,
    get: bump,
    create: bump,
    update: bump,
    delete: bump,
    callMethod: bump,
    invalidate: () => {},
  } as unknown as FrappeClient;
  return { ctx: { client }, calls: () => count };
}

Deno.test("requireCallerClient - a service client is refused with the tool name", () => {
  const { ctx, calls } = countingCtx("service");
  const error = assertThrows(
    () => requireCallerClient(ctx, "erpnext_employee_performance_get"),
    Error,
  );
  assertStringIncludes(error.message, "[erpnext_employee_performance_get]");
  assertStringIncludes(error.message, "service account");
  assertEquals(calls(), 0);
});

Deno.test("requireCallerClient - a client without actsAs counts as a service client", () => {
  // `FrappeClient` mặc định là "service"; một client không khai gì cũng không được coi là
  // đang nói thay người hỏi.
  const { ctx, calls } = countingCtx(undefined);
  assertThrows(() => requireCallerClient(ctx, "erpnext_team_performance_get"));
  assertEquals(calls(), 0);
});

Deno.test("requireCallerClient - a caller client passes without touching ERP", () => {
  const { ctx, calls } = countingCtx("caller");
  requireCallerClient(ctx, "erpnext_employee_performance_get");
  assertEquals(calls(), 0);
});
