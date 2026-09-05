# Kế hoạch 013: Dùng ngày site cho cửa sổ analytics

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 013 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 13; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: thấp; sửa cận thời gian.
- Phụ thuộc: `005`, `006`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

KPI orders dựng local Date rồi toISOString khiến UTC+7 báo khoảng tháng 8 là
31/7 đến 30/8. Current-month query không có cận trên còn lấy ngày tương lai. Mục
tiêu là cửa sổ dựa ngày site, phép cộng tháng UTC và cận trên/cận dưới phù hợp
từng loại field.

## Hiện trạng và chứng cứ

`src/tools/analytics.ts:1100`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
      const lastMonthEndStr = lastMonthEnd.toISOString().split("T")[0];
```

`src/tools/site-date.ts:122`:

<!-- evidence: src/tools/site-date.ts -->

<!-- deno-fmt-ignore -->
```text
export async function siteToday(ctx: ErpNextToolContext): Promise<string> {
  return (await siteNow(ctx)).now.slice(0, 10);
}
```

## Quy ước cần giữ

Server dùng TypeScript Deno ESM, import tương đối có `.ts`, `import type` cho
kiểu. API nền tảng chỉ qua runtime adapter; giữ nguyên schema và hình dạng phản
hồi công khai trừ phần bổ sung được nêu rõ. Test colocated, lỗi được truyền rõ
ràng, không nuốt lỗi.

Mẫu test có sẵn tại `src/tools/assignment_test.ts` dùng `Deno.test` và
`@std/assert`, ví dụ:

```typescript
Deno.test("prepareAssignment returns undefined without assign_to", () => {
  assertEquals(prepareAssignment({}, "tool"), undefined);
});
```

Test dùng mock client hoặc fetch giả, không gọi ERPNext thật trong suite chính.

## Phạm vi và Git

Các file được sửa khi thực thi:

- `src/tools/analytics.ts`
- `src/tools/analytics_test.ts`
- `src/tools/analytics-dates.ts` (tạo mới)
- `src/tools/analytics-dates_test.ts` (tạo mới)
- `docs/tools.md`
- `plans/README.md`
- `plans/evidence/013.md`

Ngoài phạm vi: không đổi cơ chế siteTimeZone/fallback đã được HR dùng; không
dùng ngày browser; không sửa logic HR, P&L đã đúng hoặc tỷ giá. Không sửa dữ
liệu production, credential, `execution-notes.md` ở gốc; không bump version hay
tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải
thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-dates.ts src/tools/analytics-dates_test.ts docs/tools.md`
và
`git diff -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-dates.ts src/tools/analytics-dates_test.ts docs/tools.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/013-analytics-site-date-windows`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(analytics): align date windows with the ERP site`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                  | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/analytics-dates_test.ts src/tools/analytics_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                         | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                          | exit 0                                             |
| Lint              | `deno lint`                                                                           | exit 0                                             |
| Format            | `deno fmt --check`                                                                    | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`            | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Định nghĩa cửa sổ theo loại chỉ số

Tạo helper pure nhận today YYYY-MM-DD và số tháng; dùng Date.UTC/getUTC*. MTD
tới today, previous month đủ tháng; overdue due_date < today; trend các tháng
tới today, không cộng future-dated docs. Với Datetime creation dùng khoảng nửa
mở từ 00:00 đầu kỳ tới 00:00 ngày sau today, không <= bare YYYY-MM-DD làm mất cả
ngày. Lập bảng tool/date field/bounds, gồm
revenue/orders/overdue/trend/funnel/aging, giữ P&L contract riêng hiện có.

**Kiểm tra:** `deno test --allow-all src/tools/analytics-dates_test.ts` → test
expected dates cố định, có 2026-08-01..2026-08-31 cho previous month của
2026-09-05.

### Bước 2: Nối siteToday một lần mỗi tool call

Lấy today từ siteToday(ctx), truyền helper, không new Date local trong
arithmetic/bucket. Bucket transaction_date bằng thành phần YYYY-MM để không lệch
múi giờ âm. Giữ lookup timezone theo quyền caller, ghi ngày đã dùng ở metadata
bổ sung nếu cần; không làm như fallback đã authoritative. Dùng contract currency
và complete data từ 005/006.

**Kiểm tra:**
`deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-dates_test.ts`
→ exit 0; query capture đúng field và cả hai cận, future docs không tính.

### Bước 3: Chạy cùng test trên ba múi giờ host

Đặt TZ chỉ cho subprocess test, không đổi hệ thống. Fixture ngày site cố định
độc lập đồng hồ. Kiểm năm mới, leap day, tháng 28/29/30/31 ngày và site timezone
khác host.

**Kiểm tra:**
`TZ=UTC deno test --allow-all src/tools/analytics-dates_test.ts && TZ=Asia/Ho_Chi_Minh deno test --allow-all src/tools/analytics-dates_test.ts && TZ=America/Los_Angeles deno test --allow-all src/tools/analytics-dates_test.ts`
→ cả ba exit 0 với cùng kết quả expected; không phụ thuộc ngày chạy thật.

## Kiểm thử

- Ngày đầu/cuối tháng, đầu năm, 2024-02-29, tháng không có ngày 31.
- Site today 2026-09-05 nhưng host UTC ngày khác; today không tự thay bằng
  Date.now.
- Datetime ngày cuối chứa 23:59:59 vẫn nằm trong kỳ; ngày sau bị loại.
- MTD/trend loại future, overdue dùng strict <, P&L regression không đổi.

## Tiêu chí hoàn tất

- [ ] Mỗi tool thời gian trong bảng dùng ngày site và bounds đã định nghĩa.
- [ ] Test ba TZ và toàn bộ gates server đạt.
- [ ] Không còn new Date(y,m,d).toISOString cho các cửa sổ đã sửa.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/013.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu ngày site không xác định, giữ và mô tả fallback hiện có; không đổi quyền
  đọc timezone của người dùng.
- Nếu một field là Datetime thay vì Date chưa xác minh, kiểm schema trước khi
  chọn bounds.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Ngày nghiệp vụ là dữ liệu site, không phải timezone runtime. Test ngày cố định
và nhiều TZ ngăn regression khi deploy từ laptop sang container.
