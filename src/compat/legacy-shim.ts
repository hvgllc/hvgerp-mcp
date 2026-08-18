/**
 * Shim tương thích cho client MCP đời cũ đứng trước server chỉ nói 2026-07-28.
 *
 * Bối cảnh đo được trên dây: Claude Cowork mở phiên bằng `initialize` với
 * `protocolVersion: "2025-11-25"` và KHÔNG gửi header `MCP-Protocol-Version`,
 * nên server trả 400 kèm `-32020`; Cowork hiểu đó là "không phải endpoint
 * Streamable HTTP đời mới" rồi tụt xuống transport HTTP+SSE cũ bằng
 * `GET /mcp`, và nhận tiếp 405. Claude chat thì gửi đúng bộ header
 * 2026-07-28 nên chạy bình thường.
 *
 * Shim này dịch đúng hai chiều đó và không đụng gì tới luồng đã chạy được:
 * request nào đã mang `MCP-Protocol-Version: 2026-07-28` được chuyển tiếp
 * nguyên trạng, không parse, không sửa.
 *
 * Ba khác biệt phải bắc cầu, theo đúng thứ tự mà server kiểm tra:
 *
 * 1. Header. Mọi POST có `id` phải mang `MCP-Protocol-Version` khớp với
 *    `params._meta["io.modelcontextprotocol/protocolVersion"]`, `Mcp-Method`
 *    khớp `method`, và `Mcp-Name` khớp trường định danh với những method có
 *    một (`tools/call`, `resources/read`, ...). Notification (không `id`)
 *    được miễn.
 * 2. Body. `params._meta` phải mang protocolVersion và `clientCapabilities`
 *    dạng object; thiếu là `-32602`.
 * 3. Verb và mã trạng thái. `GET /mcp` (stream SSE cũ) và `DELETE /mcp`
 *    (đóng phiên) không còn tồn tại nên server trả 405; method không còn
 *    tồn tại (`ping`, `logging/setLevel`) trả HTTP 404 chứ không phải 200.
 *    Client cũ đọc cả hai như "endpoint chết".
 */

/** Revision duy nhất mà server chấp nhận. */
export const SPEC_2026_07_28 = "2026-07-28";

/** Revision giả định cho client cũ khi không tự khai báo. */
export const LEGACY_FALLBACK_VERSION = "2025-11-25";

/**
 * Revision đời cũ mà shim biết cách dịch. Danh sách đóng, có lý do.
 *
 * "Mọi thứ khác 2026-07-28 đều là đồ cũ" là một phép đoán sai ở chiều tương
 * lai: một client khai revision mới hơn sẽ bị hạ xuống 2026-07-28 rồi nhận
 * lại chính revision nó xin trong `result`, tức là một cuộc thương lượng
 * trông như thành công với một server không hiểu ngữ nghĩa đó. Không nhận ra
 * thì chuyển tiếp nguyên trạng và để server thật từ chối, vì từ chối rõ ràng
 * bao giờ cũng lành hơn một cái bắt tay giả.
 *
 * 2024-11-05 cố ý KHÔNG có trong danh sách. Transport HTTP+SSE của bản đó bắt
 * stream mở đầu phải phát một sự kiện `endpoint` báo URI để POST tiếp, mà
 * {@link openLegacyStream} chỉ phát comment giữ nhịp. Nhận dịch bản ấy là hứa
 * một thứ shim không làm: client sẽ chờ `endpoint` mãi mãi và không bao giờ
 * gửi nổi `initialize`. Chuyển tiếp thẳng thì nó nhận lời từ chối ngay.
 */
const KNOWN_LEGACY_VERSIONS: ReadonlySet<string> = new Set([
  "2025-03-26",
  "2025-06-18",
  LEGACY_FALLBACK_VERSION,
]);

/**
 * Revision được nhận stream GET tổng hợp, và chỉ khi khai TƯỜNG MINH.
 *
 * `GET` mở đầu của 2024-11-05 có trước cả header `MCP-Protocol-Version`, nên
 * trên dây nó là một request không header mang mỗi `Accept: text/event-stream`
 * - đúng hình dạng mà {@link isTranslatableRequest} coi là dịch được. Mở
 * {@link openLegacyStream} cho nó là hứa một sự kiện `endpoint` không bao giờ
 * tới: client treo vô hạn.
 *
 * Vì thế stream tổng hợp chỉ dành cho revision tự xưng tên trong header. Client
 * Streamable HTTP không khai tên (2025-03-26 chưa có header này) nhận 405 của
 * upstream, và 405 là câu trả lời spec cho phép ở đúng chỗ này, nên nó không
 * mất gì: server stateless 2026-07-28 không bao giờ đẩy message qua `GET`.
 */
const SYNTHETIC_STREAM_VERSIONS: ReadonlySet<string> = new Set([
  "2025-06-18",
  LEGACY_FALLBACK_VERSION,
]);

/**
 * Header CORS phải mang từ upstream sang mọi response do shim tự dựng.
 *
 * Server bật `cors: true`, nên với client chạy trong trình duyệt, mất
 * `Access-Control-Allow-Origin` nghĩa là request thành công nhưng trình duyệt
 * chặn không cho đọc kết quả.
 */
const CORS_HEADERS = [
  "Access-Control-Allow-Origin",
  "Access-Control-Allow-Credentials",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Headers",
  "Access-Control-Expose-Headers",
  "Access-Control-Max-Age",
  "Vary",
];

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** Trường trong `params` mà `Mcp-Name` phải soi gương, theo method. */
const NAME_SOURCE: Readonly<Record<string, "name" | "uri" | "taskId">> = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId",
};

/**
 * Method đã bị gỡ khỏi 2026-07-28 nhưng client cũ vẫn gọi, và shim tự trả lời.
 *
 * Chuyển tiếp lên server chỉ nhận về HTTP 404 kèm `-32601`. Với `ping` đó là
 * hỏng thật: client cũ dùng ping làm keepalive và đọc 404 như mất endpoint,
 * nên nó phải được trả lời tại chỗ bằng result rỗng đúng như spec cũ.
 */
const LOCALLY_ANSWERED = new Set(["ping", "logging/setLevel"]);

const SENTINEL_PREFIX = "=?base64?";
const SENTINEL_SUFFIX = "?=";

/** RFC 9110 field-value: quyết định giá trị nào được gửi thô. */
const HEADER_SAFE_VALUE = /^(?:[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?)?$/;

/**
 * Header hop-by-hop và header do tầng vận chuyển tự tính, không được chuyển tiếp.
 *
 * `content-length` nằm trong danh sách vì shim viết lại thân request, còn
 * `accept-encoding` bị cắt để upstream trả thân chưa nén: shim phải đọc và sửa
 * JSON, và một thân đã nén sẽ phải giải nén thủ công không vì lợi ích gì.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

/** Header MCP mà shim tự dựng lại, nên bản của client bị bỏ đi. */
const SHIM_OWNED_HEADERS = new Set([
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
]);

/**
 * Header mô tả thân request mà shim vừa dựng lại.
 *
 * Nhánh dịch không bao giờ chuyển tiếp byte gốc: nó parse rồi `JSON.stringify`
 * ra một thân mới, không nén. Giữ lại `Content-Encoding` của client nghĩa là
 * bảo upstream giải nén một thân JSON thô, còn giữ `Content-Length` là khai
 * sai độ dài. `fetch` tự đặt lại độ dài nhưng không đụng tới encoding, nên
 * phải gỡ ở đây.
 */
const BODY_OWNED_HEADERS = new Set(["content-encoding", "content-length"]);

/**
 * Content-Encoding mà shim tự giải được, ánh xạ sang tên `DecompressionStream`.
 *
 * Encoding lạ (`br`, `zstd`) không bị đoán mò: request đó đi thẳng, vì đọc
 * byte nén như UTF-8 chỉ sinh ra một lỗi parse sai chỗ.
 */
const DECODABLE_ENCODINGS = new Map<string, "gzip" | "deflate">([
  ["gzip", "gzip"],
  ["x-gzip", "gzip"],
  ["deflate", "deflate"],
]);

/**
 * Mức hợp lệ của `logging/setLevel`, theo RFC 5424 như đặc tả MCP dẫn lại.
 */
const LOGGING_LEVELS = new Set([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
]);

/**
 * Capabilities mà shim KHÔNG được khai hộ, dù client cũ có khai lúc
 * `initialize`.
 *
 * Cả ba đều mô tả một luồng mà transport này không chở nổi tới cùng.
 * `elicitation` là ví dụ đã đo được: server 2026-07-28 đọc nó rồi trả về phong
 * bì MRTR `resultType: "input_required"`, và client 2025-11-25 không biết phong
 * bì đó là gì nên nó chỉ thấy một result rỗng - tệ hơn hẳn lời báo lỗi kèm danh
 * sách ứng viên mà nó vẫn nhận được khi không khai `elicitation`.
 * `sampling` và `roots` thì cần server hỏi ngược lại client, mà stream tổng hợp
 * ở đây không chở request nào.
 *
 * Khai đúng những gì chở được, và im lặng về phần còn lại.
 */
const UNBRIDGED_CAPABILITIES = new Set(["elicitation", "sampling", "roots"]);

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

/** Danh tính client điền vào `_meta` khi bản thân request không mang theo. */
export interface ClientIdentity {
  name: string;
  version: string;
}

export interface ShimOptions {
  /** Gốc URL của server thật, ví dụ `http://hvgerp-mcp-origin:7654`. */
  upstream: string;
  /** Nhịp heartbeat cho stream SSE giả, tính bằng mili giây. */
  heartbeatMs?: number;
  /** Trần kích thước thân POST của nhánh dịch, tính bằng byte. */
  maxBodyBytes?: number;
  log?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bọc giá trị header theo sentinel base64 khi nó không phải ASCII an toàn.
 *
 * Sao đúng thuật toán của server: nó từ chối một giá trị ngoài tập an toàn mà
 * gửi thô, và cũng từ chối một giá trị thô trông y hệt sentinel.
 */
export function encodeHeaderValue(value: string): string {
  const looksLikeSentinel = value.startsWith(SENTINEL_PREFIX) &&
    value.endsWith(SENTINEL_SUFFIX);
  if (HEADER_SAFE_VALUE.test(value) && !looksLikeSentinel) return value;

  const utf8 = new TextEncoder().encode(value);
  let latin1 = "";
  for (const byte of utf8) latin1 += String.fromCharCode(byte);
  return `${SENTINEL_PREFIX}${btoa(latin1)}${SENTINEL_SUFFIX}`;
}

/**
 * Shim có được phép dịch request này hay không.
 *
 * Ba trường hợp, và chỉ hai trong số đó được dịch: không khai revision (đúng
 * hình dạng của Cowork, và là lý do shim tồn tại), khai một revision cũ nằm
 * trong {@link KNOWN_LEGACY_VERSIONS}, hoặc khai một revision lạ. Trường hợp
 * thứ ba đi thẳng lên server thật, kể cả khi nó mới hơn 2026-07-28.
 */
export function acceptsSyntheticStream(headers: Headers): boolean {
  const declared = headers.get("MCP-Protocol-Version");
  return declared !== null && SYNTHETIC_STREAM_VERSIONS.has(declared);
}

export function isTranslatableRequest(headers: Headers): boolean {
  const declared = headers.get("MCP-Protocol-Version");
  if (declared === null || declared.length === 0) return true;
  return KNOWN_LEGACY_VERSIONS.has(declared);
}

/**
 * Thân request có cho phép dịch hay không, xét riêng `initialize`.
 *
 * Header không phải chỗ duy nhất client khai revision, và với client cũ thì nó
 * còn là chỗ hay vắng nhất: chính hình dạng "không header, revision nằm trong
 * `params.protocolVersion`" là lý do shim tồn tại. Nếu chỉ soi header thì một
 * `initialize` không header khai một revision tương lai vẫn bị hạ xuống
 * 2026-07-28 rồi nhận lại đúng revision nó xin, tức là vẫn đúng cái bắt tay
 * giả mà {@link KNOWN_LEGACY_VERSIONS} sinh ra để chặn.
 *
 * `initialize` không phải chỗ duy nhất: mọi message đều có thể khai revision
 * trong `params._meta`, và `rewriteOutbound` ghi đè đúng khoá đó, nên bỏ sót
 * nó là để một lời gọi thuộc revision lạ chạy thật thay vì bị server từ chối.
 *
 * Bản 2026-07-28 khai trong thân thì vẫn dịch được: dịch nó là phép đồng nhất
 * cộng thêm bộ header còn thiếu, không có gì bị bịa ra.
 */
export function isTranslatableBody(parsed: unknown): boolean {
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const params = entry["params"];
    if (!isRecord(params)) continue;

    const declared: unknown[] = [];
    if (entry["method"] === "initialize" && "protocolVersion" in params) {
      declared.push(params["protocolVersion"]);
    }
    const meta = params["_meta"];
    if (isRecord(meta) && META_PROTOCOL_VERSION in meta) {
      declared.push(meta[META_PROTOCOL_VERSION]);
    }

    for (const value of declared) {
      if (value === undefined) continue;
      // Khai một revision KHÔNG phải chuỗi - `protocolVersion: 7` - không giống
      // với không khai gì. Coi hai thứ đó như nhau nghĩa là `rewriteOutbound`
      // thay số 7 bằng 2026-07-28 và một request sai định dạng đi hết cuộc
      // thương lượng như thể nó đúng. Để upstream trả lỗi kiểm tra thật.
      if (typeof value !== "string" || value.length === 0) return false;
      if (value === SPEC_2026_07_28) continue;
      if (!KNOWN_LEGACY_VERSIONS.has(value)) return false;
    }
  }
  return true;
}

/**
 * Đọc một số nguyên dương từ biến môi trường, hoặc ném lỗi.
 *
 * `Number()` trần biến "abc" thành `NaN` và "" thành `0`, mà `setInterval`
 * nhận cả hai rồi chạy như chu kỳ 0: một kết nối SSE duy nhất đủ để bơm
 * keepalive liên tục. Cấu hình sai phải làm tiến trình chết lúc khởi động,
 * chứ không phải sống dở lúc có tải.
 */
export function readPositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max
  ) {
    throw new RangeError(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}, got ${
        JSON.stringify(raw)
      }`,
    );
  }
  return parsed;
}

/**
 * Client có thật sự xin stream SSE hay không.
 *
 * Phép thử chuỗi con sai ở hai chiều: `text/event-stream;q=0` là lời từ chối
 * tường minh mà vẫn khớp, còn `Text/Event-Stream` là lời xin hợp lệ mà không
 * khớp. Cái sai thứ nhất mở một kết nối sống lâu không ai muốn, cái thứ hai
 * đẩy client cũ về đúng 405 mà shim sinh ra để tránh.
 */
/**
 * Thân request có tự khai là JSON hay không.
 *
 * Shim đọc và phân tích thân TRƯỚC khi dựng lại request, rồi dán
 * `Content-Type: application/json` lên bản gửi đi. Không kiểm ở đây thì một
 * request khai `text/plain` (hay không khai gì) mà bên trong là JSON vẫn được
 * nâng thành một request MCP hợp lệ, đúng thứ mà tầng vận chuyển phải từ chối.
 */
export function isJsonMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const media = contentType.split(";", 1)[0].trim().toLowerCase();
  return media === "application/json";
}

export function acceptsEventStream(accept: string): boolean {
  for (const range of accept.split(",")) {
    const [media, ...params] = range.split(";");
    if (media.trim().toLowerCase() !== "text/event-stream") continue;
    const quality = params
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith("q="));
    if (quality === undefined) return true;
    const value = Number(quality.slice(2));
    if (!Number.isFinite(value) || value > 0) return true;
  }
  return false;
}

/**
 * Trường nào của request sai kiểu tới mức shim không được phép vá, hoặc
 * `undefined` nếu không có.
 *
 * `rewriteOutbound` chỉ biết "có phải object không": không phải thì nó dựng một
 * object rỗng để có chỗ đặt `_meta`. Với một trường vắng mặt thì đó là phép
 * nâng cấp đúng; với một trường CÓ mặt mà sai kiểu thì đó là sửa hộ client một
 * request mà bộ kiểm của server phải từ chối - và server không bao giờ nhìn
 * thấy giá trị thật để từ chối.
 */
export function describeInvalidFields(
  message: JsonRpcMessage,
): string | undefined {
  const params = message.params;
  if (params === undefined) return undefined;
  if (!isRecord(params)) return "'params' must be an object";

  if ("_meta" in params && !isRecord(params["_meta"])) {
    return "'params._meta' must be an object";
  }
  const meta = params["_meta"];
  if (
    isRecord(meta) && META_CLIENT_CAPABILITIES in meta &&
    !isRecord(meta[META_CLIENT_CAPABILITIES])
  ) {
    return `'params._meta.${META_CLIENT_CAPABILITIES}' must be an object`;
  }
  if (
    message.method === "initialize" && "capabilities" in params &&
    !isRecord(params["capabilities"])
  ) {
    return "'params.capabilities' must be an object";
  }
  return undefined;
}

/**
 * Mọi revision mà thân request tự khai, theo thứ tự gặp và không lặp.
 *
 * Đọc mỗi `message[0]` là đủ sai trong đúng trường hợp batch trộn: một `ping`
 * đời cũ không mang metadata đứng đầu sẽ đẩy cả batch về bản mặc định, và câu
 * trả lời cho entry sau echo một revision nó không hề xin.
 */
export function readDeclaredRevisions(
  message: JsonRpcMessage | JsonRpcMessage[] | undefined,
): string[] {
  const entries = Array.isArray(message)
    ? message
    : message === undefined
    ? []
    : [message];
  const found: string[] = [];
  for (const entry of entries) {
    const params = entry?.params;
    if (!isRecord(params)) continue;
    const meta = params["_meta"];
    // Đọc cả hai chỗ khai trong cùng một entry chứ không dừng ở chỗ đầu tiên:
    // một `initialize` khai `2025-06-18` ở thân và `2025-03-26` ở `_meta` là
    // một lời khai tự mâu thuẫn, mà nếu chỉ đọc thân thì nó lọt qua phép so
    // bên dưới và `rewriteOutbound` ghi đè cả hai bằng bản 2026.
    for (
      const value of [
        params["protocolVersion"],
        isRecord(meta) ? meta[META_PROTOCOL_VERSION] : undefined,
      ]
    ) {
      if (typeof value !== "string" || value.length === 0) continue;
      if (!found.includes(value)) found.push(value);
    }
  }
  return found;
}

/**
 * Revision mà request này thật sự khai, hoặc `undefined` nếu nó không khai gì.
 *
 * Tách khỏi {@link readClientProtocolVersion} vì hai câu hỏi khác nhau: "client
 * xin bản nào" và "shim đoán bản nào". Chỗ gọi cần phân biệt được lời khai thật
 * với bản mặc định thì mới biết có gì đáng nhớ cho lượt sau.
 */
export function readDeclaredProtocolVersion(
  headers: Headers,
  message: JsonRpcMessage | JsonRpcMessage[] | undefined,
): string | undefined {
  const fromHeader = headers.get("MCP-Protocol-Version");
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return fromHeader;
  }
  // Message không phải `initialize` khai revision ở `_meta`, và đó là chỗ
  // {@link isTranslatableBody} đã chấp nhận, nên bỏ qua nó ở đây là dịch đúng
  // nhưng trả lời sai: response echo một revision client không hề xin.
  return readDeclaredRevisions(message)[0];
}

/** Revision mà client cũ tự nhận, để trả lại đúng thứ nó chờ đợi. */
export function readClientProtocolVersion(
  headers: Headers,
  message: JsonRpcMessage | JsonRpcMessage[] | undefined,
): string {
  return readDeclaredProtocolVersion(headers, message) ??
    LEGACY_FALLBACK_VERSION;
}

/** Suy ra danh tính client từ header Anthropic gửi kèm, để log server có nghĩa. */
export function readClientIdentity(
  headers: Headers,
  clientVersion: string,
): ClientIdentity {
  const vendor = headers.get("X-Anthropic-Client") ??
    headers.get("User-Agent") ?? "legacy-mcp-client";
  return { name: `${vendor} (via compat shim)`, version: clientVersion };
}

/**
 * Capabilities client khai lúc `initialize`, giữ lại cho những lời gọi sau.
 *
 * Ở transport cũ, client khai capabilities đúng một lần rồi thôi, còn server
 * 2026-07-28 đọc `_meta.clientCapabilities` của TỪNG request. Điền `{}` cho
 * mọi lời gọi sau `initialize` nghĩa là nói dối server rằng client không làm
 * được gì: `src/mrtr/link-disambiguation.ts` đọc đúng trường đó để quyết định
 * có hỏi lại người dùng hay không, nên một client có `elicitation` sẽ bị hạ
 * xuống báo lỗi thay vì được hỏi.
 *
 * Khoá là băm SHA-256 của chứng danh, không phải bản thân chứng danh: bộ nhớ
 * này sống lâu, và một token nằm nguyên văn trong đó là một thứ không cần
 * thiết phải giữ. Bảng có trần và đuổi bản ghi cũ nhất, vì một shim công khai
 * không được để bộ nhớ lớn theo số client.
 *
 * Không có chứng danh thì KHÔNG có khoá, và không có khoá thì không nhớ gì.
 * Một khoá dùng chung - chẳng hạn băm của hằng "anonymous" khi chạy không xác
 * thực - không phải bộ nhớ theo client mà là một ô nhớ toàn cục: `initialize`
 * của người này ghi đè capabilities của người kia, nên một lời gọi có thể nhận
 * `input_required` dù client của nó không làm được, hoặc mất đúng khả năng nó
 * vừa khai. Nhớ sai còn tệ hơn không nhớ.
 */
const CAPABILITY_CACHE = new Map<string, Record<string, unknown>>();
const CAPABILITY_CACHE_MAX = 512;

/**
 * Trần kích thước cho một bản ghi capabilities.
 *
 * Đếm số bản ghi là chưa đủ khi chạy không xác thực: mỗi `initialize` ẩn danh
 * được cấp một phiên mới, mà `experimental` thì chở được gần trọn trần thân
 * request, nên 512 bản ghi vẫn giữ được hàng GB. Những capability có nghĩa với
 * shim - `elicitation`, `sampling`, `roots` - chỉ vài trăm byte; thứ vượt trần
 * này không phải khai báo mà là tải trọng, và quên nó vẫn đúng hơn giữ nó.
 */
const CAPABILITY_MAX_BYTES = 8 * 1024;

/** Băm chứng danh thành khoá: bộ nhớ này sống lâu, token thì không nên. */
async function digestKey(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function capabilityKey(req: Request): Promise<string | undefined> {
  const session = req.headers.get("Mcp-Session-Id");
  const authorization = req.headers.get("Authorization");
  if (session === null && authorization === null) return undefined;

  // Một token tĩnh dùng chung cho nhiều client vẫn gộp chúng vào một khoá, nên
  // trộn thêm dấu vết phần mềm gọi. Hai client cùng token VÀ cùng dấu vết thì
  // là cùng một phần mềm, tức capabilities của chúng giống nhau và va nhau
  // cũng không đổi kết quả.
  const source = session ?? [
    authorization,
    req.headers.get("X-Anthropic-Client") ?? "",
    req.headers.get("User-Agent") ?? "",
  ].join("\n");
  return await digestKey(source);
}

/**
 * Gắn phiên do shim cấp vào một response.
 *
 * Client chạy trong trình duyệt chỉ đọc được những header mà CORS cho phép lộ,
 * nên cấp một phiên rồi không khai nó ở `Access-Control-Expose-Headers` là cấp
 * một thứ người nhận không nhìn thấy.
 */
function attachSession(headers: Headers, session: string): void {
  headers.set("Mcp-Session-Id", session);
  if (headers.get("Access-Control-Allow-Origin") === null) return;
  const exposed = headers.get("Access-Control-Expose-Headers") ?? "";
  const names = exposed.split(",").map((name) => name.trim().toLowerCase());
  // `*` không phải ký tự đại diện với request mang chứng danh: trình duyệt đọc
  // nó thành tên header đúng nghĩa đen, nên chỉ dựa vào nó là để một client
  // cross-origin dùng cookie không bao giờ thấy phiên vừa được cấp.
  if (names.includes("mcp-session-id")) return;
  headers.set(
    "Access-Control-Expose-Headers",
    exposed.length > 0 ? `${exposed}, Mcp-Session-Id` : "Mcp-Session-Id",
  );
}

/** Bỏ những capability mà transport này không chở nổi tới cùng. */
function bridgeableCapabilities(
  capabilities: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(capabilities)) {
    if (UNBRIDGED_CAPABILITIES.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function rememberCapabilities(key: string, capabilities: unknown): void {
  if (!isRecord(capabilities)) return;
  const bridged = bridgeableCapabilities(capabilities);
  if (JSON.stringify(bridged).length > CAPABILITY_MAX_BYTES) return;
  // Xoá rồi đặt lại để bản ghi vừa dùng về cuối hàng, nên phép đuổi bên dưới
  // bỏ đúng bản ghi lâu không đụng tới nhất.
  CAPABILITY_CACHE.delete(key);
  CAPABILITY_CACHE.set(key, bridged);
  while (CAPABILITY_CACHE.size > CAPABILITY_CACHE_MAX) {
    const oldest = CAPABILITY_CACHE.keys().next().value;
    if (oldest === undefined) break;
    CAPABILITY_CACHE.delete(oldest);
  }
}

/**
 * Revision mà mỗi client đã thoả thuận ở `initialize`.
 *
 * `MCP-Protocol-Version` chỉ có từ bản 2025-06-18, nên một client 2025-03-26
 * khai bản của nó đúng một lần - trong thân `initialize` - rồi im lặng mãi mãi.
 * Không nhớ thì mọi lượt sau của nó rơi về {@link LEGACY_FALLBACK_VERSION}, và
 * response echo một revision nó chưa từng xin.
 */
const REVISION_CACHE = new Map<string, string>();

/**
 * Đọc một bản ghi và đẩy nó về cuối hàng.
 *
 * `Map` giữ thứ tự chèn, nên phép đuổi bên dưới lấy đúng bản ghi vào sớm nhất
 * chứ không phải bản ghi lâu không dùng nhất - trừ khi mỗi lượt đọc cũng đặt
 * lại. Không làm thì một client cũ vẫn đang chạy bị đuổi vì nó khai
 * `initialize` từ lâu, dù mọi lời gọi của nó đều vừa chạm bộ nhớ này.
 */
function touch<T>(cache: Map<string, T>, key: string): T | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function rememberRevision(key: string, version: string): void {
  // Cùng phép đuổi với CAPABILITY_CACHE: đặt lại để bản ghi vừa dùng về cuối
  // hàng, rồi bỏ bản ghi lâu không đụng tới nhất.
  REVISION_CACHE.delete(key);
  REVISION_CACHE.set(key, version);
  while (REVISION_CACHE.size > CAPABILITY_CACHE_MAX) {
    const oldest = REVISION_CACHE.keys().next().value;
    if (oldest === undefined) break;
    REVISION_CACHE.delete(oldest);
  }
}

/** Quên sạch trạng thái của một phiên: dùng khi client đóng phiên bằng DELETE. */
function forgetSession(key: string): void {
  CAPABILITY_CACHE.delete(key);
  REVISION_CACHE.delete(key);
}

/** Xoá bộ nhớ capabilities. Dành cho test, để hai bài không dẫm lên nhau. */
export function clearCapabilityCache(): void {
  CAPABILITY_CACHE.clear();
  REVISION_CACHE.clear();
}

export interface OutboundMessage {
  message: JsonRpcMessage;
  headers: Record<string, string>;
}

/**
 * Nâng một message đời cũ lên đúng hình dạng 2026-07-28.
 *
 * Chỉ thêm, không xoá: `_meta` sẵn có của client được giữ nguyên trừ khoá
 * protocolVersion, vì đó là thứ duy nhất bắt buộc phải khớp header.
 */
export function rewriteOutbound(
  message: JsonRpcMessage,
  identity: ClientIdentity,
  rememberedCapabilities?: Record<string, unknown>,
): OutboundMessage {
  const method = typeof message.method === "string" ? message.method : "";
  const params = isRecord(message.params) ? { ...message.params } : {};
  const meta = isRecord(params["_meta"]) ? { ...params["_meta"] } : {};

  meta[META_PROTOCOL_VERSION] = SPEC_2026_07_28;
  if (!isRecord(meta[META_CLIENT_CAPABILITIES])) {
    meta[META_CLIENT_CAPABILITIES] = isRecord(params["capabilities"])
      ? params["capabilities"]
      : rememberedCapabilities ?? {};
  }
  if (!isRecord(meta[META_CLIENT_INFO])) {
    meta[META_CLIENT_INFO] = isRecord(params["clientInfo"])
      ? params["clientInfo"]
      : identity;
  }
  params["_meta"] = meta;

  // `initialize` mang protocolVersion ở cả hai chỗ trong bản cũ. Server đọc
  // `_meta`, nhưng để lại "2025-11-25" trong params là bỏ lại một mâu thuẫn
  // ngay trong cùng một thân request.
  if (method === "initialize") {
    params["protocolVersion"] = SPEC_2026_07_28;
  }

  const headers: Record<string, string> = {
    "MCP-Protocol-Version": SPEC_2026_07_28,
    "Mcp-Method": method,
  };

  const nameField = NAME_SOURCE[method];
  if (nameField !== undefined) {
    const value = params[nameField];
    // Giá trị không phải chuỗi là request hỏng của client. Bỏ qua header ở đây
    // để server trả về đúng lỗi của nó thay vì shim bịa ra một lỗi khác.
    if (typeof value === "string") {
      headers["Mcp-Name"] = encodeHeaderValue(value);
    }
  }

  return { message: { ...message, params }, headers };
}

/**
 * Hạ một result 2026-07-28 về hình dạng mà client cũ chờ đợi.
 *
 * `resultType` là trường của phong bì mới, không tồn tại ở 2025-11-25;
 * `protocolVersion` trong result của `initialize` phải là bản mà client đã
 * đề nghị, nếu không client coi như thương lượng thất bại.
 *
 * Một phong bì `input_required` thì không được gỡ trường phân biệt rồi thả đi:
 * làm thế client cũ nhận một result trông như bình thường nhưng rỗng nội dung,
 * còn câu hỏi thì nằm trong `inputRequests` mà nó không biết đọc. Câu hỏi đó
 * vốn đã là văn bản cho người đọc, nên hạ nó xuống một tool result báo lỗi:
 * người dùng thấy đúng danh sách ứng viên và gọi lại với ID cụ thể.
 */
export function rewriteInbound(
  payload: unknown,
  clientVersion: string,
): unknown {
  if (Array.isArray(payload)) {
    return payload.map((entry) => rewriteInbound(entry, clientVersion));
  }
  if (!isRecord(payload) || !isRecord(payload["result"])) return payload;

  const result = { ...payload["result"] };
  if (result["resultType"] === "input_required") {
    return { ...payload, result: describeInputRequired(result) };
  }
  delete result["resultType"];
  if (typeof result["protocolVersion"] === "string") {
    result["protocolVersion"] = clientVersion;
  }
  return { ...payload, result };
}

/**
 * Hạ phong bì `input_required` xuống một tool result mà client cũ hiểu.
 *
 * Mỗi mục trong `inputRequests` là một `elicitation/create` với `params.message`
 * đã viết sẵn cho người đọc. Gom chúng lại thành nội dung văn bản và đánh dấu
 * `isError` để host hiển thị như một lời gọi chưa xong, thay vì như một kết quả
 * thành công không có gì bên trong.
 */
function describeInputRequired(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const requests = result["inputRequests"];
  const messages: string[] = [];
  if (isRecord(requests)) {
    for (const request of Object.values(requests)) {
      if (!isRecord(request)) continue;
      const params = request["params"];
      if (isRecord(params) && typeof params["message"] === "string") {
        messages.push(params["message"]);
      }
    }
  }
  if (messages.length === 0) {
    messages.push(
      "This call needs more input than the legacy MCP revision can carry.",
    );
  }
  return {
    content: [{ type: "text", text: messages.join("\n\n") }],
    isError: true,
  };
}

/**
 * Tập hop-by-hop của riêng một request.
 *
 * RFC 9110 §7.6.1: ngoài danh sách cố định, mọi tên mà chính header
 * `Connection` gọi ra cũng là hop-by-hop. Bỏ qua vế thứ hai nghĩa là một
 * request mang `Connection: X-Internal-Auth` bị gỡ mất `Connection` nhưng
 * `X-Internal-Auth` vẫn được chuyển tiếp, tức là shim rò một header vốn chỉ
 * có nghĩa giữa hai chặng sang một upstream có thể đang tin nó.
 */
function hopByHopFor(source: Headers): Set<string> {
  const hops = new Set(HOP_BY_HOP);
  const connection = source.get("Connection");
  if (connection !== null) {
    for (const token of connection.split(",")) {
      const name = token.trim().toLowerCase();
      if (name.length > 0) hops.add(name);
    }
  }
  return hops;
}

function filterHeaders(source: Headers): Headers {
  const hops = hopByHopFor(source);
  const out = new Headers();
  for (const [key, value] of source) {
    const lower = key.toLowerCase();
    if (
      hops.has(lower) || SHIM_OWNED_HEADERS.has(lower) ||
      BODY_OWNED_HEADERS.has(lower)
    ) continue;
    out.set(key, value);
  }
  return out;
}

/** Mang header CORS của upstream sang response do shim dựng. */
function copyCorsHeaders(from: Headers | undefined, to: Headers): void {
  if (from === undefined) return;
  for (const name of CORS_HEADERS) {
    const value = from.get(name);
    if (value !== null) to.set(name, value);
  }
}

/**
 * Mã 4xx phải tới thẳng client, không được hạ xuống 200.
 *
 * Chúng không nói về lời gọi mà nói về quyền và nhịp: 401/407 khởi động lại
 * luồng xác thực, 403 là từ chối dứt khoát, 429 là lệnh lùi nhịp. Bọc chúng
 * trong một HTTP 200 là giấu đi đúng thứ client cần thấy.
 */
const AUTH_STATUSES = new Set([401, 403, 407, 429]);

function isProtocolErrorStatus(status: number): boolean {
  return status >= 400 && status < 500 && !AUTH_STATUSES.has(status);
}

function hasJsonRpcError(payload: unknown): boolean {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.some((entry) => isRecord(entry) && isRecord(entry["error"]));
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: { code, message },
  };
}

/**
 * `id` hợp lệ theo JSON-RPC 2.0, hoặc `null` khi không xác định được.
 *
 * Chép nguyên `id` sai kiểu vào error response là trả cho client một phong bì
 * cũng sai kiểu: nó không đối chiếu được lỗi với lời gọi nào, và bộ đọc chặt
 * còn vứt luôn cả response.
 */
function normalizeId(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

interface ForwardOutcome {
  /**
   * Thân JSON-RPC đã dịch, hoặc `undefined` khi upstream không trả JSON
   * (202 không thân, stream SSE, trang lỗi của tầng dưới).
   */
  payload?: unknown;
  status: number;
  /** Response gốc, còn nguyên thân chưa đọc khi `payload` là `undefined`. */
  response: Response;
}

async function forwardOne(
  message: JsonRpcMessage,
  req: Request,
  target: URL,
  identity: ClientIdentity,
  clientVersion: string,
  rememberedCapabilities?: Record<string, unknown>,
  allowEventStream = true,
): Promise<ForwardOutcome> {
  const { message: outbound, headers: mcpHeaders } = rewriteOutbound(
    message,
    identity,
    rememberedCapabilities,
  );
  const headers = filterHeaders(req.headers);
  for (const [key, value] of Object.entries(mcpHeaders)) {
    headers.set(key, value);
  }
  headers.set("Content-Type", "application/json");
  // Hai lý do để KHÔNG xin SSE, và cả hai đều là lời của client. Một: shim
  // tách batch thành N lượt gọi, mà một stream không đối chiếu được với từng
  // entry, nên nhận nó cho entry đầu nghĩa là các entry sau không bao giờ được
  // gửi. Hai: client tự khai không đọc được SSE - `Accept: application/json`
  // hay `text/event-stream;q=0` - và dịch thân bên trong không làm media type
  // đó trở nên đọc được với nó.
  const wantsStream = allowEventStream &&
    acceptsEventStream(req.headers.get("Accept") ?? "");
  headers.set(
    "Accept",
    wantsStream ? "application/json, text/event-stream" : "application/json",
  );

  // Client rời đi thì lượt gọi upstream cũng phải dừng: không nối tín hiệu
  // huỷ, shim giữ nguyên request, thân response và socket cho tới khi upstream
  // tự xong, nên một chuỗi lời gọi bị bỏ dở tích lại thành công việc thừa.
  const res = await fetch(target, {
    method: "POST",
    headers,
    body: JSON.stringify(outbound),
    signal: req.signal,
  });

  // Media type không phân biệt hoa thường (RFC 9110), nên `Application/JSON`
  // của một upstream hay một tầng trung gian vẫn là JSON. So chuỗi thô ở đây
  // biến nó thành "không phải JSON" và cả bước dịch bị bỏ qua.
  const contentType = (res.headers.get("Content-Type") ?? "").toLowerCase();
  if (contentType.startsWith("text/event-stream") && res.body !== null) {
    // Shim tự khai `Accept: text/event-stream`, nên upstream được quyền trả
    // stream cho một POST đã dịch. Trả thẳng stream đó nghĩa là mọi message
    // bên trong giữ nguyên hình dạng 2026-07-28 - nặng nhất là `initialize`
    // báo về đúng revision mà client không nói được.
    // Thân được viết lại nên độ dài cũ hết đúng, và một `Content-Length` sai
    // là lỗi khung tin chứ không phải sai lệch nhỏ.
    const streamHeaders = new Headers(res.headers);
    for (const name of BODY_OWNED_HEADERS) streamHeaders.delete(name);
    // Thân bên trong đã được hạ về revision của client, nên header khai
    // revision cũng phải theo: giữ `2026-07-28` ở đây là gửi đi một response
    // tự mâu thuẫn với chính nó.
    streamHeaders.set("MCP-Protocol-Version", clientVersion);
    return {
      status: res.status,
      response: new Response(
        translateEventStream(res.body, clientVersion),
        { status: res.status, headers: streamHeaders },
      ),
    };
  }
  if (res.status === 202 || !contentType.includes("application/json")) {
    return { status: res.status, response: res };
  }

  const payload = rewriteInbound(await res.json(), clientVersion);

  // Ở transport cũ, mọi lỗi JSON-RPC đều đi kèm HTTP 200; client cũ đọc một mã
  // 4xx là "endpoint hỏng" rồi vứt cả endpoint thay vì báo lỗi một lời gọi.
  // 2026-07-28 thì ngược lại: method lạ trả 404, header lệch trả 400 kèm
  // -32020. Hạ mọi 4xx CÓ thân JSON-RPC error xuống 200 - trừ những mã nói về
  // quyền, vì đó là câu trả lời client bắt buộc phải thấy nguyên trạng để khởi
  // động lại luồng OAuth hoặc để lùi nhịp.
  const status = isProtocolErrorStatus(res.status) && hasJsonRpcError(payload)
    ? 200
    : res.status;
  return { payload, status, response: res };
}

/**
 * Dịch từng sự kiện SSE khi bay qua, giữ nguyên khung sự kiện.
 *
 * Sự kiện SSE kết thúc ở một dòng trống, mà ranh giới chunk của mạng thì rơi ở
 * đâu cũng được, nên phải gom vào bộ đệm rồi mới cắt. Dòng không phải `data:`
 * (`event:`, `id:`, `retry:`, comment) đi qua nguyên trạng; khối nào không
 * phải JSON cũng vậy, vì đoán nghĩa một khối lạ còn tệ hơn chuyển tiếp nó.
 */
export function translateEventStream(
  source: ReadableStream<Uint8Array>,
  clientVersion: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = "";
  let pendingCr = false;

  const rewriteBlock = (block: string): string => {
    const lines = block.split("\n");
    const data: string[] = [];
    let dataIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("data:")) continue;
      if (dataIndex < 0) dataIndex = index;
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    if (dataIndex < 0) return block;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join("\n"));
    } catch {
      return block;
    }
    const rewritten = JSON.stringify(rewriteInbound(parsed, clientVersion));
    const kept = lines.filter((line) => !line.startsWith("data:"));
    kept.splice(dataIndex, 0, `data: ${rewritten}`);
    return kept.join("\n");
  };

  const transform = new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      // Một `\r\n` bị mạng cắt đôi giữa hai chunk: chuẩn hoá riêng từng chunk
      // biến `\r` cuối chunk thành `\n`, rồi `\n` đầu chunk sau ghép vào thành
      // một dòng trống không có thật, tức một sự kiện bị cắt đôi rồi dịch nhầm.
      // Giữ lại `\r` treo đến khi biết ký tự sau nó là gì.
      let text = chunk;
      if (pendingCr) {
        text = `\r${text}`;
        pendingCr = false;
      }
      if (text.endsWith("\r")) {
        pendingCr = true;
        text = text.slice(0, -1);
      }
      // SSE cho phép cả ba kiểu xuống dòng; chuẩn hoá về `\n` để chỉ phải tìm
      // một dạng ranh giới, và phát lại bằng `\n` cũng vẫn đúng spec.
      buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        controller.enqueue(encoder.encode(`${rewriteBlock(block)}\n\n`));
        boundary = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      // Stream kết thúc ngay sau một `\r`: nó là một dấu xuống dòng trọn vẹn,
      // không phải một byte để bỏ đi.
      if (pendingCr) {
        buffer += "\n";
        pendingCr = false;
      }
      if (buffer.length === 0) return;
      controller.enqueue(encoder.encode(rewriteBlock(buffer)));
    },
  });

  return source.pipeThrough(new TextDecoderStream()).pipeThrough(transform);
}

/** Stream SSE rỗng thay cho 405, đúng vai `GET /mcp` của transport cũ. */
function openLegacyStream(
  heartbeatMs: number,
  upstreamHeaders?: Headers,
): Response {
  let timer: number | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      // Client cũ chờ stream mở và im lặng: server-initiated message ở
      // revision mới đi qua `subscriptions/listen`, không qua đây. Heartbeat
      // chỉ để Cloudflare và các proxy trung gian không đóng kết nối rỗng.
      controller.enqueue(encoder.encode(": connected\n\n"));
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          if (timer !== undefined) clearInterval(timer);
        }
      }, heartbeatMs) as unknown as number;
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    // Tắt buffering của proxy ngược, nếu không stream sẽ nằm im trong bộ đệm.
    "X-Accel-Buffering": "no",
  });
  copyCorsHeaders(upstreamHeaders, headers);
  return new Response(stream, { status: 200, headers });
}

/**
 * Chuyển tiếp nguyên trạng.
 *
 * `body` chỉ được truyền khi thân đã bị đọc mất để quyết định có dịch hay
 * không; khi ấy phải gửi lại bản đã đọc vì `req.body` không tua lại được.
 */
async function proxyPassThrough(
  req: Request,
  target: URL,
  body?: string,
): Promise<Response> {
  const hops = hopByHopFor(req.headers);
  const headers = new Headers();
  for (const [key, value] of req.headers) {
    const lower = key.toLowerCase();
    if (hops.has(lower)) continue;
    // Thân đã đọc là thân đã giải nén: giữ `Content-Encoding` của client ở đây
    // là bảo upstream giải nén một lần nữa thứ đã phẳng.
    if (body !== undefined && BODY_OWNED_HEADERS.has(lower)) continue;
    headers.set(key, value);
  }
  const init: RequestInit & { duplex?: string; signal?: AbortSignal } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (body !== undefined) {
    init.body = body;
  } else if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Bắt buộc khi thân là stream chưa đọc hết, nếu không fetch từ chối gửi.
    init.duplex = "half";
  }
  init.signal = req.signal;
  return await fetch(target, init);
}

/**
 * Trần mặc định cho thân một POST đời cũ, tính bằng byte.
 *
 * Nhánh dịch buộc phải giữ cả thân trong bộ nhớ để parse, nên không có trần
 * thì một caller chưa qua cổng xác thực nào cũng bơm được một thân tuỳ ý và
 * bắt tiến trình shim ôm nó. 32 MiB là chỗ đứng giữa: đủ cho lời gọi thật
 * nặng nhất - `erpnext_file_upload` gửi nội dung tệp dạng base64, tức là gấp
 * khoảng 4/3 kích thước tệp - và vẫn là một trần cứng thay vì không có gì.
 */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Đọc thân request, hoặc trả `null` khi nó vượt `limit` byte.
 *
 * `Content-Length` được soi trước để một thân khai sẵn là quá khổ bị chặn
 * trước khi đọc byte nào; nhưng nó không phải bằng chứng nên vòng đọc vẫn tự
 * đếm, vì thân chunked không khai độ dài và một thân có khai vẫn có thể nói
 * dối.
 *
 * Khi thân được nén, `Content-Length` nói về kích thước NÉN nên không dùng để
 * chặn trước được: mấy KiB nén phồng ra được hàng GiB. Vòng đếm chạy sau khi
 * giải nén nên cùng một trần chặn luôn cả thân phồng.
 *
 * Ném lỗi khi luồng nén hỏng; người gọi hạ nó thành lỗi parse, vì đó đúng là
 * thứ đã xảy ra: thân không đọc ra được.
 */
async function readBoundedText(
  req: Request,
  limit: number,
  encoding?: "gzip" | "deflate",
): Promise<string | null> {
  const declared = req.headers.get("Content-Length");
  if (encoding === undefined && declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > limit) return null;
  }

  const source = req.body;
  if (source === null) return "";
  const body = encoding === undefined
    ? source
    : source.pipeThrough(new DecompressionStream(encoding));

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Kết quả hỏi upstream xem caller có quyền hay không.
 */
interface AuthorizationProbe {
  /** Response phải trả thẳng cho client khi phép hỏi không cho phép tổng hợp. */
  blocked?: Response;
  /** Header của lượt hỏi, để chép CORS sang response shim tự dựng. */
  upstream: Headers;
}

/**
 * Hỏi upstream xem caller có quyền không, TRƯỚC khi shim tự trả lời `GET` hay
 * `DELETE`.
 *
 * Không có phép hỏi này thì hai verb đó là hai lỗ thủng: bất kỳ ai cũng mở
 * được một stream SSE sống lâu kèm timer keepalive mà không cần token, tức là
 * đi vòng qua đúng cái cổng xác thực mà server dựng lên, và giữ được tài
 * nguyên của tiến trình.
 *
 * Phép hỏi phải là `POST`: đo trên server thật, `GET` và `DELETE` trả 405
 * bất kể có token hay không, nên chúng vô dụng làm phép thử quyền. `ping` là
 * lời gọi đúng ở đây vì nó không có tác dụng phụ và đã bị gỡ khỏi 2026-07-28,
 * nên câu trả lời phân biệt sạch: 401 khi thiếu quyền, 404 (`-32601`) khi đã
 * qua cổng.
 */
async function authorizeSynthetic(
  req: Request,
  target: URL,
): Promise<AuthorizationProbe> {
  const headers = filterHeaders(req.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  headers.set("MCP-Protocol-Version", SPEC_2026_07_28);
  headers.set("Mcp-Method", "ping");

  const probe = await fetch(target, {
    method: "POST",
    headers,
    signal: req.signal,
    // Một tầng xác thực đẩy request chưa đăng nhập sang trang login trả 302;
    // đi theo nó thì mã cuối cùng là 200 của trang login, và shim đọc thành
    // "đã qua cổng". Redirect phải là câu trả lời, không phải một bước.
    redirect: "manual",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "shim-authorization-probe",
      method: "ping",
      params: {
        _meta: {
          [META_PROTOCOL_VERSION]: SPEC_2026_07_28,
          [META_CLIENT_CAPABILITIES]: {},
        },
      },
    }),
  });

  // Chỉ hai câu trả lời nghĩa là "đã qua cổng": 2xx, và 404 của `ping` (bản
  // 2026-07-28 bỏ method này). Mọi mã khác đều phải chặn, và danh sách phải
  // viết theo chiều cho phép chứ không theo chiều cấm: liệt kê 401/403/407/429
  // rồi cho qua phần còn lại là mở cổng cho mọi mã chưa ai nghĩ tới - 3xx của
  // một trang login, 400 của một tầng chặn, 405 của một endpoint sai - và
  // đường đi sau đó là shim tự tổng hợp `ping`, GET stream hay DELETE thành
  // công cho một caller chưa từng qua xác thực.
  const passed = (probe.status >= 200 && probe.status < 300) ||
    probe.status === 404;
  if (!passed) {
    return { blocked: probe, upstream: probe.headers };
  }
  await probe.body?.cancel();
  return { upstream: probe.headers };
}

/**
 * Kiểm phong bì của một request mà shim tự trả lời, trả lỗi JSON-RPC nếu sai.
 *
 * Chỉ dùng cho {@link LOCALLY_ANSWERED}: mọi method khác đều đi lên server và
 * gặp bộ kiểm thật ở đó.
 */
function validateLocalRequest(
  message: JsonRpcMessage,
): Record<string, unknown> | undefined {
  const id = message.id;
  if (message.jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "Invalid Request: 'jsonrpc' must be '2.0'");
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return jsonRpcError(
      null,
      -32600,
      "Invalid Request: 'id' must be a string or a number",
    );
  }
  // JSON-RPC bắt `params` phải là kiểu có cấu trúc, còn MCP thu hẹp thêm về
  // object. `ping` với `params: "invalid"` mà nhận `result` rỗng nghĩa là shim
  // vừa nới lỏng bộ kiểm của server ở đúng hai method server không nhìn thấy.
  const params = message.params;
  if (params !== undefined && !isRecord(params)) {
    return jsonRpcError(
      id,
      -32602,
      "Invalid params: 'params' must be an object",
    );
  }
  if (message.method === "logging/setLevel") {
    const level = isRecord(params) ? params["level"] : undefined;
    if (typeof level !== "string" || !LOGGING_LEVELS.has(level)) {
      return jsonRpcError(
        id,
        -32602,
        "Invalid params: 'level' must be a syslog severity name",
      );
    }
  }
  return undefined;
}

/**
 * Điểm vào duy nhất của shim.
 *
 * Thứ tự nhánh là cố ý: luồng hiện đại được nhận ra trước hết và đi thẳng, nên
 * một lỗi trong phần dịch không thể làm hỏng đường đang chạy tốt.
 */
export async function handleShimRequest(
  req: Request,
  opts: ShimOptions,
): Promise<Response> {
  const url = new URL(req.url);
  // Client cấu hình endpoint là `/mcp/` hoặc trỏ thẳng vào gốc không phải
  // chuyện hiếm, và một proxy đứng trước giữ nguyên dấu gạch chéo đó. Chuẩn hoá
  // cả hai về `/mcp` ngay tại đây, nếu không cả nhánh dịch lẫn hai verb tổng
  // hợp đều không chạy và client cũ nhận lại đúng lời từ chối mà shim sinh ra
  // để tránh.
  //
  // Chuẩn hoá phải xảy ra TRƯỚC khi dựng target, không chỉ ở phép so đường
  // dẫn: coi `/` là đường MCP mà vẫn gửi lên gốc của upstream nghĩa là
  // `initialize` rơi vào 404 của tầng định tuyến, và tệ hơn, phép hỏi quyền
  // đọc đúng cái 404 đó thành "đã lọt cổng".
  const path = url.pathname === "/mcp/" || url.pathname === "/"
    ? "/mcp"
    : url.pathname;

  // `new URL(path, upstream)` KHÔNG an toàn ở đây: một path mở đầu bằng `//`
  // là URL scheme-relative, nên `//169.254.169.254/latest/meta-data` thay luôn
  // host và biến shim thành proxy mở tới mọi thứ mạng của nó với tới - đường
  // không phải `/mcp` lại còn được chuyển tiếp trước cả phép hỏi quyền. Gán
  // `pathname` thì bộ phân tích chỉ đọc phần path và origin không đổi; phép so
  // origin bên dưới là chốt thứ hai, để một cách phá khác cũng không đi qua.
  const upstream = new URL(opts.upstream);
  const target = new URL(upstream);
  target.pathname = path;
  target.search = url.search;
  if (target.origin !== upstream.origin) {
    return Response.json(
      jsonRpcError(
        null,
        -32600,
        "Invalid Request: refusing to change upstream",
      ),
      { status: 400 },
    );
  }

  const isMcpPath = path === "/mcp";

  if (!isMcpPath) return await proxyPassThrough(req, target);

  if (req.method === "GET") {
    const accept = req.headers.get("Accept") ?? "";
    // Client hiện đại không mở stream ở đây, nên chỉ nhận SSE mới đổi hành vi;
    // còn lại vẫn để server trả 405 của chính nó. Và chỉ những revision shim
    // nhận dịch mới được nhận stream tổng hợp: với một revision ngoài danh
    // sách - `2024-11-05` chờ sự kiện `endpoint`, hay một bản tương lai - stream
    // im lặng này là một lời hứa suông, client treo thay vì nhận lời từ chối.
    if (acceptsEventStream(accept) && acceptsSyntheticStream(req.headers)) {
      const auth = await authorizeSynthetic(req, target);
      if (auth.blocked !== undefined) return auth.blocked;
      return openLegacyStream(opts.heartbeatMs ?? 15_000, auth.upstream);
    }
    return await proxyPassThrough(req, target);
  }

  // Transport cũ đóng phiên bằng DELETE. Server stateless không có phiên để
  // đóng, nên câu trả lời đúng là "đã xong", không phải "verb không hợp lệ".
  // Nhưng chỉ với revision shim nhận dịch: với các bản khác, shim đã hứa không
  // đụng vào, mà 204 tổng hợp ở đây là báo đóng phiên thành công thay cho 405
  // thật của endpoint stateless.
  if (req.method === "DELETE" && isTranslatableRequest(req.headers)) {
    const auth = await authorizeSynthetic(req, target);
    if (auth.blocked !== undefined) return auth.blocked;
    // Phiên do shim cấp thì cũng do shim thu hồi: báo "đã đóng" mà vẫn giữ
    // capabilities và revision của nó nghĩa là một `Mcp-Session-Id` đã đóng
    // vẫn dịch được lời gọi bằng đúng trạng thái cũ.
    const closing = await capabilityKey(req);
    if (closing !== undefined) forgetSession(closing);
    const headers = new Headers();
    copyCorsHeaders(auth.upstream, headers);
    return new Response(null, { status: 204, headers });
  }

  if (
    req.method !== "POST" || !isTranslatableRequest(req.headers) ||
    !isJsonMediaType(req.headers.get("Content-Type"))
  ) {
    return await proxyPassThrough(req, target);
  }

  /** Hỏi một lần cho cả request, dùng lại cho mọi nhánh cần biết quyền. */
  let authorization: AuthorizationProbe | undefined;
  const authorize = async (): Promise<AuthorizationProbe> =>
    authorization ??= await authorizeSynthetic(req, target);

  /**
   * Lỗi do chính shim sinh ra, không phải của upstream.
   *
   * Vẫn phải mang chính sách CORS của upstream: với client chạy trong trình
   * duyệt, một 413 thiếu `Access-Control-Allow-Origin` hiện ra thành lỗi CORS
   * chung chung, tức là giấu mất đúng câu giải thích mà shim vừa viết ra.
   */
  const localFailure = async (
    status: number,
    payload: Record<string, unknown>,
  ): Promise<Response> => {
    const auth = await authorize();
    if (auth.blocked !== undefined) return auth.blocked;
    const headers = new Headers({ "Content-Type": "application/json" });
    // Response đã dịch nào cũng echo revision client xin, nên một lỗi do shim
    // tự sinh mà thiếu header đó là một response lệch chuẩn: client chặt đọc
    // metadata trước rồi vứt luôn cả câu giải thích bên trong.
    const declared = req.headers.get("MCP-Protocol-Version");
    if (declared !== null && KNOWN_LEGACY_VERSIONS.has(declared)) {
      headers.set("MCP-Protocol-Version", declared);
    }
    copyCorsHeaders(auth.upstream, headers);
    return new Response(JSON.stringify(payload), { status, headers });
  };

  // Thân nén: giải được thì giải, không giải được thì đi thẳng. Đọc byte nén
  // như UTF-8 rồi báo lỗi parse là đổ lỗi sai cho client.
  const encoding = (req.headers.get("Content-Encoding") ?? "").trim()
    .toLowerCase();
  let decoding: "gzip" | "deflate" | undefined;
  if (encoding.length > 0 && encoding !== "identity") {
    decoding = DECODABLE_ENCODINGS.get(encoding);
    if (decoding === undefined) return await proxyPassThrough(req, target);
  }

  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let raw: string | null;
  try {
    raw = await readBoundedText(req, maxBodyBytes, decoding);
  } catch {
    return await localFailure(
      400,
      jsonRpcError(null, -32700, "Parse error: unreadable content encoding"),
    );
  }
  if (raw === null) {
    return await localFailure(
      413,
      jsonRpcError(
        null,
        -32600,
        `Request body exceeds the ${maxBodyBytes} byte limit`,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return await localFailure(400, jsonRpcError(null, -32700, "Parse error"));
  }

  // JSON-RPC 2.0: batch rỗng là Invalid Request, không phải một batch chỉ toàn
  // notification. Trả 202 cho nó là để client chờ một câu trả lời không bao giờ tới.
  if (Array.isArray(parsed) && parsed.length === 0) {
    return await localFailure(
      400,
      jsonRpcError(null, -32600, "Invalid Request: empty batch"),
    );
  }

  // Thân đã bị đọc mất ở trên nên phải gửi lại bản `raw`, không phải `req.body`.
  if (!isTranslatableBody(parsed)) {
    return await proxyPassThrough(req, target, raw);
  }

  // Một request khai hai revision khác nhau không có câu trả lời đúng: response
  // dựng lại chỉ mang được một `MCP-Protocol-Version`, nên chọn bừa một bản là
  // echo cho phân nửa số entry một revision chúng không hề xin. Header nằm
  // trong phép so cùng với thân: nó cũng là một lời khai, và một request khai
  // `2025-06-18` ở header rồi `2025-03-26` ở thân thì mâu thuẫn y như hai entry
  // đá nhau.
  const declaredRevisions = new Set(
    readDeclaredRevisions(parsed as JsonRpcMessage[]),
  );
  const headerRevision = req.headers.get("MCP-Protocol-Version");
  if (headerRevision !== null && headerRevision.length > 0) {
    declaredRevisions.add(headerRevision);
  }
  if (declaredRevisions.size > 1) {
    return await localFailure(
      400,
      jsonRpcError(
        null,
        -32600,
        "Invalid Request: request declares more than one protocol revision",
      ),
    );
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];

  // Vắng khoá nghĩa là không phân biệt được caller, và khi đó shim không nhớ
  // và cũng không phát lại gì.
  const credentialKey = await capabilityKey(req);

  // Chạy HTTP không xác thực là một chế độ được hỗ trợ (AGENTS.md, "HTTP mode
  // starts unauthenticated with a startup warning"), và ở đó một client
  // 2025-03-26 không mang theo thứ gì để nhận diện: không token, không phiên,
  // và revision thì nó khai đúng một lần rồi im. Bịa một khoá từ User-Agent là
  // gộp mọi caller vào một ô nhớ chung - đúng thứ mà chú thích của
  // CAPABILITY_CACHE bác bỏ. Cấp cho nó một phiên là cách duy nhất vừa phân
  // biệt được caller vừa không đoán mò: transport 2025-03-26 trở đi bắt client
  // gửi lại `Mcp-Session-Id` ở mọi request sau, và upstream 2026-07-28 không
  // bao giờ thấy header này vì nó nằm trong SHIM_OWNED_HEADERS.
  const mintedSession = credentialKey === undefined &&
      messages.some((entry) =>
        isRecord(entry) && entry["method"] === "initialize"
      )
    ? crypto.randomUUID()
    : undefined;
  const sessionKey = credentialKey ??
    (mintedSession === undefined ? undefined : await digestKey(mintedSession));

  const declaredVersion = readDeclaredProtocolVersion(
    req.headers,
    parsed as JsonRpcMessage | JsonRpcMessage[],
  );
  const clientVersion = declaredVersion ??
    (sessionKey === undefined
      ? undefined
      : touch(REVISION_CACHE, sessionKey)) ??
    LEGACY_FALLBACK_VERSION;
  const identity = readClientIdentity(req.headers, clientVersion);

  const replies: unknown[] = [];
  let status = 200;
  let upstreamHeaders: Headers | undefined;
  // Phiên chỉ được trao đi khi đã có gì đó để nó trỏ tới.
  let issuedSession: string | undefined;

  for (const entry of messages) {
    if (!isRecord(entry) || typeof entry["method"] !== "string") {
      // Câu trả lời này cũng do shim tự viết, nên nó cũng đi vòng qua cổng xác
      // thực của server nếu không hỏi: một thân `[{}]` không token vẫn nhận
      // HTTP 200 thay vì 401.
      const auth = await authorize();
      if (auth.blocked !== undefined) return auth.blocked;
      upstreamHeaders ??= auth.upstream;
      replies.push(jsonRpcError(
        normalizeId(isRecord(entry) ? entry["id"] : null),
        -32600,
        "Invalid Request: missing 'method' field",
      ));
      continue;
    }

    const message = entry as JsonRpcMessage;
    const id = message.id;

    if (id !== undefined && LOCALLY_ANSWERED.has(message.method as string)) {
      // Trả lời tại chỗ nghĩa là không có lượt nào chạm cổng xác thực của
      // server, nên phải tự hỏi. Không hỏi thì một caller không token vẫn nhận
      // 200 cho keepalive và báo "phiên còn sống", trong khi mọi lời gọi thật
      // của nó đều bị từ chối.
      const auth = await authorize();
      if (auth.blocked !== undefined) return auth.blocked;
      upstreamHeaders ??= auth.upstream;
      // Hai method này không bao giờ tới bộ kiểm của server, nên shim phải tự
      // kiểm. Không kiểm thì một phong bì sai - thiếu `jsonrpc`, `id` là object,
      // `level` không hợp lệ - vẫn nhận `result` rỗng như một lời gọi đúng.
      const invalid = validateLocalRequest(message);
      replies.push(
        invalid ?? { jsonrpc: "2.0", id, result: {} },
      );
      continue;
    }

    // `rewriteOutbound` thay trường sai kiểu bằng `{}` để có chỗ đặt `_meta`,
    // nên `{"method":"tools/list","params":[]}` tới server dưới hình dạng một
    // request hợp lệ và nhận về danh sách tool thay vì `-32602`. Bộ kiểm của
    // server không bao giờ nhìn thấy giá trị thật, nên shim phải tự từ chối.
    const invalidField = describeInvalidFields(message);
    if (invalidField !== undefined) {
      const auth = await authorize();
      if (auth.blocked !== undefined) return auth.blocked;
      upstreamHeaders ??= auth.upstream;
      // Notification sai định dạng không có câu trả lời nào theo JSON-RPC,
      // nhưng vẫn phải đi qua cổng quyền: bỏ qua nó mà không hỏi là để một
      // caller không token nhận 202 thay vì 401.
      if (id !== undefined) {
        replies.push(jsonRpcError(
          normalizeId(id),
          -32602,
          `Invalid params: ${invalidField}`,
        ));
      }
      continue;
    }

    const outcome = await forwardOne(
      message,
      req,
      target,
      identity,
      clientVersion,
      sessionKey === undefined
        ? undefined
        : touch(CAPABILITY_CACHE, sessionKey),
      !Array.isArray(parsed),
    );
    upstreamHeaders = outcome.response.headers;

    // Không có JSON để dịch thì không có gì để shim làm: trả nguyên response
    // của upstream, thân còn nguyên chưa đọc. Đây là đường của 401 kèm
    // `WWW-Authenticate` (thứ khởi động lại luồng OAuth), của 5xx, và của mọi
    // thân không phải JSON.
    // Response không có JSON để đọc - stream SSE, thân lạ, 5xx - thì shim không
    // biết cuộc thoả thuận có thành hay không, nên không cấp phiên ở đây: quên
    // vẫn đúng hơn nhớ một trạng thái chưa chắc có thật.
    if (outcome.payload === undefined && outcome.status !== 202) {
      return outcome.response;
    }
    if (outcome.status >= 400) status = outcome.status;
    if (outcome.payload !== undefined) replies.push(outcome.payload);

    // Chỉ nhớ sau khi thoả thuận THÀNH CÔNG. Ghi trước lúc gọi nghĩa là một
    // `initialize` bị upstream từ chối vẫn để lại capabilities, revision và
    // một phiên gắn trên chính response lỗi: client mang phiên đó quay lại và
    // được dịch bằng một trạng thái chưa bao giờ được thoả thuận.
    if (
      message.method === "initialize" && sessionKey !== undefined &&
      isRecord(message.params) && outcome.status < 400 &&
      outcome.payload !== undefined && !hasJsonRpcError(outcome.payload)
    ) {
      rememberCapabilities(sessionKey, message.params["capabilities"]);
      // Thoả thuận revision xảy ra đúng một lần, ở đây. Chỉ nhớ bản đời cũ đã
      // biết: một lời khai `2026-07-28` được phát lại cho lượt sau là dựng
      // ngược chính thứ shim sinh ra để dịch.
      if (
        declaredVersion !== undefined &&
        KNOWN_LEGACY_VERSIONS.has(declaredVersion)
      ) {
        rememberRevision(sessionKey, declaredVersion);
      }
      issuedSession = mintedSession;
    }

    // Cả batch dùng chung một bộ chứng danh, nên khi một message đã nhận câu
    // trả lời về quyền hoặc về nhịp thì mọi message còn lại chắc chắn nhận
    // đúng câu đó. Đi tiếp không đổi được kết quả mà biến một request bên
    // ngoài thành N lượt gọi lên tầng xác thực: một thân vừa đủ dưới trần
    // kích thước cũng chứa được hàng nghìn message nhỏ.
    if (AUTH_STATUSES.has(outcome.status)) break;
  }

  if (replies.length === 0) {
    const accepted = new Headers();
    // 202 vẫn là một câu trả lời, nên nó cũng phải mang revision như đường
    // JSON bên dưới: client chặt chẽ đọc thiếu header này thì bỏ luôn một
    // response vốn đã thành công.
    accepted.set("MCP-Protocol-Version", clientVersion);
    copyCorsHeaders(upstreamHeaders, accepted);
    if (issuedSession !== undefined) attachSession(accepted, issuedSession);
    return new Response(null, { status: 202, headers: accepted });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("MCP-Protocol-Version", clientVersion);
  // Ba header điều khiển mà response dựng lại phải mang theo, nếu không client
  // đọc được lệnh nhưng không đọc được cách thi hành: thiếu `Retry-After` thì
  // 429 là "hãy chờ" mà không nói chờ bao lâu, thiếu `Proxy-Authenticate` thì
  // 407 là "hãy xưng danh với proxy" mà không nói xưng theo cách nào.
  for (
    const name of ["WWW-Authenticate", "Proxy-Authenticate", "Retry-After"]
  ) {
    const value = upstreamHeaders?.get(name);
    if (value !== null && value !== undefined) headers.set(name, value);
  }
  copyCorsHeaders(upstreamHeaders, headers);
  if (issuedSession !== undefined) attachSession(headers, issuedSession);

  const body = Array.isArray(parsed) ? replies : replies[0];
  return new Response(JSON.stringify(body), { status, headers });
}
