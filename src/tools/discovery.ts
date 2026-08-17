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
async function assertReadable(
  ctx: Parameters<ErpNextTool["handler"]>[1],
  doctype: string,
): Promise<void> {
  const res = await ctx.client.callMethod<{ has_permission?: boolean }>(
    "frappe.client.has_permission",
    { doctype, docname: "", perm_type: "read" },
    { httpMethod: "GET" },
  );
  if (!res?.has_permission) {
    throw new Error(
      `[erpnext_doctype_fields] You do not have read permission on '${doctype}'. ` +
        "Ask an ERPNext administrator for the role that grants it; do not guess the schema.",
    );
  }
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
      "they are filterable and sortable but appear in no form. Fails with a permission error if " +
      "the caller cannot read the DocType, so the answer is always inside the caller's own scope.",
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

      await assertReadable(ctx, doctype);

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

      const needle = (input.search as string | undefined)?.toLowerCase().trim();
      const matches = (fieldname: string, label: string | null | undefined) =>
        !needle ||
        `${fieldname} ${label ?? ""}`.toLowerCase().includes(needle);

      // Standard columns come first, and they are never subject to
      // `include_hidden`: they are not hidden form fields, they are columns that
      // no form ever declared. They are all read-only from a writer's point of
      // view, and all filterable and sortable from a reader's.
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
