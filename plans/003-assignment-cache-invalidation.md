# Kế hoạch 003: Trả dữ liệu mới sau giao và bỏ giao việc

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 003 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 3; loại: `bug`.
- Ưu tiên: P1; công sức: S; rủi ro sửa: thấp; ảnh hưởng cache hit.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

doc_assign GET trước khi ghi, applyAssignment/removeAssignment gọi method native
không invalidate rồi fetchDocAfterAssignment GET thường. Vì vậy tool có thể báo
thành công cùng dữ liệu _assign cũ; list ToDo cũng cũ. Đích sửa là độ mới của
phản hồi và cache sau mutation, không thay workflow giao việc native.

## Hiện trạng và chứng cứ

`src/tools/assignment.ts:242`:

<!-- evidence: src/tools/assignment.ts -->

```typescript
nativeResult = await ctx.client.callMethod(ASSIGNMENT_METHOD, {
  doctype,
  name,
  ...assignment.args,
});
```

`src/tools/assignment.ts:305`:

<!-- evidence: src/tools/assignment.ts -->

```typescript
try {
  return await ctx.client.get(doctype, name);
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

- `src/tools/assignment.ts`
- `src/tools/assignment_test.ts`
- `src/tools/operations_test.ts`
- `src/tools/project_test.ts`
- `src/api/caller-client_test.ts`
- `plans/README.md`
- `plans/evidence/003.md`

Ngoài phạm vi: không viết _assign trực tiếp, không đổi notification/idempotency
native, không tự sửa UI từ dữ liệu suy đoán. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/tools/assignment.ts src/tools/assignment_test.ts src/tools/operations_test.ts src/tools/project_test.ts src/api/caller-client_test.ts`
và
`git diff -- src/tools/assignment.ts src/tools/assignment_test.ts src/tools/operations_test.ts src/tools/project_test.ts src/api/caller-client_test.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/003-assignment-cache-invalidation`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(assignment): invalidate caches after native mutations`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                        | Kết quả mong đợi                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/tools/assignment_test.ts src/tools/operations_test.ts src/tools/project_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                               | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                | exit 0                                             |
| Lint              | `deno lint`                                                                                                 | exit 0                                             |
| Format            | `deno fmt --check`                                                                                          | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                  | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Tạo regression với cache thật

Dùng FrappeClient + MemoryCache thật và fetch giả để đi qua preflight GET,
assignment method, re-fetch. Fixture _assign trước/sau khác nhau; count GET phải
chứng minh lần sau ra network. Warm cả target list và ToDo list; thêm caller
peer cache. Restore fetch trong finally như các client tests.

**Kiểm tra:** `deno test --allow-all src/tools/assignment_test.ts` → test mới đỏ
vì returned _assign cũ và thiếu invalidation.

### Bước 2: Invalidate ngay sau mutation thành công

Trong applyAssignment/removeAssignment, ngay sau await method thành công,
invalidate doctype/name và ToDo list. ToDo name biết được từ response thì
invalidate từng GET theo name; nếu response không cho ID, đừng giả danh ID hoặc
xóa toàn cache tùy tiện, ghi rõ giới hạn. fetchDocAfterAssignment dùng
skipCache:true. Bổ sung invalidate spy vào mock trong các test bị tác động,
không xóa assertion.

**Kiểm tra:**
`deno test --allow-all src/tools/assignment_test.ts src/tools/operations_test.ts src/tools/project_test.ts src/api/caller-client_test.ts`
→ exit 0; mutation lỗi không bị báo thành công, re-fetch lỗi vẫn báo mutation đã
thành.

### Bước 3: Xác minh toàn hệ thống

Chạy typecheck và toàn suite. Kiểm không thêm mutation/retry để làm mới dữ liệu.
Ghi rằng Frappe có thể không trả _assign trong single-doc GET: test cache
freshness không được biến thành lời hứa trường này luôn có trên mọi site.

**Kiểm tra:** `deno test --allow-all src/` → exit 0; assignment native vẫn chỉ
một lượt.

## Kiểm thử

- Assign/unassign với cache nóng/lạnh; target list và ToDo list hết cache.
- Mutation method throw; post-mutation GET throw có ngữ cảnh đã thành công.
- Caller B warm cache, caller A mutate, B đọc lại không dùng target/list cũ.

## Tiêu chí hoàn tất

- [ ] Phản hồi sau assignment dùng fresh GET, cache liên quan bị invalidate đúng
      thời điểm.
- [ ] Các regression cache thật và gate server đều đạt.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/003.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Native method thay shape response hoặc có side effect thêm DocType: xác minh
  rồi sửa phạm vi trước, không xóa cache toàn tiến trình cho tiện.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi mutation qua callMethod phải tự invalidate. Giữ testcase có cache thật vì
mock get đơn giản không phát hiện hồi quy này.
