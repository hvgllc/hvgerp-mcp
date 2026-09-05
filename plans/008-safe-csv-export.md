# Kế hoạch 008: Xuất CSV đúng cấu trúc và giữ văn bản là văn bản

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 008 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 8; loại: `security`.
- Ưu tiên: P1; công sức: S; rủi ro sửa: thấp; cần giữ kiểu số.
- Phụ thuộc: `007`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

exportCsv dùng formatCell rồi chỉ quote comma/quote, bỏ sót CR/LF và header. Văn
bản từ ERP còn có thể bị spreadsheet hiểu là công thức. Đích là serializer thuần
có quy tắc kiểu rõ, bọc DOM download giữ nguyên thao tác người dùng.

## Hiện trạng và chứng cứ

`src/ui/doclist-viewer/src/helpers.ts:92`:

<!-- evidence: src/ui/doclist-viewer/src/helpers.ts -->

<!-- deno-fmt-ignore -->
```text
  const header = columns.join(",");
```

`src/ui/doclist-viewer/src/helpers.ts:95`:

<!-- evidence: src/ui/doclist-viewer/src/helpers.ts -->

<!-- deno-fmt-ignore -->
```text
      const v = formatCell(row[col]);
      return v.includes(",") || v.includes('"')
        ? `"${v.replace(/"/g, '""')}"`
        : v;
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

- `src/ui/doclist-viewer/src/helpers.ts`
- `src/ui/shared/csv.ts` (tạo mới)
- `src/ui/shared/csv_test.ts` (tạo mới)
- `src/ui/testing/fixtures.ts`
- `plans/evidence/008.csv` (tạo mới)
- `plans/evidence/008/` (tạo mới)
- `plans/README.md`
- `plans/evidence/008.md`

Ngoài phạm vi: không đổi cột/dòng được xuất, bộ lọc, phân trang hoặc format hiển
thị bảng; không tự mở file trong spreadsheet tài khoản thật. Không sửa dữ liệu
production, credential, `execution-notes.md` ở gốc; không bump version hay tự
nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích
tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/doclist-viewer/src/helpers.ts src/ui/shared/csv.ts src/ui/shared/csv_test.ts src/ui/testing/fixtures.ts`
và
`git diff -- src/ui/doclist-viewer/src/helpers.ts src/ui/shared/csv.ts src/ui/shared/csv_test.ts src/ui/testing/fixtures.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/008-safe-csv-export`. Không commit, push, mở PR hoặc
merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(ui): serialize CSV safely and preserve text cells`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/shared/csv_test.ts`                          | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                              | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                               | exit 0                                             |
| Lint              | `deno lint`                                                                | exit 0                                             |
| Format            | `deno fmt --check`                                                         | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                        | exit 0 sau khi hoàn tất kế hoạch 007               |
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

### Bước 1: Tách dữ liệu khỏi DOM và thêm fixture

Tạo helper pure serializeCsv(columns,rows), không import alias ~, React hoặc
DOM. Giữ giá trị gốc đủ lâu để phân biệt numeric negative với chuỗi bắt đầu dấu
công thức. Tests header/body có comma/quote/CR/LF, chuỗi Unicode, null, object,
số âm và chuỗi công thức; fixtures dùng biểu thức vô hại, không URL/network hay
macro.

**Kiểm tra:** `deno test --allow-all src/ui/shared/csv_test.ts` → test
serializer mới đỏ trước khi triển khai, expected CSV chỉ rõ escape và kiểu số.

### Bước 2: Serialize mọi cell bằng cùng quy tắc

Quote cell chứa comma/quote/CR/LF, nhân đôi quote; áp dụng cho header lẫn body.
Với văn bản có tiền tố khiến spreadsheet diễn giải công thức, kể cả
whitespace/control prefix liên quan, áp dụng chính sách text an toàn và ghi
tradeoff apostrophe nếu trình đọc khác hiển thị nó. Số thật giữ số, không đổi số
âm thành text. Không dùng formatNumber có phân cách nghìn cho giá trị numeric
machine-readable. Object stringify thành text trước bảo vệ. Chốt bytes:
null/undefined thành cell rỗng; boolean true/false; number hữu hạn dùng
String(value), NaN/Infinity ném lỗi; object JSON.stringify, lỗi serialize truyền
rõ. Chuỗi/header bắt đầu tab/CR/LF hoặc bỏ prefix [space,tab,CR,LF] mà ký tự đầu
là =,+,-,@ thì prefix apostrophe ở đầu toàn chuỗi gốc trước CSV escaping. String
'=1+1' và ' -12' có apostrophe; number -12 giữ -12. LF giữa chuỗi chỉ cần quote.
CRLF là separator record. Tests expected bytes theo bảng này.

**Kiểm tra:** `deno test --allow-all src/ui/shared/csv_test.ts` → exit 0;
round-trip rows/columns đủ, numeric -12 giữ nghĩa số.

### Bước 3: Nối lại download và kiểm hành vi

Dùng host của 007: deno task ui:build rồi npm --prefix src/ui run dev:test-host,
mở http://127.0.0.1:5178/testing/host.html?viewer=doclist-viewer&scenario=csv.
Host gửi payload đúng type Doclist, hai row có Unicode/multiline và giá trị an
toàn. Click Export trong iframe viewer thật, lưu download vào
plans/evidence/008.csv, đối chiếu bytes và round-trip với serializer tests.
Trace phải có handshake/input/result. exportCsv giữ DOM wrapper Blob/object URL,
MIME text/csv;charset=utf-8 và cleanup sau khởi động download. Host không gọi
ERP; dùng browser skill sẵn có, không thêm dependency.

**Kiểm tra:** `npm --prefix src/ui run typecheck` → exit 0; browser click tạo
đúng artifact CSV đã kiểm nội dung.

## Kiểm thử

- Header và cell nhiều dòng, CRLF/LF, quote+comma, Unicode; số cột/hàng không
  đổi.
- Chuỗi có tiền tố công thức được text hóa, số âm kiểu number không bị biến
  thành string.
- Null/undefined/object/boolean có serialization được mô tả; dữ liệu trên bảng
  không đổi.

## Tiêu chí hoàn tất

- [ ] Unit serializer tests đạt với expected bytes và round-trip cấu trúc.
- [ ] Export từ viewer thật tạo file đúng bằng serializer; có bằng chứng
      artifact.
- [ ] Typecheck UI và Deno tests đạt.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/008.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu policy spreadsheet làm đổi ý nghĩa số thật, sửa type distinction trước,
  không prefix tất cả cell.
- Không thực thi fixture công thức có tác dụng phụ hoặc mở dữ liệu production để
  thử.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

CSV serializer là ranh giới output, không dùng formatCell vốn dành cho trình
bày. Thêm format xuất khác phải có serializer và quy tắc text riêng.
