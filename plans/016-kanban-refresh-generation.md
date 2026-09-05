# Kế hoạch 016: Bỏ snapshot board cũ và giữ refresh sau mutation

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 016 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 16; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; phối hợp queue và optimistic
  updates.
- Phụ thuộc: `007`, `009`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao qua luồng code; browser cần kiểm.

Refresh bắt đầu trước move có thể kết thúc sau move và ghi đè board mới. Cờ
refreshAfterMutation bị xóa trước khi refresh mới được chấp nhận nên lần xác
nhận có thể mất. Mục tiêu là đọc cũ không rollback UI, và pending refresh chỉ
hết khi đã thực sự xử lý.

## Hiện trạng và chứng cứ

`src/ui/kanban-viewer/src/KanbanViewer.tsx:1127`:

<!-- evidence: src/ui/kanban-viewer/src/KanbanViewer.tsx -->

<!-- deno-fmt-ignore -->
```text
      updateBoard(parseBoard(text));
```

`src/ui/kanban-viewer/src/KanbanViewer.tsx:1224`:

<!-- evidence: src/ui/kanban-viewer/src/KanbanViewer.tsx -->

<!-- deno-fmt-ignore -->
```text
      } else if (refreshAfterMutationRef.current) {
        refreshAfterMutationRef.current = false;
        void requestBoardRefresh({ ignoreInterval: true });
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

- `src/ui/kanban-viewer/src/KanbanViewer.tsx`
- `src/ui/shared/kanban/refresh.ts`
- `src/ui/shared/kanban/refresh_test.ts`
- `src/ui/shared/kanban/refresh-controller.ts` (tạo mới)
- `src/ui/shared/kanban/refresh-controller_test.ts` (tạo mới)
- `src/ui/testing/fixtures.ts`
- `plans/evidence/016/` (tạo mới)
- `plans/README.md`
- `plans/evidence/016.md`

Ngoài phạm vi: không đổi move business rules hoặc refresh các viewer khác; không
serialize toàn UI bằng khóa làm mất thao tác người dùng. Không sửa dữ liệu
production, credential, `execution-notes.md` ở gốc; không bump version hay tự
nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích
tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/kanban-viewer/src/KanbanViewer.tsx src/ui/shared/kanban/refresh.ts src/ui/shared/kanban/refresh_test.ts src/ui/shared/kanban/refresh-controller.ts src/ui/shared/kanban/refresh-controller_test.ts src/ui/testing/fixtures.ts`
và
`git diff -- src/ui/kanban-viewer/src/KanbanViewer.tsx src/ui/shared/kanban/refresh.ts src/ui/shared/kanban/refresh_test.ts src/ui/shared/kanban/refresh-controller.ts src/ui/shared/kanban/refresh-controller_test.ts src/ui/testing/fixtures.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/016-kanban-refresh-generation`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(kanban): retain refresh requests across concurrent moves`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                         | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/shared/kanban/refresh_test.ts src/ui/shared/kanban/refresh-controller_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                 | exit 0                                             |
| Lint              | `deno lint`                                                                                                  | exit 0                                             |
| Format            | `deno fmt --check`                                                                                           | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                                                          | exit 0 sau khi hoàn tất kế hoạch 007               |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                   | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Tái hiện refresh trước move bằng deferred

Tách controller thuần đủ để test quyết định start/apply/pending. Bắt đầu refresh
snapshot G, bắt đầu và hoàn tất move G+1, rồi release refresh cũ. Board phải còn
destination và pending refresh mới cuối cùng chạy đúng một lần khi idle. Test
queue nhiều move, hidden/focus và read lỗi; không dựa interval ngẫu nhiên.

**Kiểm tra:**
`deno test --allow-all src/ui/shared/kanban/refresh-controller_test.ts` → test
mới đỏ với logic clear-pending trước refresh và apply mọi response.

### Bước 2: Đánh dấu generation và pending đúng vòng đời

Capture board identity và mutation generation lúc read bắt đầu; khi read về chỉ
apply nếu board/generation vẫn khớp và không có optimistic mutation mới làm
snapshot lỗi thời. Bump generation khi mutation bắt đầu để cả request về giữa
write cũng bị bỏ. Pending revalidation không clear nếu gate reject vì
refreshInFlight/drag/hidden/queue; drain sau finally/idle/focus. Không busy-loop
retry khi lỗi hoặc hidden, giữ interval/backoff đang có. Hợp nhất nhiều yêu cầu
pending thành một latest refresh. Board identity không chỉ là boardId vì mọi
Task dùng task-board: dùng generation của phiên board cùng request arguments
được chuẩn hóa (doctype, project, priority, offset, limit và mọi filter). Tăng
session generation khi host đưa input/board mới, kể cả cùng DocType; không tăng
do chính response refresh của cùng request. Không dùng generatedAt làm identity.

**Kiểm tra:**
`deno test --allow-all src/ui/shared/kanban/refresh_test.ts src/ui/shared/kanban/refresh-controller_test.ts`
→ exit 0; tối đa một refresh đang chạy, yêu cầu sau mutation không mất.

### Bước 3: Nối component và kiểm browser queue

Dùng host 007 tại
http://127.0.0.1:5178/testing/host.html?viewer=kanban-viewer&scenario=board-race
sau UI build. Host release read cũ sau move success, ghi trace; thẻ không quay
về và một fresh read xuất hiện sau đó. Thêm failed move/rollback, board đổi, tab
hidden→visible. Dùng identity detail của 009 nhưng không nhầm generation detail
với generation board.

**Kiểm tra:**
`npm --prefix src/ui run typecheck && deno test --allow-all src/ui/shared/kanban/`
→ exit 0; browser trace chứng minh response cũ bị bỏ và refresh cuối cùng xảy
ra.

## Kiểm thử

- Refresh→move success→old refresh; old refresh về giữa move; nhiều queued move.
- Gate từ chối không xóa pending; focus sau hidden drain một lần.
- Read failure không infinite loop; move failure rollback không bị stale
  snapshot ghi đè.
- Board A→B khi read A đang chạy không hydrate board A.
- Cùng DocType Task: project A→B và offset0→50 khi read cũ chưa về; response cũ
  không hydrate bộ lọc/trang mới.

## Tiêu chí hoàn tất

- [ ] Deferred tests kiểm thứ tự request và trạng thái board thật, không chỉ
      boolean gate.
- [ ] Browser core race qua, không flicker về cột cũ, không mất pending refresh.
- [ ] Gate UI/server và toàn suite đạt.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/016.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu biện pháp là chặn mọi move suốt thời gian refresh mạng, đánh giá UX và sửa
  controller trước.
- Nếu cần tăng timer để che race, dừng: test phải điều khiển thứ tự bằng
  deferred promise.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Generation detail và board khác nhau. Mọi mutation mới phải invalidates read
generation và yêu cầu revalidation qua controller chung.
