# Kế hoạch 011: Giữ kết quả batch đã thực thi khi upstream ném lỗi

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 011 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 11; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; semantics JSON-RPC batch.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

forwardOne throw trong entry thứ hai làm mất replies của entry đầu; shim.ts trả
một lỗi 502 id:null. Client không biết phần nào đã ghi và có thể gửi lại cả
batch. Đích là giữ kết quả thành công, đánh dấu entry lỗi là outcome unknown, và
các entry chưa gọi là not executed.

## Hiện trạng và chứng cứ

`src/compat/legacy-shim.ts:1783`:

<!-- evidence: src/compat/legacy-shim.ts -->

```typescript
const outcome = await forwardOne(
```

`shim.ts:92`:

<!-- evidence: shim.ts -->

```typescript
return Response.json({
  jsonrpc: "2.0",
  id: null,
  error: { code: -32603, message: "Shim upstream failure" },
}, { status: 502 });
```

## Quy ước cần giữ

Shim library chỉ dùng Web APIs, không Deno.* hoặc node:*; shim.ts là entrypoint
Deno ngoại lệ. Giữ auth/header/version translation, synthetic SSE và giới hạn
body hiện có. Không tự retry mutation.

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

- `src/compat/legacy-shim.ts`
- `src/compat/legacy-shim_test.ts`
- `shim.ts`
- `docs/migration-mcp-spec-2026-07-28.md`
- `plans/README.md`
- `plans/evidence/011.md`

Ngoài phạm vi: không thay single-request transport hoặc auth pipeline; không
replay batch, không đổi legacy versions hỗ trợ. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/compat/legacy-shim.ts src/compat/legacy-shim_test.ts shim.ts docs/migration-mcp-spec-2026-07-28.md`
và
`git diff -- src/compat/legacy-shim.ts src/compat/legacy-shim_test.ts shim.ts docs/migration-mcp-spec-2026-07-28.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/011-shim-partial-batch-errors`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(shim): preserve completed batch replies on upstream failure`.

## Lệnh xác minh

| Mục đích       | Lệnh                                                   | Kết quả mong đợi                      |
| -------------- | ------------------------------------------------------ | ------------------------------------- |
| Test trọng tâm | `deno test --allow-all src/compat/legacy-shim_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt |
| Kiểu server    | `deno check mod.ts server.ts`                          | exit 0                                |
| Test hồi quy   | `deno test --allow-all src/`                           | exit 0                                |
| Lint           | `deno lint`                                            | exit 0                                |
| Format         | `deno fmt --check`                                     | exit 0                                |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Tạo ca batch dở dang có write

Dùng fetch giả cục bộ hoặc fake upstream của legacy-shim_test.ts: 3 entries, thứ
nhất success, thứ hai network throw hoặc JSON body lỗi, thứ ba spy chưa gọi.
Expected replies giữ id thứ nhất và outcome unknown cho id thứ hai, not executed
cho id thứ ba. Thêm batch có notification trước/sau lỗi, không tạo JSON-RPC
response cho notification.

**Kiểm tra:** `deno test --allow-all src/compat/legacy-shim_test.ts` →
regression đỏ vì handleShimRequest reject toàn bộ hoặc mất reply đầu.

### Bước 2: Catch ở ranh giới từng entry

Đặt ranh giới xử lý lỗi ở toàn bộ từng entry: authorize ở cả missing-method,
locally-answered và invalid-fields; auth.blocked; forwardOne; đọc/parse payload.
Theo dõi đã chuyển một entry lên upstream riêng với replies.length, vì
notification có thể đã ghi mà không có reply. Nếu chưa thực thi entry nào, giữ
nguyên auth response/challenge như trước. Nếu đã có entry thực thi, không return
auth.blocked làm mất replies: giữ kết quả trước đó, trả lỗi xác thực cho entry
hiện tại có id và not executed cho phần còn lại, dừng batch. Khi authorize bị
throw thì entry local chưa gọi mutation, ghi not executed/auth unavailable; khi
forwardOne throw thì outcome unknown vì có thể đã commit. Giữ WWW-Authenticate,
CORS và protocol headers theo response auth nếu có; không biến auth deny thành
success hoặc bỏ auth probe bắt buộc. HTTP status/body cho partial batch phải
được khóa bằng wire test để client còn đọc được completed replies. Không đưa raw
URL/internal exception ra client; không retry mutation.

**Kiểm tra:** `deno test --allow-all src/compat/legacy-shim_test.ts` → exit 0;
không entry nào sau lỗi gọi upstream và completed reply không biến mất.

### Bước 3: Kiểm wire và runtime boundary

Kiểm malformed response, network reject, lỗi đọc body, mixed notification,
non-JSON branch hiện có, 401/403, legacy revision. Chạy typecheck shim riêng và
test boundary. Không cần Node bundle vì shim không được npm ship; không dựng
Docker trong task nếu không cần kiểm dependency mới. Bắt buộc kiểm authorize
throw/401 trong cả ba nhánh local và notification đầu batch; ghi HTTP status,
headers, JSON-RPC ids và số mutation.

**Kiểm tra:**
`deno check shim.ts && deno test --allow-all src/runtime-boundary_test.ts src/compat/legacy-shim_test.ts`
→ exit 0; shim library vẫn platform-free.

## Kiểm thử

- Success→network error→not executed; success→invalid JSON→not executed.
- Notification đầu tiên có thể đã thực thi nhưng không có reply: vẫn phân biệt
  batch đã chạy với replies.length=0.
- Exception trước entry đầu, auth deny, canceled body; không raw upstream URL
  trong client error.
- Số upstream mutation không tăng do catch/retry; fixture cleanup không leak
  server.
- Success write → ping/invalid entry → authorize throw hoặc401: giữ reply write,
  giữ challenge401, entry sau không chạy; lặp với notification write đầu tiên.

## Tiêu chí hoàn tất

- [ ] Client thấy toàn bộ kết quả đã biết và phân biệt unknown với not executed.
- [ ] Mọi regression batch và gate shim/runtime boundary đạt.
- [ ] Không làm giảm xác thực hoặc lộ chi tiết nội bộ.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/011.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu lựa chọn HTTP status/header khiến client không đọc batch body, kiểm
  contract host và ghi tradeoff trước khi chốt.
- Nếu cần retry để biết write thành hay chưa, dừng: không replay operation không
  idempotent.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi exception sau khi entry có thể đã chạy phải đi qua cùng bộ tổng hợp. Chỉ
kiểm replies.length không đủ vì notification không có reply.
