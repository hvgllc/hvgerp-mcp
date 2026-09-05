# Kế hoạch 001: Từ chối cấu hình OAuth chưa đầy đủ

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 001 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 1; loại: `security`.
- Ưu tiên: P1; công sức: S; rủi ro sửa: thấp; giữ chế độ không auth chủ động.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `DONE`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

HTTP dùng tài khoản dịch vụ có thể khởi động không xác thực khi đã đặt
issuer/audience nhưng thiếu JWKS. Mục tiêu là phân biệt cấu hình không auth có
chủ đích với cấu hình OAuth dở dang; trường hợp dở dang phải lỗi trước khi
server nhận request.

## Hiện trạng và chứng cứ

`src/auth/config.ts:81`:

<!-- evidence: src/auth/config.ts -->

```typescript
if (tokens.size === 0 && !jwksUrl) return null;
```

`server.ts:101`:

<!-- evidence: server.ts -->

```typescript
const authConfig = httpFlag ? loadAuthConfig() : null;
const authProvider = authConfig ? buildAuthProvider(authConfig) : undefined;
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

- `src/auth/config.ts`
- `src/auth/config_test.ts`
- `docs/environment-variables.md`
- `plans/README.md`
- `plans/evidence/001.md`

Ngoài phạm vi: không đổi scopes, JWT provider, caller identity, hostname mặc
định, stdio hay cấu hình triển khai. Không sửa dữ liệu production, credential,
`execution-notes.md` ở gốc; không bump version hay tự nâng dependency. Định
danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng Việt có dấu,
không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/auth/config.ts src/auth/config_test.ts docs/environment-variables.md`
và
`git diff -- src/auth/config.ts src/auth/config_test.ts docs/environment-variables.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/001-reject-partial-oauth`. Không commit, push, mở PR
hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(auth): reject incomplete OAuth configuration`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/auth/config_test.ts`                            | exit 0; mọi ca trong mục Kiểm thử đạt              |
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

Điều chỉnh xác minh được người dùng chấp thuận ngày 2026-09-05: áp dụng
docs/jsr-403-workaround.md trong worktree. Cho phép các artifact local bị Git
ignore là deno.nojsr.json, .nojsr-vendor/ và bản copy deno.lock không đổi byte.
Lệnh check/test local dùng --config deno.nojsr.json --sloppy-imports --frozen;
không đổi deno.json hoặc dependency của project. Không dùng deno task --config.
Gate CI dùng JSR thật vẫn phải được xác nhận trước DONE; chưa được push hoặc
dispatch nếu chưa có ủy quyền tương ứng. Bằng chứng ở
plans/evidence/jsr-workaround.md.

Kết quả: commit 495cd98 đã sửa auth và vượt qua review source, 79 test auth, 805
test toàn suite, typecheck, lint, format và build local. Người dùng đã cho phép
push và chạy workflow. CI Test 33940983646 trên commit bb78ace đạt với JSR thật:
805 pass, 0 fail, 4 ignored. Verdict APPROVE, trạng thái DONE trong nhánh riêng,
chưa merge. Chi tiết ở plans/evidence/001.md.

Khi kiểm local, chạy build UI xong mới chạy suite; gọi trực tiếp node
build-all.mjs trong src/ui để tránh deno task cập nhật lockfile local.

### Bước 1: Đóng đinh ma trận cấu hình bằng test

Dùng withEnv trong config_test.ts, luôn khôi phục env sau test. Thêm các trường
hợp issuer-only, audience-only, issuer+audience thiếu JWKS; lặp khi có static
token hợp lệ. Mọi tập có ý định OAuth nhưng thiếu một trong
JWKS/issuer/audience/resource phải ném lỗi chỉ rõ tên biến còn thiếu. Trường hợp
toàn bộ OAuth không có vẫn cho static-only hoặc null như cũ. Quyết định
resource-only là lỗi cấu hình thiếu chế độ auth, ghi rõ trong docs.

**Kiểm tra:** `deno test --allow-all src/auth/config_test.ts` → test mới thất
bại vì hiện tại trả null hoặc nhận static-only; lỗi phải đúng assertion, không
phải thiếu dependency.

### Bước 2: Kiểm đầy đủ trước nhánh trả null

Đọc và chuẩn hóa mọi biến trước return. Nhận diện ý định OAuth từ JWKS, issuer
hoặc audience; kiểm đủ nhóm OAuth trước xây provider, cả khi token tĩnh cũng có.
Không coi token tĩnh là phương án che lỗi OAuth. Duy trì xử lý quote/whitespace
hiện có; giá trị rỗng sau unquote được coi là thiếu.

**Kiểm tra:**
`deno test --allow-all src/auth/config_test.ts src/auth/composite-provider_test.ts src/auth/caller-identity_test.ts`
→ exit 0; no-auth, static-only, OAuth đủ và composite không hồi quy.

### Bước 3: Đồng bộ hợp đồng startup

Cập nhật docs/environment-variables.md về cấu hình từng phần. Kiểm server vẫn
gọi loadAuthConfig chỉ ở HTTP và dựng provider trước startHttp. Không sửa
deployment thật. Chạy toàn bộ gate server và lưu bằng chứng.

**Kiểm tra:** `deno check mod.ts server.ts` → exit 0; cấu hình lỗi không thể đi
đến startup.

## Kiểm thử

- Mỗi biến OAuth bị thiếu một lần; có/không static token; rỗng và quote rỗng.
- Không auth: null; static-only đầy đủ: provider tĩnh; OAuth/composite đầy đủ:
  provider tương ứng.
- Không đưa giá trị env thực vào snapshot/log; chỉ dùng fixture giả.

## Tiêu chí hoàn tất

- [x] Ma trận cấu hình mới và các test auth hiện có đều qua.
- [x] Cấu hình dở dang ném lỗi trước server.startHttp; stdio không đọc nhóm
      auth.
- [x] Các gate server trong bảng đạt hoặc toàn bộ công việc được ghi BLOCKED kèm
      bằng chứng.
- [x] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [x] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/001.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu framework bắt buộc resource-only cho chế độ không auth đang dùng, xác minh
  hợp đồng trước khi đổi; không tự suy đoán.
- Nếu thay đổi yêu cầu cấu hình provider hoặc token production, dừng tại diff
  local.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Khi thêm phương thức auth mới, mở rộng ma trận ý định/chế độ đầy đủ. Review phải
kiểm cấu hình kết hợp, không chỉ từng provider riêng.
