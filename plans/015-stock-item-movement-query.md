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
lịch sử là chứng từ toàn site. Thêm tool đọc hẹp `erpnext_stock_ledger_list`
trong category `inventory`, lọc Stock Ledger Entry theo đúng item và warehouse.
Tool phải tồn tại khi client dùng `categories: ["inventory"]`; không dùng
erpnext_doc_list thuộc operations làm đường đọc của panel. Đây là bổ sung không
phá API cũ để sửa Recent Movements, chưa xây timeline mới. Không sửa
schema/nghĩa stock_entry_list hoặc tự expose operations.

## Hiện trạng và chứng cứ

`src/ui/stock-viewer/src/components/StockDetailPanel.tsx:35`:

<!-- evidence: src/ui/stock-viewer/src/components/StockDetailPanel.tsx -->

<!-- deno-fmt-ignore -->
```text
          app.callServerTool({
            name: "erpnext_stock_entry_list",
            arguments: { limit: 5, item_code: itemCode },
```

`src/tools/inventory.ts:341`:

<!-- evidence: src/tools/inventory.ts -->

<!-- deno-fmt-ignore -->
```text
    name: "erpnext_stock_entry_list",
    annotations: { readOnlyHint: true },
    _meta: DOCLIST_META,
    description: "List Stock Entries (material transfers, receipts, issues). " +
      "Fields: name, stock_entry_type, posting_date, from_warehouse, to_warehouse, total_amount. " +
      "Filterable by stock_entry_type, date range.",
    category: "inventory",
```

`src/client.ts:137`:

<!-- evidence: src/client.ts -->

<!-- deno-fmt-ignore -->
```text
      const selected = options.categories.flatMap((cat) =>
        getToolsByCategory(cat)
      );
```

Hai record này được đối chiếu lại ở sourceRef e09537b. Category filter giữ
stock_balance nhưng không có doc_list; coi thiếu operations là lỗi mong đợi sẽ
làm mất chức năng ở cấu hình inventory-only hợp lệ.

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
- `src/ui/testing/host.ts`
- `src/tools/inventory.ts`
- `src/tools/inventory_test.ts`
- `src/client_test.ts`
- `docs/tools.md`
- `README.md`
- `docs/coverage.md`
- `docs/architecture.md`
- `CHANGELOG.md`
- `plans/evidence/015/` (tạo mới)
- `plans/README.md`
- `plans/evidence/015.md`

Ngoài phạm vi: không thêm field hoặc đổi schema/nghĩa stock_entry_list; không
chỉnh inventory mutation, category filter của client hay gọi report tùy ý; không
tự expose operations hoặc fallback query toàn site; không xây timeline của 023.
Chỉ thêm tool ledger đọc hẹp thuộc inventory. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/stock-viewer/src/components/StockDetailPanel.tsx src/ui/shared/stock-movements.ts src/ui/shared/stock-movements_test.ts src/ui/testing/fixtures.ts src/ui/testing/host.ts src/tools/inventory.ts src/tools/inventory_test.ts src/client_test.ts docs/tools.md README.md docs/coverage.md docs/architecture.md CHANGELOG.md`
và
`git diff -- src/ui/stock-viewer/src/components/StockDetailPanel.tsx src/ui/shared/stock-movements.ts src/ui/shared/stock-movements_test.ts src/ui/testing/fixtures.ts src/ui/testing/host.ts src/tools/inventory.ts src/tools/inventory_test.ts src/client_test.ts docs/tools.md README.md docs/coverage.md docs/architecture.md CHANGELOG.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/015-stock-item-movement-query`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(stock): scope recent movements to the selected item and warehouse`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                         | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/shared/stock-movements_test.ts src/tools/inventory_test.ts src/client_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                 | exit 0                                             |
| Lint              | `deno lint`                                                                                                  | exit 0                                             |
| Format            | `deno fmt --check`                                                                                           | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                                                          | exit 0 sau khi hoàn tất kế hoạch 007               |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                   | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

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

Đã đọc
[schema Stock Ledger Entry upstream](https://github.com/frappe/erpnext/blob/1a0bf0bf6c4aeaae5acde90c74b186312f49b95c/erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.json)
từ branch version-15 ở commit cố định ngày 2026-09-05. Schema có item_code,
warehouse, posting_date (Date), posting_time (Time), voucher_type, voucher_no,
actual_qty, qty_after_transaction, stock_uom và is_cancelled (Check). `name` là
ID document chuẩn. Đây là kiểm source upstream, chưa phải schema/permission site
người dùng; executor phải đối chiếu phiên bản được hỗ trợ bằng source hoặc
discovery chỉ đọc trước khi triển khai.

Thêm tool `erpnext_stock_ledger_list` vào inventoryTools hiện được registry gom
tự động. Schema `required: ["item_code", "warehouse"]`, hai chuỗi không rỗng;
limit integer 1..20, mặc định 5. Handler xác minh lại type/required/limit trước
mọi query; thiếu hoặc sai đầu vào không được đọc ledger. Annotation
`readOnlyHint: true`. Item nhận ID hoặc name qua resolveItem theo quy ước hiện
có; warehouse là ID từ row đã chọn. Không tự đổi kho hoặc bỏ filter khi resolve
lỗi. Chỉ đọc bằng client.list thông thường, giữ permission ERP.

Server cố định DocType Stock Ledger Entry, danh sách fields
name,item_code,warehouse,posting_date,posting_time,voucher_type,voucher_no,actual_qty,qty_after_transaction,stock_uom.
Filters bắt buộc item_code đã resolve, warehouse và is_cancelled = 0 sau khi xác
minh field trên phiên bản mục tiêu. Chốt order_by
`posting_date desc, posting_time desc, name desc`: hai field thời gian đã có
trong schema, name làm tie-break ổn định; không dùng sort mặc định modified.
Không cho caller truyền doctype/fields/filters/order_by tùy ý. Response mới
`{ data: rows }`, không đổi envelope tool cũ. Pure request builder gửi tên tool
này và arguments item_code, warehouse, limit 5; không phụ thuộc operations.

**Kiểm tra:** `deno test --allow-all src/ui/shared/stock-movements_test.ts` →
test mới đỏ vì request cũ không đủ item/kho và gọi sai tool; inventory/client
tests đỏ vì tool hẹp chưa đăng ký, không chấp nhận lỗi import hoặc cache thay
cho lỗi contract.

### Bước 2: Hiển thị ledger và xử lý lỗi rõ

Panel gọi request builder, parse rows typed, hiện voucher type/no, date/time và
actual_qty/UOM thích hợp thay stock_entry_type. Reset loading/data/error khi
itemCode hoặc warehouse đổi; dependencies useEffect phải có cả hai. Nếu
permission denied, hiện lỗi có lý do và không fallback về chứng từ toàn site.
Inventory-only phải hoạt động, không coi operations bị tắt là lỗi bình thường
của Recent Movements. Giữ cancellation guard để response item cũ không đi vào
item mới. Cập nhật `docs/tools.md`, `README.md`, `docs/coverage.md`,
`docs/architecture.md` và CHANGELOG về tool đọc mới. Đếm registry thực lúc
execute: tổng tool và inventory tăng một so với baseline của lượt sửa; cập nhật
cả heading, số tổng/category, bảng catalog và liệt kê inventory, không chỉ thêm
tên trong docs/tools.md. Không hardcode số 134/9 nếu các kế hoạch trước đã thêm
tool; không bump version.

**Kiểm tra:**
`npm --prefix src/ui run typecheck && deno test --allow-all src/ui/shared/stock-movements_test.ts src/tools/inventory_test.ts src/client_test.ts`
→ exit 0; không còn gọi stock_entry_list kèm item_code ở panel.

### Bước 3: Kiểm hai item và hai kho trên viewer thật

Dùng host 007: deno task ui:build rồi npm --prefix src/ui run dev:test-host, mở
/testing/host.html?viewer=stock-viewer&scenario=smoke tại localhost:5178. Thêm
fixture ledger ITEM-A/W1, ITEM-A/W2, ITEM-B/W1; chỉnh host.ts dispatch tool hẹp
với payload typed, lọc item/kho, limit và sort như contract, ghi trace request.
Host từ chối doc_list trong kịch bản inventory-only, không giả cho phép
operations. Client test dùng ErpNextToolsClient thật với
`categories: ["inventory"]`: listTools và buildHandlersMap chứa tool ledger,
không có erpnext_doc_list, gọi ledger handler với mock FrappeClient cho đúng
rows. Click từng dòng trên browser: panel chỉ hiện đúng cặp item/kho. Thử
permission/error và response cũ trả muộn; lưu trace/screenshot không có data
production. Fixture không thay bằng chứng schema hoặc quyền site.

**Kiểm tra:**
`deno test --allow-all src/ui/shared/stock-movements_test.ts src/tools/inventory_test.ts src/client_test.ts`
→ exit 0; browser trace và rows hiển thị khớp đúng cặp item/kho.

## Kiểm thử

- Request gọi tool ledger thuộc inventory, chứa item_code và warehouse; handler
  dùng đúng fields, ba filter, order_by và limit đã chốt.
- Missing/empty/sai type item hoặc warehouse và limit sai: không query ledger;
  resolve lỗi hoặc permission denied truyền rõ. Không sửa tool mutation/cũ.
- Hai item hai kho, cùng item đổi kho, ledger empty, permission denied,
  malformed row.
- Inventory-only vẫn đọc Recent Movements với operations vắng mặt; không tự
  expose category khác hoặc fallback query thiếu phạm vi.
- Hai row cùng posting_date/time có thứ tự name ổn định; bản ghi cancelled không
  hiển thị; source kiểm schema upstream lưu commit và giới hạn.

## Tiêu chí hoàn tất

- [ ] Recent Movements được xác minh chỉ chứa đúng item/kho và dữ liệu posted
      ledger phù hợp.
- [ ] Nguồn/field upstream có bằng chứng; tests và browser flow thật qua.
- [ ] Tool ledger read-only tồn tại và gọi được ở inventory-only; không có
      doc_list trong client đó, không thay schema/nghĩa tool cũ.
- [ ] Typecheck UI/server và suite đạt; docs mô tả tool/giới hạn mới đúng, không
      nâng version.
- [ ] Catalog `README.md`, `docs/coverage.md`, `docs/architecture.md` và
      `docs/tools.md` liệt kê tool ledger; số tổng/category khớp registry thực
      được lưu bằng chứng, không còn danh mục inventory tuyên bố đầy đủ nhưng
      thiếu tool.
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
