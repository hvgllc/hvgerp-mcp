function escapeText(value: string): string {
  // Dấu nháy đơn giữ chuỗi là văn bản trong spreadsheet, nhưng trình đọc CSV
  // thông thường có thể hiển thị dấu này. Không áp dụng quy tắc này cho số.
  const text = /^[\t\r\n]|^[ \t\r\n]*[=+@-]/.test(value) ? `'${value}` : value;
  return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serializeCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("CSV numbers must be finite");
    }
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return escapeText(value);
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError("CSV objects must serialize to JSON");
    }
    return escapeText(text);
  }
  throw new TypeError(`Unsupported CSV value type: ${typeof value}`);
}

export function serializeCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  return [
    columns.map(escapeText).join(","),
    ...rows.map((row) =>
      columns.map((column) => serializeCell(row[column])).join(",")
    ),
  ].join("\r\n");
}
