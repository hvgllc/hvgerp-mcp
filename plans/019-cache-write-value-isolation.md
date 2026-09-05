# Kế hoạch 019: Tách giá trị cache khỏi đối tượng bên ghi

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 019 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 19; loại: `bug`.
- Ưu tiên: P2; công sức: S; rủi ro sửa: LOW.
- Phụ thuộc: `018`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

Clone khi đọc không bảo vệ cache nếu bên gọi sửa chính đối tượng đã đưa vào set.
FrappeClient trả đối tượng từ fetch sau khi lưu nên lần đọc đầu có thể làm hỏng
các lần đọc sau.

## Hiện trạng và chứng cứ

`src/cache/memory.ts:33`:

<!-- evidence: src/cache/memory.ts -->

<!-- deno-fmt-ignore -->
```text
  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
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

- `src/cache/memory.ts`
- `src/cache/memory_test.ts`
- `src/api/frappe-client_test.ts`
- `plans/README.md`
- `plans/evidence/019.md`

Ngoài phạm vi: Không sửa client nếu clone tại cache đã đủ, không JSON stringify
để thay structuredClone, không thay Cache interface. Không sửa dữ liệu
production, credential, `execution-notes.md` ở gốc; không bump version hay tự
nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích
tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/cache/memory.ts src/cache/memory_test.ts src/api/frappe-client_test.ts`
và
`git diff -- src/cache/memory.ts src/cache/memory_test.ts src/api/frappe-client_test.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/019-cache-write-value-isolation`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix: isolate cache values on write`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/cache/ src/api/frappe-client_test.ts`           | exit 0; mọi ca trong mục Kiểm thử đạt              |
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

### Bước 1: Tái hiện alias sau set và sau cache miss

Test nested object/array: set(value), sửa value, get phải trả bản gốc. Test
client với fetch giả: lần get/list đầu trả dữ liệu mới, sửa kết quả, lần tiếp
theo phải lấy cache chưa bị sửa và không fetch thêm.

**Kiểm tra:**
`deno test --allow-all src/cache/memory_test.ts src/api/frappe-client_test.ts` →
test alias mới đỏ trên implementation chưa clone khi set.

### Bước 2: Clone trước khi lưu

Áp dụng structuredClone(value) vào entry mới trong set sau kiểm TTL của018; chỉ
thay entry cũ khi clone thành công. Giữ clone trên get. Nếu clone thất bại,
truyền lỗi, không nuốt và không làm mất entry trước đó. Hợp đồng đang dùng dữ
liệu cloneable vì get vốn đã structuredClone.

**Kiểm tra:** `deno test --allow-all src/cache/ src/api/frappe-client_test.ts` →
exit 0; cả cache hit và cache miss đều cách ly object.

### Bước 3: Xác nhận không đổi invalidation

Chạy test cache/client, kiểm clone lỗi, prefix invalidation và TTL vẫn đúng
với018. Chi phí clone-on-write là đánh đổi đã nêu, chưa benchmark và không tuyên
bố cải thiện tốc độ. Không tự chuyển sang shallow copy.

**Kiểm tra:** `deno check mod.ts server.ts` → exit 0; không đổi interface công
khai.

## Kiểm thử

- Nested array/object sửa sau set và sau get không ảnh hưởng cache.
- Lần đọc đầu từ FrappeClient bị caller sửa không làm đổi cache.
- Clone lỗi không thay entry trước đó, TTL và cap018 giữ nguyên.

## Tiêu chí hoàn tất

- [ ] Hai lớp regression cache và FrappeClient đạt.
- [ ] Không xóa clone-on-read hoặc thay bằng shallow clone.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/019.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Phát hiện consumer cố tình lưu dữ liệu không cloneable; cần thống nhất
  contract trước.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Cache backend mới phải giữ cách ly cả đầu ghi và đầu đọc.
