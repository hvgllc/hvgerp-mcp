# Kế hoạch 002: Kiểm câu trả lời MRTR trước mọi thao tác ghi

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 002 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 2; loại: `bug`.
- Ưu tiên: P1; công sức: L; rủi ro sửa: vừa; thay ranh giới phân giải và thực
  thi.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `IN_PROGRESS`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

runWithLinkDisambiguation chạy handler với args gốc trước khi kiểm
inputResponses. Khi tập ứng viên đổi từ hai xuống một giữa hai lượt, handler có
thể ghi dù action là decline hoặc bỏ qua ID đã chọn. Cần một pha chuẩn bị chỉ
đọc: không dùng việc chạy lại handler ghi làm phép dò ứng viên. Ước lượng tăng
từ M lên L vì phải chứng minh ranh giới này cho tất cả đường MRTR có ghi.

## Hiện trạng và chứng cứ

`src/mrtr/link-disambiguation.ts:177`:

<!-- evidence: src/mrtr/link-disambiguation.ts -->

```typescript
try {
  return { result: await options.execute(options.args), args: options.args };
```

`src/client.ts:221`:

<!-- evidence: src/client.ts -->

```typescript
execute: (callArgs) => tool.handler(callArgs, toolContext),
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

- `src/mrtr/link-disambiguation.ts`
- `src/mrtr/link-disambiguation_test.ts`
- `src/api/resolve.ts`
- `src/api/resolve_test.ts`
- `src/tools/types.ts`
- `src/client.ts`
- `src/client_test.ts`
- `src/tools/assignment.ts`
- `src/tools/sales.ts`
- `src/tools/purchasing.ts`
- `src/tools/hr.ts`
- `src/tools/project.ts`
- `src/tools/operations.ts`
- `src/tools/accounting.ts`
- `src/tools/inventory.ts`
- `src/tools/crm.ts`
- `src/tools/sales_test.ts`
- `src/tools/purchasing_test.ts`
- `src/tools/hr_test.ts`
- `src/tools/project_test.ts`
- `src/tools/operations_test.ts`
- `src/tools/assignment_test.ts`
- `src/transport_wire_test.ts`
- `src/tools/assets.ts`
- `src/tools/assets_test.ts`
- `plans/README.md`
- `plans/evidence/002.md`

Ngoài phạm vi: không đổi giao thức ký token, replay store, scopes, quy tắc
partial matching của write hoặc bật MRTR mặc định; không nâng @casys/mcp-server.
Không sửa dữ liệu production, credential, `execution-notes.md` ở gốc; không bump
version hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh;
phần giải thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/mrtr/link-disambiguation.ts src/mrtr/link-disambiguation_test.ts src/api/resolve.ts src/api/resolve_test.ts src/tools/types.ts src/client.ts src/client_test.ts src/tools/assignment.ts src/tools/sales.ts src/tools/purchasing.ts src/tools/hr.ts src/tools/project.ts src/tools/operations.ts src/tools/accounting.ts src/tools/inventory.ts src/tools/crm.ts src/tools/sales_test.ts src/tools/purchasing_test.ts src/tools/hr_test.ts src/tools/project_test.ts src/tools/operations_test.ts src/tools/assignment_test.ts src/transport_wire_test.ts src/tools/assets.ts src/tools/assets_test.ts`
và
`git diff -- src/mrtr/link-disambiguation.ts src/mrtr/link-disambiguation_test.ts src/api/resolve.ts src/api/resolve_test.ts src/tools/types.ts src/client.ts src/client_test.ts src/tools/assignment.ts src/tools/sales.ts src/tools/purchasing.ts src/tools/hr.ts src/tools/project.ts src/tools/operations.ts src/tools/accounting.ts src/tools/inventory.ts src/tools/crm.ts src/tools/sales_test.ts src/tools/purchasing_test.ts src/tools/hr_test.ts src/tools/project_test.ts src/tools/operations_test.ts src/tools/assignment_test.ts src/transport_wire_test.ts src/tools/assets.ts src/tools/assets_test.ts`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/002-mrtr-preflight-before-write`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(mrtr): validate selections before write execution`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                                                                               | Kết quả mong đợi                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/mrtr/link-disambiguation_test.ts src/api/resolve_test.ts src/client_test.ts src/transport_wire_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                                                                                      | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                                                                                       | exit 0                                             |
| Lint              | `deno lint`                                                                                                                        | exit 0                                             |
| Format            | `deno fmt --check`                                                                                                                 | exit 0                                             |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh`                                                         | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

Goal đã cho phép thực thi và commit trong worktree riêng từ main 013a1cf. Drift
check source lúc giao việc không có thay đổi so với d2c5305. Parent quản lý
index, review, push, PR, CI và merge. Local được dùng workaround đã duyệt với
--config deno.nojsr.json --sloppy-imports --frozen; giữ nguyên lockfile và
vendor. UI chạy npm ci rồi node build-all.mjs trong src/ui, hoàn tất build mới
chạy suite. CI dùng JSR thật vẫn là gate trước DONE. Không tự nâng dependency.

### Bước 1: Tái hiện retry khi ứng viên thay đổi

Thêm fixture two-pass: lần đầu có hai customer, lần sau còn một. Với verified
decline/cancel, đếm create/update/delete/callMethod ghi đều bằng 0; với accept
chọn ID khác bản còn lại, không được ghi theo bản còn lại. Thêm
missing/invalid/unverified response và việc biến đổi array assign_to. Kiểm luôn
đường buildHandlersMap, không chỉ callback trống.

**Kiểm tra:**
`deno test --allow-all src/mrtr/link-disambiguation_test.ts src/client_test.ts`
→ regression mới đỏ do mutation hoặc lựa chọn sai, các test khác không đổi.

### Bước 2: Tách pha chuẩn bị chỉ đọc khỏi handler ghi

Thêm callback chuẩn bị nội bộ tùy chọn vào ErpNextTool cho các tool có inputPath
MRTR. Callback chỉ normalize/resolve/validate, trả args đã chuẩn bị và thông tin
phân giải cần đối chiếu; handler mutation chạy đúng một lần sau khi chuẩn bị
thành công. Tái dùng helper phân giải giữa prepare và handler để tránh hai quy
tắc. buildHandlersMap chuyển callback vào MRTR wrapper. Kiểm retryVerified và
cấu trúc/action câu trả lời trước prepare; decline/cancel dừng ngay. Trên
accept, tái dựng ứng viên bằng đọc mới, yêu cầu ID được chọn vẫn khớp cùng field
và identifier; thiếu/đổi ứng viên trả lỗi yêu cầu làm lại, không chọn thay. Tool
ghi có MRTR nhưng thiếu callback phải fail closed trên retry; không trả success
giả. Kiểm danh mục inputPath trong toàn bộ src/tools và resolveAssignees để
không bỏ sót đường ghi. Thêm option bypass cache cho pha phân giải retry, truyền
xuyên mọi wrapper: GET, exact/partial list và negative-cache miss đều phải đọc
mới. Test FrappeClient/cache thật phải thấy request mới. Asset create/custodian
là đường ghi bắt buộc trong ma trận.

**Kiểm tra:** `deno check mod.ts server.ts` → exit 0; callback typed, không any
và không phụ thuộc runtime ngoài adapter.

### Bước 3: Bảo toàn hợp đồng read/write và wire

Migrate từng tool đủ điều kiện, giữ nguyên thứ tự resolve/validate trước create
và lỗi partial success của assignment. Các read tool có thể dùng cùng preflight;
không sửa business payload ngoài phân giải. Giữ một ambiguity mỗi retry, strict
write match, array giữ các assignee còn lại, refreshRequest dùng args đã giải.
Trong transport_wire_test dùng McpApp thật + fetch ERP giả để kiểm token
ký/nonce và kết quả input_required/complete. Chạy suite và Node build theo bảng;
artifact tạo bởi build không commit.

**Kiểm tra:** `deno test --allow-all src/` → exit 0; mọi retry bị từ chối có số
mutation bằng 0, accept hợp lệ ghi đúng một lần.

## Kiểm thử

- Initial ambiguous call: 0 mutation, input_required đúng key; ordinary ID call:
  đúng một mutation.
- Decline/cancel/missing response/unverified response; candidates 2→1, 2→0, đổi
  ID; không dùng lựa chọn cũ không còn hợp lệ.
- Accept còn hợp lệ chọn đúng ID; array một tên mơ hồ giữ mọi assignee khác;
  ambiguity thứ hai trả lỗi không ghi.
- Wire test với framework thực; read-only prepare bị gắn spy để thất bại nếu gọi
  bất kỳ mutation nào.

## Tiêu chí hoàn tất

- [ ] Có kiểm thử chứng minh 0 thao tác ghi trước xác nhận hợp lệ trên mọi tool
      ghi MRTR.
- [ ] Không thay kiểu response hiện có hay nới strict link resolution; signed
      retry vẫn đi qua framework.
- [ ] Typecheck, toàn bộ tests và Node build đạt; các test không dùng workaround
      bỏ MRTR.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/002.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu framework không cung cấp đủ ngữ cảnh để ràng buộc field/args, dừng và mô
  tả hợp đồng cần thêm; không tự chấp nhận selected ID.
- Nếu prepare cần callMethod chưa rõ đọc hay ghi, xác minh trước; không gọi
  handler ghi để khám phá.
- Nếu cần phá schema/public response, dừng tại đề xuất tương thích, không bump
  version.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi tool ghi bổ sung có inputPath phải đăng ký preflight và có test mutation=0
khi từ chối. Review độc lập phải kiểm nhánh không còn AmbiguousLinkError, vì đó
chính là nhánh bộ test cũ bỏ sót.
