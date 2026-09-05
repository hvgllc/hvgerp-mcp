# Kế hoạch 012: Không tái nạp snapshot cũ sau cache invalidation

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 012 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 12; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; phối hợp cache nhiều caller.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

list/get ghi cache vô điều kiện sau await. Một GET bắt đầu trước PUT có thể hoàn
tất sau invalidate và đưa snapshot cũ vào TTL mới. Đích là kết quả đang bay có
thể trả cho request đã bắt đầu trước đó nhưng không được dùng để phục vụ các
request mới sau mutation.

## Hiện trạng và chứng cứ

`src/api/frappe-client.ts:589`:

<!-- evidence: src/api/frappe-client.ts -->

```typescript
this.cache.set(cacheKey, res.data, getCacheTtlMs());
return res.data;
```

`src/api/frappe-client.ts:610`:

<!-- evidence: src/api/frappe-client.ts -->

```typescript
cache.deleteByPrefix(`list:${doctype}:`);
cache.deleteByPrefix(`resolve:miss:${doctype}:`);
if (name) cache.delete(`get:${doctype}:${name}`);
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
- `src/api/caller-client_test.ts`
- `src/cache/invalidation-generation.ts` (tạo mới)
- `src/cache/invalidation-generation_test.ts` (tạo mới)
- `plans/README.md`
- `plans/evidence/012.md`

Ngoài phạm vi: không thay Cache interface công khai, không đổi TTL/caller
isolation, không thêm request deduplication, không buộc retry mọi read. Không
sửa dữ liệu production, credential, `execution-notes.md` ở gốc; không bump
version hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh;
phần giải thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/api/frappe-client.ts src/api/frappe-client_test.ts src/api/caller-client_test.ts src/cache/invalidation-generation.ts src/cache/invalidation-generation_test.ts`
và
`git diff -- src/api/frappe-client.ts src/api/frappe-client_test.ts src/api/caller-client_test.ts src/cache/invalidation-generation.ts src/cache/invalidation-generation_test.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/012-cache-inflight-invalidation`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(cache): reject stale inflight cache fills after writes`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                                          | Kết quả mong đợi                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/api/frappe-client_test.ts src/api/caller-client_test.ts src/cache/invalidation-generation_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                                 | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                                  | exit 0                                             |
| Lint              | `deno lint`                                                                                                                   | exit 0                                             |
| Format            | `deno fmt --check`                                                                                                            | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                                    | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Tái hiện response GET đến sau mutation

Deferred fetch: start GET old, PUT new xong/invalidate, release GET old, đọc lại
phải gọi network và nhận new. Lặp cho list, skipCache read, delete/create làm
đổi list, mutation qua invalidate trực tiếp, và caller B GET đang bay khi A
write. Không dùng sleep thứ tự phụ thuộc timing.

**Kiểm tra:**
`deno test --allow-all src/api/frappe-client_test.ts src/api/caller-client_test.ts`
→ test mới đỏ vì lần đọc cuối dùng old mà không fetch.

### Bước 2: Theo dõi generation theo chính cache và DocType

Helper nội bộ dùng WeakMap keyed by Cache object để client cùng cache thấy cùng
invalidation generation; generation phải cập nhật cho mọi cache trong cachePeers
và cache nguồn trong invalidate. Capture trước network, so lại trước cache.set.
Không key chỉ theo FrappeClient vì peer caller sẽ bị bỏ sót. Giữ đơn vị DocType
bảo thủ cho list/get, invalidate nào ảnh hưởng DocType thì chặn fill cũ tương
ứng; không mở shared cache giữa user. Cân nhắc generation table không giữ Cache
bị evict; WeakMap không giữ object sống.

**Kiểm tra:**
`deno test --allow-all src/cache/invalidation-generation_test.ts src/api/frappe-client_test.ts src/api/caller-client_test.ts`
→ exit 0; fills không liên quan DocType vẫn được cache, stale fill liên quan bị
bỏ.

### Bước 3: Kiểm cache lỗi và vòng đời caller

Test GET fail không fill, mutation fail không tăng generation vì chưa
invalidate, cache Noop không đổi API, evicted caller không bị giữ sống bởi
registry mới. Không yêu cầu request GET cũ trả new vì snapshot của chính request
đó bắt đầu trước write; yêu cầu lần đọc mới không dùng stale cached fill.

**Kiểm tra:** `deno test --allow-all src/` → exit 0; same-cache/multi-caller
invalidation không hồi quy.

## Kiểm thử

- GET/list deferred với write xen giữa; skipCache cũng không được fill sau
  invalidation.
- Hai client cùng cache và hai caller cache peer; DocType A mutate không bỏ fill
  B.
- Create/delete/callMethod handler invalidate; failed mutation; cache disabled.
- Không thêm strong reference giữ caller cache sau eviction.

## Tiêu chí hoàn tất

- [ ] Sau write hoàn tất, late old response không trở thành cache hit mới.
- [ ] Có tests cả list/get và peer cache, không chỉ single-client.
- [ ] Gate server và runtime boundary đạt; Cache interface công khai không đổi.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/012.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu generation được đặt trong instance client nhưng peer cache không truy cập
  được, dừng đổi thiết kế trước.
- Nếu cần đổi Cache public interface, đánh giá tương thích thay vì thêm method
  bắt buộc cho plugin cache.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi write invalidation mới phải bump cùng generation. Tránh registry key bằng
chuỗi token/principal; object cache là ranh giới ownership.
