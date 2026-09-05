import type {
  FrappeDoc,
  FrappeFilter,
  FrappeListOptions,
} from "../api/types.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";
import { cellNumber } from "./query-report.ts";

export async function resolveReportCompany(
  ctx: ErpNextToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  if (input.company !== undefined) {
    if (typeof input.company !== "string" || input.company.trim() === "") {
      throw new Error("'company' must be a non-empty Company name.");
    }
    return input.company.trim();
  }
  const companies = await ctx.client.list("Company", {
    fields: ["name"],
    limit: 21,
    order_by: "name asc",
  });
  const names = companies.map((row) => row.name);
  if (names.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new Error("Company lookup returned an invalid name.");
  }
  if (names.length === 1) return names[0];
  if (names.length === 0) {
    throw new Error(
      "No Company is visible to you. Ask an administrator for access to a company.",
    );
  }
  throw new Error(
    `Multiple companies are visible, so 'company' is required. Pass one of: ${
      names.slice(0, 20).join(", ")
    }${names.length > 20 ? ", ..." : ""}.`,
  );
}

export function analyticsNumber(
  row: Record<string, unknown>,
  field: string,
): number {
  const value = cellNumber(row[field]);
  if (value === null) {
    throw new Error(
      `Analytics field '${field}' is missing or not a finite number; refusing to report zero.`,
    );
  }
  return value;
}

export interface AnalyticsContext {
  company: string;
  currency: string;
  listDocuments: (
    doctype: string,
    options: FrappeListOptions,
  ) => Promise<FrappeDoc[]>;
  listItems: (
    parentType: "Sales Order" | "Sales Invoice",
    options: FrappeListOptions,
  ) => Promise<FrappeDoc[]>;
  listBins: (options: FrappeListOptions) => Promise<FrappeDoc[]>;
}

export async function resolveAnalyticsContext(
  ctx: ErpNextToolContext,
  input: Record<string, unknown>,
): Promise<AnalyticsContext> {
  const company = await resolveReportCompany(ctx, input);
  const doc = await ctx.client.get("Company", company);
  const currency = doc.default_currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Company '${company}' has no valid default_currency.`);
  }
  const listDocuments = (doctype: string, options: FrappeListOptions) =>
    ctx.client.list(doctype, {
      ...options,
      filters: [...(options.filters ?? []), ["company", "=", company]],
    });

  let warehouses: Promise<string[]> | undefined;
  return {
    company,
    currency,
    listDocuments,
    listItems: async (parentType, options) => {
      const parentFilters = (options.filters ?? []).filter((filter) =>
        filter[0] === "docstatus"
      );
      const parents = await listDocuments(parentType, {
        fields: ["name"],
        filters: parentFilters,
        limit: 1000,
        order_by: "name asc",
      });
      const names = parents.map((row) => row.name);
      if (names.some((name) => typeof name !== "string" || name === "")) {
        throw new Error(
          `Analytics ${parentType} lookup returned an invalid parent name.`,
        );
      }
      if (names.length === 0) return [];
      const rows = await ctx.client.list(`${parentType} Item`, {
        ...options,
        fields: [
          ...new Set([...(options.fields ?? []), "parent", "parenttype"]),
        ],
        filters: [...(options.filters ?? []), ["parent", "in", names], [
          "parenttype",
          "=",
          parentType,
        ]],
      });
      const allowed = new Set(names);
      for (const row of rows) {
        if (
          typeof row.parent !== "string" || !allowed.has(row.parent) ||
          row.parenttype !== parentType
        ) {
          throw new Error(
            `Analytics ${parentType} Item has unverified company ownership.`,
          );
        }
      }
      return rows;
    },
    listBins: async (options) => {
      warehouses ??= listDocuments("Warehouse", {
        fields: ["name"],
        limit: 1000,
        order_by: "name asc",
      }).then((rows) => rows.map((row) => row.name));
      const names = await warehouses;
      if (names.some((name) => typeof name !== "string" || name === "")) {
        throw new Error("Analytics Warehouse lookup returned an invalid name.");
      }
      if (names.length === 0) return [];
      const warehouseFilter: FrappeFilter = ["warehouse", "in", names];
      const rows = await ctx.client.list("Bin", {
        ...options,
        fields: [...new Set([...(options.fields ?? []), "warehouse"])],
        filters: [...(options.filters ?? []), warehouseFilter],
      });
      const allowed = new Set(names);
      for (const row of rows) {
        if (typeof row.warehouse !== "string" || !allowed.has(row.warehouse)) {
          throw new Error("Analytics Bin has unverified company ownership.");
        }
      }
      return rows;
    },
  };
}

type CompanyAnalyticsTool = Omit<ErpNextTool, "handler"> & {
  handler: (
    input: Record<string, unknown>,
    ctx: ErpNextToolContext,
    context: AnalyticsContext,
  ) => Promise<unknown>;
};

/** Ghim company đã phân giải vào refresh, kể cả lần gọi đầu không truyền company. */
export function companyAnalyticsTool(tool: CompanyAnalyticsTool): ErpNextTool {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        company: {
          type: "string",
          description:
            "Company name. Optional only when exactly one Company is visible. Monetary values use its default currency.",
        },
      },
    },
    handler: async (input, ctx) => {
      const maxItems = tool.inputSchema.properties?.items?.maxItems;
      if (
        Array.isArray(input.items) && typeof maxItems === "number" &&
        input.items.length > maxItems
      ) {
        throw new Error(
          `${tool.name} accepts at most ${maxItems} item codes, received ${input.items.length}.`,
        );
      }
      const context = await resolveAnalyticsContext(ctx, input);
      const result = await tool.handler(input, ctx, context);
      if (
        result === null || typeof result !== "object" || Array.isArray(result)
      ) {
        throw new Error(`${tool.name} returned an invalid analytics result.`);
      }
      return {
        ...result,
        refreshRequest: {
          toolName: tool.name,
          arguments: { ...input, company: context.company },
        },
      };
    },
  };
}
