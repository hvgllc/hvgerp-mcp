/**
 * Gọi hàm whitelisted của app riêng `hvg_workspace` trên site.
 *
 * Nhiều nhóm tool (sửa ngày công, đơn hàng sàn, tài khoản bán hàng) dựa vào hàm của app riêng
 * thay vì doctype chuẩn. Site thiếu app thì Frappe trả một lỗi tra hàm khó hiểu; module này dịch
 * đúng lỗi đó thành câu nói rõ app nào cần có, và để mọi lỗi khác đi nguyên vẹn.
 *
 * @module lib/erpnext/tools/hvg-workspace
 */

import { FrappeAPIError } from "../api/frappe-client.ts";
import type { ErpNextToolContext } from "./types.ts";

/**
 * Câu duy nhất Frappe nói khi KHÔNG phân giải được đường dẫn hàm.
 *
 * Hẹp có chủ ý. Bắt theo "not found" hay "does not exist" chung thì mọi lỗi nghiệp vụ có
 * chứa mấy chữ ấy - một lượt bấm giờ vừa bị người khác xoá, chẳng hạn - đều bị dịch thành
 * "site này không có app", tức là báo sai nguyên nhân, và `FrappeAPIError` bị thay bằng
 * `Error` trần nên người gọi mất luôn `status` với `body` đã parse.
 */
const METHOD_LOOKUP_FAILURE = /Failed to get method|Method Not Found/i;

/**
 * Gọi một hàm của `hvg_workspace`, dịch "app không có" thành câu người đọc hiểu được.
 *
 * `missingAppHint` là câu nói nhóm tool nào cần app nào, vì mỗi nhóm cần một lời khác nhau.
 */
export async function callHvgWorkspace<T>(
  ctx: ErpNextToolContext,
  method: string,
  args: Record<string, unknown>,
  tool: string,
  missingAppHint: string,
  opts: { httpMethod?: "GET" | "POST" } = {},
): Promise<T> {
  try {
    return await ctx.client.callMethod<T>(method, args, opts);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Soi cả thân phản hồi đã parse, không chỉ `message`: `FrappeAPIError` dựng message từ
    // `message ?? exc_type ?? statusText`, mà lượt tra hàm hỏng thường chỉ có `exc_type`
    // là "ValidationError" còn nguyên văn "Failed to get method" nằm trong `exception`.
    // Chỉ đọc message là trượt đúng cái ca mà lớp bọc này sinh ra để dịch.
    const body = err instanceof FrappeAPIError && err.body !== null
      ? JSON.stringify(err.body)
      : "";
    // Frappe trả cùng một lỗi cho "hàm không tồn tại" dù nguyên nhân là app chưa cài hay
    // tên gõ sai. Người đọc cần biết nhánh nào để còn hành động.
    if (METHOD_LOOKUP_FAILURE.test(text) || METHOD_LOOKUP_FAILURE.test(body)) {
      throw new Error(
        `[${tool}] this site does not expose '${method}'. ${missingAppHint} ` +
          "Original error: " + text,
        { cause: err },
      );
    }
    throw err;
  }
}
