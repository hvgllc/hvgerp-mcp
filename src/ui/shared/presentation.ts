/**
 * Where a viewer's error belongs on screen.
 *
 * Two failures reach the same `error` state and must not reach the same
 * pixels. An error raised while the viewer already holds data is a refresh
 * that failed: what is on screen is still the last known truth, so the message
 * belongs inline beside it. An error raised before any data arrived leaves
 * nothing to show, and a viewer that falls through to its empty state there
 * tells the reader "no documents" when what actually happened is "the response
 * was broken" - the swap AGENTS.md:450-451 forbids, and the reason this rule
 * is one shared function instead of a branch order each viewer re-derives.
 */
export function getErrorPresentation(
  state: { data: unknown; error: string | null },
): {
  blockingError: string | null;
  inlineError: string | null;
} {
  if (!state.error) {
    return { blockingError: null, inlineError: null };
  }

  if (state.data) {
    return { blockingError: null, inlineError: state.error };
  }

  return { blockingError: state.error, inlineError: null };
}

import type { ToolResultPayload, UiRefreshRequestData } from "./refresh.ts";

export interface InvoiceItem {
  item_code: string;
  item_name?: string;
  qty: number;
  rate: number;
  amount: number;
}

export interface InvoiceData {
  name: string;
  customer?: string;
  customer_name?: string;
  supplier?: string;
  supplier_name?: string;
  company?: string;
  posting_date: string;
  due_date?: string;
  status: string;
  docstatus?: number;
  grand_total: number;
  net_total?: number;
  total_taxes_and_charges?: number;
  outstanding_amount?: number;
  currency?: string;
  items?: InvoiceItem[];
  contact_email?: string;
  address_display?: string;
}

export interface StockEntry {
  item_code: string;
  warehouse: string;
  actual_qty: number;
  reserved_qty?: number;
  projected_qty?: number;
  valuation_rate?: number;
  stock_value?: number;
}

export interface StockData {
  // Tổng số Bin khớp query, không phải số dòng của trang; null nghĩa là chưa xác định.
  count: number | null;
  // Giữ lý do riêng để người dùng không nhầm tổng chưa xác định với tổng bằng 0.
  count_error?: string;
  data: StockEntry[];
  refreshRequest?: UiRefreshRequestData;
}

export type SortKey = keyof StockEntry;
export type SortDir = "asc" | "desc";

export type ChartType =
  | "bar"
  | "horizontal-bar"
  | "stacked-bar"
  | "line"
  | "area"
  | "stacked-area"
  | "composed"
  | "pie"
  | "donut"
  | "radar"
  | "scatter"
  | "treemap";

export interface Dataset {
  label: string;
  values: number[];
  color?: string;
  type?: "bar" | "line" | "area";
  stack?: string;
  yAxisId?: "left" | "right";
  showDots?: boolean;
  strokeStyle?: "solid" | "dashed";
}

export interface ScatterPoint {
  x: number;
  y: number;
  z?: number;
  label?: string;
}

export interface ScatterSeries {
  label: string;
  color?: string;
  points: ScatterPoint[];
}

export interface TreeNode {
  name: string;
  value?: number;
  color?: string;
  children?: TreeNode[];
}

export interface ChartData {
  title: string;
  subtitle?: string;
  type?: ChartType;

  labels: string[];

  datasets: Dataset[];

  unit?: string;

  currency?: string;

  generatedAt?: string;

  xAxisLabel?: string;
  yAxisLabel?: string;

  showRightAxis?: boolean;
  rightAxisLabel?: string;

  scatterData?: ScatterSeries[];

  treeData?: TreeNode[];

  height?: number;
  refreshRequest?: UiRefreshRequestData;

  _drillDown?: string;
}

export interface KpiData {
  label: string;
  value: number;
  formattedValue?: string;
  unit?: string;
  currency?: string;
  delta?: number;
  deltaLabel?: string;
  trend?: "up" | "down" | "flat";
  trendIsGood?: boolean;
  sparkline?: number[];
  color?: string;
  icon?: string;
  refreshRequest?: UiRefreshRequestData;

  _drillDown?: string;

  _trendDrillDown?: string;
}

export interface FunnelStage {
  label: string;
  count: number;
  value?: number;
  color: string;
  conversionRate?: number;

  _drillDown?: string;
}

export interface FunnelData {
  title: string;
  subtitle?: string;
  stages: FunnelStage[];
  currency?: string;
  refreshRequest?: UiRefreshRequestData;
}

export interface ViewerDataMap {
  invoice: InvoiceData;
  stock: StockData;
  chart: ChartData;
  kpi: KpiData;
  funnel: FunnelData;
}
export type ViewerKind = keyof ViewerDataMap;
export interface ViewerState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refreshRequest: UiRefreshRequestData | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string";
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const boolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const array = (value: unknown, check: (entry: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);
function optionalFields(
  value: Record<string, unknown>,
  keys: string[],
  check: (entry: unknown) => boolean,
): boolean {
  return keys.every((key) => value[key] == null || check(value[key]));
}
function refreshRequest(value: unknown): value is UiRefreshRequestData {
  return record(value) && text(value.toolName) &&
    value.toolName.trim().length > 0 && record(value.arguments);
}
function treeNode(value: unknown): boolean {
  return record(value) && text(value.name) &&
    optionalFields(value, ["value"], number) &&
    optionalFields(value, ["color"], text) &&
    (value.children == null || array(value.children, treeNode));
}
const validators: {
  [K in ViewerKind]: (value: unknown) => value is ViewerDataMap[K];
} = {
  invoice: (value): value is InvoiceData =>
    record(value) &&
    ["name", "posting_date", "status"].every((key) => text(value[key])) &&
    number(value.grand_total) &&
    optionalFields(value, [
      "customer",
      "customer_name",
      "supplier",
      "supplier_name",
      "company",
      "due_date",
      "currency",
      "contact_email",
      "address_display",
    ], text) &&
    optionalFields(value, [
      "docstatus",
      "net_total",
      "total_taxes_and_charges",
      "outstanding_amount",
    ], number) &&
    (value.items == null || array(value.items, (item) =>
      record(item) && text(item.item_code) &&
      ["qty", "rate", "amount"].every((key) => number(item[key])) &&
      optionalFields(item, ["item_name"], text))),
  stock: (value): value is StockData =>
    record(value) && (value.count === null || number(value.count)) &&
    optionalFields(value, ["count_error"], text) && array(value.data, (entry) =>
      record(entry) &&
      text(entry.item_code) && text(entry.warehouse) &&
      number(entry.actual_qty) &&
      optionalFields(entry, [
        "reserved_qty",
        "projected_qty",
        "valuation_rate",
        "stock_value",
      ], number)),
  chart: (value): value is ChartData =>
    record(value) && text(value.title) &&
    array(value.labels, text) && array(value.datasets, (entry) =>
      record(entry) && text(entry.label) && array(entry.values, number) &&
      optionalFields(entry, ["color", "stack"], text) &&
      optionalFields(entry, ["showDots"], boolean) &&
      optionalFields(entry, ["type"], (type) =>
        text(type) && ["bar", "line", "area"].includes(type)) &&
      optionalFields(entry, ["yAxisId"], (axis) =>
        axis === "left" || axis === "right") &&
      optionalFields(entry, ["strokeStyle"], (style) =>
        style === "solid" || style === "dashed")) &&
    optionalFields(value, [
      "subtitle",
      "unit",
      "currency",
      "generatedAt",
      "xAxisLabel",
      "yAxisLabel",
      "rightAxisLabel",
      "_drillDown",
    ], text) &&
    optionalFields(value, ["height"], number) &&
    optionalFields(value, ["showRightAxis"], boolean) &&
    optionalFields(value, ["type"], (type) =>
      text(type) && [
        "bar",
        "horizontal-bar",
        "stacked-bar",
        "line",
        "area",
        "stacked-area",
        "composed",
        "pie",
        "donut",
        "radar",
        "scatter",
        "treemap",
      ].includes(type)) &&
    (value.scatterData == null || array(value.scatterData, (series) =>
      record(series) && text(series.label) &&
      optionalFields(series, ["color"], text) &&
      array(series.points, (point) =>
        record(point) && number(point.x) && number(point.y) &&
        optionalFields(point, ["z"], number) &&
        optionalFields(point, ["label"], text)))) &&
    (value.treeData == null || array(value.treeData, treeNode)),
  kpi: (value): value is KpiData =>
    record(value) && text(value.label) && number(value.value) &&
    optionalFields(value, [
      "formattedValue",
      "unit",
      "currency",
      "deltaLabel",
      "color",
      "icon",
      "_drillDown",
      "_trendDrillDown",
    ], text) &&
    optionalFields(value, ["delta"], number) &&
    optionalFields(value, ["trendIsGood"], boolean) &&
    optionalFields(
      value,
      ["trend"],
      (trend) => trend === "up" || trend === "down" || trend === "flat",
    ) &&
    (value.sparkline == null || array(value.sparkline, number)),
  funnel: (value): value is FunnelData =>
    record(value) && text(value.title) &&
    optionalFields(value, ["subtitle", "currency"], text) &&
    array(value.stages, (stage) =>
      record(stage) &&
      text(stage.label) && number(stage.count) && text(stage.color) &&
      optionalFields(stage, ["value", "conversionRate"], number) &&
      optionalFields(stage, ["_drillDown"], text)),
};

export function consumeViewerResult<K extends ViewerKind>(
  kind: K,
  result: ToolResultPayload,
  previous: ViewerState<ViewerDataMap[K]>,
): ViewerState<ViewerDataMap[K]> {
  const fail = (error: string): ViewerState<ViewerDataMap[K]> => ({
    ...previous,
    error,
    loading: false,
  });
  const content = result.content?.find((entry) => entry.type === "text")?.text;
  if (result.isError) {
    return fail(content || "Tool returned an error");
  }
  try {
    if (result.structuredContent === undefined && !content) {
      return fail(`Missing ${kind} payload`);
    }
    const parsed: unknown = result.structuredContent ?? JSON.parse(content!);
    const payload: unknown =
      kind === "invoice" && record(parsed) && "data" in parsed
        ? parsed.data
        : parsed;
    if (payload !== null && !validators[kind](payload)) {
      return fail(`Invalid ${kind} payload`);
    }
    const request = record(parsed) ? parsed.refreshRequest : undefined;
    if (request != null && !refreshRequest(request)) {
      return fail(`Invalid ${kind} refresh request`);
    }
    return {
      data: payload,
      refreshRequest: request ?? previous.refreshRequest,
      error: null,
      loading: false,
    };
  } catch {
    return fail(`Failed to parse ${kind} payload`);
  }
}
