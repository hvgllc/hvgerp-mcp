# Kế hoạch 020: Đồng bộ schema trạng thái Kanban và giới hạn tháng doanh thu

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 020 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 20; loại: `bug`.
- Ưu tiên: P2; công sức: M; rủi ro sửa: MED.
- Phụ thuộc: `014`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Schema Kanban chỉ khai báo trạng thái Opportunity dù Issue adapter nhận trạng
thái riêng. Revenue trend nhận months dạng number không chặn số lẻ/âm trước khi
tạo mảng. Hai biên này cần được kiểm cả ở schema lẫn handler trực tiếp.

## Hiện trạng và chứng cứ

`src/tools/kanban.ts:111`:

<!-- evidence: src/tools/kanban.ts -->

<!-- deno-fmt-ignore -->
```text
        status: {
          type: "string",
          description: "Optional Opportunity status filter",
          enum: ["Open", "Replied", "Quotation", "Converted", "Closed", "Lost"],
        },
```

`src/tools/analytics.ts:360`:

<!-- evidence: src/tools/analytics.ts -->

<!-- deno-fmt-ignore -->
```text
        months: {
          type: "number",
          description: "How many months back to include (default 6)",
        },
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

- `src/tools/kanban.ts`
- `src/tools/kanban_test.ts`
- `src/tools/analytics.ts`
- `src/tools/analytics_test.ts`
- `plans/README.md`
- `plans/evidence/020.md`

Ngoài phạm vi: Không thêm DocType, không tự thêm status filter Task chưa được
adapter hỗ trợ, không sửa trạng thái ERPNext chuẩn. Không sửa dữ liệu
production, credential, `execution-notes.md` ở gốc; không bump version hay tự
nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích
tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/tools/kanban.ts src/tools/kanban_test.ts src/tools/analytics.ts src/tools/analytics_test.ts`
và
`git diff -- src/tools/kanban.ts src/tools/kanban_test.ts src/tools/analytics.ts src/tools/analytics_test.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/020-align-tool-schema-boundaries`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix: align kanban filters and revenue month validation`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                         | Kết quả mong đợi                                   |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/kanban_test.ts src/tools/analytics_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                 | exit 0                                             |
| Lint              | `deno lint`                                                                  | exit 0                                             |
| Format            | `deno fmt --check`                                                           | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`   | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Khóa hành vi biên hiện tại

Đọc columns và filter của Issue/Opportunity. Thêm ca schema chấp nhận On
Hold/Resolved cho Issue và giữ trạng thái Opportunity hiện có. Revenue:
default6,1,60 hợp lệ; 0,-1,1.5,61,NaN,Infinity và chuỗi đều bị từ chối trước mọi
client call; NaN/Infinity kiểm ở handler trực tiếp.

**Kiểm tra:**
`deno test --allow-all src/tools/kanban_test.ts src/tools/analytics_test.ts` →
regression mới đỏ đúng nguyên nhân schema hoặc RangeError cũ.

### Bước 2: Đồng bộ contract

Kanban dùng enum hợp của trạng thái thực tế từ hai adapter, mô tả áp dụng
Issue/Opportunity. Handler kiểm trạng thái tương ứng DocType trước fetch để
union không cho phép Issue=Quotation. Không đổi hành vi Task trong đợt này; ghi
rõ status không hỗ trợ Task. Revenue months dùng integer minimum1 maximum60 và
kiểm Number.isInteger cùng biên trong handler, dùng lỗi validation theo mẫu
MAX_PL_MONTHS hiện có. Kế thừa company/currency/date/pagination
từ005/006/013/014.

**Kiểm tra:**
`deno test --allow-all src/tools/kanban_test.ts src/tools/analytics_test.ts` →
exit 0, đầu vào sai không gọi ERP và không rơi vào RangeError.

### Bước 3: Kiểm registry và schema công khai

Dùng validator hiện tại của repo để kiểm schema, không chỉ gọi handler mock. Ghi
những input nay bị từ chối vì trước đây không có nghĩa hợp lệ; không đổi tool
name hoặc response shape.

**Kiểm tra:** `deno check mod.ts server.ts && deno test --allow-all src/` → exit
0, schema và handler nhất quán.

## Kiểm thử

- Issue On Hold/Resolved và Opportunity Quotation/Converted.
- Trạng thái thuộc DocType khác bị từ chối trước fetch.
- Months default/1/60 và toàn bộ đầu vào sai đã nêu.

## Tiêu chí hoàn tất

- [ ] Schema validation và direct-handler tests đều đạt.
- [ ] Không còn cấp phát mảng từ months chưa kiểm tra.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/020.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Adapter thực tế đã thay trạng thái khác chứng cứ; cần cập nhật bảng trước khi
  sửa.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Khi thêm trạng thái adapter, cập nhật schema và ma trận theo DocType trong cùng
thay đổi.
