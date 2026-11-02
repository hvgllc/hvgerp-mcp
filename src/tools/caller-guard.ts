/**
 * Chặn tool chỉ được trả lời bằng danh tính của chính người hỏi.
 *
 * Có những câu hỏi mà câu trả lời đúng phụ thuộc vào việc AI hỏi: "hiệu suất của Đức thế nào"
 * với trưởng nhóm của Đức là số trên các đơn của nhóm đó, với người không quản lý Đức là "không
 * được xem". Client dùng chung (service account của bản triển khai, hay khoá tĩnh của stdio) gọi
 * ERP bằng quyền của tài khoản dịch vụ, nên câu trả lời là tầm nhìn của tài khoản ấy: thường rộng
 * hơn người hỏi, và trông y hệt một câu trả lời đúng. Lớp chặn này đứng trước mọi lượt gọi ERP.
 *
 * @module lib/erpnext/tools/caller-guard
 */

import type { ErpNextToolContext } from "./types.ts";

/**
 * Ném lỗi khi client không mang token của chính người gọi.
 *
 * Kiểm `=== "caller"` chứ không `!== "service"`: client không khai `actsAs` cũng không được coi
 * là đang nói thay người hỏi, vì mặc định của `FrappeClient` là `"service"`.
 */
export function requireCallerClient(
  ctx: ErpNextToolContext,
  tool: string,
): void {
  if (ctx.client.actsAs === "caller") return;
  throw new Error(
    `[${tool}] this tool answers with the caller's own ERP permissions, but this ` +
      "deployment runs it under a shared service account, which would show what that " +
      "account can see instead. Use the per-user OAuth connector (HTTP mode with a " +
      "signed-in user) to call it.",
  );
}
