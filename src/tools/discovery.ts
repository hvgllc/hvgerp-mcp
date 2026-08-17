/**
 * ERPNext Discovery Tools
 *
 * Metadata discovery: what a DocType actually stores, in the caller's own
 * permission scope.
 *
 * Without this, a model that wants to filter or read a specific field has only
 * one way to learn the schema: fetch a sample document and look at the keys it
 * happens to carry. That misses every field left null on the sample, hides the
 * labels a human would recognise, and says nothing about types, link targets,
 * or which fields are mandatory. Measured on a live instance, asking "what
 * fields does Account have?" produced a guess assembled from one row.
 *
 * `frappe.desk.form.load.getdoctype` returns the real meta bundle, but it does
 * NOT check permissions and it answers through `frappe.response["docs"]` rather
 * than `message` — hence `callMethodRaw`. The permission gate is therefore ours
 * to impose, and it is imposed by asking ERPNext rather than by reasoning about
 * roles: `frappe.client.has_permission` runs the same `frappe.has_permission`
 * the rest of the system runs. It is used instead of a one-row list probe
 * because it also answers for Single and child DocTypes, which cannot be
 * listed at all.
 *
 * @module lib/erpnext/tools/discovery
 */

import type { ErpNextTool } from "./types.ts";
import { FrappeAPIError } from "../api/frappe-client.ts";

/** Fieldtypes that only shape the form layout and carry no data. */
const LAYOUT_FIELDTYPES = new Set([
  "Section Break",
  "Column Break",
  "Tab Break",
  "Fold",
  "Heading",
  "HTML",
  "Button",
]);

/**
 * Fieldtypes that appear in a form but have no column on the DocType's table.
 *
 * Frappe keeps this rule in `frappe.model.no_value_fields`, which on the live
 * instance holds exactly ten entries: the seven layout types above plus
 * `Table`, `Table MultiSelect` and `Image`. Measured against the real schema -
 * every non-virtual `DocField` of every table-backed DocType, checked against
 * `DESCRIBE` of its parent table - the split is clean: those ten never have a
 * column (`Table` 472 rows, `Table MultiSelect` 35, `Image` 17, `Button` 93,
 * `Section Break` 1924, ...) and every other fieldtype always does.
 *
 * The two halves differ in what they store, not in what they can be queried on.
 * A `Table` field points at rows in the child DocType, joined back by `parent`;
 * an `Image` field stores nothing at all - its `options` names another field
 * that holds the URL, and the form just renders that. Either way the parent
 * table has no column of that name, so both are readable on a document and
 * never usable in `filters` or `order_by`. A model that trusted a DocType-wide
 * `queryable: true` here was being steered into an unknown-column error.
 *
 * Layout types are absent from this set only because they never reach the
 * predicate - they are dropped from the answer entirely. Together the two sets
 * cover `no_value_fields`, so a new no-value fieldtype upstream belongs in one
 * of them.
 */
const COLUMNLESS_FIELDTYPES = new Set([
  "Table",
  "Table MultiSelect",
  "Image",
]);

/** A field every DocType stores, described the way a `fields` row would be. */
interface StandardField {
  fieldname: string;
  label: string;
  fieldtype: string;
  options: string | null;
  description: string;
}

/**
 * The columns Frappe adds to every table, which `getdoctype` never lists.
 *
 * They are absent from the `fields` child table because nobody defined them in
 * the DocType form, yet they are real columns and they are exactly the ones a
 * model reaches for first: `owner` to ask "mine", `modified` to ask "recent",
 * `docstatus` to tell a draft from a submitted document. Leaving them out of
 * this tool's answer means the tool says a field does not exist when it does,
 * and the caller then writes a filter that ERPNext rejects.
 *
 * Mirrors `frappe/model/__init__.py::default_fields` minus `doctype`, which is
 * in that tuple but is NOT a column - it is attached in memory when a document
 * is loaded, so filtering or sorting on it fails at the database.
 */
const STANDARD_FIELDS: readonly StandardField[] = [
  {
    fieldname: "name",
    label: "ID",
    fieldtype: "Data",
    options: null,
    description: "Primary key of the document.",
  },
  {
    fieldname: "owner",
    label: "Created By",
    fieldtype: "Link",
    options: "User",
    description: "User who created the document.",
  },
  {
    fieldname: "creation",
    label: "Created On",
    fieldtype: "Datetime",
    options: null,
    description: "When the document was created.",
  },
  {
    fieldname: "modified",
    label: "Last Updated On",
    fieldtype: "Datetime",
    options: null,
    description: "When the document was last written.",
  },
  {
    fieldname: "modified_by",
    label: "Last Updated By",
    fieldtype: "Link",
    options: "User",
    description: "User who last wrote the document.",
  },
  {
    fieldname: "docstatus",
    label: "Document Status",
    fieldtype: "Int",
    options: null,
    description: "0 = draft, 1 = submitted, 2 = cancelled.",
  },
  {
    fieldname: "idx",
    label: "Index",
    fieldtype: "Int",
    options: null,
    description: "Position of the row inside its parent, or 0.",
  },
] as const;

/**
 * The three extra columns a child table carries, from
 * `frappe/model/__init__.py::child_table_fields`. Only meaningful when
 * `istable` is set, so they are merged in only then.
 */
const CHILD_TABLE_FIELDS: readonly StandardField[] = [
  {
    fieldname: "parent",
    label: "Parent",
    fieldtype: "Data",
    options: null,
    description: "Name of the document this row belongs to.",
  },
  {
    fieldname: "parentfield",
    label: "Parent Field",
    fieldtype: "Data",
    options: null,
    description: "Fieldname of the table this row sits in.",
  },
  {
    fieldname: "parenttype",
    label: "Parent Type",
    fieldtype: "Link",
    options: "DocType",
    description: "DocType of the parent document.",
  },
] as const;

/**
 * The assignment column every ordinary DocType carries and no child table does.
 *
 * `_assign` is one of Frappe's `optional_fields`, created on the table of every
 * DocType that has one: measured on the live instance, all 625 DocTypes with
 * `istable = 0, issingle = 0, is_virtual = 0` have the column and not one of
 * the 447 child tables does. It is also the column this server's own
 * `assignedToFilter` (`src/tools/assignment.ts`) queries, so leaving it out of
 * the schema told a caller "no such field" about the one column that answers
 * "assigned to me" - and the caller then had no way to build that filter for
 * itself.
 *
 * Merged in only when the DocType has a table of its own - which is exactly
 * what `doctypeQueryable` already answers for a Single and a virtual DocType -
 * and is not a child table. A child table is assigned through the document
 * that owns it.
 */
const ASSIGNMENT_FIELD: readonly StandardField[] = [
  {
    fieldname: "_assign",
    label: "Assigned To",
    fieldtype: "Text",
    options: null,
    description:
      'JSON array of User ids assigned to the document, stored as text. Filter it with a substring match that keeps the quotes, e.g. ["_assign", "like", "%\\"user@example.com\\"%"]; an unquoted pattern also matches every longer id ending in the same characters.',
  },
] as const;

/** One row of the `fields` child table of a DocType, as `getdoctype` returns it. */
interface RawDocField {
  fieldname?: string;
  label?: string;
  fieldtype?: string;
  options?: string | null;
  reqd?: number;
  read_only?: number;
  hidden?: number;
  in_list_view?: number;
  permlevel?: number;
  description?: string | null;
  default?: string | null;
  /**
   * A field computed by a Python property instead of stored. 33 DocField rows
   * carry it on the live instance, and none of them has a column - measured on
   * `tabSales Invoice`, whose only non-layout field without a column besides the
   * `Table` ones is `last_scanned_warehouse`, flagged exactly this way.
   */
  is_virtual?: number;
}

/** The DocType meta document `getdoctype` writes into `frappe.response.docs[0]`. */
interface RawDocTypeMeta {
  name?: string;
  module?: string;
  istable?: number;
  issingle?: number;
  is_virtual?: number;
  is_submittable?: number;
  is_tree?: number;
  title_field?: string | null;
  description?: string | null;
  fields?: RawDocField[];
}

/** Ask ERPNext whether the caller may read this DocType at all. */
async function canRead(
  ctx: Parameters<ErpNextTool["handler"]>[1],
  doctype: string,
): Promise<boolean> {
  const res = await ctx.client.callMethod<{ has_permission?: boolean }>(
    "frappe.client.has_permission",
    { doctype, docname: "", perm_type: "read" },
    { httpMethod: "GET" },
  );
  return Boolean(res?.has_permission);
}

/** Ask ERPNext whether the caller may read this DocType at all. */
async function assertReadable(
  ctx: Parameters<ErpNextTool["handler"]>[1],
  doctype: string,
): Promise<void> {
  if (!await canRead(ctx, doctype)) {
    throw new Error(
      `[erpnext_doctype_fields] You do not have read permission on '${doctype}'. ` +
        "Ask an ERPNext administrator for the role that grants it; do not guess the schema.",
    );
  }
}

/**
 * Ceiling on the `DocField` rows read while enumerating owners of a child table.
 *
 * This is a runaway guard, not a policy: the busiest child table on the live
 * instance is `Has Role` with 10 owning DocTypes, so a real answer never comes
 * close. Reaching the ceiling therefore means the enumeration is unusable
 * rather than long, and it is reported as incomplete instead of being passed
 * off as the full list.
 */
const MAX_PARENT_ROWS = 100;

/** Who owns a child table, and whether that list is the whole truth. */
interface ParentResolution {
  parents: string[];
  /**
   * False when the caller could not enumerate `DocField` and only the single
   * parent `getdoctype` names is known. A refusal built on an incomplete list
   * has to say so: the caller may well be able to read an owner that is not on
   * it.
   */
  complete: boolean;
}

/**
 * List every DocType that declares this child in a Table field.
 *
 * `getdoctype(child, with_parent=1)` cannot answer this. Its helper
 * `frappe.model.meta.get_parent_dt` is built on `frappe.db.get_value`, so it
 * returns exactly ONE parent and which one is arbitrary - measured on the live
 * instance, `Sales Taxes and Charges` is owned by six DocTypes (Delivery Note,
 * POS Invoice, Quotation, Sales Invoice, Sales Order, Sales Taxes and Charges
 * Template) and the endpoint names only `Quotation`. Gating on that single name
 * denies a caller who can read `Sales Invoice` but not `Quotation`.
 *
 * Enumerating `DocField` gives the real list, and it is not a permission hole:
 * `frappe.client.get_list` applies DocType permissions like any other list, so
 * an account that cannot read `DocField` gets a `PermissionError` here -
 * measured for `khoa.do@havigroup.com`, whose `has_permission('DocField',
 * 'read')` is false. That case falls back to the single name, flagged
 * incomplete.
 */
async function resolveChildParents(
  ctx: Parameters<ErpNextTool["handler"]>[1],
  doctype: string,
): Promise<ParentResolution> {
  try {
    const rows = await ctx.client.callMethod<{ parent?: string }[]>(
      "frappe.client.get_list",
      {
        doctype: "DocField",
        parent: "DocType",
        filters: [
          ["fieldtype", "in", ["Table", "Table MultiSelect"]],
          ["options", "=", doctype],
        ],
        fields: ["parent"],
        limit_page_length: MAX_PARENT_ROWS,
      },
      { httpMethod: "GET" },
    );
    if (Array.isArray(rows)) {
      const names = [
        ...new Set(
          rows
            .map((row) => row?.parent)
            .filter((name): name is string => !!name && name !== doctype),
        ),
      ];
      return { parents: names, complete: rows.length < MAX_PARENT_ROWS };
    }
  } catch (error) {
    // Only a permission denial earns the degraded answer. The fallback below
    // names ONE arbitrary owner, and the caller is then gated against that one
    // name - so a caller who can read a different owner is refused metadata
    // they are entitled to. That is an acceptable price for an account that
    // genuinely cannot read `DocField`, and a wrong answer for a timeout or a
    // 5xx, which say nothing about who owns this child table. `identity.ts`
    // draws the same line for the same reason.
    if (!(error instanceof FrappeAPIError) || error.status !== 403) throw error;
  }

  // `with_parent: 1` makes `getdoctype` attach the owning DocType alongside the
  // child. One name only, but it is the one answer a caller with no `DocField`
  // access can still get.
  const envelope = await ctx.client.callMethodRaw<
    { docs?: RawDocTypeMeta[] }
  >(
    "frappe.desk.form.load.getdoctype",
    { doctype, with_parent: 1 },
    { httpMethod: "GET" },
  );
  const parents: string[] = [];
  for (const candidate of envelope?.docs ?? []) {
    const name = candidate.name;
    if (!name || name === doctype || parents.includes(name)) continue;
    const ownsIt = (candidate.fields ?? []).some(
      (field) =>
        (field.fieldtype === "Table" ||
          field.fieldtype === "Table MultiSelect") &&
        field.options === doctype,
    );
    if (ownsIt) parents.push(name);
  }
  return { parents, complete: false };
}

/**
 * Gate a child DocType through a parent document the caller may read.
 *
 * A child DocType carries no role permissions of its own, so asking
 * `frappe.has_permission('Sales Invoice Item', 'read')` returns false for every
 * account except Administrator - measured on the live instance as
 * `khoa.do@havigroup.com`. Gating on that answer would make this tool reject
 * every child table for every real user, while still advertising child-table
 * support. ERPNext itself derives child access from the parent that owns the
 * row, and that is what is reproduced here: resolve the DocTypes that declare
 * this child in a Table field, and require read permission on at least one.
 */
async function assertChildReadable(
  ctx: Parameters<ErpNextTool["handler"]>[1],
  doctype: string,
): Promise<void> {
  const { parents, complete } = await resolveChildParents(ctx, doctype);

  // Every resolved parent is probed. There is no cap: the list is already
  // bounded by how many DocTypes really declare this child, and cutting it
  // short would deny a caller over an owner that was never checked.
  for (const parent of parents) {
    if (await canRead(ctx, parent)) return;
  }

  throw new Error(
    `[erpnext_doctype_fields] '${doctype}' is a child table, so it has no ` +
      "permissions of its own; access comes from the document that owns it. " +
      (parents.length > 0
        ? `You cannot read ${
          complete ? "any of its parent DocTypes" : "the parent DocType"
        } (${parents.join(", ")}), so its schema stays out of scope.`
        : "No parent DocType could be resolved for it, so there is nothing to " +
          "check the permission against.") +
      (complete
        ? ""
        : " That list may be partial: enumerating the owners requires read " +
          "access to DocField, which this account does not have, so another " +
          "DocType you can read may own this table.") +
      " Ask an ERPNext administrator for the role that grants the parent.",
  );
}

export const discoveryTools: ErpNextTool[] = [
  {
    name: "erpnext_doctype_fields",
    annotations: { readOnlyHint: true },
    description:
      "Describe the fields of an ERPNext DocType: fieldname, label, fieldtype, link target, " +
      "whether it is mandatory or read-only, and its permission level. Use this before " +
      "erpnext_doc_list / erpnext_doc_get when you need to filter, sort or select a field and " +
      "are not certain it exists — reading a sample document only reveals the fields that " +
      "happen to be filled in. The answer also lists the standard columns every DocType stores " +
      "(name, owner, creation, modified, modified_by, docstatus, idx, plus _assign on any DocType " +
      "with a table of its own) marked is_standard, because " +
      "they appear in no form. _assign is the JSON array of User ids assigned to a document, so it " +
      "is how you answer 'assigned to me': filter it with a quoted substring match. " +
      "Every field carries queryable: false means the value can be read " +
      "but cannot be relied on in a filter or order_by. That is the case for every field of a " +
      "Single DocType (no table of its own) and of a virtual DocType (rows come from a Python " +
      "controller, so only that controller decides what it will filter on), and for individual " +
      "Table / Table MultiSelect fields (their values are rows in the child DocType, so the " +
      "parent table has no such column - read them with erpnext_doc_get on a parent document, " +
      "which returns the child rows inline; do not try to list the child DocType directly, it " +
      "carries no permissions of its own and the call is refused), Image fields (they display a " +
      "URL held by another field and store nothing themselves) and virtual fields " +
      "(computed in Python, never stored). Fails with a permission error if the " +
      "caller cannot read the DocType; for a child table the check runs against a parent DocType " +
      "that owns it, because child tables carry no permissions of their own.",
    category: "discovery",
    inputSchema: {
      type: "object",
      properties: {
        doctype: {
          type: "string",
          description:
            "DocType name, exactly as ERPNext spells it, e.g. 'Sales Invoice', 'Account'.",
          minLength: 1,
        },
        search: {
          type: "string",
          description:
            "Case-insensitive substring filter on fieldname and label.",
        },
        include_hidden: {
          type: "boolean",
          description:
            "Include fields flagged hidden in the form (default false).",
        },
      },
      required: ["doctype"],
    },
    handler: async (input, ctx) => {
      const doctype = (input.doctype as string).trim();
      if (!doctype) {
        throw new Error("[erpnext_doctype_fields] 'doctype' must not be empty");
      }

      // The meta is fetched BEFORE the permission gate because the gate itself
      // depends on it: a child DocType has to be checked against its parent,
      // and nothing but the meta says whether this is one. No part of it is
      // returned unless the gate below passes, and reading it early grants no
      // access the caller did not already have - `getdoctype` is whitelisted
      // and performs no permission check of its own, which is exactly why this
      // module imposes one.
      //
      // It does mean a missing DocType and an unreadable one fail differently.
      // That is Frappe's own behaviour on every access path, not something this
      // ordering introduces: measured as `khoa.do@` (an employee for whom
      // `has_permission('DocType', 'read')` is false), `frappe.get_list` raises
      // `DoesNotExistError` - HTTP 404, message "DocType X not found" - for a
      // name that does not exist and `PermissionError` - HTTP 403 - for one
      // that does, so `/api/resource/<name>` is already that oracle for any
      // authenticated user. Collapsing the two here would hide nothing and
      // would cost the caller the one distinction worth having: a typo in the
      // DocType name versus a missing role.
      const envelope = await ctx.client.callMethodRaw<
        { docs?: RawDocTypeMeta[] }
      >(
        "frappe.desk.form.load.getdoctype",
        { doctype, with_parent: 0 },
        { httpMethod: "GET" },
      );
      const meta = envelope?.docs?.[0];
      if (!meta) {
        throw new Error(
          `[erpnext_doctype_fields] ERPNext returned no metadata for '${doctype}'. ` +
            "Check the spelling; DocType names are case- and space-sensitive.",
        );
      }
      // A metadata document with no `fields` array is a broken response, not a
      // DocType that declares nothing: every DocType worth asking about
      // declares at least one field, and the seven standard columns below are
      // synthesised here rather than read from ERPNext. Falling through would
      // hand back a schema listing only those columns, and a model reading it
      // would conclude that every real field of the DocType does not exist.
      if (!Array.isArray(meta.fields)) {
        throw new Error(
          `[erpnext_doctype_fields] ERPNext returned metadata for '${doctype}' with no field list. ` +
            "This is a broken response, not an empty schema; retry, and report it if it persists.",
        );
      }

      if (meta.istable) {
        await assertChildReadable(ctx, doctype);
      } else {
        await assertReadable(ctx, doctype);
      }

      const needle = (input.search as string | undefined)?.toLowerCase().trim();
      const matches = (fieldname: string, label: string | null | undefined) =>
        !needle ||
        `${fieldname} ${label ?? ""}`.toLowerCase().includes(needle);

      // A Single DocType is stored as name/value rows in `tabSingles`; there is
      // no `tab<DocType>` table behind it. Measured on the live instance:
      // `show tables like 'tabSystem Settings'` returns nothing, while
      // `tabSingles` does hold owner/creation/modified/modified_by/docstatus/
      // idx/name for it. So every field of a Single - the standard columns most
      // of all - is a value you can read but not a column you can filter or
      // sort on, and a model that carried one into `order_by` would get a
      // database error. That distinction is what `queryable` carries.
      //
      // A virtual DocType is the same problem from the other direction: there
      // is no `tab<DocType>` behind it either, and its rows come from a Python
      // controller. Whether a filter or an order_by is honoured is up to that
      // controller, so nothing here can promise it - 20 of them exist on the
      // live instance (RQ Job, Recorder, System Health Report, ...). Marking
      // them not queryable states what this tool can actually vouch for.
      //
      // This is the DocType-wide half of the answer. It is necessary but not
      // sufficient: an ordinary DocType with a table behind it still holds
      // individual fields that have no column of their own, so the per-field
      // half is applied below.
      const doctypeQueryable = !meta.issingle && !meta.is_virtual;

      /**
       * Whether one field is usable in `filters` or `order_by`.
       *
       * Storage decides this, not the form: a `Table` field points at rows in
       * another table, an `Image` field renders a URL held by another field,
       * and a virtual field is computed by a Python property, so none of them
       * exists as a column to compare or sort on.
       */
      const isQueryable = (field: RawDocField) =>
        doctypeQueryable &&
        !COLUMNLESS_FIELDTYPES.has(field.fieldtype ?? "") &&
        !field.is_virtual;

      // Standard columns come first, and they are never subject to
      // `include_hidden`: they are not hidden form fields, they are columns that
      // no form ever declared. They are all read-only from a writer's point of
      // view.
      const standard = [
        ...STANDARD_FIELDS,
        ...(meta.istable ? CHILD_TABLE_FIELDS : []),
        ...(doctypeQueryable && !meta.istable ? ASSIGNMENT_FIELD : []),
      ]
        .filter((field) => matches(field.fieldname, field.label))
        .map((field) => ({
          fieldname: field.fieldname,
          label: field.label,
          fieldtype: field.fieldtype,
          options: field.options,
          reqd: false,
          read_only: true,
          in_list_view: false,
          permlevel: 0,
          description: field.description,
          is_standard: true,
          // Every standard column is a real column, so only the DocType-wide
          // half applies here.
          queryable: doctypeQueryable,
        }));

      const declared = meta.fields
        .filter((field) => {
          if (!field.fieldname) return false;
          if (LAYOUT_FIELDTYPES.has(field.fieldtype ?? "")) return false;
          if (!input.include_hidden && field.hidden) return false;
          return matches(field.fieldname, field.label);
        })
        .map((field) => ({
          fieldname: field.fieldname,
          label: field.label ?? null,
          fieldtype: field.fieldtype ?? null,
          // For Link/Table/Select this carries the target DocType or the option list.
          options: field.options ?? null,
          reqd: Boolean(field.reqd),
          read_only: Boolean(field.read_only),
          in_list_view: Boolean(field.in_list_view),
          // permlevel > 0 means a separate role permission controls this field;
          // it can be absent from documents even when the DocType is readable.
          permlevel: field.permlevel ?? 0,
          description: field.description ?? null,
          is_standard: false,
          queryable: isQueryable(field),
        }));

      const fields = [...standard, ...declared];

      return {
        doctype: meta.name ?? doctype,
        module: meta.module ?? null,
        is_single: Boolean(meta.issingle),
        is_virtual: Boolean(meta.is_virtual),
        is_child_table: Boolean(meta.istable),
        is_submittable: Boolean(meta.is_submittable),
        is_tree: Boolean(meta.is_tree),
        title_field: meta.title_field ?? null,
        description: meta.description ?? null,
        count: fields.length,
        fields,
      };
    },
  },
];
