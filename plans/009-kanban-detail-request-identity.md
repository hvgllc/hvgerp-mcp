# Kế hoạch 009: Chỉ áp kết quả bất đồng bộ vào đúng phiên mở thẻ

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 009 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 9; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; không hủy mutation đã gửi.
- Phụ thuộc: `007`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao qua luồng code; chưa tái hiện browser.

Khi lưu/assign A rồi đóng và mở B trước response A, hydrate-detail không kiểm
card identity và promise save luôn reset edits. Mục tiêu là mutation A vẫn được
ghi nhận chính xác nhưng tuyệt đối không thay nội dung, error hoặc draft của B.
Đóng rồi mở lại cùng ID cũng phải là phiên mới.

## Hiện trạng và chứng cứ

`src/ui/shared/kanban/state.ts:68`:

<!-- evidence: src/ui/shared/kanban/state.ts -->

<!-- deno-fmt-ignore -->
```text
    case "hydrate-detail":
      return {
        ...state,
        detail: {
          ...state.detail,
          cardDetail: action.detail,
```

`src/ui/kanban-viewer/src/DetailModal.tsx:1030`:

<!-- evidence: src/ui/kanban-viewer/src/DetailModal.tsx -->

<!-- deno-fmt-ignore -->
```text
      await onSave(board.doctype, detail.selectedCardId, editedFields);
      setSaveMessage({ text: "Saved", isError: false });
      setEditedFields({});
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
- `src/ui/kanban-viewer/src/DetailModal.tsx`
- `src/ui/shared/kanban/state.ts`
- `src/ui/shared/kanban/state_test.ts`
- `src/ui/shared/kanban/useKanbanBoard.ts`
- `src/ui/shared/kanban/detail-session.ts` (tạo mới)
- `src/ui/shared/kanban/detail-session_test.ts` (tạo mới)
- `src/ui/testing/fixtures.ts`
- `plans/evidence/009/` (tạo mới)
- `plans/README.md`
- `plans/evidence/009.md`

Ngoài phạm vi: không đổi business API, cột Kanban hay cơ chế hàng đợi move;
không rollback mutation A trên server khi đóng dialog. Không sửa dữ liệu
production, credential, `execution-notes.md` ở gốc; không bump version hay tự
nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích
tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/kanban-viewer/src/KanbanViewer.tsx src/ui/kanban-viewer/src/DetailModal.tsx src/ui/shared/kanban/state.ts src/ui/shared/kanban/state_test.ts src/ui/shared/kanban/useKanbanBoard.ts src/ui/shared/kanban/detail-session.ts src/ui/shared/kanban/detail-session_test.ts src/ui/testing/fixtures.ts`
và
`git diff -- src/ui/kanban-viewer/src/KanbanViewer.tsx src/ui/kanban-viewer/src/DetailModal.tsx src/ui/shared/kanban/state.ts src/ui/shared/kanban/state_test.ts src/ui/shared/kanban/useKanbanBoard.ts src/ui/shared/kanban/detail-session.ts src/ui/shared/kanban/detail-session_test.ts src/ui/testing/fixtures.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/009-kanban-detail-request-identity`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(kanban): bind detail responses to their request session`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                   | Kết quả mong đợi                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/shared/kanban/state_test.ts src/ui/shared/kanban/detail-session_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                          | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                           | exit 0                                             |
| Lint              | `deno lint`                                                                                            | exit 0                                             |
| Format            | `deno fmt --check`                                                                                     | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                                                    | exit 0 sau khi hoàn tất kế hoạch 007               |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                             | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Tái hiện thay thẻ bằng deferred promise

Tạo session token gồm doctype/cardId/generation, test orchestration thuần dùng
reducer thật: mở A, bắt đầu save/assign/unassign, đóng A, mở B và nhập draft B,
hoàn tất response A. Expected B còn nguyên. Thêm A→đóng→A và hai DocType cùng
name. Test cả error và loading cleanup của promise cũ.

**Kiểm tra:**
`deno test --allow-all src/ui/shared/kanban/state_test.ts src/ui/shared/kanban/detail-session_test.ts`
→ test race mới đỏ nếu dùng hydrate-detail hoặc save completion không identity.

### Bước 2: Đưa identity vào state và callback

Mỗi open/close đổi generation; capture token trước await. Reducer
hydrate-detail/detail-error chỉ áp token trùng active session. useKanbanBoard và
mọi caller GET/save/assign/unassign gửi token; không chỉ vá GET mở detail vốn đã
có cardId guard. DetailModal capture token và draft revision lúc save, chỉ reset
edits/message khi token và draft revision còn tương ứng, để cả edit mới trên
cùng thẻ không bị xóa. Sửa onSave từ void thành Promise kết quả typed hoặc dùng
token rõ ràng; không dùng stale closure để quyết định active identity.

**Kiểm tra:** `npm --prefix src/ui run typecheck` → exit 0; mọi đường
hydrate/error bắt buộc gửi identity typed.

### Bước 3: Kiểm luồng trên viewer thật

Chạy Deno tests, UI build rồi dùng MCP host kiểm thử có response trì hoãn để
thực hiện A→lưu→Escape→B→response A. Kiểm cả dialog đang thấy, selectedCardId và
draft B; sau đó mở A lại thấy write đã thành công. Nếu thiếu host/browser, ghi
BLOCKED phần browser và cách chạy lại, không nhận screenshots từ mock HTML làm
bằng chứng. Host từ 007: deno task ui:build rồi npm --prefix src/ui run
dev:test-host; URL
http://127.0.0.1:5178/testing/host.html?viewer=kanban-viewer&scenario=detail-race.
Task A/B dùng cùng fixture state cho get/update; release/reject trả promise A
sau mở B, trace xác nhận thứ tự.

**Kiểm tra:** `deno test --allow-all src/ui/shared/kanban/` → exit 0; evidence
bổ sung thao tác browser và trạng thái sau response cũ.

## Kiểm thử

- Save/assign/unassign/read đều có success/error cũ quay về sai phiên.
- Cùng ID mở lại và khác doctype cùng name không dùng nhầm token.
- Đổi field khi save đang chạy trong cùng phiên không bị xóa; save đúng phiên
  vẫn hiện success.
- Close không gửi cancel/rollback write tới ERP; không warning unhandled
  rejection.

## Tiêu chí hoàn tất

- [ ] Mọi completion detail gắn token, reducer và modal từ chối completion không
      còn phù hợp.
- [ ] Regression tests và typecheck/UI build qua; browser kiểm đúng chuỗi race
      có bằng chứng.
- [ ] Không gây mất dấu mutation đã thành công khi UI bỏ response cũ.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/009.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu cần can thiệp server hoặc hủy write để tránh race, dừng: giải quyết
  identity UI trước.
- Host thử nghiệm không cho trì hoãn response: ghi thiếu bằng chứng, không dùng
  sleep ngẫu nhiên làm ca test đã qua.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Identity phải gồm DocType, name và session generation, không chỉ cardId. Mọi
callback async mới trả về modal phải theo cùng quy tắc.
