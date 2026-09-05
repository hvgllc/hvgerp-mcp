import type {
  FrappeDoc,
  FrappeFilter,
  FrappeListOptions,
} from "../api/types.ts";
import type { ErpNextTool, ErpNextToolContext } from "./types.ts";
import { cellNumber } from "./query-report.ts";
import { normalizeLimit } from "../api/frappe-client.ts";

// Tính cả path và query đã encode, chừa khoảng đệm cho origin/prefix của proxy.
const SCOPE_REQUEST_TARGET_BUDGET = 6000;

function listRequestTargetLength(
  doctype: string,
  options: FrappeListOptions,
): number {
  const params = new URLSearchParams();
  if (options.fields?.length) {
    params.set("fields", JSON.stringify(options.fields));
  }
  if (options.filters?.length) {
    params.set("filters", JSON.stringify(options.filters));
  }
  if (options.order_by) params.set("order_by", options.order_by);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.limit_start !== undefined) {
    params.set("limit_start", String(options.limit_start));
  }
  params.set("as_dict", "1");
  return `/api/resource/${encodeURIComponent(doctype)}?${params}`.length;
}

function chunkRequestNames(
  doctype: string,
  names: string[],
  queryOptions: (names: string[]) => FrappeListOptions,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const name of new Set(names)) {
    const candidate = [...current, name];
    if (
      listRequestTargetLength(doctype, queryOptions(candidate)) <=
        SCOPE_REQUEST_TARGET_BUDGET
    ) {
      current = candidate;
      continue;
    }
    if (current.length) chunks.push(current);
    current = [name];
    if (
      listRequestTargetLength(doctype, queryOptions(current)) >
        SCOPE_REQUEST_TARGET_BUDGET
    ) {
      throw new Error(
        `Analytics ${doctype} scope cannot fit within the encoded request budget.`,
      );
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function listAnalyticsItemUnits(
  ctx: ErpNextToolContext,
  names: string[],
): Promise<FrappeDoc[]> {
  const queryOptions = (chunk: string[]): FrappeListOptions => ({
    fields: ["name", "stock_uom"],
    filters: [["name", "in", chunk]],
    limit: chunk.length,
    order_by: "name asc",
  });
  const chunks = chunkRequestNames("Item", names, queryOptions);
  const result: FrappeDoc[] = [];
  for (const chunk of chunks) {
    const rows = await ctx.client.list("Item", queryOptions(chunk));
    const remaining = new Set(chunk);
    for (const row of rows) {
      if (typeof row?.name !== "string" || !remaining.delete(row.name)) {
        throw new Error(
          "Analytics Item lookup returned a duplicate or unrequested name.",
        );
      }
    }
    if (remaining.size) {
      throw new Error(
        "Analytics Item lookup is missing a requested item; verified stock UOM is unavailable.",
      );
    }
    result.push(...rows);
  }
  return result;
}

async function listScoped(
  ctx: ErpNextToolContext,
  doctype: string,
  options: FrappeListOptions,
  scopeField: string,
  names: string[],
  verify: (row: FrappeDoc, allowed: Set<string>) => void,
  extraFilters: FrappeFilter[] = [],
): Promise<FrappeDoc[]> {
  const limit = normalizeLimit(options.limit ?? 20);
  if (options.limit_start !== undefined && options.limit_start !== 0) {
    throw new Error("Analytics scoped reads do not support offsets.");
  }
  // API không bảo đảm thứ tự khi bỏ order_by; chọn tường minh cho mọi chunk.
  const orderBy = options.order_by ?? "modified desc";
  if (
    !["base_amount desc", "stock_value desc", "modified desc"].includes(orderBy)
  ) {
    throw new Error(`Unsupported analytics scope order: '${orderBy}'.`);
  }
  const sortField = orderBy.split(" ")[0];
  const queryOptions = (scopeNames: string[]): FrappeListOptions => ({
    ...options,
    fields: [...new Set([...(options.fields ?? []), sortField])],
    filters: [
      ...(options.filters ?? []),
      [scopeField, "in", scopeNames],
      ...extraFilters,
    ],
    limit,
    order_by: orderBy,
  });
  const chunks = chunkRequestNames(doctype, names, queryOptions);

  let result: FrappeDoc[] = [];
  for (const chunk of chunks) {
    const rows = await ctx.client.list(doctype, queryOptions(chunk));
    const allowed = new Set(chunk);
    for (const row of rows) verify(row, allowed);
    if (chunks.length === 1) return rows.slice(0, limit);

    // N ứng viên mỗi chunk đủ để tìm top N toàn cục, không nhân cap đầu ra.
    const candidates = [...result, ...rows].map((row) => {
      let value: number | string;
      if (sortField === "modified") {
        const modified = row.modified;
        if (
          typeof modified !== "string" ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(modified)
        ) {
          throw new Error(
            "Analytics scoped row has no valid modified timestamp for ordered merging.",
          );
        }
        value = modified.includes(".")
          ? modified.padEnd(26, "0")
          : `${modified}.000000`;
      } else value = analyticsNumber(row, sortField);
      return { row, value };
    });
    // Sort ổn định: giá trị bằng nhau giữ thứ tự chunk rồi thứ tự server trong chunk.
    candidates.sort((a, b) =>
      a.value < b.value ? 1 : a.value > b.value ? -1 : 0
    );
    result = candidates.slice(0, limit).map(({ row }) => row);
  }
  return result;
}

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

async function listOwnershipNames(
  listDocuments: AnalyticsContext["listDocuments"],
  doctype: string,
  filters: FrappeFilter[] = [],
): Promise<string[]> {
  const pageSize = 1000;
  const maxNames = 100000;
  const names = new Set<string>();
  for (let offset = 0;; offset += pageSize) {
    const rows = await listDocuments(doctype, {
      fields: ["name"],
      filters,
      limit: pageSize,
      limit_start: offset,
      order_by: "name asc",
    });
    if (rows.length > pageSize) {
      throw new Error(
        `Analytics ${doctype} ownership page exceeds its requested size.`,
      );
    }
    for (const row of rows) {
      const name = row?.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error(
          `Analytics ${doctype} ownership lookup returned an invalid name.`,
        );
      }
      // Trang lặp hoặc dịch chuyển không được xem là tập ownership đầy đủ.
      if (names.has(name)) {
        throw new Error(
          `Analytics ${doctype} ownership pagination did not make unique progress.`,
        );
      }
      names.add(name);
      if (names.size > maxNames) {
        throw new Error(
          `Analytics ${doctype} ownership lookup exceeds the ${maxNames} name safety limit.`,
        );
      }
    }
    if (rows.length < pageSize) return [...names];
  }
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
      const names = await listOwnershipNames(
        listDocuments,
        parentType,
        parentFilters,
      );
      if (names.length === 0) return [];
      return await listScoped(
        ctx,
        `${parentType} Item`,
        {
          ...options,
          fields: [
            ...new Set([...(options.fields ?? []), "parent", "parenttype"]),
          ],
        },
        "parent",
        names,
        (row, allowed) => {
          if (
            typeof row.parent !== "string" || !allowed.has(row.parent) ||
            row.parenttype !== parentType
          ) {
            throw new Error(
              `Analytics ${parentType} Item has unverified company ownership.`,
            );
          }
        },
        [["parenttype", "=", parentType]],
      );
    },
    listBins: async (options) => {
      warehouses ??= listOwnershipNames(listDocuments, "Warehouse");
      const names = await warehouses;
      if (names.length === 0) return [];
      return await listScoped(
        ctx,
        "Bin",
        {
          ...options,
          fields: [...new Set([...(options.fields ?? []), "warehouse"])],
        },
        "warehouse",
        names,
        (row, allowed) => {
          if (
            typeof row.warehouse !== "string" || !allowed.has(row.warehouse)
          ) {
            throw new Error("Analytics Bin has unverified company ownership.");
          }
        },
      );
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
