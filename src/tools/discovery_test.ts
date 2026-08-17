/**
 * Discovery Tools Tests
 *
 * The metadata endpoint behind erpnext_doctype_fields has no permission check
 * of its own, so the gate this tool imposes is the whole point: these tests
 * pin it down.
 *
 * @module lib/erpnext/tests/tools/discovery_test
 */

// deno-lint-ignore-file no-explicit-any

import { assertEquals, assertRejects } from "@std/assert";
import { discoveryTools } from "./discovery.ts";
import type { FrappeClient } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

type AnyFn = (...args: any[]) => any;

function makeMockClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  const mock: Record<string, AnyFn> = {
    list: async () => [],
    get: async () => ({ name: "TEST-001" }),
    create: async () => ({ name: "NEW-001" }),
    update: async () => ({ name: "TEST-001" }),
    delete: async () => {},
    callMethod: async () => ({ has_permission: true }),
    callMethodRaw: async () => ({ docs: [META] }),
    invalidate: () => {},
    ...overrides,
  };
  return mock as unknown as FrappeClient;
}

function makeCtx(client: FrappeClient): ErpNextToolContext {
  return { client };
}

function getTool(name: string) {
  const tool = discoveryTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

const META = {
  name: "Account",
  module: "Accounts",
  issingle: 0,
  istable: 0,
  is_submittable: 0,
  is_tree: 1,
  title_field: "account_name",
  fields: [
    { fieldname: "sb_main", fieldtype: "Section Break" },
    { fieldname: "col_1", fieldtype: "Column Break" },
    {
      fieldname: "account_name",
      label: "Account Name",
      fieldtype: "Data",
      reqd: 1,
    },
    {
      fieldname: "parent_account",
      label: "Parent Account",
      fieldtype: "Link",
      options: "Account",
    },
    { fieldname: "disabled", label: "Disable", fieldtype: "Check" },
    {
      fieldname: "lft",
      label: "lft",
      fieldtype: "Int",
      hidden: 1,
      read_only: 1,
    },
  ],
};

Deno.test("erpnext_doctype_fields - refuses when the caller cannot read the doctype", async () => {
  let metaCalls = 0;
  const client = makeMockClient({
    callMethod: async () => ({ has_permission: false }),
    callMethodRaw: async () => {
      metaCalls++;
      return { docs: [META] };
    },
  });

  await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Employee" },
        makeCtx(client),
      ),
    Error,
    "read permission",
  );
  // The gate must run before the metadata call, not alongside it.
  assertEquals(metaCalls, 0);
});

Deno.test("erpnext_doctype_fields - asks ERPNext about the requested doctype", async () => {
  let permArgs: Record<string, unknown> = {};
  let metaArgs: Record<string, unknown> = {};
  const client = makeMockClient({
    callMethod: async (_method: string, args: Record<string, unknown>) => {
      permArgs = args;
      return { has_permission: true };
    },
    callMethodRaw: async (_method: string, args: Record<string, unknown>) => {
      metaArgs = args;
      return { docs: [META] };
    },
  });

  await getTool("erpnext_doctype_fields").handler(
    { doctype: "  Account  " },
    makeCtx(client),
  );

  assertEquals(permArgs.doctype, "Account");
  assertEquals(permArgs.perm_type, "read");
  assertEquals(metaArgs.doctype, "Account");
});

Deno.test("erpnext_doctype_fields - drops layout and hidden fields by default", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.doctype, "Account");
  assertEquals(result.is_tree, true);
  assertEquals(result.title_field, "account_name");
  assertEquals(
    result.fields.map((f: any) => f.fieldname),
    ["account_name", "parent_account", "disabled"],
  );
  assertEquals(result.count, 3);
  assertEquals(result.fields[0].reqd, true);
  // A Link field must carry its target, or the model cannot follow the reference.
  assertEquals(result.fields[1].options, "Account");
});

Deno.test("erpnext_doctype_fields - include_hidden brings back the hidden ones", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account", include_hidden: true },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.fields.length, 4);
  assertEquals(result.fields[3].fieldname, "lft");
});

Deno.test("erpnext_doctype_fields - search matches fieldname and label", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account", search: "PARENT" },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.fields.map((f: any) => f.fieldname), ["parent_account"]);
});

Deno.test("erpnext_doctype_fields - reports a misspelled doctype instead of returning nothing", async () => {
  const client = makeMockClient({ callMethodRaw: async () => ({ docs: [] }) });

  await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Acount" },
        makeCtx(client),
      ),
    Error,
    "no metadata",
  );
});
