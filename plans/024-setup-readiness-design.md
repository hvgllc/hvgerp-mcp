# Kế hoạch 024: Khảo sát kiểm tra điều kiện khởi tạo ERPNext

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 024 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: Hướng phát triển 2; loại: `direction`.
- Ưu tiên: P3; công sức: M; rủi ro sửa: LOW.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `DONE`.
- Độ tin cậy: cao về vị trí cơ hội trong roadmap; nhu cầu người dùng và khả năng
  ERP cần khảo sát, chưa coi là đã chứng minh.

Roadmap đề xuất setup_check để nêu prerequisite còn thiếu. Cần tách thiếu master
data khỏi không đủ quyền và lỗi mạng, tránh công cụ read-only đưa ra khuyến nghị
ghi sai hoặc tự chạy setup.

## Hiện trạng và chứng cứ

`docs/ROADMAP.md:70`:

<!-- evidence: docs/ROADMAP.md -->

<!-- deno-fmt-ignore -->
```text
1. Create Company
2. Create Price Lists (Standard Selling, Standard Buying)
3. Create Warehouses (or use the ones auto-created by Company)
4. Create Item Groups if needed
5. Create UOMs if non-standard (Nos, Kg, etc. exist by default)
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

- `docs/design/setup-readiness.md` (tạo mới)
- `plans/README.md`
- `plans/evidence/024.md`

Ngoài phạm vi: Không triển khai tính năng, tạo viewer/tool, thêm dependency hay
khảo sát dữ liệu khách hàng production. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- docs/design/setup-readiness.md` và
`git diff -- docs/design/setup-readiness.md`. Bảo toàn thay đổi có sẵn. Nếu phụ
thuộc đã thực thi, đối chiếu diff và làm mới kế hoạch này theo code mới trước
khi sửa; sai khác chưa giải thích được là điều kiện dừng.

Nhánh đề xuất: `advisor/024-setup-readiness-design`. Không commit, push, mở PR
hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`docs: design read-only setup readiness checks`.

## Lệnh xác minh

| Mục đích      | Lệnh                                              | Kết quả mong đợi |
| ------------- | ------------------------------------------------- | ---------------- |
| Kiểm tài liệu | `deno fmt --check docs/design/setup-readiness.md` | exit 0           |
| Kiểm diff     | `git diff --check`                                | exit 0           |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Xác định nhu cầu và bằng chứng

Tạo7mục Problem, Evidence, Alternatives, Contract, Verification, Decision, Open
questions. Phân biệt kiểm dữ liệu tối thiểu để tạo giao dịch với xác nhận setup
wizard hoàn tất. Đọc src/tools/setup.ts, operations.ts và
docs/erpnext-quirks.md. So sánh ghép tool hiện tại với erpnext_setup_check mới.
Không coi master data có mặt là bằng chứng tất cả giao dịch submit được.

**Kiểm tra:** `rg -n '^## ' docs/design/setup-readiness.md` → đủ7mục và giới hạn
tuyên bố readiness rõ ràng.

### Bước 2: Thiết kế báo cáo không làm thay đổi dữ liệu

Bảng5nhóm Company/Price List/Warehouse/Item Group/UOM, mỗi nhóm ghi tool/query
hiện có, fields thật, scope company, predicate hợp lệ. Status
present/missing/unknown;403/timeout/500 =>unknown, chỉ query thành công đủ phạm
vi mới =>missing. Contract báo overall
incomplete/unknown/ready-for-specified-checks, checkedAt, limitations và hướng
dẫn do người duyệt quyết định; tuyệt đối không tự create/submit hoặc đọc
credential.

**Kiểm tra:** `deno fmt --check docs/design/setup-readiness.md` → exit0; đủ5nhóm
và3status có định nghĩa chính xác.

### Bước 3: Đánh giá bằng tình huống phản chứng

Bảng Verification ít nhất8ca: đầy đủ, thiếu Company, thiếu Price List, Warehouse
sai company, UOM custom thiếu,403,500,timeout. Mỗi ca
input/result/classification/khuyến nghị không mutation. Phản chứng: đủ5nhóm
nhưng setup wizard chưa hoàn tất vẫn có thể submit lỗi, cần ghi giới hạn chứ
không phát hiện giả. Decision chọn ghép/toolmới/defer với quyền và chi phí API;
không prototype bằng dữ liệu thật.

**Kiểm tra:**
`rg -n '^## (Verification|Decision|Open questions)' docs/design/setup-readiness.md`
→ đủ3mục,8ca và phản chứng readiness được giải thích.

## Kiểm thử

- Rubric7mục/5nhóm/8ca, missing và unknown không trộn.
- Query allowlist toàn read-only, không có bước auto-fix.

## Tiêu chí hoàn tất

- [x] Tài liệu thiết kế đạt rubric, có quyết định và unknown rõ ràng.
- [x] Review chỉ đọc không còn nhầm lỗi quyền thành thiếu dữ liệu.
- [x] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [x] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/024.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Cần xác minh setup flag hoặc predicate ERP không có trong repo; ghi câu hỏi mở
  thay vì khẳng định.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Khi thêm prerequisite phải định nghĩa predicate, quyền đọc và trạng thái unknown
trước.
