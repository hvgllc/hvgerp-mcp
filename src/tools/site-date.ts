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
  return (await resolveTimeZone(ctx)).zone;
}

/**
 * Múi giờ site, kèm câu trả lời cho "giá trị này có phải thứ chính Frappe dùng không".
 *
 * `authoritative` không phải chi tiết trang trí: bậc dưới đọc bảng defaults chứ không đọc
 * `System Settings`, và đo trên production thấy nó trả `Asia/Kolkata` cho một site khai
 * `Asia/Ho_Chi_Minh` - lệch 1.5 giờ. Một phép kiểm chỉ tính theo NGÀY nuốt được sai số ấy,
 * còn phép kiểm tính theo GIỜ thì không: nó sẽ từ chối một lượt bấm vừa xảy ra, hoặc cho
 * lọt một lượt bấm chưa xảy ra, mà không cách nào phân biệt. Nên người gọi phải biết mình
 * đang cầm giá trị nào.
 */
async function resolveTimeZone(
  ctx: ErpNextToolContext,
): Promise<{ zone: string | null; authoritative: boolean }> {
  try {
    const value = await ctx.client.callMethod<{ time_zone?: string } | null>(
      "frappe.client.get_value",
      { doctype: "System Settings", fieldname: "time_zone" },
      { httpMethod: "GET" },
    );
    if (value?.time_zone) return { zone: value.time_zone, authoritative: true };
  } catch {
    // Không có quyền đọc System Settings: thử bậc dưới.
  }

  try {
    const value = await ctx.client.callMethod<{ time_zone?: string } | null>(
      "frappe.client.get_time_zone",
      {},
      { httpMethod: "GET" },
    );
    if (value?.time_zone) {
      return { zone: value.time_zone, authoritative: false };
    }
  } catch {
    // Cả hai đường đều tắc.
  }

  return { zone: null, authoritative: false };
}

/**
 * Bây giờ theo múi giờ của chính site, dạng `YYYY-MM-DD HH:MM:SS`.
 *
 * `authoritative` tắt nghĩa là múi giờ chỉ đọc được ở bậc dưới, tức con số này có thể lệch
 * vài giờ so với đồng hồ site - xem `resolveTimeZone`. Người gọi tự quyết định: phép kiểm
 * theo ngày vẫn dùng được, phép kiểm theo giờ thì không, và một phép kiểm theo giờ chạy
 * trên một con số lệch còn tệ hơn không có phép kiểm nào, vì nó từ chối việc hợp lệ.
 *
 * Định dạng khớp đúng kiểu Datetime của Frappe nên so sánh chuỗi là so sánh thời gian,
 * không phải một phép quy đổi nữa.
 */
export async function siteNow(
  ctx: ErpNextToolContext,
): Promise<{ now: string; authoritative: boolean }> {
  const { zone, authoritative } = await resolveTimeZone(ctx);

  const now = new Date();
  if (zone) {
    try {
      // `en-CA` cho ra `YYYY-MM-DD, HH:MM:SS`; dấu phẩy là thứ duy nhất phải bỏ đi.
      const formatted = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
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
      return { now: formatted, authoritative };
    } catch {
      // Múi giờ site khai không hợp lệ với runtime này; rơi xuống UTC bên dưới.
    }
  }
  return {
    now: now.toISOString().slice(0, 19).replace("T", " "),
    authoritative: false,
  };
}

/**
 * Hôm nay theo múi giờ của chính site, dạng YYYY-MM-DD.
 *
 * Không dùng thẳng ngày UTC của tiến trình: máy chủ MCP có thể chạy ở múi giờ khác site, và
 * "số dư phép tính đến hôm nay" lệch một ngày là một câu trả lời sai trông y hệt câu đúng
 * ngay đúng lúc nó quan trọng nhất, tức ngày đầu hoặc cuối kỳ phép. Khi không đọc được cấu
 * hình thì lùi về UTC, và người gọi vẫn thấy ngày đã dùng qua `as_on_date` trong kết quả.
 */
export async function siteToday(ctx: ErpNextToolContext): Promise<string> {
  return (await siteNow(ctx)).now.slice(0, 10);
}
