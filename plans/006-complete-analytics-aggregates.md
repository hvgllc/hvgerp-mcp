# Kế hoạch 006: Tổng hợp đủ dữ liệu trước khi tạo KPI và top N

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 006 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 6; loại: `bug`.
- Ưu tiên: P1; công sức: L; rủi ro sửa: vừa; lượng truy vấn và ngữ nghĩa tổng.
- Phụ thuộc: `005`.
- Mốc soạn: `67a7bc4`, 2026-09-05. Trạng thái thực thi: `DONE`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Analytics có giới hạn 500/1000/5000 trên dữ liệu đầu vào nhưng lấy length/reduce
làm tổng toàn bộ. Stock chart còn limit Bin trước khi cộng item ở nhiều kho, nên
top N cũng sai. Đích là đúng toàn bộ phạm vi truy vấn, hoặc lỗi rõ khi không thể
chứng minh đầy đủ; tăng cap đơn thuần không hoàn tất.

## Hiện trạng và chứng cứ

`src/tools/analytics.ts:1120`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
        limit: 1000,
      });
      const currentCount = currentOrders.length;
```

`src/tools/analytics.ts:1133`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
      const prevCount = prevOrders.length;
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
- `src/tools/analytics-context.ts`
- `src/tools/analytics-context_test.ts`
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
`git diff --stat d2c5305..HEAD -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-context.ts src/tools/analytics-context_test.ts src/tools/analytics-pagination.ts src/tools/analytics-pagination_test.ts src/tools/query-report.ts src/tools/query-report_test.ts docs/tools.md`
và
`git diff -- src/tools/analytics.ts src/tools/analytics_test.ts src/tools/analytics-context.ts src/tools/analytics-context_test.ts src/tools/analytics-pagination.ts src/tools/analytics-pagination_test.ts src/tools/query-report.ts src/tools/query-report_test.ts docs/tools.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/006-complete-analytics-aggregates`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(analytics): aggregate complete datasets before ranking`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                                                                          | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-context_test.ts src/tools/analytics-pagination_test.ts src/tools/query-report_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                                                                 | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                                                                  | exit 0                                             |
| Lint              | `deno lint`                                                                                                                                                   | exit 0                                             |
| Format            | `deno fmt --check`                                                                                                                                            | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                                                                    | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

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
rows và funnel, cùng các đường listItems/listBins trong analytics-context.ts.
Mỗi phép count/sum/top N phải có test fixture vượt cap: 1001 đơn cho KPI count,
1001 dòng Accounts Receivable để giữ đường report của 005, 501 mỗi funnel stage,
5001 đơn sáu tháng; Stock có item ở hai kho làm đổi thứ hạng. Mock phải thực thi
limit/limit_start thật, không trả tất cả bất kể args.

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
`deno test --allow-all src/tools/analytics_test.ts src/tools/analytics-context_test.ts src/tools/analytics-pagination_test.ts`
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

- [x] Ma trận toàn analytics không còn phép tổng âm thầm dùng một trang.
- [x] Mọi đường đầy đủ hoặc lỗi rõ khi giới hạn an toàn; không xuất partial
      total như complete.
- [x] Toàn bộ gate server và tests vượt cap đạt, request budget có bằng chứng.
- [x] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [x] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/006.md`, cập
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

Parent đã đối chiếu source main `67a7bc4d777cccced5255b0a43ae648752241f21` sau
khi 005 DONE qua PR29. Outstanding/overdue/aging nay đọc Accounts Receivable qua
receivableInvoiceRows, dùng siteToday và company currency: không quay lại Sales
Invoice outstanding_amount hoặc lặp sửa cap đã biến mất ở đường đó. Evidence
hiện trạng chuyển sang KPI orders còn cap 1000 thật. Cache 012/018/019 và shim
011 đã merge, không thuộc phạm vi sửa của 006.

005 thêm analytics-context.ts: listOwnershipNames đã phân trang tên parent và
Warehouse tới hết, có guard 100000, kiểm tiến triển và memo Warehouse. Tuy nhiên
listScoped vẫn lấy N mỗi chunk rồi cắt N toàn cục, từ chối offset khác 0. Vì vậy
không bọc listItems/listBins hiện tại bằng vòng offset rồi coi là pagination.
Phạm vi bổ sung đúng analytics-context.ts và test để cung cấp đường đọc đầy đủ
cho aggregate; giữ company/parenttype/warehouse ownership, budget toàn encoded
request target 6000, kiểm Item UOM đủ/duy nhất và fail-closed. Không được bỏ
chứng cứ URL thật, Unicode, chunk cuối hoặc các control quyền của 005 để làm
test qua. Nếu thay đổi contract helper nội bộ từ top N sang full dataset, cập
nhật test đúng ý nghĩa mới và giữ control cho lọc company/ownership/URL.

Đọc kỹ public tool schema trước khi phân loại scope: stock_chart và kpi_orders
không nhận company trong 005, nên giữ phạm vi các dữ liệu caller được phép đọc;
không tự thêm company filter hoặc đổi API vì câu chữ tổng quát ở bước 3. Với
tool có AnalyticsContext, bắt buộc giữ company đã chốt. P&L/report allowlist và
ngày/draft window đã định nghĩa giữ nguyên; các sửa ngày/draft thuộc 013/014.
Cap ambiguity Company 21 và radar lựa chọn mặc định 4 item là giới hạn chọn phạm
vi/hiển thị, không mặc nhiên biến chúng thành phép tổng toàn site.

Baseline tích hợp trước dispatch: full suite 1202 passed, 0 failed, 4 ignored;
server/UI typecheck, lint, format, UI/Node build đều đạt trong worktree riêng.
Local dùng workaround frozen đã cho phép trong docs/jsr-403-workaround.md; CI
Test bắt buộc JSR thật trước merge. Cài UI đúng lock bằng npm ci offline, không
thay dependency. Parent giữ root ở d2c5305 để bảo toàn file người dùng: excerpt
mới trong plan này phải đối chiếu ở worktree main67a7bc4, không coi source cũ
tại root là hiện trạng triển khai hoặc nới validator để che drift.
