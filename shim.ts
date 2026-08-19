/**
 * Entry point của shim tương thích MCP đời cũ.
 *
 * Chạy như một tiến trình riêng đứng trước server thật, không nhúng vào
 * server: `McpApp` đăng ký `POST /mcp` của chính nó và `customRoutes` không
 * có cách nào gọi tiếp handler gốc, nên mọi bản vá tại chỗ sẽ phải chép lại
 * toàn bộ đường xử lý POST.
 *
 * Biến môi trường:
 *   SHIM_PORT       cổng lắng nghe, 1..65535 (mặc định 7654)
 *   SHIM_HOSTNAME   địa chỉ bind (mặc định 0.0.0.0)
 *   SHIM_UPSTREAM   gốc URL của server thật (bắt buộc)
 *   SHIM_HEARTBEAT_MS nhịp keepalive cho stream SSE giả, 1000..300000 ms
 *                     (mặc định 15000)
 *   SHIM_MAX_BODY_BYTES trần thân POST của nhánh dịch, 65536..134217728 byte
 *                     (mặc định 33554432)
 *
 * Ba giá trị số được kiểm ngay lúc khởi động và sai thì tiến trình chết. Đây
 * là cố ý: một `SHIM_HEARTBEAT_MS` rỗng hay không phải số mà lọt qua sẽ thành
 * chu kỳ 0, và tiến trình chỉ tỏ ra hỏng khi đã có client cắm vào.
 */
import {
  handleShimRequest,
  readPositiveInteger,
} from "./src/compat/legacy-shim.ts";

const upstream = Deno.env.get("SHIM_UPSTREAM");
if (upstream === undefined || upstream.length === 0) {
  console.error(
    "[shim] SHIM_UPSTREAM is required, e.g. http://hvgerp-mcp-origin:7654",
  );
  Deno.exit(1);
}

// Cùng lý do với ba giá trị số bên dưới: một URL hỏng chỉ vỡ ở request đầu
// tiên, nơi nó thành một 502 chung chung, trong khi log khởi động đã báo shim
// đang lắng nghe. Một triển khai không dùng được phải chết ngay lúc dựng, chứ
// không phải trông như đã lên.
try {
  const parsed = new URL(upstream);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported scheme ${parsed.protocol}`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[shim] SHIM_UPSTREAM must be an http(s) URL: ${detail}`);
  Deno.exit(1);
}

let port: number;
let heartbeatMs: number;
let maxBodyBytes: number;
try {
  port = readPositiveInteger("SHIM_PORT", Deno.env.get("SHIM_PORT"), 7654, {
    min: 1,
    max: 65535,
  });
  heartbeatMs = readPositiveInteger(
    "SHIM_HEARTBEAT_MS",
    Deno.env.get("SHIM_HEARTBEAT_MS"),
    15_000,
    { min: 1000, max: 300_000 },
  );
  maxBodyBytes = readPositiveInteger(
    "SHIM_MAX_BODY_BYTES",
    Deno.env.get("SHIM_MAX_BODY_BYTES"),
    32 * 1024 * 1024,
    { min: 64 * 1024, max: 128 * 1024 * 1024 },
  );
} catch (error) {
  console.error(`[shim] ${error instanceof Error ? error.message : error}`);
  Deno.exit(1);
}

const hostname = Deno.env.get("SHIM_HOSTNAME") ?? "0.0.0.0";

console.log(`[shim] listening on ${hostname}:${port}, upstream ${upstream}`);

Deno.serve({ port, hostname }, async (req) => {
  try {
    return await handleShimRequest(req, {
      upstream,
      heartbeatMs,
      maxBodyBytes,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Chi tiết chỉ đi vào log của người vận hành. Thông điệp của `fetch` mang
    // nguyên URL upstream, tức tên service và cổng nội bộ; người gọi chưa xác
    // thực nào cũng chạm được nhánh này nên không trả nó ra ngoài dây.
    console.error(`[shim] upstream failure: ${detail}`);
    return Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Shim upstream failure" },
    }, { status: 502 });
  }
});
