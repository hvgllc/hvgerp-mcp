# Kế hoạch 021: Khóa đầu vào dependency của bản build

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 021 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 21; loại: `dx`.
- Ưu tiên: P2; công sức: L; rủi ro sửa: HIGH.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

deno.lock bị bỏ qua và Node build tạo workspace mới rồi npm install các khoảng
phiên bản. Cùng commit chưa đủ để tái lập graph dependency. Cần lockfile được
theo dõi cho cả đường Deno và Node, giữ nguyên phiên bản đã được chấp thuận.

## Hiện trạng và chứng cứ

`.gitignore:1`:

<!-- evidence: .gitignore -->

```text
node_modules/
deno.lock
dist-node/
```

`scripts/build-node.sh:65`:

<!-- evidence: scripts/build-node.sh -->

```json
"devDependencies": {
  "esbuild": "^0.25.12",
  "tsx": "^4.20.6",
  "typescript": "^5.9.2"
},
```

`scripts/build-node.sh:80`:

<!-- evidence: scripts/build-node.sh -->

```bash
pushd "$DIST_DIR" >/dev/null
npm install --no-fund --no-audit
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

- `.gitignore`
- `deno.lock` (tạo mới)
- `scripts/build-node.sh`
- `scripts/node-build/package.json` (tạo mới)
- `scripts/node-build/package-lock.json` (tạo mới)
- `scripts/release-check.sh`
- `.github/workflows/publish.yml`
- `CONTRIBUTING.md`
- `scripts/verify-reproducible-build.mjs` (tạo mới)
- `plans/evidence/021/` (tạo mới)
- `plans/README.md`
- `plans/evidence/021.md`

Ngoài phạm vi: Không nâng dependency, không bỏ UI package-lock.json, không chạy
npm publish, không đổi runtime baseline hoặc sửa generated bundle bằng tay.
Không sửa dữ liệu production, credential, `execution-notes.md` ở gốc; không bump
version hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh;
phần giải thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- .gitignore deno.lock scripts/build-node.sh scripts/node-build/package.json scripts/node-build/package-lock.json scripts/release-check.sh .github/workflows/publish.yml CONTRIBUTING.md scripts/verify-reproducible-build.mjs`
và
`git diff -- .gitignore deno.lock scripts/build-node.sh scripts/node-build/package.json scripts/node-build/package-lock.json scripts/release-check.sh .github/workflows/publish.yml CONTRIBUTING.md scripts/verify-reproducible-build.mjs`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/021-reproducible-build-inputs`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`build: lock dependency graphs for release builds`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                        |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| Test trọng tâm    | `bash -n scripts/build-node.sh && bash -n scripts/release-check.sh`        | exit 0; hai script hợp lệ về cú pháp, chưa kiểm hành vi |
| Kiểu server       | `deno check mod.ts server.ts`                                              | exit 0                                                  |
| Test hồi quy      | `deno test --allow-all src/`                                               | exit 0                                                  |
| Lint              | `deno lint`                                                                | exit 0                                                  |
| Format            | `deno fmt --check`                                                         | exit 0                                                  |
| UI và Node bundle | `deno task ui:install && deno task ui:build && bash scripts/build-node.sh` | exit 0; đủ 7 viewer; kiểm tra bundle như bước cuối      |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Chốt graph đang được chấp thuận

Đọc import map, UI lock và graph Node đã có nếu tồn tại. Lập bảng
package/version/resolved/integrity cho đường build hiện tại trong evidence021.
Không dùng latest để khởi tạo lock. Nếu chưa có graph đủ chứng cứ, dừng xin chấp
thuận các phiên bản chính xác cần khóa. Ghi nhận graph JSR và npm có thể khác
cách đóng gói, không mặc định byte bằng nhau.

**Kiểm tra:**
`git ls-files deno.lock src/ui/package-lock.json && git check-ignore deno.lock`
→ baseline: UI lock được theo dõi, deno.lock đang bị ignore; bảng phiên bản có
nguồn hoặc mục này bị chặn rõ.

### Bước 2: Dùng lockfile trong đường build mặc định

Bỏ ignore deno.lock, tạo lock bằng graph đã chốt. Tạo
scripts/node-build/package.json cùng lock cho build-time dependencies và
@casys/mcp-server. Build copy hai file vào workspace trung gian rồi npm ci,
không npm install giải khoảng phiên bản. Metadata npm phát hành vẫn lấy từ
deno.json như hiện tại; không vô tình xuất package build nội bộ.
MCP_SERVER_OVERRIDE vẫn là nhánh thử nghiệm được ghi rõ không tái lập, không
được dùng trong Publish chuẩn. CI kiểm lock frozen đúng CLI Deno đang hỗ trợ,
không đoán flag.

**Kiểm tra:**
`bash -n scripts/build-node.sh && bash -n scripts/release-check.sh` → exit 0;
diff chỉ đổi cơ chế lấy dependency, không đổi phiên bản đã chốt.

### Bước 3: Tạo và chạy gate tái lập độc lập

Tạo scripts/verify-reproducible-build.mjs, CLI --node <đường dẫn binary> tùy
chọn, mặc định process.execPath; kiểm version của binary được chọn là Node20
hoặc22, khác thì exit1 và hướng dẫn chọn binary có sẵn, không tự tải. Script tạo
hai thư mục tạm bằng mkdtemp, copy snapshot source hiện tại kể cả sửa chưa
commit: allowlist src/, scripts/, deno.json, deno.lock, server.ts, mod.ts,
README.md, LICENSE nếu có; loại node_modules, src/ui/dist, .env*, .git,
dist-node và mọi symlink thoát repo. Không dùng git archive HEAD vì sẽ bỏ sửa
chưa commit. Trong mỗi workspace chạy npm ci cho UI, build7viewer, bash
scripts/build-node.sh; thu npm ls --all --json trước và sau build. Chuẩn hóa
đường dẫn tuyệt đối, so tên/version/resolved/integrity từ lock và graph, so
SHA256 bundle và npm pack --dry-run --json file list ở dist-node/bin. Hash khác
phải fail, không tự bỏ trường để lách. Dùng binary Node đã chọn chạy bundle
stdio: môi trường allowlist tối thiểu, tắt cache warming, URL loopback không có
ERP và credential giả; gửi initialize, notifications/initialized, tools/list và
resources/list, kiểm JSON-RPC responses, version từ manifest, đúng7resource
viewer, không gọi tool ERP. Timeout5giây và cleanup child bắt buộc. Script in vị
trí evidence/temporary roots, không xóa worktree user; chỉ cleanup đúng thư mục
do nó vừa tạo sau khi lưu báo cáo. Thêm --self-test với fixture graph bằng/khác,
hash khác và runtime không hỗ trợ để chứng minh gate có thể fail. release:check
vẫn là gate một build riêng, không gọi nó là bằng chứng hai build.

**Kiểm tra:**
`node scripts/verify-reproducible-build.mjs --self-test && node scripts/verify-reproducible-build.mjs`
→ self-test đạt; gate chính exit0 với hai graph/hash/file list giống nhau và
smoke20/22 đạt, hoặc BLOCKED khi thiếu binary20/22; release:check chạy riêng
cũng phải đạt.

## Kiểm thử

- Lock không khớp manifest phải làm build thất bại.
- Cùng source/lock hai build có graph giống nhau; không tải phiên bản mới do
  khoảng semver.
- Normal Publish không nhận override; đường override vẫn phục vụ kiểm thử có
  đánh dấu.
- npm pack không đưa host testing007 hoặc build manifests nội bộ vào package.
- Helper --self-test bắt graph/hash khác và runtime26; không dùng successful
  single build thay so sánh hai build.

## Tiêu chí hoàn tất

- [ ] Deno và Node build đều dùng lock được theo dõi.
- [ ] Hai build sạch và smoke runtime20/22 có chứng cứ; release:check đạt.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/021.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Cần chọn hoặc nâng một phiên bản chưa được chấp thuận.
- Thiếu mạng/runtime để xác minh bundle hoặc chưa giải thích được graph khác
  nhau.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Cập nhật dependency sau này phải có phê duyệt và diff lock riêng; release-check
phải phát hiện manifest/lock drift.
