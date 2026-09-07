# Bằng chứng kế hoạch 001

## Trạng thái

`LOCAL VERIFIED / AWAITING CI`

Chưa đánh dấu kế hoạch hoàn tất vì mạng hiện tại trả `403 Forbidden` cho JSR.
Các test và type check local dùng import map workaround đã được user duyệt. Hai
import `@std/assert` và `@std/yaml` được chuyển local sang
`deno.land/std@0.224.0`; kết quả này không thay thế gate JSR thật trên CI.

## Regression trước khi sửa

- `deno test --config deno.nojsr.json --sloppy-imports --frozen --allow-all src/auth/config_test.ts`
  - Exit 1.
  - `18 passed | 16 failed`.
  - Cả 16 lỗi mới đều là `Expected function to throw`, xác nhận source cũ không
    từ chối cấu hình OAuth chưa đầy đủ.
- Full suite trước khi sửa: `762 passed | 16 failed | 4 ignored`; không có lỗi
  ngoài 16 regression auth mới.

## Thay đổi

- Đọc và chuẩn hóa đủ JWKS, audience, issuer và resource trước nhánh no-auth.
- Nhận diện ý định OAuth từ bất kỳ biến JWKS, audience hoặc issuer nào.
- Từ chối thiếu từng biến bắt buộc ngay trong `loadAuthConfig()`, kể cả khi có
  static token.
- Từ chối `MCP_AUTH_RESOURCE` khi không có static token hoặc OAuth.
- Giá trị empty, whitespace, quoted-empty và quoted-whitespace được coi là
  thiếu. Giá trị non-empty có khoảng trắng bên trong quote vẫn được bảo toàn
  theo hành vi cũ.
- Fixture ban đầu chỉ kiểm blank JWKS đã được mở rộng thành ma trận từng field
  và từng dạng rỗng, có và không static token. Toàn bộ nhóm OAuth rỗng được kiểm
  riêng cho no-auth, static-only và resource-only.

## Gate local sau khi sửa

- Auth regression:
  `deno test --config deno.nojsr.json --sloppy-imports --frozen --allow-all src/auth/config_test.ts src/auth/composite-provider_test.ts src/auth/caller-identity_test.ts`
  - Exit 0: `79 passed | 0 failed`.
- Type check:
  `deno check --config deno.nojsr.json --sloppy-imports --frozen mod.ts server.ts`
  - Exit 0.
- Full suite:
  `deno test --config deno.nojsr.json --sloppy-imports --frozen --allow-all src/`
  - Exit 0: `805 passed | 0 failed | 4 ignored`.
- Lint: `deno lint --config deno.nojsr.json`
  - Exit 0: `Checked 191 files`.
- Format: `deno fmt --check --config deno.nojsr.json --ignore=.nojsr-vendor/`
  - Exit 0: `Checked 210 files`.
- UI và Node bundle: `cd src/ui && node build-all.mjs`, sau đó
  `bash scripts/build-node.sh`
  - Exit 0; đủ 7 viewer.
  - Bundle `dist-node/bin/hvgerp-mcp.mjs` được tạo thành công, kích thước khoảng
    1.8 MB.

### Pitfall khi chạy gate local

- Không chạy full suite song song với UI build. `viewer_handshake_test.ts` đọc
  bundle trong lúc build có thể chỉ thấy một phần trong 7 viewer; kết quả
  `804 passed | 1 failed` từ lần chạy race đó không phải lỗi source và không
  được tính là gate.
- Không dùng `deno task ui:build` cùng config workaround. Deno task đọc
  `deno.json` mặc định và đã đổi local lock từ SHA `f32268...882a` sang
  `374260...119`, khiến các lệnh `--frozen` sau đó từ chối lock out-of-date.
- Lock đã được phục hồi bằng patch về đúng byte từ bản đã duyệt. UI được build
  tuần tự bằng `cd src/ui && node build-all.mjs`; auth suite và full suite chỉ
  chạy sau khi đủ 7 viewer. SHA lock vẫn là `f32268...882a` sau từng nhóm lệnh.

## Workaround integrity

- `deno.lock` trước và sau gate có SHA-256
  `f32268af50c10ba06223c9a0b7f2d7092555ffa90172cd573ecf8d3feb2d882a`.
- Vendor `@casys/mcp-server@0.25.0` byte-identical với Deno npm cache.
- `deno.nojsr.json`, `deno.lock`, `.nojsr-vendor/`, `src/ui/dist/` và
  `dist-node/` là artifact local hoặc generated, không được commit.

## Gate còn chờ

CI JSR thật chưa chạy. Cần dispatch workflow `Test` sau khi có chỉ thị push hoặc
dispatch phù hợp; lượt thực thi này không được phép push hay chạy GitHub
workflow.
