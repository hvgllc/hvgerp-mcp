/**
 * Delivery Tools Tests
 *
 * @module lib/erpnext/tests/tools/delivery_test
 */

import { assertEquals } from "@std/assert";
import { deliveryTools } from "./delivery.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";

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

function tool(name: string): ErpNextTool {
  const found = deliveryTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool not found: ${name}`);
  return found;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

Deno.test("erpnext_shipment_list asks for pickup columns, not delivery_date", async () => {
  let capturedFields: string[] = [];
  const client = makeMockClient({
    list: async (_doctype: string, opts: { fields?: string[] }) => {
      capturedFields = opts?.fields ?? [];
      return [];
    },
  });

  await tool("erpnext_shipment_list").handler({}, makeCtx(client));

  // Shipment không có `delivery_date`; ngày có thật là `pickup_date` kèm hai đầu địa chỉ.
  // Hỏi cột không tồn tại làm cả truy vấn chết với SQL 1054 chứ không bị bỏ qua im lặng.
  assertEquals(capturedFields.includes("pickup_date"), true);
  assertEquals(capturedFields.includes("pickup_from"), true);
  assertEquals(capturedFields.includes("pickup_to"), true);
  assertEquals(capturedFields.includes("delivery_date"), false);
});

Deno.test("erpnext_shipment_list ranges the date filters over pickup_date", async () => {
  let capturedFilters: unknown[][] = [];
  const client = makeMockClient({
    list: async (_doctype: string, opts: { filters?: unknown[][] }) => {
      capturedFilters = opts?.filters ?? [];
      return [];
    },
  });

  await tool("erpnext_shipment_list").handler(
    { date_from: "2026-01-01", date_to: "2026-01-31" },
    makeCtx(client),
  );

  assertEquals(capturedFilters, [
    ["pickup_date", ">=", "2026-01-01"],
    ["pickup_date", "<=", "2026-01-31"],
  ]);
});
