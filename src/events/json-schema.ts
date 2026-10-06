/**
 * Bộ kiểm tra JSON Schema tối giản cho hợp đồng Events.
 *
 * Chỉ hỗ trợ đúng tập từ khoá mà `contract/meeting-events.v1.json` dùng: không kéo thêm thư viện
 * vào lockfile chỉ để kiểm một schema nhỏ, và một tập từ khoá hẹp giúp hành vi dễ đọc, dễ test.
 * Từ khoá lạ bị bỏ qua có chủ đích (JSON Schema mặc định cho phép), nhưng test hợp đồng khoá lại
 * danh sách từ khoá đang dùng để không có từ khoá nào bị bỏ qua mà không ai biết.
 *
 * Thông báo lỗi chỉ chứa đường dẫn và tên từ khoá, KHÔNG chứa giá trị gốc: giá trị có thể là URL
 * callback hay secret mà người gọi vừa gửi lên.
 *
 * @module lib/erpnext/src/events/json-schema
 */

/** Các từ khoá mà bộ kiểm tra này hiểu. Test hợp đồng đối chiếu schema thật với danh sách này. */
export const SUPPORTED_KEYWORDS: readonly string[] = [
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "format",
  "allOf",
  "anyOf",
  "not",
  "if",
  "then",
  "else",
  "description",
];

type Schema = Record<string, unknown>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().startsWith(value);
}

function formatMatches(format: string, value: string): boolean {
  if (format === "date") return isRealDate(value);
  if (format === "date-time") {
    return DATE_TIME_PATTERN.test(value) &&
      !Number.isNaN(new Date(value).getTime());
  }
  // Định dạng lạ thì không phán xét, theo đúng tinh thần "format là chú thích".
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function walk(
  schema: Schema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const type = schema.type;
  if (typeof type === "string" && !typeMatches(type, value)) {
    errors.push(`${path}: expected ${type}`);
    return;
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: const mismatch`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => deepEqual(item, value))
  ) {
    errors.push(`${path}: not in enum`);
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" && value.length < schema.minLength
    ) {
      errors.push(`${path}: shorter than minLength`);
    }
    if (
      typeof schema.maxLength === "number" && value.length > schema.maxLength
    ) {
      errors.push(`${path}: longer than maxLength`);
    }
    if (
      typeof schema.format === "string" && !formatMatches(schema.format, value)
    ) {
      errors.push(`${path}: invalid ${schema.format}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: above maximum`);
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) =>
      walk(schema.items as Schema, item, `${path}/${index}`, errors)
    );
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !(name in value)) {
          errors.push(`${path}/${name}: required`);
        }
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = properties[name];
      if (isRecord(childSchema)) {
        walk(childSchema, child, `${path}/${name}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}/${name}: additional property`);
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      if (isRecord(part)) walk(part, value, path, errors);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((part) =>
      isRecord(part) && validateJsonSchema(part, value).length === 0
    );
    if (!matched) errors.push(`${path}: no anyOf branch matched`);
  }
  if (
    isRecord(schema.not) && validateJsonSchema(schema.not, value).length === 0
  ) {
    errors.push(`${path}: matched a forbidden shape`);
  }
  if (isRecord(schema.if)) {
    const conditionHolds = validateJsonSchema(schema.if, value).length === 0;
    const branch = conditionHolds ? schema.then : schema.else;
    if (isRecord(branch)) walk(branch, value, path, errors);
  }
}

/** Trả về danh sách lỗi (rỗng nghĩa là hợp lệ). Đường dẫn gốc là chuỗi rỗng. */
export function validateJsonSchema(schema: Schema, value: unknown): string[] {
  const errors: string[] = [];
  walk(schema, value, "", errors);
  return errors;
}

/** Mọi từ khoá xuất hiện trong schema (đệ quy), dùng để khoá phạm vi hỗ trợ. */
export function collectKeywords(schema: unknown, found = new Set<string>()) {
  if (Array.isArray(schema)) {
    for (const item of schema) collectKeywords(item, found);
  } else if (isRecord(schema)) {
    for (const [key, child] of Object.entries(schema)) {
      if (key === "properties" && isRecord(child)) {
        // Tên thuộc tính không phải từ khoá, chỉ đi sâu vào schema con.
        for (const sub of Object.values(child)) collectKeywords(sub, found);
        continue;
      }
      found.add(key);
      if (key !== "enum" && key !== "const") collectKeywords(child, found);
    }
  }
  return found;
}
