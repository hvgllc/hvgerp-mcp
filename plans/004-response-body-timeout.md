# Kế hoạch 004: Áp timeout cho toàn bộ phản hồi ERPNext

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 004 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 4; loại: `bug`.
- Ưu tiên: P1; công sức: S; rủi ro sửa: thấp; giữ chính sách không retry write.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `DONE`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

requestOnce clearTimeout ngay khi fetch có response, trước response.text. Body
treo sẽ giữ slot xử lý dù timeoutMs đã hết; lỗi stream còn đi ngoài
FrappeAPIError. Timeout phải bao trùm headers và body, dọn tài nguyên trong mọi
nhánh.

## Hiện trạng và chứng cứ

`src/api/frappe-client.ts:455`:

<!-- evidence: src/api/frappe-client.ts -->

```typescript
clearTimeout(timer);
```

`src/api/frappe-client.ts:460`:

<!-- evidence: src/api/frappe-client.ts -->

```typescript
const rawText = await response.text();
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

- `src/api/frappe-client.ts`
- `src/api/frappe-client_test.ts`
- `plans/README.md`
- `plans/evidence/004.md`

Ngoài phạm vi: không đổi mặc định retries, backoff, phương thức nào được retry;
không thêm timeout cấp process hoặc dependency. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/api/frappe-client.ts src/api/frappe-client_test.ts`
và `git diff -- src/api/frappe-client.ts src/api/frappe-client_test.ts`. Bảo
toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới kế
hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/004-response-body-timeout`. Không commit, push, mở PR
hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(api): enforce timeout while reading response bodies`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/api/frappe-client_test.ts`                      | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                              | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                               | exit 0                                             |
| Lint              | `deno lint`                                                                | exit 0                                             |
| Format            | `deno fmt --check`                                                         | exit 0                                             |
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

Đã hoàn tất và merge qua PR #24 tại fbe9528 sau review độc lập, Codex sạch và CI
JSR thật. Bằng chứng: [evidence/004.md](evidence/004.md). Các lệnh và giới hạn
baseline bên trên là lịch sử trước thực thi.

Goal đã cho phép thực thi và commit trong worktree riêng từ main 013a1cf. Drift
check source lúc giao việc không có thay đổi so với d2c5305. Parent quản lý
index, review, push, PR, CI và merge. Local được dùng workaround đã duyệt với
--config deno.nojsr.json --sloppy-imports --frozen; giữ nguyên lockfile và
vendor. UI chạy npm ci rồi node build-all.mjs trong src/ui, hoàn tất build mới
chạy suite. CI dùng JSR thật vẫn là gate trước DONE. Không tự nâng dependency.

### Bước 1: Đóng đinh header nhanh và body chậm

Mock fetch trả Response với ReadableStream nhận signal; kiểm pending get với
timeout nhỏ có abort và reject FrappeAPIError 408 trước khi chủ động nhả body.
Dùng deferred promise cho đồng bộ, cho timeout một cửa sổ đủ rộng, dọn
stream/timer trong finally. Thêm stream error sau headers, body thành công và
lỗi HTTP có JSON/non-JSON.

**Kiểm tra:** `deno test --allow-all src/api/frappe-client_test.ts` → test
timeout body mới đỏ, không treo suite.

### Bước 2: Giữ timer trong try/catch/finally chung

Bao fetch và đọc body bằng cùng xử lý lỗi; clear timer trong finally sau
đọc/parse. Abort thành FrappeAPIError 408; lỗi đọc mạng thành status 0 như lỗi
fetch. Không bọc lại FrappeAPIError HTTP đã phân tích thành status 0. Khi abort,
bảo đảm stream được hủy theo signal hoặc cleanup phù hợp.

**Kiểm tra:** `deno test --allow-all src/api/frappe-client_test.ts` → exit 0;
error code HTTP không bị mất và không leaked resources.

### Bước 3: Kiểm retry theo loại thao tác

Spy số fetch: GET lỗi stream có thể retry theo cấu hình; POST/PUT/upload không
tự retry dù timeout xảy ra sau server có thể đã xử lý. Chạy gate server.

**Kiểm tra:** `deno test --allow-all src/` → exit 0; số mutation request vẫn
bằng 1.

## Kiểm thử

- Timeout trước headers, trong body; signal thực sự aborted, promise thực sự
  reject.
- HTTP 4xx/5xx với body đầy đủ; malformed JSON theo hợp đồng cũ; lỗi stream phân
  loại đúng.
- Retries=0 và retries>0; GET/POST/PUT/multipart; sanitizer không báo
  timer/resource leak.

## Tiêu chí hoàn tất

- [x] Body chậm không thể tồn tại vô hạn ngoài timeoutMs.
- [x] FrappeAPIError và số lần retry đúng loại lỗi/phương thức; mọi gate server
      đạt.
- [x] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [x] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/004.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu một test chỉ mô phỏng promise không tuân AbortSignal, sửa fixture đúng
  hành vi stream trước khi đổi implementation.
- Nếu cần tự retry write để test qua, dừng: trạng thái ghi sau timeout là chưa
  xác định.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Sau này thêm streaming API phải định nghĩa timeout riêng và cleanup rõ. Đừng
chuyển clearTimeout trở lại ngay sau fetch.
