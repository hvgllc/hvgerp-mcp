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
}

/** The DocType meta document `getdoctype` writes into `frappe.response.docs[0]`. */
interface RawDocTypeMeta {
  name?: string;
  module?: string;
  istable?: number;
  issingle?: number;
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

/** How many parent candidates are worth a permission round-trip. */
const MAX_PARENT_PROBES = 10;

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
  // `with_parent: 1` makes `getdoctype` return the owning DocTypes alongside
  // the child, which is the only place the parent link is exposed - a child
  // DocType does not record its own parents.
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

  for (const parent of parents.slice(0, MAX_PARENT_PROBES)) {
    if (await canRead(ctx, parent)) return;
  }

  throw new Error(
    `[erpnext_doctype_fields] '${doctype}' is a child table, so it has no ` +
      "permissions of its own; access comes from the document that owns it. " +
      (parents.length > 0
        ? `You cannot read any of its parent DocTypes (${
          parents.join(", ")
        }), so its schema stays out of scope.`
        : "No parent DocType could be resolved for it, so there is nothing to " +
          "check the permission against.") +
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
      "(name, owner, creation, modified, modified_by, docstatus, idx) marked is_standard, because " +
      "they appear in no form. Every field carries queryable: false means the value can be read " +
      "but not used in a filter or order_by, which is the case for every field of a Single " +
      "DocType because a Single has no table of its own. Fails with a permission error if the " +
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
      // and nothing but the meta says whether this is one. That ordering leaks
      // nothing - `getdoctype` performs no permission check of its own (which
      // is exactly why this module imposes one), so reading it earlier grants
      // the caller no access it did not already have, and no part of it is
      // returned unless the gate below passes.
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
      const queryable = !meta.issingle;

      // Standard columns come first, and they are never subject to
      // `include_hidden`: they are not hidden form fields, they are columns that
      // no form ever declared. They are all read-only from a writer's point of
      // view.
      const standard = [
        ...STANDARD_FIELDS,
        ...(meta.istable ? CHILD_TABLE_FIELDS : []),
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
          queryable,
        }));

      const declared = (meta.fields ?? [])
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
          queryable,
        }));

      const fields = [...standard, ...declared];

      return {
        doctype: meta.name ?? doctype,
        module: meta.module ?? null,
        is_single: Boolean(meta.issingle),
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
