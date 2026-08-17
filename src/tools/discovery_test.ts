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
  let permChecks = 0;
  const client = makeMockClient({
    callMethod: async () => {
      permChecks++;
      return { has_permission: false };
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
  // The metadata call runs first now - it is what tells the tool whether this
  // is a child table - but the gate still has to be asked, and its answer still
  // has to stop the schema from being returned.
  assertEquals(permChecks, 1);
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

/** The declared fields only, i.e. what the DocType form itself defines. */
function declaredNames(result: any): string[] {
  return result.fields.filter((f: any) => !f.is_standard).map((f: any) =>
    f.fieldname
  );
}

Deno.test("erpnext_doctype_fields - drops layout and hidden fields by default", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.doctype, "Account");
  assertEquals(result.is_tree, true);
  assertEquals(result.title_field, "account_name");
  assertEquals(
    declaredNames(result),
    ["account_name", "parent_account", "disabled"],
  );
  // 7 standard columns, `_assign`, and the 3 declared fields that survived the filter.
  assertEquals(result.count, 11);
  const declared = result.fields.filter((f: any) => !f.is_standard);
  assertEquals(declared[0].reqd, true);
  // A Link field must carry its target, or the model cannot follow the reference.
  assertEquals(declared[1].options, "Account");
});

Deno.test("erpnext_doctype_fields - lists the standard columns no form declares", async () => {
  // Without these, the tool answers "no such field" for `owner` and `modified` -
  // the two a model reaches for first to ask "mine" and "recent" - and the
  // caller then writes a filter ERPNext rejects.
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;

  const standard = result.fields.filter((f: any) => f.is_standard);
  assertEquals(standard.map((f: any) => f.fieldname), [
    "name",
    "owner",
    "creation",
    "modified",
    "modified_by",
    "docstatus",
    "idx",
    // Not one of Frappe's `default_fields`, but a real column on every DocType
    // with a table - and the one this server's own assignment filter queries.
    "_assign",
  ]);
  // `doctype` is in Frappe's default_fields tuple but is NOT a column: it is
  // attached in memory, so filtering or sorting on it fails at the database.
  assertEquals(standard.some((f: any) => f.fieldname === "doctype"), false);
  assertEquals(standard[1].options, "User");
  assertEquals(standard[1].read_only, true);
  // A child table carries three more columns; a normal DocType must not claim them.
  assertEquals(standard.some((f: any) => f.fieldname === "parent"), false);
});

/** The child DocType and the invoice that owns it, as `getdoctype` returns them. */
const CHILD_META = { ...META, name: "Sales Invoice Item", istable: 1 };
const PARENT_META = {
  ...META,
  name: "Sales Invoice",
  istable: 0,
  fields: [
    {
      fieldname: "items",
      label: "Items",
      fieldtype: "Table",
      options: "Sales Invoice Item",
    },
  ],
};

/**
 * Mock `getdoctype` the way ERPNext answers it: `with_parent: 0` returns the
 * requested DocType alone, `with_parent: 1` puts the owning DocType first.
 */
function makeChildClient(overrides: Record<string, AnyFn> = {}): FrappeClient {
  return makeMockClient({
    callMethodRaw: async (_method: string, args: Record<string, unknown>) =>
      args.with_parent
        ? { docs: [PARENT_META, CHILD_META] }
        : { docs: [CHILD_META] },
    ...overrides,
  });
}

Deno.test("erpnext_doctype_fields - adds the parent columns for a child table", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(makeChildClient()),
  ) as any;

  const standard = result.fields.filter((f: any) => f.is_standard).map((
    f: any,
  ) => f.fieldname);
  assertEquals(standard.slice(-3), ["parent", "parentfield", "parenttype"]);
  assertEquals(result.is_child_table, true);
});

/**
 * Route the two whitelisted calls the child-table gate makes.
 *
 * `owners` is what enumerating `DocField` returns, or `null` for the account
 * that may not read `DocField` at all. `readable` is the set of DocTypes the
 * caller can read.
 */
function makeChildPermissionClient(
  owners: string[] | null,
  readable: string[],
  asked: string[] = [],
): FrappeClient {
  return makeChildClient({
    callMethod: async (method: string, args: Record<string, unknown>) => {
      if (method === "frappe.client.get_list") {
        if (owners === null) throw new Error("PermissionError: DocField");
        return owners.map((parent) => ({ parent }));
      }
      asked.push(args.doctype as string);
      // The child itself is unreadable for everyone but Administrator, which is
      // exactly why the parent has to be the thing that is asked about.
      return { has_permission: readable.includes(args.doctype as string) };
    },
  });
}

Deno.test("erpnext_doctype_fields - checks a child table against the parent that owns it", async () => {
  const asked: string[] = [];
  const client = makeChildPermissionClient(
    ["Sales Invoice"],
    ["Sales Invoice"],
    asked,
  );

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(client),
  ) as any;

  assertEquals(asked, ["Sales Invoice"]);
  assertEquals(result.doctype, "Sales Invoice Item");
});

Deno.test("erpnext_doctype_fields - probes every owner, not just the one getdoctype names", async () => {
  // `getdoctype(with_parent=1)` names exactly one owner and which one is
  // arbitrary: measured live, `Sales Taxes and Charges` has six and the
  // endpoint returns `Quotation`. A caller who can read `Sales Invoice` but not
  // `Quotation` must still get the schema.
  const asked: string[] = [];
  const client = makeChildPermissionClient(
    ["Quotation", "Sales Order", "Sales Invoice"],
    ["Sales Invoice"],
    asked,
  );

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(client),
  ) as any;

  assertEquals(asked, ["Quotation", "Sales Order", "Sales Invoice"]);
  assertEquals(result.doctype, "Sales Invoice Item");
});

Deno.test("erpnext_doctype_fields - refuses a child table when no owner is readable", async () => {
  const client = makeChildPermissionClient(["Sales Invoice", "Quotation"], []);

  await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
    "Sales Invoice, Quotation",
  );
});

Deno.test("erpnext_doctype_fields - says so when the owner list could not be enumerated", async () => {
  // No `DocField` access means only `getdoctype`'s single owner is known, so
  // the refusal must not present that name as the complete list of owners.
  const client = makeChildPermissionClient(null, []);

  await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
    "That list may be partial",
  );
});

Deno.test("erpnext_doctype_fields - include_hidden brings back the hidden ones", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account", include_hidden: true },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(declaredNames(result), [
    "account_name",
    "parent_account",
    "disabled",
    "lft",
  ]);
});

Deno.test("erpnext_doctype_fields - search matches fieldname and label", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account", search: "PARENT" },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.fields.map((f: any) => f.fieldname), ["parent_account"]);
});

Deno.test("erpnext_doctype_fields - search filters the standard columns too", async () => {
  // Otherwise a narrow search returns every standard column alongside the one
  // declared field that matched, which is the opposite of narrowing.
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account", search: "modified" },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.fields.map((f: any) => f.fieldname), [
    "modified",
    "modified_by",
  ]);
});

Deno.test("erpnext_doctype_fields - marks a Single's fields as not queryable", async () => {
  const client = makeMockClient({
    callMethodRaw: async () => ({
      docs: [{ ...META, name: "System Settings", issingle: 1 }],
    }),
  });

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "System Settings" },
    makeCtx(client),
  ) as any;

  // A Single lives in `tabSingles`; there is no `tabSystem Settings` to filter
  // or sort against, so neither the standard columns nor the declared fields
  // may be presented as usable in a filter or an order_by.
  assertEquals(result.is_single, true);
  assertEquals(result.fields.some((f: any) => f.queryable), false);
  assertEquals(
    result.fields.some((f: any) => f.is_standard && f.fieldname === "modified"),
    true,
  );
});

Deno.test("erpnext_doctype_fields - marks a virtual doctype's fields as not queryable", async () => {
  const client = makeMockClient({
    callMethodRaw: async () => ({
      docs: [{ ...META, name: "RQ Job", is_virtual: 1 }],
    }),
  });

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "RQ Job" },
    makeCtx(client),
  ) as any;

  // A virtual DocType has no table either; its rows come from a Python
  // controller, so nothing here can promise that a filter or an order_by will
  // be honoured. 20 of them exist on the live instance.
  assertEquals(result.is_virtual, true);
  assertEquals(result.fields.some((f: any) => f.queryable), false);
});

Deno.test("erpnext_doctype_fields - an ordinary doctype keeps its fields queryable", async () => {
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;

  assertEquals(result.fields.every((f: any) => f.queryable), true);
  assertEquals(result.is_virtual, false);
});

Deno.test("erpnext_doctype_fields - a child table field is not queryable on the parent", async () => {
  const client = makeMockClient({
    callMethodRaw: async () => ({
      docs: [{
        ...META,
        name: "Sales Invoice",
        fields: [
          ...META.fields,
          {
            fieldname: "items",
            label: "Items",
            fieldtype: "Table",
            options: "Sales Invoice Item",
          },
          {
            fieldname: "sales_team",
            label: "Sales Team",
            fieldtype: "Table MultiSelect",
            options: "Sales Team",
          },
        ],
      }],
    }),
  });

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice" },
    makeCtx(client),
  ) as any;

  // The rows live in the child DocType and are joined back by `parent`, so the
  // parent table has no column of that name - measured on the live instance,
  // `tabSales Invoice` has no column for any of its 11 `Table` fields.
  const byName = (fieldname: string) =>
    result.fields.find((f: any) => f.fieldname === fieldname);
  assertEquals(byName("items").queryable, false);
  assertEquals(byName("sales_team").queryable, false);
  // The DocType itself is perfectly ordinary, so its stored fields stay queryable.
  assertEquals(result.is_virtual, false);
  assertEquals(byName("account_name").queryable, true);
  assertEquals(byName("name").queryable, true);
});

Deno.test("erpnext_doctype_fields - a virtual field is not queryable on an ordinary doctype", async () => {
  const client = makeMockClient({
    callMethodRaw: async () => ({
      docs: [{
        ...META,
        name: "Sales Invoice",
        fields: [
          ...META.fields,
          {
            fieldname: "last_scanned_warehouse",
            label: "Last Scanned Warehouse",
            fieldtype: "Data",
            is_virtual: 1,
          },
        ],
      }],
    }),
  });

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice" },
    makeCtx(client),
  ) as any;

  // Computed by a Python property, never stored - so there is no column to
  // filter or sort on even though the DocType has a table.
  assertEquals(
    result.fields.find((f: any) => f.fieldname === "last_scanned_warehouse")
      .queryable,
    false,
  );
  assertEquals(
    result.fields.find((f: any) => f.fieldname === "account_name").queryable,
    true,
  );
});

Deno.test("erpnext_doctype_fields - offers _assign only where the column exists", async () => {
  // Measured on the live instance: all 625 DocTypes with `istable = 0,
  // issingle = 0, is_virtual = 0` carry the `_assign` column and not one of the
  // 447 child tables does. A Single and a virtual DocType have no table at all.
  const assignOf = (result: any) =>
    result.fields.find((f: any) => f.fieldname === "_assign");

  const ordinary = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;
  assertEquals(assignOf(ordinary).is_standard, true);
  assertEquals(assignOf(ordinary).queryable, true);

  const child = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(makeChildClient()),
  ) as any;
  assertEquals(assignOf(child), undefined);

  const single = await getTool("erpnext_doctype_fields").handler(
    { doctype: "System Settings" },
    makeCtx(makeMockClient({
      callMethodRaw: async () => ({
        docs: [{ ...META, name: "System Settings", issingle: 1 }],
      }),
    })),
  ) as any;
  assertEquals(assignOf(single), undefined);
});

Deno.test("erpnext_doctype_fields - refuses metadata that carries no field list", async () => {
  // A response with no `fields` array is broken, not a DocType that declares
  // nothing. Returning the synthetic standard columns alone would tell a model
  // that every real field of the DocType does not exist.
  const client = makeMockClient({
    callMethodRaw: async () => ({
      docs: [{ name: "Account", module: "Accounts" }],
    }),
  });

  await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Account" },
        makeCtx(client),
      ),
    Error,
    "no field list",
  );
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
