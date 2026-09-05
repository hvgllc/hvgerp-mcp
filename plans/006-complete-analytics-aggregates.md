# Kế hoạch 006: Tổng hợp đủ dữ liệu trước khi tạo KPI và top N

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 006 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 6; loại: `bug`.
- Ưu tiên: P1; công sức: L; rủi ro sửa: vừa; lượng truy vấn và ngữ nghĩa tổng.
- Phụ thuộc: `005`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Analytics có giới hạn 500/1000/5000 trên dữ liệu đầu vào nhưng lấy length/reduce
làm tổng toàn bộ. Stock chart còn limit Bin trước khi cộng item ở nhiều kho, nên
top N cũng sai. Đích là đúng toàn bộ phạm vi truy vấn, hoặc lỗi rõ khi không thể
chứng minh đầy đủ; tăng cap đơn thuần không hoàn tất.

## Hiện trạng và chứng cứ

`src/tools/analytics.ts:1060`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
        limit: 1000,
      });

      const total = invoices.reduce(
```

`src/tools/analytics.ts:1067`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
      const count = invoices.length;
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
- `src/tools/analytics-pagination.ts` (tạo mới)
- `src/tools/analytics-pagination_test.ts` (tạo mới)
- `src/tools/query-report.ts`
- `src/tools/query-report_test.ts`
- `docs/tools.md`
- `plans/README.md`
- `plans/evidence/006.md`

Ngoài phạm vi: không đổi paginated list tools, không dùng get_all/SQL bypass
quyền, không mở Prepared Report, không đổi business units đã chốt ở 005. Không
sửa dữ liệu production, credential, `execution-notes.md` ở gốc; không bump
version hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh;
phần giải thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-pagination.ts src/tools/analytics-pagination_test.ts src/tools/query-report.ts src/tools/query-report_test.ts docs/tools.md`
và
`git diff -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-pagination.ts src/tools/analytics-pagination_test.ts src/tools/query-report.ts src/tools/query-report_test.ts docs/tools.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/006-complete-analytics-aggregates`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(analytics): aggregate complete datasets before ranking`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                                      | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-pagination_test.ts src/tools/query-report_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                             | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                              | exit 0                                             |
| Lint              | `deno lint`                                                                                                               | exit 0                                             |
| Format            | `deno fmt --check`                                                                                                        | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                                | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Gắn từng cap với tác động cụ thể

Liệt kê toàn bộ ctx.client.list trong analytics.ts và phân biệt presentation
limit với fetch limit, kể cả Item Price, item_group, Bin, sales/purchase child
rows và funnel. Mỗi phép count/sum/top N phải có test fixture vượt cap: 1001 hóa
đơn, 501 mỗi funnel stage, 5001 đơn sáu tháng; Stock có item ở hai kho làm đổi
thứ hạng. Mock phải thực thi limit/limit_start thật, không trả tất cả bất kể
args.

**Kiểm tra:**
`rg -n 'ctx.client.list|limit:|reduce\(|\.length' src/tools/analytics.ts` → mọi
phép aggregate có hàng coverage và ca vượt cap, không bỏ qua cap phụ trong
lookup.

### Bước 2: Chọn nguồn đầy đủ và giới hạn an toàn

Ưu tiên báo cáo chuẩn đã allowlist với quyền caller,
ignore_prepared_report:true. Nơi cần pagination, thêm helper nhận
doctype/fields/filters, thứ tự ổn định có name tie-breaker, page size hữu hạn,
offset tiến đều, validation rows và dừng khi trang ngắn. Có trần tổng
request/row rõ ràng, chạm trần phải lỗi thông báo không đủ dữ liệu, không xuất
tổng của prefix. Không dùng fields chứa sum(...) vì docs/query-report ghi site
từ chối. ERP không cung cấp snapshot transaction qua nhiều request: ghi rõ thời
điểm đọc và giới hạn khi dữ liệu đổi; không quảng cáo atomic snapshot.

**Kiểm tra:** `deno test --allow-all src/tools/analytics-pagination_test.ts` →
exit 0; trang cuối đúng bội page size, empty, lỗi giữa chừng và chạm trần đều
được kiểm.

### Bước 3: Tổng hợp rồi mới cắt top N

Migrate mọi aggregate trong ma trận. Stock gom đủ Bin được phép theo
item/warehouse/company trước sort/slice; lookup item_group cũng không cắt âm
thầm. Giữ đúng đơn vị 005, đừng sửa lại cơ chế ngày của 013 tại đây. Funnel
count phải đầy đủ từng tập, vẫn giữ ngữ nghĩa ratio giữa tập độc lập, không tự
đổi thành cohort conversion. Số tổng không được zero hóa khi report hoặc page
thất bại.

**Kiểm tra:**
`deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-pagination_test.ts`
→ exit 0; expected totals khớp toàn dataset, thứ hạng stock đúng khi thêm kho.

### Bước 4: Kiểm chi phí và hợp đồng

Ghi số request/rows theo fixture nhỏ, vượt cap và tới trần trong evidence. Kiểm
large input không treo vô hạn, không N+1 theo từng row. Chạy gates, cập nhật
docs về giới hạn an toàn và tính nhất quán nhiều trang.

**Kiểm tra:** `deno test --allow-all src/` → exit 0; không đổi kết quả P&L chuẩn
hoặc list-result pagination.

## Kiểm thử

- Count/sum 0, cap-1, cap, cap+1, hơn hai trang; đúng bội page size vẫn dò hết.
- Page lặp/không tiến hoặc shape lỗi: lỗi rõ, không vòng lặp vô hạn.
- Đủ mọi currency/company theo 005, DocType permission error không thành dữ liệu
  rỗng.
- Mỗi item nhiều kho, item_group nhiều hơn 1000, top N áp sau aggregate.

## Tiêu chí hoàn tất

- [ ] Ma trận toàn analytics không còn phép tổng âm thầm dùng một trang.
- [ ] Mọi đường đầy đủ hoặc lỗi rõ khi giới hạn an toàn; không xuất partial
      total như complete.
- [ ] Toàn bộ gate server và tests vượt cap đạt, request budget có bằng chứng.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/006.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu upstream không hỗ trợ stable pagination hay report tương đương, dừng xác
  định contract; không tăng limit thành số lớn vô hạn.
- Nếu kết quả 005 chưa chốt hoặc unit metadata thiếu, không sửa totals trên đơn
  vị mơ hồ.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi cap mới phải phân loại retrieval/presentation. Giữ datasets vượt cap trong
regression, không tối ưu test bằng mock trả vượt limit.
