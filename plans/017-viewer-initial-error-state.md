# Kế hoạch 017: Hiển thị lỗi tải đầu và giữ dữ liệu khi refresh lỗi

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 017 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 17; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: MED.
- Phụ thuộc: `007`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Invoice và Stock có thể đi vào empty state trước khi trình bày lỗi. Các viewer
biểu đồ còn ép payload thành dữ liệu mà chưa thống nhất xử lý isError. Người
dùng cần phân biệt không có dữ liệu với không đọc được dữ liệu.

## Hiện trạng và chứng cứ

`src/ui/invoice-viewer/src/InvoiceViewer.tsx:237`:

<!-- evidence: src/ui/invoice-viewer/src/InvoiceViewer.tsx -->

```typescript
if (result.isError) {
  const text = extractToolResultText(result);
  setError(text ?? "Tool returned an error");
  setLoading(false);
  return false;
}
```

`src/ui/invoice-viewer/src/InvoiceViewer.tsx:378`:

<!-- evidence: src/ui/invoice-viewer/src/InvoiceViewer.tsx -->

```typescript
if (!data) {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <ErpNextBrandHeader />
      <InvoiceEmptyState />
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

- `src/ui/invoice-viewer/src/InvoiceViewer.tsx`
- `src/ui/stock-viewer/src/StockViewer.tsx`
- `src/ui/chart-viewer/src/ChartViewer.tsx`
- `src/ui/kpi-viewer/src/KpiViewer.tsx`
- `src/ui/funnel-viewer/src/FunnelViewer.tsx`
- `src/ui/shared/presentation.ts`
- `src/ui/shared/presentation_test.ts`
- `src/ui/viewer_error_state_test.ts`
- `src/ui/testing/fixtures.ts`
- `plans/evidence/017/` (tạo mới)
- `plans/README.md`
- `plans/evidence/017.md`

Ngoài phạm vi: Không đổi giao diện thành thiết kế mới, không thay schema tool
hoặc chỉnh Doclist/Kanban đã có xử lý lỗi riêng. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/invoice-viewer/src/InvoiceViewer.tsx src/ui/stock-viewer/src/StockViewer.tsx src/ui/chart-viewer/src/ChartViewer.tsx src/ui/kpi-viewer/src/KpiViewer.tsx src/ui/funnel-viewer/src/FunnelViewer.tsx src/ui/shared/presentation.ts src/ui/shared/presentation_test.ts src/ui/viewer_error_state_test.ts src/ui/testing/fixtures.ts`
và
`git diff -- src/ui/invoice-viewer/src/InvoiceViewer.tsx src/ui/stock-viewer/src/StockViewer.tsx src/ui/chart-viewer/src/ChartViewer.tsx src/ui/kpi-viewer/src/KpiViewer.tsx src/ui/funnel-viewer/src/FunnelViewer.tsx src/ui/shared/presentation.ts src/ui/shared/presentation_test.ts src/ui/viewer_error_state_test.ts src/ui/testing/fixtures.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/017-viewer-initial-error-state`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix: distinguish viewer errors from empty results`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                         | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/shared/presentation_test.ts src/ui/viewer_error_state_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                 | exit 0                                             |
| Lint              | `deno lint`                                                                                  | exit 0                                             |
| Format            | `deno fmt --check`                                                                           | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                                          | exit 0 sau khi hoàn tất kế hoạch 007               |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                   | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Khóa hợp đồng trạng thái bằng test

Dùng getErrorPresentation trong shared/presentation.ts làm mẫu. Bổ sung ma trận
loading, lỗi ban đầu không data, empty hợp lệ, data thành công, lỗi refresh giữ
data cũ. Kiểm payload tối thiểu theo từng viewer trước hydrate; không chấp nhận
JSON bất kỳ chỉ nhờ type assertion. Test guard source hiện có chỉ là hỗ trợ,
không thay thế hành vi.

**Kiểm tra:** `deno test --allow-all src/ui/shared/presentation_test.ts` → ma
trận pure state đạt; test tái hiện đường lỗi cũ được ghi lại.

### Bước 2: Áp dụng vào năm viewer

Xử lý isError trước parse, lỗi parse/schema đặt error rõ ràng, kết thúc loading.
Render blocking error trước empty state khi chưa có data; khi đã có data hiển
thị inline error, không xóa data và refreshRequest hợp lệ cũ. Xóa error chỉ khi
hydrate thành công.

**Kiểm tra:** `npm --prefix src/ui run typecheck` → exit 0, không ép unknown vào
ReactNode hoặc bỏ kiểm tra kiểu.

### Bước 3: Kiểm đường render thật qua host của 007

Bổ sung fixtures initial-error, refresh-error và malformed-payload đúng contract
riêng của năm viewer. Build rồi chạy host tại
http://127.0.0.1:5178/testing/host.html?viewer=invoice-viewer&scenario=initial-error;
lặp tên stock-viewer, chart-viewer, kpi-viewer, funnel-viewer và các scenario.
Ghi 15 kết quả: initial/malformed hiển thị lỗi chứ không empty, refresh giữ số
liệu cũ cùng lỗi. Chụp bằng chứng, không chỉ so regex.

**Kiểm tra:** `deno task ui:build && npm --prefix src/ui run dev:test-host` →
host sẵn sàng; toàn bộ 15 ca quan sát đúng, không lỗi console ngoài lỗi fixture
có chủ ý.

## Kiểm thử

- Pure state: 5 trạng thái được phân biệt.
- Mỗi viewer: isError text không phải JSON, JSON sai shape, success rồi refresh
  thất bại.
- Empty hợp lệ vẫn là empty, không trở thành lỗi giả.

## Tiêu chí hoàn tất

- [ ] Typecheck, test trọng tâm và UI build đạt.
- [ ] Có bằng chứng 15 ca render trong host, không thay bằng test source regex.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/017.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Chưa có host007 hoặc không xác định được payload thực tế của một viewer.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Viewer mới phải có ca lỗi ban đầu và refresh lỗi trong cùng bộ fixtures.
