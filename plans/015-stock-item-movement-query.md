# Kế hoạch 015: Hiện đúng chuyển động theo mặt hàng và kho

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 015 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 15; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; đổi nguồn đọc lịch sử.
- Phụ thuộc: `007`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

StockDetailPanel gửi item_code cho stock_entry_list nhưng tool không hỗ trợ nên
lịch sử là chứng từ toàn site. Chọn nguồn Stock Ledger Entry qua generic
doc_list đã có để lọc item và warehouse thực sự, không thêm một field giả vào
Stock Entry cha. Đây là sửa phần lịch sử hiện có, chưa xây timeline mới.

## Hiện trạng và chứng cứ

`src/ui/stock-viewer/src/components/StockDetailPanel.tsx:35`:

<!-- evidence: src/ui/stock-viewer/src/components/StockDetailPanel.tsx -->

<!-- deno-fmt-ignore -->
```text
          app.callServerTool({
            name: "erpnext_stock_entry_list",
            arguments: { limit: 5, item_code: itemCode },
```

`src/tools/operations.ts:582`:

<!-- evidence: src/tools/operations.ts -->

<!-- deno-fmt-ignore -->
```text
        filters: {
          type: "array",
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

- `src/ui/stock-viewer/src/components/StockDetailPanel.tsx`
- `src/ui/shared/stock-movements.ts` (tạo mới)
- `src/ui/shared/stock-movements_test.ts` (tạo mới)
- `src/ui/testing/fixtures.ts`
- `src/tools/operations_test.ts`
- `docs/tools.md`
- `plans/evidence/015/` (tạo mới)
- `plans/README.md`
- `plans/evidence/015.md`

Ngoài phạm vi: không thêm hoặc đổi schema stock_entry_list; không chỉnh
inventory mutation hay gọi report tùy ý; không xây timeline của 023. Không sửa
dữ liệu production, credential, `execution-notes.md` ở gốc; không bump version
hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải
thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/stock-viewer/src/components/StockDetailPanel.tsx src/ui/shared/stock-movements.ts src/ui/shared/stock-movements_test.ts src/ui/testing/fixtures.ts src/tools/operations_test.ts docs/tools.md`
và
`git diff -- src/ui/stock-viewer/src/components/StockDetailPanel.tsx src/ui/shared/stock-movements.ts src/ui/shared/stock-movements_test.ts src/ui/testing/fixtures.ts src/tools/operations_test.ts docs/tools.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/015-stock-item-movement-query`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(stock): scope recent movements to the selected item and warehouse`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                       | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/shared/stock-movements_test.ts src/tools/operations_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                              | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                               | exit 0                                             |
| Lint              | `deno lint`                                                                                | exit 0                                             |
| Format            | `deno fmt --check`                                                                         | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                                        | exit 0 sau khi hoàn tất kế hoạch 007               |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                 | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Xác minh nguồn và đóng đinh request

Đọc schema Stock Ledger Entry bằng discovery hoặc source Frappe phiên bản hỗ
trợ, chỉ đọc. Chốt field thực:
name,item_code,warehouse,posting_date,posting_time,voucher_type,voucher_no,actual_qty,qty_after_transaction
và is_cancelled nếu có. Dùng erpnext_doc_list fields/filters/order_by có sẵn.
Pure request builder nhận itemCode/warehouse, lọc cả hai, limit 5, sort
posting_date desc, posting_time desc, name desc. Không thêm filter is_cancelled
khi chưa xác minh tồn tại.

**Kiểm tra:** `deno test --allow-all src/ui/shared/stock-movements_test.ts` →
test mới chứng minh request cũ không đủ filter, expected request đủ item và kho
theo schema đã xác minh.

### Bước 2: Hiển thị ledger và xử lý lỗi rõ

Panel gọi request builder, parse rows typed, hiện voucher type/no, date/time và
actual_qty/UOM thích hợp thay stock_entry_type. Reset loading/data/error khi
itemCode hoặc warehouse đổi; dependencies useEffect phải có cả hai. Nếu
permission denied hoặc tool category operations không được host expose, hiện
lỗi/không khả dụng có lý do, không fallback về chứng từ toàn site. Giữ
cancellation guard để response item cũ không đi vào item mới.

**Kiểm tra:**
`npm --prefix src/ui run typecheck && deno test --allow-all src/ui/shared/stock-movements_test.ts src/tools/operations_test.ts`
→ exit 0; không còn gọi stock_entry_list kèm item_code ở panel.

### Bước 3: Kiểm hai item và hai kho trên viewer thật

Dùng host 007: deno task ui:build rồi npm --prefix src/ui run dev:test-host, mở
/testing/host.html?viewer=stock-viewer&scenario=smoke tại localhost:5178. Thêm
fixture ledger ITEM-A/W1, ITEM-A/W2, ITEM-B/W1; host thực thi filters và trace
request. Click từng dòng: panel chỉ hiện đúng cặp item/kho. Thử permission/error
và response cũ trả muộn; lưu trace/screenshot không có data production.

**Kiểm tra:**
`deno test --allow-all src/ui/shared/stock-movements_test.ts src/tools/operations_test.ts`
→ exit 0; browser trace và rows hiển thị khớp đúng cặp item/kho.

## Kiểm thử

- Request chứa item_code và warehouse; query shape qua schema của doc_list.
- Hai item hai kho, cùng item đổi kho, ledger empty, permission denied,
  malformed row.
- Operations category bị tắt được báo rõ; không fallback query thiếu phạm vi.

## Tiêu chí hoàn tất

- [ ] Recent Movements được xác minh chỉ chứa đúng item/kho và dữ liệu posted
      ledger phù hợp.
- [ ] Nguồn/field upstream có bằng chứng; tests và browser flow thật qua.
- [ ] Typecheck UI/server và suite đạt, không thay inventory tool công khai.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/015.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Stock Ledger Entry không đọc được với quyền mục tiêu: báo hạn chế, không
  bypass permission hoặc đổi sang get_all.
- Schema upstream khác dự kiến: sửa request bằng bằng chứng trước, không để fake
  fixture định nghĩa schema ERP.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Nếu sau này timeline 023 được chọn triển khai, tái dùng request contract/rows đã
xác minh. Item và warehouse là identity của panel, không chỉ item.
