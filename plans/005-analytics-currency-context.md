# Kế hoạch 005: Tính analytics trong company và đồng tiền xác định

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 005 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 5; loại: `bug`.
- Ưu tiên: P1; công sức: L; rủi ro sửa: vừa; thay ý nghĩa số tiền đang hiển thị
  sai.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `IN_PROGRESS`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Các chart/KPI cộng grand_total, amount, outstanding_amount mà không mang đơn vị
hoặc company rồi gắn EUR. Mục tiêu là mỗi số tiền có nguồn và đơn vị thống nhất,
không cộng tiền tệ khác nhau; số đếm thuần túy vẫn giữ ngữ nghĩa hiện tại. Phạm
vi cần bao trùm toàn analytics, không chỉ thay chuỗi EUR.

## Hiện trạng và chứng cứ

`src/tools/analytics.ts:1054`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
      const invoices = await ctx.client.list("Sales Invoice", {
        fields: ["outstanding_amount"],
```

`src/tools/analytics.ts:1075`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
        currency: "EUR",
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
- `src/client_test.ts` (chỉ fixture của test direct-execution bounded radar)
- `src/tools/analytics-context.ts` (tạo mới)
- `src/tools/analytics-context_test.ts` (tạo mới)
- `src/tools/query-report.ts`
- `src/tools/query-report_test.ts`
- `docs/tools.md`
- `docs/concepts.md`
- `CHANGELOG.md`
- `plans/README.md`
- `plans/evidence/005.md`

Ngoài phạm vi: không đổi sổ kế toán, không suy tỷ giá hiện tại cho chứng từ lịch
sử, không mở allowlist report tùy ý; không xây multi-ERP adapter. Không sửa dữ
liệu production, credential, `execution-notes.md` ở gốc; không bump version hay
tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải
thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-context.ts src/tools/analytics-context_test.ts src/tools/query-report.ts src/tools/query-report_test.ts src/client_test.ts docs/tools.md docs/concepts.md CHANGELOG.md`
và
`git diff -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-context.ts src/tools/analytics-context_test.ts src/tools/query-report.ts src/tools/query-report_test.ts src/client_test.ts docs/tools.md docs/concepts.md CHANGELOG.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/005-analytics-currency-context`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(analytics): preserve company and currency semantics`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                                   | Kết quả mong đợi                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-context_test.ts src/tools/query-report_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                          | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                           | exit 0                                             |
| Lint              | `deno lint`                                                                                                            | exit 0                                             |
| Format            | `deno fmt --check`                                                                                                     | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                             | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Lập ma trận đơn vị và khóa quy tắc báo cáo

Trong evidence/005.md liệt kê mọi tool analytics có số tiền hoặc tỷ số dùng tiền
(kể cả stock value, radar/scatter price, gross margin, funnel). Cho từng field
ghi đơn vị upstream, company ownership, cách đổi về đồng tiền company và nguồn
xác minh. Chính sách: input company tùy chọn; chỉ tự chọn nếu đúng một Company
nhìn thấy, nhiều company phải yêu cầu chỉ rõ. Tái dùng logic
resolveReportCompany đang có nhưng thông báo không hard-code tên P&L. Với Lead
không có company ownership đáng tin, giữ count theo phạm vi được mô tả rõ, không
tự thêm field company giả.

**Kiểm tra:**
`rg -n 'currency:|grand_total|outstanding_amount|amount|valuation_rate|stock_value|price_list_rate' src/tools/analytics.ts`
→ mọi nơi khớp có hàng trong ma trận; chỗ chưa biết đơn vị được đánh dấu cần xác
minh.

### Bước 2: Thêm test VND và đa tiền tệ

Tạo analytics-context.ts cho resolve company/currency và metadata đơn vị dùng
chung. Test company duy nhất VND, hai company VND/USD không input, company chỉ
định, Company permission error, currency rỗng. Fixture chứng từ foreign currency
có base amount riêng: số tổng phải theo base đã ghi nhận, không theo tỷ giá hôm
nay. Với receivables dùng báo cáo chuẩn Accounts Receivable có filter company và
chế độ company currency đã xác minh; không mặc định outstanding_amount là base
currency. Nếu không có đường đổi đáng tin, trả lỗi rõ cho dữ liệu mixed thay vì
số sai.

**Kiểm tra:**
`deno test --allow-all src/tools/analytics-context_test.ts src/tools/analytics_test.ts`
→ ca VND/mixed mới đỏ trên code cũ và có expected amount/currency cụ thể.

### Bước 3: Migrate toàn bộ số tiền và giữ payload viewer

Lấy base_* đã kiểm schema khi có; với child rows/kho cần theo company cha được
xác minh, không lọc field giả trên child/Bin. Giữ output shape chart/KPI, thay
currency/nhãn trục theo metadata; số đếm không đổi. Gross margin chỉ tính khi
numerator/denominator cùng đơn vị và nguồn giá vốn đã được mô tả là ước tính;
thiếu giá vốn không được giả là 0. Với mọi phép tổng vẫn bị cap, để kế hoạch 006
xử lý sau, ghi giới hạn rõ. P&L hiện đã dùng report đúng phải có regression giữ
nguyên.

**Kiểm tra:**
`deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-context_test.ts src/tools/query-report_test.ts`
→ exit 0; mọi tool tiền tệ có test đơn vị, không còn gắn EUR cố định vào dữ liệu
tùy site.

### Bước 4: Cập nhật hợp đồng và xác minh publish surface

Ghi company/currency/error behavior trong docs và CHANGELOG Unreleased, không
bump version. Kiểm bằng schema validator, refreshRequest mang company, chạy
gates và build Node. Hành vi cần đổi response shape phải dừng trước triển khai,
không thêm field thay thế rồi bỏ field cũ.

**Kiểm tra:** `deno check mod.ts server.ts` → exit 0; schema bổ sung không loại
input hợp lệ cũ trên site một company.

## Kiểm thử

- Mỗi tool có tiền phải có fixture company VND và nguồn currency khác với base.
- Thiếu/đa company, currency thiếu, report permission/error; không zero hóa dữ
  liệu chưa biết.
- P&L, số đếm thuần túy, viewer meta và refresh arguments giữ hợp đồng.
- Ma trận đối chiếu từng tool phải phân biệt completed/blocked, không ghi toàn
  nhóm xong khi còn tool EUR.

## Tiêu chí hoàn tất

- [ ] Tất cả tool trong ma trận có chính sách đơn vị đã xác minh và test riêng.
- [ ] Không cộng mixed currency; không hiện EUR nếu nguồn là VND; company
      ambiguity trả lỗi rõ.
- [ ] Gate server, build Node đạt; docs có migration behavior, không bump
      version.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/005.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Không có nguồn xác minh đơn vị upstream hoặc tỷ giá lịch sử: dừng riêng đường
  đó, không đoán hay tuyên bố 0.
- Nếu cần đổi API shape hoặc hành vi nghiệp vụ gross margin, chốt hợp đồng trước
  khi sửa.
- Nếu phải thêm report ngoài allowlist, xác minh read-only/no Prepared Report
  trước và review thay đổi bảo mật.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Chính sách đơn vị đã chốt ngày 2026-09-05

Mở scope kiểm thử tối thiểu sau full suite đỏ 885/1/4: fixture trong
src/client_test.ts:238 chưa có Company nên auto-select hợp lệ bị từ chối bởi
contract mới. Parent đã đọc test và xác nhận file không drift d2c5305..c1e7485.
Chỉ thêm Company list/get với currency VND vào mock; giữ nguyên assertion
over-limit không gọi query và auto-select vẫn gọi query, không sửa client
source.

Đã đối chiếu ERPNext version-15 tại revision
`1a0bf0bf6c4aeaae5acde90c74b186312f49b95c`. Executor lưu liên kết nguồn chính
thức và test từng đường trong evidence/005.md.

- Accounts Receivable dùng `company`, `in_party_currency: 0`, không đặt
  `party_account` hoặc filter `presentation_currency` không được implementation
  hỗ trợ. Gọi report read-only với `ignore_prepared_report: true`; không chia
  payment terms hoặc group. Chỉ lấy Sales Invoice có outstanding dương, bỏ dòng
  tổng và đếm voucher duy nhất. Kiểm currency của dòng đúng company; thiếu hoặc
  khác currency phải lỗi rõ, không gắn nhãn thay đơn vị.
- Gross margin/profit dùng `base_amount` và `stock_qty` cùng company với kho.
  Giữ cách chọn valuation rate hiện có của từng tool, mô tả rõ là ước tính theo
  giá kho, không phải lợi nhuận kế toán thực tế. Thiếu giá vốn phải lỗi rõ.
- Scatter giữ cách chọn selling price mới nhất hiện có. Với điểm thực sự được
  dùng, Item Price currency phải đúng company currency và UOM phải khớp
  `Item.stock_uom`; trục lượng dùng `Sales Order Item.stock_qty`. Thiếu hoặc
  khác currency/UOM phải lỗi, không lọc bỏ âm thầm, không tự đổi tỷ giá hay UOM
  hiện tại cho chứng từ lịch sử. Fallback Bin chỉ khi không có điểm hợp lệ do
  thiếu giao dịch/giá, không được che lỗi dữ liệu. Nhãn ghi rõ currency và stock
  unit, không thay response shape.
- Các phép tổng còn giới hạn số dòng vẫn thuộc 006, phải ghi giới hạn trung
  thực. Không mở rộng allowlist, dependency hoặc API ngoài phạm vi này.

## Bảo trì

Company/currency là phần khóa cache và refresh request. Một tool tài chính mới
phải bổ sung hàng ma trận cùng test đơn vị, bao gồm số liệu tỷ lệ.
