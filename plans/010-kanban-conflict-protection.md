# Kế hoạch 010: Kiểm trạng thái Kanban bằng dữ liệu mới và bảo vệ ghi

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 010 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 10; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; phụ thuộc hợp đồng optimistic
  locking của Frappe.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `DONE`.
- Độ tin cậy: cao về GET cache; cơ chế compare-and-write cần xác minh.

Ba adapter GET bình thường rồi so fromColumn, sau đó update chỉ status. Cache có
thể che thay đổi của người khác; ngay cả fresh GET còn khoảng tranh chấp trước
PUT. Done cần chứng minh cả fresh read và cơ chế ngăn ghi đè, không gọi fresh
GET là khóa nguyên tử.

## Hiện trạng và chứng cứ

Đối chiếu trước execute từ `d2c5305` đến main `99b1fa3`: chỉ
`src/api/frappe-client_test.ts` thêm 219 dòng regression timeout của 004; mọi
adapter và hợp đồng update trong scope không đổi. Thực thi ở worktree 010 riêng
từ main này, không cập nhật source root. Cơ chế modified đã đối chiếu mã Frappe
`755b5cb81fabb431265690fca07f4a8038a5599a`; executor phải đọc lại và lưu bằng
chứng primary, không coi fake server là bằng chứng transaction upstream.

Mở scope tối thiểu đã được parent duyệt: full suite 944 passed, 3 failed, 4
ignored; đúng ba happy-path move Task/Opportunity/Issue trong
`src/tools/kanban_test.ts` có GET fixture thiếu modified. Chỉ bổ sung modified
cho ba fixture này và assertion fresh GET với skipCache/PUT mang modified; không
đổi handler, mock chung hoặc nới kiểm lỗi để suite xanh.

`src/kanban/adapters/task.ts:218`:

<!-- evidence: src/kanban/adapters/task.ts -->

<!-- deno-fmt-ignore -->
```text
    const currentTask = await ctx.client.get("Task", move.cardId) as Record<
```

`src/kanban/adapters/task.ts:258`:

<!-- evidence: src/kanban/adapters/task.ts -->

<!-- deno-fmt-ignore -->
```text
    const serverTask = await ctx.client.update("Task", move.cardId, {
      status,
    }) as Record<
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

- `src/kanban/adapters/task.ts`
- `src/kanban/adapters/opportunity.ts`
- `src/kanban/adapters/issue.ts`
- `src/kanban/adapters/task-adapter_test.ts`
- `src/kanban/adapters/opportunity-adapter_test.ts`
- `src/kanban/adapters/issue-adapter_test.ts`
- `src/api/frappe-client_test.ts`
- `src/tools/kanban_test.ts` (chỉ fixture ba happy-path move và assertion guard)
- `docs/erpnext-quirks.md`
- `plans/README.md`
- `plans/evidence/010.md`

Ngoài phạm vi: không đổi transition rules, không tự cài method Frappe hoặc sửa
site; không thay generic update toàn hệ thống để giải một adapter. Không sửa dữ
liệu production, credential, `execution-notes.md` ở gốc; không bump version hay
tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải
thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/kanban/adapters/task.ts src/kanban/adapters/opportunity.ts src/kanban/adapters/issue.ts src/kanban/adapters/task-adapter_test.ts src/kanban/adapters/opportunity-adapter_test.ts src/kanban/adapters/issue-adapter_test.ts src/api/frappe-client_test.ts src/tools/kanban_test.ts docs/erpnext-quirks.md`
và
`git diff -- src/kanban/adapters/task.ts src/kanban/adapters/opportunity.ts src/kanban/adapters/issue.ts src/kanban/adapters/task-adapter_test.ts src/kanban/adapters/opportunity-adapter_test.ts src/kanban/adapters/issue-adapter_test.ts src/api/frappe-client_test.ts src/tools/kanban_test.ts docs/erpnext-quirks.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/010-kanban-conflict-protection`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(kanban): verify fresh state before guarded card moves`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/kanban/adapters/`                               | exit 0; mọi ca trong mục Kiểm thử đạt              |
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

### Bước 1: Chứng minh hai kiểu xung đột

Test có FrappeClient/cache thật: cache Task Open, server đã Working, request từ
Open phải trả conflict và 0 PUT. Test thứ hai giữ response GET rồi thay
modified/status trên server giả trước PUT; PUT phải bị từ chối bởi optimistic
locking. Đọc mã endpoint Frappe REST và Document.save đúng phiên bản hỗ trợ hoặc
bằng chứng local hiện có để xác minh modified từ PUT có được tôn trọng. Lưu
nguồn/file/version; fake server tự từ chối không đủ chứng minh upstream làm vậy.

**Kiểm tra:** `deno test --allow-all src/kanban/adapters/` → ca cache mới đỏ; cơ
chế khóa được ghi verified hoặc BLOCKED, không mặc định verified.

### Bước 2: Fresh GET và mutation có điều kiện đã xác minh

Ở cả ba executeMove dùng get(...,{skipCache:true}). Giữ kiểm
serverColumn/fromColumn. Chỉ khi đã chứng minh REST honor modified, gửi modified
nhận từ fresh GET cùng status; từ chối thiếu modified thay vì ghi không khóa.
Mapping lỗi conflict phải bảo toàn error và không báo move thành công. Nếu REST
không hỗ trợ, dừng phần compare-and-write và đề xuất method site trong phạm vi
riêng; không giả vờ prefetch là atomic.

**Kiểm tra:**
`deno test --allow-all src/kanban/adapters/ src/api/frappe-client_test.ts src/tools/kanban_test.ts`
→ exit 0; conflict không ghi, fresh GET không đi cache, PUT mang phiên bản đã
xác minh.

### Bước 3: Kiểm cả ba DocType và hợp đồng lỗi

Test Task/Opportunity/Issue thành công, trạng thái đã đổi, modified đổi xen
giữa, permission/error và cache sau success. Ghi rõ phiên bản Frappe xác minh
trong quirks, không diễn giải suy đoán thành fact. Nếu không có môi trường test
an toàn, có thể dùng mã upstream làm bằng chứng cơ chế và unit tests cho
request; không chạy mutation production.

**Kiểm tra:** `deno check mod.ts server.ts` → exit 0; tài liệu phân biệt
fresh-read guard và compare-and-write.

## Kiểm thử

- Mỗi adapter: stale cache, foreign fromColumn, invalid destination, success.
- Mỗi adapter: cập nhật xen giữa GET/PUT phải conflict, thiếu modified không
  ghi.
- Frappe permission/network error không thành ok:true hoặc no-op giả.

## Tiêu chí hoàn tất

- [x] Cả ba adapter dùng fresh GET và có regression cache thật.
- [x] Có bằng chứng upstream cho cơ chế khóa; test request/response tương ứng
      đạt.
- [x] Nếu chưa chứng minh compare-and-write thì trạng thái vẫn BLOCKED, dù fresh
      GET đã sửa.
- [x] Các gate server đạt.
- [x] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [x] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/010.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- REST bỏ qua modified hoặc hợp đồng chưa rõ: dừng thiết kế mutation có điều
  kiện; không tạo endpoint production.
- Cần sửa adapter transition hoặc generic update ngoài scope: xin điều chỉnh kế
  hoạch bằng chứng trước.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Khi nâng Frappe phải kiểm lại endpoint xử lý modified. Unit server giả chỉ chứng
minh client gửi đúng request, không chứng minh DB transaction.
