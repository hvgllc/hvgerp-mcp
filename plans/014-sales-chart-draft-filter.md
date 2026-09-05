# Kế hoạch 014: Áp include_drafts nhất quán cho sales chart

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 014 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 14; loại: `bug`.
- Ưu tiên: P1; công sức: S; rủi ro sửa: thấp; lọc cùng business population.
- Phụ thuộc: `005`, `006`, `013`.
- Mốc soạn: `bce7d25`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Sales chart có ba nhánh customer/item/status dùng ba quy tắc docstatus khác
nhau. Đích: mặc định chỉ submitted, include_drafts:true nhận draft+submitted,
cancelled luôn bị loại; dimension chỉ đổi nhóm tổng hợp, không đổi tập chứng từ.

## Hiện trạng và chứng cứ

`src/tools/analytics.ts:205`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
      if (!input.include_drafts) {
        filters.push(["docstatus", "=", 1]); // Submitted only
```

`src/tools/analytics.ts:213`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
          filters: [["docstatus", "!=", 2]], // exclude cancelled
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
- `docs/tools.md`
- `plans/README.md`
- `plans/evidence/014.md`

Ngoài phạm vi: không đổi cách tính doanh thu, company/currency hoặc paging đã
chốt; không đổi default tool khác. Không sửa dữ liệu production, credential,
`execution-notes.md` ở gốc; không bump version hay tự nâng dependency. Định
danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng Việt có dấu,
không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/tools/analytics.ts src/tools/analytics_test.ts docs/tools.md`
và
`git diff -- src/tools/analytics.ts src/tools/analytics_test.ts docs/tools.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/014-sales-chart-draft-filter`. Không commit, push, mở PR
hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(analytics): apply draft filters across sales chart groups`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/analytics_test.ts`                        | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                              | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                               | exit 0                                             |
| Lint              | `deno lint`                                                                | exit 0                                             |
| Format            | `deno fmt --check`                                                         | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh` | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Dựng ma trận dimension và docstatus

Test cả group_by customer/item/status với include_drafts bỏ trống,false,true;
fixture có docstatus 0/1/2 cùng amounts nhận diện riêng. Mock cần thực thi
filter hoặc assert args đầy đủ. Nếu dùng report sau 006, test tương ứng filter
báo cáo và kết quả, không ép code quay về list chỉ để match snippet cũ.

**Kiểm tra:** `deno test --allow-all src/tools/analytics_test.ts` → ca mặc định
status, true item và true customer thất bại đúng khác biệt population trên
baseline chưa sửa.

### Bước 2: Dùng một chính sách lọc

Tạo filter chung submitted-only hoặc docstatus in [0,1], truyền đúng bảng
cha/child hoặc report đã xác minh. Item branch phải lọc đúng docstatus cha,
không tự giả field mới. Không bỏ toàn bộ filter khi true. Giữ các filter
company/date/paging từ phụ thuộc.

**Kiểm tra:** `deno test --allow-all src/tools/analytics_test.ts` → exit 0; cùng
tập invoice theo docstatus, expected tính riêng cho grand_total
(status/customer) và amount (item), không ép các tổng bằng nhau.

### Bước 3: Ghi hợp đồng và kiểm hồi quy

Docs ghi cancelled luôn bị loại và ý nghĩa include_drafts. Chạy schema validator
và handler direct cases vì library.execute không validate schema thay host.

**Kiểm tra:** `deno check mod.ts server.ts` → exit 0; schema giữ boolean default
behavior, không đổi public shape.

## Kiểm thử

- 3 dimensions × 3 cách truyền option; có cancelled với amount lớn để dễ bắt
  lọt.
- Input invalid boolean qua schema bị từ chối; direct handler xử lý theo hợp
  đồng validation hiện có, không tự truthy hóa chuỗi.
- Multi-company/currency cùng 005, cap+1 cùng 006 không bị mất filter.
- Fixture có thuế/chiết khấu và top N: tổng item có thể khác grand_total; assert
  population đúng và metric riêng. Fixture so tổng bằng nhau chỉ dùng khi không
  thuế/chiết khấu và số nhóm dưới limit.

## Tiêu chí hoàn tất

- [ ] Chín tổ hợp dimension/option có expected total đúng và cancelled luôn
      vắng.
- [ ] Gate server qua, không làm khác aggregate ngoài population draft.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/014.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu report nguồn của item không thể include draft, báo rõ limitation và chọn
  nguồn tương đương đã xác minh; không âm thầm bỏ option.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi dimension mới phải tái dùng policy population chung và có ca cancelled. Đừng
sao chép filter riêng vào từng nhánh.

Đối chiếu sau 005 tại main67a7bc4: ba nhánh vẫn khác population như finding,
nhưng dùng context.listDocuments/listItems và base_grand_total/base_amount. Giữ
ownership/company/currency và chunk budget đã duyệt. Đoạn item hiện lọc
docstatus 1 ở child và discovery parent, nên include_drafts phải được truyền
đúng qua cả hai tầng sau khi 006/013 hoàn tất. Chưa thực thi mục 014.

Đối chiếu main67896f3 sau 006: quotes giữ nguyên byte tại dòng 204/212. Context
nay dùng listAllDocuments/listAllItems với complete-read budget; population
drafts vẫn khác giữa các nhánh. Giữ các guard mới và chờ 013 DONE trước thực
thi, không dùng reconciliation để đánh dấu đã sửa.

Đối chiếu sau 013 tại main `bce7d2513783058a8b160b0cbe6ab55299f90991`: quotes
vẫn nguyên byte, chuyển sang dòng 205/213 do import helper ngày. Các phụ thuộc
005/006/013 đã DONE; chưa triển khai draft policy trong 014.
