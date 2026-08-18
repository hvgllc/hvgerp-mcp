/**
 * Entry point của shim tương thích MCP đời cũ.
 *
 * Chạy như một tiến trình riêng đứng trước server thật, không nhúng vào
 * server: `McpApp` đăng ký `POST /mcp` của chính nó và `customRoutes` không
 * có cách nào gọi tiếp handler gốc, nên mọi bản vá tại chỗ sẽ phải chép lại
 * toàn bộ đường xử lý POST.
 *
 * Biến môi trường:
 *   SHIM_PORT       cổng lắng nghe (mặc định 7654)
 *   SHIM_HOSTNAME   địa chỉ bind (mặc định 0.0.0.0)
 *   SHIM_UPSTREAM   gốc URL của server thật (bắt buộc)
 *   SHIM_HEARTBEAT_MS nhịp keepalive cho stream SSE giả (mặc định 15000)
 */
import { handleShimRequest } from "./src/compat/legacy-shim.ts";

const upstream = Deno.env.get("SHIM_UPSTREAM");
if (upstream === undefined || upstream.length === 0) {
  console.error(
    "[shim] SHIM_UPSTREAM is required, e.g. http://hvgerp-mcp-origin:7654",
  );
  Deno.exit(1);
}

const port = Number(Deno.env.get("SHIM_PORT") ?? "7654");
const hostname = Deno.env.get("SHIM_HOSTNAME") ?? "0.0.0.0";
const heartbeatMs = Number(Deno.env.get("SHIM_HEARTBEAT_MS") ?? "15000");

console.log(`[shim] listening on ${hostname}:${port}, upstream ${upstream}`);

Deno.serve({ port, hostname }, async (req) => {
  try {
    return await handleShimRequest(req, { upstream, heartbeatMs });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[shim] upstream failure: ${detail}`);
    return Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: `Shim upstream failure: ${detail}` },
    }, { status: 502 });
  }
});
