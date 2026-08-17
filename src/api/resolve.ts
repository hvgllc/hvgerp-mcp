/**
 * Link-field resolution.
 *
 * Lets tool handlers accept a human-readable identifier (name, email) for a
 * Frappe Link field and resolve it to the document's actual ID server-side,
 * in the same tool call — instead of requiring the agent to first call a
 * `_list` tool to look up the ID and then call the target tool with it.
 *
 * @module lib/erpnext/api/resolve
 */

import { FrappeAPIError, type FrappeClient } from "./frappe-client.ts";
import { getCache } from "../cache/cache.ts";
import {
  isSelfReference,
  resolveSelfEmployee,
  resolveSelfUser,
} from "./identity.ts";

/** How long a confirmed "identifier is not a valid ID" result is remembered. */
const NEGATIVE_CACHE_TTL_MS = 15_000;

/**
 * How many candidates to fetch per match rung when checking for ambiguity.
 * `EXACT_MATCH_PROBE_LIMIT` only needs to distinguish "unique" from
 * "ambiguous" (2 is enough); the partial rung's error message lists
 * candidates for the caller, so it fetches a few more.
 */
const EXACT_MATCH_PROBE_LIMIT = 2;
const PARTIAL_MATCH_PROBE_LIMIT = 5;

export interface ResolveLinkOptions {
  /** Default true. Pass false on write paths — a fuzzy match there can silently attach the wrong record. */
  allowPartialMatch?: boolean;
  /** Top-level tool input field to replace when an MCP client disambiguates via MRTR. */
  inputPath?: string;
}

export interface LinkCandidate {
  id: string;
  label: string;
}

/** Structured ambiguity used by the MCP layer to offer a safe MRTR choice. */
export class AmbiguousLinkError extends Error {
  readonly doctype: string;
  readonly identifier: string;
  readonly inputPath?: string;
  readonly candidates: LinkCandidate[];
  readonly truncated: boolean;

  constructor(options: {
    message: string;
    doctype: string;
    identifier: string;
    inputPath?: string;
    candidates: LinkCandidate[];
    truncated: boolean;
  }) {
    super(options.message);
    this.name = "AmbiguousLinkError";
    this.doctype = options.doctype;
    this.identifier = options.identifier;
    this.inputPath = options.inputPath;
    this.candidates = options.candidates;
    this.truncated = options.truncated;
  }
}

/**
 * Run a `searchField <op> value` list() query, probing up to `probeLimit`
 * rows. Returns the name on a unique hit, `undefined` on no match, and
 * throws an ambiguity error (listing candidates) when more than one row
 * matches — display-name fields like `customer_name` aren't unique in
 * ERPNext, so "matches" is not the same as "safe to resolve silently".
 */
async function resolveUnique(
  client: FrappeClient,
  doctype: string,
  identifier: string,
  searchField: string,
  op: "=" | "like",
  value: string,
  probeLimit: number,
  ambiguityHint: string,
  inputPath?: string,
): Promise<string | undefined> {
  const rows = await client.list(doctype, {
    filters: [[searchField, op, value]],
    fields: ["name", searchField],
    limit: probeLimit,
  });
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return rows[0].name as string;

  const candidates = rows.map((row) => ({
    id: String(row.name),
    label: String(row[searchField] ?? row.name),
  }));
  const candidateText = candidates.map(({ id, label }) => `${id} (${label})`)
    .join(", ");
  const truncated = rows.length === probeLimit;
  const suffix = truncated ? ", and possibly more" : "";
  throw new AmbiguousLinkError({
    message: `[resolveLink] Ambiguous ${doctype} identifier "${identifier}": ` +
      `did you mean ${candidateText}${suffix}? ${ambiguityHint}`,
    doctype,
    identifier,
    inputPath,
    candidates,
    truncated,
  });
}

/**
 * Doctype nào hiểu được "chính người đang hỏi", và cách phân giải ra ID của họ.
 *
 * Bảng này nằm ở `resolveLink` chứ không ở từng wrapper vì wrapper KHÔNG phải cửa duy nhất:
 * `erpnext_employee_get` và hai handler tạo Leave Application / Expense Claim gọi thẳng
 * `resolveLink(..., "Employee", ...)`, còn `resolveDynamicLink` thì gọi lại chính hàm này.
 * Ở những đường đó `me` từng bị tìm như một cái tên thật rồi hỏng với "No Employee found
 * matching \"me\"" - trong khi server instructions hứa với model rằng `me` dùng được ở mọi
 * ô nhận người. Đặt ở đây thì lời hứa đó thành đúng theo cấu trúc, không phải theo trí nhớ.
 */
const SELF_RESOLVERS: Record<
  string,
  (client: FrappeClient) => Promise<string>
> = {
  Employee: resolveSelfEmployee,
  User: resolveSelfUser,
};

/**
 * Resolve `identifier` to a document name (ID) within `doctype`: fast-path
 * get(), then exact match on `searchField`, then partial match (unless
 * `allowPartialMatch` is false). Both the exact and partial rungs only
 * resolve silently when the match is unique; multiple candidates throw with
 * the list instead of guessing — display-name fields aren't unique keys, so
 * even an "exact" name match can hit more than one document.
 */
export async function resolveLink(
  client: FrappeClient,
  doctype: string,
  identifier: string,
  searchField: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  const { allowPartialMatch = true, inputPath } = options;

  const selfResolver = SELF_RESOLVERS[doctype];
  if (selfResolver && isSelfReference(identifier)) return selfResolver(client);

  const cache = getCache();
  const missKey = `resolve:miss:${doctype}:${identifier}`;

  if (cache.get<boolean>(missKey) === undefined) {
    try {
      await client.get(doctype, identifier);
      return identifier;
    } catch (e) {
      if (!(e instanceof FrappeAPIError) || e.status !== 404) throw e;
      cache.set(missKey, true, NEGATIVE_CACHE_TTL_MS);
    }
  }

  const exact = await resolveUnique(
    client,
    doctype,
    identifier,
    searchField,
    "=",
    identifier,
    EXACT_MATCH_PROBE_LIMIT,
    "Please pass the record's ID directly.",
    inputPath,
  );
  if (exact !== undefined) return exact;

  if (allowPartialMatch) {
    const partial = await resolveUnique(
      client,
      doctype,
      identifier,
      searchField,
      "like",
      `%${identifier}%`,
      PARTIAL_MATCH_PROBE_LIMIT,
      "Please pass an exact value.",
      inputPath,
    );
    if (partial !== undefined) return partial;
  }

  throw new Error(`[resolveLink] No ${doctype} found matching "${identifier}"`);
}

/**
 * Resolve an employee-typed input, accepting `me` for the caller themselves.
 *
 * `me` is handled by `resolveLink` through {@link SELF_RESOLVERS}, not here: a guard on this
 * wrapper only covers the call sites that remember to use the wrapper, and three of them did not.
 */
export function resolveEmployee(
  client: FrappeClient,
  identifier: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  return resolveLink(client, "Employee", identifier, "employee_name", options);
}

/**
 * Resolve a `User`-typed input (assignee, owner, approver), accepting `me`.
 *
 * Users are matched on `full_name` because that is what a person typing a name has; the ID is an
 * email address, which `resolveLink`'s fast path already handles.
 */
export function resolveUser(
  client: FrappeClient,
  identifier: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  return resolveLink(client, "User", identifier, "full_name", options);
}

export function resolveCustomer(
  client: FrappeClient,
  identifier: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  return resolveLink(client, "Customer", identifier, "customer_name", options);
}

export function resolveSupplier(
  client: FrappeClient,
  identifier: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  return resolveLink(client, "Supplier", identifier, "supplier_name", options);
}

export function resolveItem(
  client: FrappeClient,
  identifier: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  return resolveLink(client, "Item", identifier, "item_name", options);
}

/** Human-readable name field per doctype, for dynamic-link resolution. */
const DYNAMIC_LINK_SEARCH_FIELDS: Record<string, string> = {
  Customer: "customer_name",
  Supplier: "supplier_name",
  Employee: "employee_name",
  Lead: "lead_name",
};

/**
 * Resolve a dynamic-link field, e.g. Payment Entry's `party` (target doctype
 * given by `party_type`). Target doctype isn't known until the companion
 * field's value is read at the call site. Falls back to passing `identifier`
 * through unresolved for doctypes not in `DYNAMIC_LINK_SEARCH_FIELDS`.
 */
export async function resolveDynamicLink(
  client: FrappeClient,
  targetDoctype: string,
  identifier: string,
  options: ResolveLinkOptions = {},
): Promise<string> {
  const searchField = DYNAMIC_LINK_SEARCH_FIELDS[targetDoctype];
  if (!searchField) return identifier;
  return resolveLink(client, targetDoctype, identifier, searchField, options);
}

/**
 * Phân giải một người nhận việc, nhưng chỉ tra cứu `User` khi thật sự cần.
 *
 * Một ID người dùng của Frappe CHÍNH LÀ địa chỉ thư, nên đưa nó qua `resolveUser` là bỏ tiền mua
 * một lượt `GET User/{email}` không đổi lấy gì. Tệ hơn: `User` là doctype có phân quyền riêng, nên
 * người có quyền sửa tài liệu mà không có quyền đọc hồ sơ người khác sẽ nhận 403 ở đúng lượt đọc
 * thừa đó - `resolveLink` chỉ nuốt 404, mọi mã khác đều ném tiếp. Kết quả là mất luôn thao tác gỡ
 * giao việc mà lẽ ra họ được phép làm.
 *
 * Tự tham chiếu phải xét TRƯỚC lối tắt địa chỉ thư: `@me` và `@self` đều chứa dấu at-sign nên lối
 * tắt sẽ tưởng chúng là ID có sẵn và không dịch.
 */
export function resolveAssigneeUser(
  client: FrappeClient,
  identifier: string,
  inputPath?: string,
): Promise<string> {
  const needsLookup = isSelfReference(identifier) || !identifier.includes("@");
  if (!needsLookup) return Promise.resolve(identifier);
  return resolveUser(client, identifier, {
    allowPartialMatch: false,
    inputPath,
  });
}

/**
 * Dịch `me` thành ID người gọi trong một giá trị lọc, và chỉ có vậy.
 *
 * Dùng cho các ô lọc kiểu `lead_owner` / `opportunity_owner`: chỉ dạng tự tham chiếu mới được
 * dịch, còn mọi giá trị khác đi thẳng xuống Frappe như cũ. Cố ý KHÔNG tra cứu theo họ tên: một ô
 * lọc không khớp ai vốn trả danh sách rỗng, biến nó thành lỗi là đổi hành vi của một đường đọc
 * chứ không phải sửa lỗi.
 */
export function resolveUserFilter(
  client: FrappeClient,
  value: string,
): Promise<string> {
  return isSelfReference(value)
    ? resolveSelfUser(client)
    : Promise.resolve(value);
}
