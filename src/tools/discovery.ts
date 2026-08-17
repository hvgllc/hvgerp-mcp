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
      "happen to be filled in. Fails with a permission error if the caller cannot read the " +
      "DocType, so the answer is always inside the caller's own scope.",
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
      const fields = (meta.fields ?? [])
        .filter((field) => {
          if (!field.fieldname) return false;
          if (LAYOUT_FIELDTYPES.has(field.fieldtype ?? "")) return false;
          if (!input.include_hidden && field.hidden) return false;
          if (!needle) return true;
          return `${field.fieldname} ${field.label ?? ""}`.toLowerCase()
            .includes(needle);
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
        }));

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
