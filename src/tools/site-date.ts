/**
 * Ngày "hôm nay" theo múi giờ của chính site ERPNext.
 *
 * Tách khỏi `hr.ts` vì không chỉ số dư phép cần nó: mọi tool tự dựng khoảng thời gian
 * (số dư tính đến hôm nay, cửa sổ sáu tháng gần nhất) đều lệch cùng một kiểu nếu lấy
 * ngày UTC của tiến trình MCP, và lệch đúng vào lúc ranh giới ngày hoặc ranh giới
 * tháng, tức đúng lúc con số bị soi.
 *
 * @module lib/erpnext/tools/site-date
 */

import type { ErpNextToolContext } from "./types.ts";

/**
 * Múi giờ site khai báo, hoặc `null` khi không đọc được bằng quyền của người đang gọi.
 *
 * Hai bậc chứ không một, vì mỗi bậc hỏng theo một kiểu khác nhau. `System Settings` là nơi
 * chính Frappe lấy múi giờ ra dùng, nhưng doctype đó chỉ cấp quyền đọc cho System Manager,
 * nên với hầu hết người dùng lời gọi này trả PermissionError. `frappe.client.get_time_zone`
 * thì ai cũng gọi được, đổi lại nó đọc bảng defaults chứ không đọc System Settings: đo trên
 * production thấy nó trả `Asia/Kolkata` cho Administrator trong khi site khai
 * `Asia/Ho_Chi_Minh`. Nên thứ tự là quyền-cao-trước, và giá trị lệch chỉ được dùng khi không
 * còn cách nào khác.
 */
export async function siteTimeZone(
  ctx: ErpNextToolContext,
): Promise<string | null> {
  try {
    const value = await ctx.client.callMethod<{ time_zone?: string } | null>(
      "frappe.client.get_value",
      { doctype: "System Settings", fieldname: "time_zone" },
      { httpMethod: "GET" },
    );
    if (value?.time_zone) return value.time_zone;
  } catch {
    // Không có quyền đọc System Settings: thử bậc dưới.
  }

  try {
    const value = await ctx.client.callMethod<{ time_zone?: string } | null>(
      "frappe.client.get_time_zone",
      {},
      { httpMethod: "GET" },
    );
    if (value?.time_zone) return value.time_zone;
  } catch {
    // Cả hai đường đều tắc.
  }

  return null;
}

/**
 * Hôm nay theo múi giờ của chính site, dạng YYYY-MM-DD.
 *
 * Không dùng thẳng ngày UTC của tiến trình: máy chủ MCP có thể chạy ở múi giờ khác site, và
 * "số dư phép tính đến hôm nay" lệch một ngày là một câu trả lời sai trông y hệt câu đúng
 * ngay đúng lúc nó quan trọng nhất, tức ngày đầu hoặc cuối kỳ phép. Khi không đọc được cấu
 * hình thì lùi về UTC, và người gọi vẫn thấy ngày đã dùng qua `as_on_date` trong kết quả.
 */
/**
 * Bây giờ theo múi giờ của chính site, dạng `YYYY-MM-DD HH:MM:SS`.
 *
 * Cùng lý do với `siteToday`, nhưng cho những phép kiểm mà độ phân giải ngày là chưa đủ:
 * một lượt bấm giờ lúc 17:30 của chính hôm nay vẫn là sự kiện chưa xảy ra khi đồng hồ mới
 * chỉ 9h. Định dạng khớp đúng kiểu Datetime của Frappe nên so sánh chuỗi là so sánh thời
 * gian, không phải một phép quy đổi nữa.
 */
export async function siteNow(ctx: ErpNextToolContext): Promise<string> {
  const timeZone = await siteTimeZone(ctx);

  const now = new Date();
  if (timeZone) {
    try {
      // `en-CA` cho ra `YYYY-MM-DD, HH:MM:SS`; dấu phẩy là thứ duy nhất phải bỏ đi.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        // `h23` chứ không phải `hour12: false`: nhánh 12 giờ tắt vẫn cho ra "24:00:00" ở
        // nửa đêm trên một số runtime, và "24" không phải giờ hợp lệ của một chuỗi Datetime.
        hourCycle: "h23",
      }).format(now).replace(", ", " ");
    } catch {
      // Múi giờ site khai không hợp lệ với runtime này; rơi xuống UTC bên dưới.
    }
  }
  return now.toISOString().slice(0, 19).replace("T", " ");
}

export async function siteToday(ctx: ErpNextToolContext): Promise<string> {
  const timeZone = await siteTimeZone(ctx);

  const now = new Date();
  if (timeZone) {
    try {
      // `en-CA` cho ra đúng YYYY-MM-DD, và `timeZone` là thứ duy nhất làm nó khác UTC.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      // Múi giờ site khai không hợp lệ với runtime này; rơi xuống UTC bên dưới.
    }
  }
  return now.toISOString().slice(0, 10);
}
