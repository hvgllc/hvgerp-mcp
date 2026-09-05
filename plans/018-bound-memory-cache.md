# Kế hoạch 018: Giới hạn số entry và thu hồi cache hết hạn

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 018 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 18; loại: `perf`.
- Ưu tiên: P2; công sức: M; rủi ro sửa: MED.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `DONE`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

MemoryCache chỉ xóa entry hết hạn khi đúng key được đọc lại. Luồng truy vấn dùng
nhiều key khác nhau có thể giữ entry vô hạn theo thời gian. Giới hạn số entry
bảo vệ tiến trình mà không thêm Redis hoặc timer nền.

## Hiện trạng và chứng cứ

Parent đã đọc toàn kế hoạch và đối chiếu `d2c5305..341cba4`: source
`src/cache/memory.ts` và `src/cache/memory_test.ts` không có drift. Executor bắt
đầu trong worktree riêng từ main 341cba4; không sửa source root hoặc đổi
baseline bằng chứng bên dưới.

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
- `plans/README.md`
- `plans/evidence/018.md`

Ngoài phạm vi: Không đổi Cache interface, không thêm backend, dependency, env
var hoặc timer nền. Không sửa dữ liệu production, credential,
`execution-notes.md` ở gốc; không bump version hay tự nâng dependency. Định
danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng Việt có dấu,
không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/cache/memory.ts src/cache/memory_test.ts`
và `git diff -- src/cache/memory.ts src/cache/memory_test.ts`. Bảo toàn thay đổi
có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới kế hoạch này theo
code mới trước khi sửa; sai khác chưa giải thích được là điều kiện dừng.

Nhánh đề xuất: `advisor/018-bound-memory-cache`. Không commit, push, mở PR hoặc
merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`perf: bound memory cache entries`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/cache/`                                         | exit 0; mọi ca trong mục Kiểm thử đạt              |
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

### Bước 1: Tái hiện key hết hạn không được đọc lại

Thêm test thời gian xác định, thay Date.now trong try/finally hoặc dùng đồng hồ
giả theo quy ước hiện có. Ghi 1.001 key với TTL ngắn, tiến đồng hồ rồi ghi key
khác. Chứng minh entry cũ còn lưu bằng kiểm tra trạng thái nội bộ chỉ trong
test; không xuất API chẩn đoán mới cho production.

**Kiểm tra:** `deno test --allow-all src/cache/memory_test.ts` → test mới đỏ
trên code cũ, các test hiện có giữ nguyên.

### Bước 2: Thêm giới hạn và thu hồi trên ghi

Thêm constructor tùy chọn maxEntries mặc định 1000, giữ new MemoryCache() tương
thích. Chỉ nhận số nguyên dương hữu hạn. set quét entry hết hạn, TTL <=0 không
lưu và xóa giá trị cũ cùng key. Khi đầy, loại entry ghi lâu nhất qua thứ tự Map;
cập nhật key xóa rồi thêm để xác định FIFO theo lần ghi. Không gọi đó là LRU.
Giữ chi phí quét O(maxEntries) và không tuyên bố giới hạn byte tuyệt đối.

**Kiểm tra:** `deno test --allow-all src/cache/` → exit 0, số entry không vượt
cap, hết hạn được thu hồi trên ghi.

### Bước 3: Đo giới hạn và chạy hồi quy

Thêm test 10.000 lần set với maxEntries=100, xác nhận trạng thái nội bộ <=100
entry và đọc key mới nhất đúng. Đây là phép đo số entry được giữ, không
benchmark thời gian. Ghi baseline và sau sửa từ regression test, không tuyên bố
cải thiện latency. Giữ deleteByPrefix/clear đúng sau eviction.

**Kiểm tra:** `deno test --allow-all src/cache/ src/api/frappe-client_test.ts` →
exit 0, không timer hoặc tài nguyên bị rò.

## Kiểm thử

- Cap 1, cap100, cập nhật key, key hết hạn, TTL0 và TTL âm.
- Giới hạn không hợp lệ bị từ chối; clear/prefix invalidation vẫn đúng.
- Không xóa key đang còn hạn trừ khi cần eviction vì cap.

## Tiêu chí hoàn tất

- [x] 10.000 lần ghi không làm Map vượt cap100 trong test.
- [x] Test cache và client đạt; số entry baseline/sau sửa cùng fixture được ghi
      rõ.
- [x] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [x] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/018.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Consumer phụ thuộc constructor đặc biệt chưa có trong code hoặc cần giới hạn
  byte thay vì entry.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Nếu thay cap mặc định, đo tỉ lệ hit và thời gian quét; đây là bảo vệ số entry,
không phải hạn mức toàn bộ bộ nhớ.
