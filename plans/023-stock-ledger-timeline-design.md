# Kế hoạch 023: Khảo sát thiết kế dòng thời gian biến động tồn kho

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 023 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: Hướng phát triển 1; loại: `direction`.
- Ưu tiên: P3; công sức: M; rủi ro sửa: LOW.
- Phụ thuộc: `015`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về vị trí cơ hội trong roadmap; nhu cầu người dùng và khả năng
  ERP cần khảo sát, chưa coi là đã chứng minh.

Roadmap muốn kết hợp chart-viewer và doclist-viewer để xem lịch sử kho. Trước
khi tạo tool mới cần chứng minh dữ liệu sổ kho hiện có đủ chính xác, phân trang
và phân quyền, đồng thời không lặp lại truy vấn Stock Entry sai ở015.

## Hiện trạng và chứng cứ

`docs/ROADMAP.md:38`:

<!-- evidence: docs/ROADMAP.md -->

```text
| Stock Ledger Timeline      | chart-viewer (line) + doclist-viewer | Stock movements over time with drill-down.                                                                                                                                                                                                        |
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

- `docs/design/stock-ledger-timeline.md` (tạo mới)
- `plans/README.md`
- `plans/evidence/023.md`

Ngoài phạm vi: Không triển khai tính năng, tạo viewer/tool, thêm dependency hay
khảo sát dữ liệu khách hàng production. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- docs/design/stock-ledger-timeline.md` và
`git diff -- docs/design/stock-ledger-timeline.md`. Bảo toàn thay đổi có sẵn.
Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới kế hoạch này theo code mới
trước khi sửa; sai khác chưa giải thích được là điều kiện dừng.

Nhánh đề xuất: `advisor/023-stock-ledger-timeline-design`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`docs: design stock ledger timeline`.

## Lệnh xác minh

| Mục đích      | Lệnh                                                    | Kết quả mong đợi |
| ------------- | ------------------------------------------------------- | ---------------- |
| Kiểm tài liệu | `deno fmt --check docs/design/stock-ledger-timeline.md` | exit 0           |
| Kiểm diff     | `git diff --check`                                      | exit 0           |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Lập bản đồ dữ liệu và giả thuyết cạnh tranh

Tạo tài liệu có các mục Problem, Evidence, Alternatives, Contract, Verification,
Decision, Open questions. So sánh A: ghép erpnext_doc_list Stock Ledger Entry
với chart/doclist hiện có; B: thêm tool tổng hợp read-only. Đọc operations.ts,
inventory.ts, viewer contracts và kết quả015; trích field/query thật. Ghi
unverified cho field ERP chưa có chứng cứ; không mặc định Stock Ledger Entry
hiển thị được với mọi role.

**Kiểm tra:** `rg -n '^## ' docs/design/stock-ledger-timeline.md` → có đủ 7 mục
bắt buộc, bảng phân biệt observed và unverified.

### Bước 2: Thiết kế luồng hoàn chỉnh trên giấy

Mô tả chọn item/warehouse/company/date, truy vấn posting_date+posting_time+name
ổn định, actual_qty và qty_after_transaction với stock_uom, phân trang, opening
balance và entry hủy. Mỗi điểm trên chart drill-down đúng ledger rows, hiển thị
giới hạn dữ liệu. Không suy diễn balance bằng cộng một trang thiếu opening. Có
contract mẫu và error403/timeout/empty, không viết implementation.

**Kiểm tra:** `deno fmt --check docs/design/stock-ledger-timeline.md` → exit 0;
checklist contract đủ 10 vấn đề đã liệt kê.

### Bước 3: Thử bác bỏ phương án ưu tiên

Bảng Verification ít nhất8 ca: một movement, hai warehouse, opening balance,
ngày trùng giờ, vượt một trang, entry hủy, thiếu quyền, timeout. Mỗi ca có
input/query dự kiến/output hoặc error; ghi đây là design walkthrough, không
runtime test. Decision chọn A/B/defer dựa trên gap thật, gồm chi phí và điều
kiện chuyển sang triển khai. Hạn mức khảo sát: khi đủ bảng8ca và một vòng phản
biện, chốt hoặc ghi câu hỏi chặn, không mở rộng sang replenishment.

**Kiểm tra:**
`rg -n '^## (Verification|Decision|Open questions)' docs/design/stock-ledger-timeline.md`
→ đủ3 mục; reviewer xác nhận8ca có expected và kết luận có chứng cứ.

## Kiểm thử

- Rubric: đủ7mục,2phương án,8ca, mỗi assumption gắn nhãn và cách xác minh.
- Không có lời khẳng định feature đã chạy; source diff bằng0.

## Tiêu chí hoàn tất

- [ ] Tài liệu thiết kế đủ rubric và có quyết định implement/defer rõ ràng.
- [ ] Một reviewer chỉ đọc kiểm giả thuyết, query và8ca; lỗi ảnh hưởng quyết
      định đã sửa.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/023.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Field/permission chưa xác minh là điều kiện cần để chọn phương án; ghi defer
  thay vì tự dựng API.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Chỉ cập nhật roadmap thành shipped sau một yêu cầu triển khai riêng với test
thực tế.
