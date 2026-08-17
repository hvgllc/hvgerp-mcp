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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { discoveryTools } from "./discovery.ts";
import { FrappeAPIError, type FrappeClient } from "../api/frappe-client.ts";
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
  // 7 standard columns, the 4 unconditional `optional_fields`, and the 3
  // declared fields that survived the filter. `_seen` is not among them because
  // this DocType does not set `track_seen`.
  assertEquals(result.count, 14);
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
    // Not in Frappe's `default_fields` but in its `optional_fields`, and real
    // columns on every DocType with a table of its own - `_assign` is the one
    // this server's own assignment filter queries.
    "_assign",
    "_user_tags",
    "_comments",
    "_liked_by",
  ]);
  // The fifth `optional_fields` name is conditional, and this DocType does not
  // set `track_seen`. See the dedicated test below.
  assertEquals(standard.some((f: any) => f.fieldname === "_seen"), false);
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
    // The owner enumeration has to answer with a row list. The blanket
    // `{ has_permission: true }` of the base mock is not one, and the tool now
    // treats a non-list as the broken contract it is - see the dedicated test.
    // Each source answers with its OWN owner column (`parent` for `DocField`,
    // `dt` for `Custom Field`); a row missing the column it was asked for is a
    // broken response, so the fixture may not hand `{ parent }` to both.
    callMethod: async (method: string, args: Record<string, unknown>) =>
      method === "frappe.client.get_list"
        ? (args.doctype === "Custom Field" ? [] : [{ parent: "Sales Invoice" }])
        : { has_permission: true },
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
 * caller can read. `enumerationError` replaces the `null` denial with any other
 * failure, which must NOT be answered with the degraded single-owner fallback.
 */
function makeChildPermissionClient(
  owners: string[] | null,
  readable: string[],
  asked: string[] = [],
  enumerationError?: Error,
): FrappeClient {
  return makeChildClient({
    callMethod: async (method: string, args: Record<string, unknown>) => {
      if (method === "frappe.client.get_list") {
        if (enumerationError) throw enumerationError;
        // A real denial arrives as HTTP 403, which is what separates it from a
        // timeout or a 5xx.
        if (owners === null) {
          throw new FrappeAPIError(
            `Not permitted for ${args.doctype}`,
            403,
            {},
          );
        }
        // These fixtures describe standard child tables, whose owners are all
        // declared in `DocField`; `Custom Field` legitimately owns none of
        // them, and must answer with its own column rather than `parent`.
        return args.doctype === "Custom Field"
          ? []
          : owners.map((parent) => ({ parent }));
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

Deno.test("erpnext_doctype_fields - offers the optional columns only where they exist", async () => {
  // Measured on the live instance: all 625 DocTypes with `istable = 0,
  // issingle = 0, is_virtual = 0` carry all four of these columns and not one of
  // the 435 readable child tables carries any. A Single and a virtual DocType
  // have no table at all.
  const OPTIONAL = ["_assign", "_user_tags", "_comments", "_liked_by"];
  const optionalOf = (result: any) =>
    result.fields.filter((f: any) => OPTIONAL.includes(f.fieldname));

  const ordinary = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;
  assertEquals(optionalOf(ordinary).map((f: any) => f.fieldname), OPTIONAL);
  assertEquals(optionalOf(ordinary).every((f: any) => f.is_standard), true);
  assertEquals(optionalOf(ordinary).every((f: any) => f.queryable), true);

  const child = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(makeChildClient()),
  ) as any;
  assertEquals(optionalOf(child), []);

  const single = await getTool("erpnext_doctype_fields").handler(
    { doctype: "System Settings" },
    makeCtx(makeMockClient({
      callMethodRaw: async () => ({
        docs: [{ ...META, name: "System Settings", issingle: 1 }],
      }),
    })),
  ) as any;
  assertEquals(optionalOf(single), []);
});

Deno.test("erpnext_doctype_fields - offers _seen only where track_seen is on", async () => {
  // The fifth `optional_fields` name is the one that is NOT unconditional:
  // measured across all 625 ordinary DocTypes, the column is present on exactly
  // the 21 that set `track_seen` and absent on the other 604. Announcing it
  // everywhere would invent a column on 604 DocTypes.
  const seenOf = (result: any) =>
    result.fields.find((f: any) => f.fieldname === "_seen");

  const tracked = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice" },
    makeCtx(makeMockClient({
      callMethodRaw: async () => ({
        docs: [{ ...META, name: "Sales Invoice", track_seen: 1 }],
      }),
    })),
  ) as any;
  assertEquals(seenOf(tracked).is_standard, true);
  assertEquals(seenOf(tracked).queryable, true);
  // It comes after the four unconditional ones, so the ordering stays stable.
  assertEquals(tracked.fields.at(-1).fieldname !== "_seen", true);
  assertEquals(
    tracked.fields.filter((f: any) => f.is_standard).at(-1).fieldname,
    "_seen",
  );

  // `track_seen` absent from the metadata is the same answer as 0: the column
  // is not there.
  const untracked = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;
  assertEquals(seenOf(untracked), undefined);

  const off = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient({
      callMethodRaw: async () => ({ docs: [{ ...META, track_seen: 0 }] }),
    })),
  ) as any;
  assertEquals(seenOf(off), undefined);

  // A child table does not get it even when the flag is set, for the same
  // reason it gets none of the other four.
  const child = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(makeChildClient({
      callMethodRaw: async (_method: string, args: Record<string, unknown>) =>
        args.with_parent
          ? { docs: [PARENT_META, { ...CHILD_META, track_seen: 1 }] }
          : { docs: [{ ...CHILD_META, track_seen: 1 }] },
    })),
  ) as any;
  assertEquals(seenOf(child), undefined);
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

Deno.test("erpnext_doctype_fields - an Image field is not queryable", async () => {
  // `Image` is one of Frappe's ten `no_value_fields`: it renders a URL held by
  // another field (its `options`) and stores nothing itself. Measured against
  // the real schema, all 17 `Image` DocField rows on table-backed DocTypes have
  // no column, and every fieldtype outside `no_value_fields` always has one.
  const client = makeMockClient({
    callMethodRaw: async () => ({
      docs: [{
        ...META,
        fields: [
          ...META.fields,
          {
            fieldname: "image_view",
            label: "Image View",
            fieldtype: "Image",
            options: "image",
          },
        ],
      }],
    }),
  });

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(client),
  ) as any;

  const image = result.fields.find((f: any) => f.fieldname === "image_view");
  assertEquals(image.queryable, false);
  // A stored field of the same DocType stays queryable, so this is the field's
  // own storage talking and not a DocType-wide verdict.
  assertEquals(
    result.fields.find((f: any) => f.fieldname === "account_name").queryable,
    true,
  );
});

Deno.test("erpnext_doctype_fields - a transient parent enumeration failure is not read as a denial", async () => {
  // The degraded path names ONE arbitrary owner and gates the caller against
  // that one name, so answering a 5xx with it refuses metadata to a caller who
  // can read a different owner - a permission verdict invented from a timeout.
  const client = makeChildPermissionClient(
    ["Sales Invoice"],
    ["Sales Invoice"],
    [],
    new FrappeAPIError("Internal Server Error", 500, {}),
  );

  await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    FrappeAPIError,
    "Internal Server Error",
  );
});

Deno.test("erpnext_doctype_fields - a 403 on parent enumeration still falls back to the single owner", async () => {
  // The counterpart of the test above: an account that genuinely may not read
  // `DocField` keeps the degraded answer it has always had.
  const asked: string[] = [];
  const client = makeChildPermissionClient(null, ["Sales Invoice"], asked);

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(client),
  ) as any;

  assertEquals(result.is_child_table, true);
  // The single name `getdoctype` attaches, not an enumerated list - and it is
  // the only DocType the gate gets to ask about.
  assertEquals(asked, ["Sales Invoice"]);
});

Deno.test("erpnext_doctype_fields - a non-array owner enumeration is an error, not an empty list", async () => {
  // A response of some other shape means the endpoint broke its contract - a
  // custom app shadowing `frappe.client.get_list`, a proxy rewriting the body.
  // Reading it as "no owners" would answer a broken contract with a permission
  // verdict, and reading it as "all owners" would hand out schema unchecked.
  for (const broken of [null, {}, "nope", 7]) {
    const client = makeChildClient({
      callMethod: async (method: string) => {
        if (method === "frappe.client.get_list") return broken;
        return { has_permission: true };
      },
    });

    await assertRejects(
      () =>
        getTool("erpnext_doctype_fields").handler(
          { doctype: "Sales Invoice Item" },
          makeCtx(client),
        ),
      Error,
      "broken response",
    );
  }
});

Deno.test("erpnext_doctype_fields - a truncated owner list does not blame the caller's permissions", async () => {
  // Hitting the row ceiling says nothing about the caller's roles - measured on
  // the live instance, the busiest child table has 10 owners against a ceiling
  // of 100 - so the refusal must not send an administrator off to ask for a
  // DocField permission they already hold.
  const owners = Array.from({ length: 100 }, (_, index) => `Owner ${index}`);
  const client = makeChildPermissionClient(owners, []);

  const error = await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
  );

  assertStringIncludes(error.message, "unrelated to your permissions");
  assertStringIncludes(error.message, "stopped at 100 rows");
  assertEquals(error.message.includes("DocField"), false);
});

Deno.test("erpnext_doctype_fields - a full-but-short owner list claims no gap at all", async () => {
  // The ordinary case: fewer rows than the ceiling means the list is the whole
  // truth, and the refusal must not hedge about a partiality that is not there.
  const client = makeChildPermissionClient(["Sales Invoice", "Quotation"], []);

  const error = await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
  );

  assertEquals(error.message.includes("may be partial"), false);
  assertStringIncludes(error.message, "any of its parent DocTypes");
});

Deno.test("erpnext_doctype_fields - a single owner is named in the singular", async () => {
  const client = makeChildPermissionClient(["Sales Invoice"], []);

  const error = await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
  );

  assertStringIncludes(error.message, "its parent DocType (Sales Invoice)");
});

Deno.test("erpnext_doctype_fields - a non-boolean permission answer is an error, not a denial", async () => {
  // `Boolean(res?.has_permission)` was wrong in both directions. A missing
  // field became a denial, hiding a broken endpoint behind a permission
  // message; and any truthy junk became a grant - the string `"false"` being
  // the cruel case, because the metadata behind this gate comes from
  // `getdoctype`, which checks nothing itself.
  for (const broken of [undefined, null, "false", "true", 1, 0, {}]) {
    const client = makeMockClient({
      callMethod: async () => ({ has_permission: broken }),
    });

    const error = await assertRejects(
      () =>
        getTool("erpnext_doctype_fields").handler(
          { doctype: "Account" },
          makeCtx(client),
        ),
      Error,
      "broken response",
    );
    // Never the permission wording: a malformed answer is not a verdict, and
    // sending the caller off to ask for a role would be a lie.
    assertEquals(error.message.includes("read permission"), false);
  }
});

/**
 * Route the owner enumeration per source.
 *
 * A `Table` field can be declared in `DocField` or, when it was added through
 * Customize Form or an app's installer, in `Custom Field` - where the owner is
 * named by `dt` rather than `parent`. Each source answers independently here,
 * including with its own 403.
 */
function makeOwnerSourceClient(
  docFieldOwners: string[] | Error,
  customFieldOwners: string[] | Error,
  readable: string[],
  asked: string[] = [],
): FrappeClient {
  return makeChildClient({
    callMethod: async (method: string, args: Record<string, unknown>) => {
      if (method === "frappe.client.get_list") {
        const source = args.doctype === "Custom Field"
          ? customFieldOwners
          : docFieldOwners;
        if (source instanceof Error) throw source;
        return args.doctype === "Custom Field"
          ? source.map((dt) => ({ dt }))
          : source.map((parent) => ({ parent }));
      }
      asked.push(args.doctype as string);
      return { has_permission: readable.includes(args.doctype as string) };
    },
  });
}

Deno.test("erpnext_doctype_fields - finds an owner declared only as a Custom Field", async () => {
  // Measured on the live instance: 559 `DocField` Table rows against 4 `Custom
  // Field` ones, and those 4 are the ONLY owner of their child. `Department
  // Approver` (owned by `Department`) and `Designation Skill` (owned by
  // `Designation`) resolved to zero owners from `DocField` alone, so both were
  // refused for every caller including Administrator, with a message claiming
  // no owner exists.
  const asked: string[] = [];
  const client = makeOwnerSourceClient(
    [],
    ["Department"],
    ["Department"],
    asked,
  );

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Department Approver" },
    makeCtx(client),
  ) as any;

  assertEquals(asked, ["Department"]);
  assertEquals(result.is_child_table, true);
});

Deno.test("erpnext_doctype_fields - names the owner source that was actually denied", async () => {
  // A caller may hold `DocField` and not `Custom Field`. Naming `DocField`
  // regardless sends them to fix a permission they already have.
  const denial = new FrappeAPIError("Not permitted for Custom Field", 403, {});
  const client = makeOwnerSourceClient([], denial, []);

  const error = await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Department Approver" },
        makeCtx(client),
      ),
    Error,
  );

  assertStringIncludes(error.message, "read access to Custom Field");
  assertEquals(error.message.includes("DocField"), false);
});

Deno.test("erpnext_doctype_fields - one readable source is not degraded by the other being denied", async () => {
  // `DocField` answered and its owner is readable, so the verdict is already
  // decided and the single arbitrary name from `getdoctype` must NOT be
  // reached for: it would spend a request on a name that changes nothing.
  const denial = new FrappeAPIError("Not permitted for Custom Field", 403, {});
  const asked: string[] = [];
  const client = makeOwnerSourceClient(
    ["Quotation"],
    denial,
    ["Quotation"],
    asked,
  );

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(client),
  ) as any;

  // `Sales Invoice` is what `getdoctype(with_parent=1)` would have added.
  assertEquals(asked, ["Quotation"]);
  assertEquals(result.is_child_table, true);
});

Deno.test("erpnext_doctype_fields - both sources denied names both and falls back", async () => {
  const denial = new FrappeAPIError("Not permitted", 403, {});
  const asked: string[] = [];
  const client = makeOwnerSourceClient(denial, denial, [], asked);

  const error = await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
  );

  assertStringIncludes(
    error.message,
    "read access to DocField and Custom Field",
  );
  // Only when no source could be read at all is the single arbitrary owner
  // from `getdoctype` worth having.
  assertEquals(asked, ["Sales Invoice"]);
});

Deno.test("erpnext_doctype_fields - a denied source still reaches the fallback when nothing enumerated is readable", async () => {
  // The regression a stricter rule caused: a standard child table declares its
  // owner in `DocField` alone, so a caller who may not read `DocField` but may
  // read `Custom Field` enumerated an EMPTY list without every source refusing.
  // A fallback gated on "all sources refused" never fired, and the caller was
  // told no parent could be resolved - while `getdoctype` names the parent they
  // can read all along.
  const denial = new FrappeAPIError("Not permitted for DocField", 403, {});
  const asked: string[] = [];
  const client = makeOwnerSourceClient(denial, [], ["Sales Invoice"], asked);

  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Sales Invoice Item" },
    makeCtx(client),
  ) as any;

  assertEquals(asked, ["Sales Invoice"]);
  assertEquals(result.is_child_table, true);
});

Deno.test("erpnext_doctype_fields - the fallback stays unprobed when the enumeration was complete", async () => {
  // No source refused, so the list is the whole truth. Reaching for the
  // arbitrary single name would put a DocType in the refusal message that the
  // enumeration already proved is not an owner of this child.
  const asked: string[] = [];
  const client = makeOwnerSourceClient(["Quotation"], [], [], asked);

  const error = await assertRejects(
    () =>
      getTool("erpnext_doctype_fields").handler(
        { doctype: "Sales Invoice Item" },
        makeCtx(client),
      ),
    Error,
  );

  assertEquals(asked, ["Quotation"]);
  assertStringIncludes(error.message, "(Quotation)");
  assertEquals(error.message.includes("That list may be partial"), false);
});

Deno.test("erpnext_doctype_fields - an owner row without the field it was asked for is a broken response", async () => {
  // `fields: [ownerField]` was the only column requested and it is mandatory on
  // every row of that table, so a row without it broke the contract. Dropping
  // it would shrink the owner list and hand back a permission refusal for what
  // is really an upstream fault.
  for (const broken of [{}, { parent: "" }, { parent: null }, { dt: "X" }]) {
    const client = makeChildClient({
      callMethod: async (method: string, args: Record<string, unknown>) =>
        method === "frappe.client.get_list"
          ? (args.doctype === "Custom Field" ? [] : [broken])
          : { has_permission: true },
    });

    const error = await assertRejects(
      () =>
        getTool("erpnext_doctype_fields").handler(
          { doctype: "Sales Invoice Item" },
          makeCtx(client),
        ),
      Error,
      "no 'parent' value",
    );
    // A broken response must not be reported as a permission verdict.
    assertEquals(error.message.includes("stays out of scope"), false);
  }
});

Deno.test("erpnext_doctype_fields - the _user_tags filter advice matches how v16 stores tags", async () => {
  // `DocTags.update` writes `",".join(tags)`: no leading comma, no trailing
  // one. Measured on the live instance - 23 distinct `_user_tags` values, 13 of
  // them a bare single tag, 0 of the 115 rows carrying a comma at either end.
  // The comma-padded pattern this once advertised therefore matched the first
  // tag, the last tag and every single-tag document never, and a model
  // following it reads the empty result as "no document carries this tag".
  const result = await getTool("erpnext_doctype_fields").handler(
    { doctype: "Account" },
    makeCtx(makeMockClient()),
  ) as any;

  const tags = result.fields.find((f: any) => f.fieldname === "_user_tags");
  assertStringIncludes(tags.description, "no leading or trailing comma");
  assertStringIncludes(
    tags.description,
    '["_user_tags", "like", "%Research%"]',
  );
  // The advice must not hand back the pattern it exists to warn about.
  assertEquals(tags.description.includes('"like", "%,'), false);
});
