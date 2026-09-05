# Kế hoạch 025: Khảo sát hồ sơ khách hàng tổng hợp

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 025 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: Hướng phát triển 3; loại: `direction`.
- Ưu tiên: P3; công sức: M; rủi ro sửa: LOW.
- Phụ thuộc: `005`, `006`.
- Mốc soạn: `67896f3`, 2026-09-05. Trạng thái thực thi: `IN_PROGRESS`.
- Độ tin cậy: cao về vị trí cơ hội trong roadmap; nhu cầu người dùng và khả năng
  ERP cần khảo sát, chưa coi là đã chứng minh.

Roadmap đề xuất Customer360 bằng composition. Nên kiểm khả năng ghép
orders/invoices/payments/contacts hiện có và ý nghĩa tiền tệ trước khi thêm
viewer thứ8 hoặc tool tổng hợp rộng quyền.

## Hiện trạng và chứng cứ

`src/tools/operations.ts:561`:

<!-- evidence: src/tools/operations.ts -->

<!-- deno-fmt-ignore -->
```text
    name: "erpnext_doc_list",
    annotations: { readOnlyHint: true },
```

## Quy ước cần giữ

Chỉ khảo sát và thiết kế. Ưu tiên ghép tool/viewer hiện có, giữ MCP read-only
annotations và phạm vi quyền của caller. Không tạo source, schema mới, mock UI
hoặc gọi ERP thật trong đợt thiết kế.

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

- `docs/design/customer-360.md` (tạo mới)
- `plans/README.md`
- `plans/evidence/025.md`

Ngoài phạm vi: Không triển khai tính năng, tạo viewer/tool, thêm dependency hay
khảo sát dữ liệu khách hàng production. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- docs/design/customer-360.md` và
`git diff -- docs/design/customer-360.md`. Bảo toàn thay đổi có sẵn. Nếu phụ
thuộc đã thực thi, đối chiếu diff và làm mới kế hoạch này theo code mới trước
khi sửa; sai khác chưa giải thích được là điều kiện dừng.

Nhánh đề xuất: `advisor/025-customer-360-design`. Không commit, push, mở PR hoặc
merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`docs: design customer 360 composition`.

## Lệnh xác minh

| Mục đích      | Lệnh                                           | Kết quả mong đợi |
| ------------- | ---------------------------------------------- | ---------------- |
| Kiểm tài liệu | `deno fmt --check docs/design/customer-360.md` | exit 0           |
| Kiểm diff     | `git diff --check`                             | exit 0           |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Lập bản đồ hành trình và phương án

Tạo7mục Problem, Evidence, Alternatives, Contract, Verification, Decision, Open
questions. Bắt đầu từ ID hoặc tên khách hàng, dùng resolveCustomer; tên mơ hồ
phải yêu cầu chọn, không tự gộp. Đọc sales.ts/accounting.ts/crm.ts/resolve.ts và
viewer contracts. So sánh A: composition tool/viewer qua sendMessage; B:
tool/viewer tổng hợp mới. Mỗi section chỉ rõ tool, fields, filters và quyền thực
tế.

**Kiểm tra:** `rg -n '^## ' docs/design/customer-360.md` → đủ7mục,2phương án
và4section orders/invoices/payments/contacts.

### Bước 2: Thiết kế contract với dữ liệu không hoàn hảo

Mô tả company/currency từ005, độ đầy đủ từ006, phân trang từng section và trạng
thái loading/error/empty. Payment party_type=Customer và dynamic link; contact
mapping xác minh qua code thay vì giả định customer field. Khi section lỗi, giữ
section khác nhưng không dùng số tổng thiếu dữ liệu như complete. Không cộng
grand_total giữa currencies, không cho read-only panel phát lệnh ghi.

**Kiểm tra:** `deno fmt --check docs/design/customer-360.md` → exit0; mỗi
section có loading/error/empty/success và nguồn filter.

### Bước 3: Phản biện trải nghiệm và quyết định phạm vi

Bảng Verification ít nhất8ca: ID chuẩn, tên mơ hồ, không có giao dịch, đa
company, đa currency, hơn một trang, contact403, paymenttimeout. Mỗi ca nêu đầu
vào và kết quả người dùng nhìn thấy, thông điệp điều hướng giữ đúng
customer/context. Chỉ kết luận phương án khi có query-map và giới hạn cụ thể;
nếu contact linkage chưa xác minh ghi defer phần đó, không bịa schema. Kết thúc
ở thiết kế, không trình mock là feature đã hoạt động.

**Kiểm tra:**
`rg -n '^## (Verification|Decision|Open questions)' docs/design/customer-360.md`
→ đủ3mục,8ca và reviewer kiểm các suy luận tiền tệ/quyền.

## Kiểm thử

- Rubric7mục/2phương án/4section/8ca.
- Đường customer ID -> filters -> section -> navigation có trace trên giấy,
  không runtime claim.

## Tiêu chí hoàn tất

- [ ] Thiết kế đủ rubric, có quyết định và các câu hỏi cần chấp thuận trước
      triển khai.
- [ ] Review chỉ đọc không còn giả định liên kết hoặc tổng tiền không có chứng
      cứ.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/025.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Đề xuất cần mở rộng quyền đọc dữ liệu nhạy cảm hoặc thay hợp đồng tool ngoài
  phạm vi.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mỗi section mới cần pagination, permission và currency policy riêng, không mặc
định đầy đủ.

Đối chiếu sau khi 005/006 DONE tại main
`67896f3208caee923659f1900c399d87e99c403c`: quote operations dòng 561 giữ
nguyên. 005/006 chỉ cung cấp contract tiền tệ và complete-read trong analytics,
không tự làm các list orders/invoices/payments thành truy vấn đầy đủ. Các
dedicated list hiện chưa có company/offset; Sales Invoice list chưa trả
currency. Contact list chỉ có company_name/status, chưa chứng minh liên kết
Customer. Thiết kế phải ghi các khoảng trống này và giới hạn composition, không
coi chúng là API sẵn có hoặc tự thêm API trong đợt khảo sát. Bắt đầu thực thi
tài liệu, giữ đủ rubric và phạm vi thiết kế đã duyệt.
