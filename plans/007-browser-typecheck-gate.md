# Kế hoạch 007: Thiết lập typecheck thực cho mã browser

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 007 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 7; loại: `tests`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: thấp; không nới strict.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

deno check chỉ đi qua server entrypoint; Vite transpile không chứng minh type
safety. tsconfig UI hiện gồm cả Deno tests/server helpers và có lỗi
Recharts/unknown ReactNode thật. Mục tiêu là gate browser xanh kiểm đủ bảy
viewer mà không che lỗi hoặc kiểm nhầm môi trường.

## Hiện trạng và chứng cứ

`src/ui/tsconfig.json:19`:

<!-- evidence: src/ui/tsconfig.json -->

```json
"include": ["**/*.ts", "**/*.tsx"],
"exclude": ["node_modules", "dist"]
```

`deno.json:16`:

<!-- evidence: deno.json -->

```json
"check": "deno check mod.ts server.ts",
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

- `src/ui/tsconfig.json`
- `src/ui/package.json`
- `src/ui/chart-viewer/src/ChartViewer.tsx`
- `src/ui/invoice-viewer/src/components/ItemDetailPanel.tsx`
- `src/ui/stock-viewer/src/components/StockDetailPanel.tsx`
- `src/ui/shared/kanban/interactions.ts`
- `src/ui/shared/kanban/layout.ts`
- `src/ui/shared/kanban/presentation.ts`
- `src/ui/shared/kanban/refresh.ts`
- `src/ui/shared/kanban/state.ts`
- `.github/workflows/test.yml`
- `scripts/release-check.sh`
- `CONTRIBUTING.md`
- `src/ui/testing/host.html` (tạo mới)
- `src/ui/testing/host.ts` (tạo mới)
- `src/ui/testing/fixtures.ts` (tạo mới)
- `src/ui/testing/README.md` (tạo mới)
- `src/ui/vite.test-host.config.mjs` (tạo mới)
- `deno.json`
- `plans/evidence/007/` (tạo mới)
- `plans/README.md`
- `plans/evidence/007.md`

Ngoài phạm vi: không bỏ viewer khỏi check, không đổi strict/skipLibCheck để che
code lỗi, không nâng React/Recharts/Vite/TypeScript hoặc thêm test framework.
Không sửa dữ liệu production, credential, `execution-notes.md` ở gốc; không bump
version hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh;
phần giải thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/ui/tsconfig.json src/ui/package.json src/ui/chart-viewer/src/ChartViewer.tsx src/ui/invoice-viewer/src/components/ItemDetailPanel.tsx src/ui/stock-viewer/src/components/StockDetailPanel.tsx src/ui/shared/kanban/interactions.ts src/ui/shared/kanban/layout.ts src/ui/shared/kanban/presentation.ts src/ui/shared/kanban/refresh.ts src/ui/shared/kanban/state.ts .github/workflows/test.yml scripts/release-check.sh CONTRIBUTING.md src/ui/testing/host.html src/ui/testing/host.ts src/ui/testing/fixtures.ts src/ui/testing/README.md src/ui/vite.test-host.config.mjs deno.json`
và
`git diff -- src/ui/tsconfig.json src/ui/package.json src/ui/chart-viewer/src/ChartViewer.tsx src/ui/invoice-viewer/src/components/ItemDetailPanel.tsx src/ui/stock-viewer/src/components/StockDetailPanel.tsx src/ui/shared/kanban/interactions.ts src/ui/shared/kanban/layout.ts src/ui/shared/kanban/presentation.ts src/ui/shared/kanban/refresh.ts src/ui/shared/kanban/state.ts .github/workflows/test.yml scripts/release-check.sh CONTRIBUTING.md src/ui/testing/host.html src/ui/testing/host.ts src/ui/testing/fixtures.ts src/ui/testing/README.md src/ui/vite.test-host.config.mjs deno.json`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/007-browser-typecheck-gate`. Không commit, push, mở PR
hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`test(ui): enforce browser TypeScript checks`.

## Lệnh xác minh

| Mục đích          | Lệnh                                                                       | Kết quả mong đợi                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Test trọng tâm    | `deno test --allow-all src/ui/`                                            | exit 0; mọi ca trong mục Kiểm thử đạt              |
| Kiểu server       | `deno check mod.ts server.ts`                                              | exit 0                                             |
| Test hồi quy      | `deno test --allow-all src/`                                               | exit 0                                             |
| Lint              | `deno lint`                                                                | exit 0                                             |
| Format            | `deno fmt --check`                                                         | exit 0                                             |
| Kiểu browser      | `npm --prefix src/ui run typecheck`                                        | exit 0 sau khi hoàn tất kế hoạch 007               |
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

### Bước 1: Lưu baseline typecheck và phân loại lỗi

Chạy binary tsc đã cài, phân loại browser production errors với lỗi Deno
tests/server resource helpers. Ghi số lỗi mỗi nhóm và các file. Nếu node_modules
thiếu, chỉ dùng npm ci đúng lockfile khi được phép, không npm install cập nhật
dependency.

**Kiểm tra:** `src/ui/node_modules/.bin/tsc --noEmit -p src/ui/tsconfig.json` →
baseline exit 2; có lỗi Recharts handler/tooltip và unknown ReactNode, không chỉ
lỗi môi trường.

### Bước 2: Tách project browser mà giữ đủ coverage

Include rõ các viewer src/**/*.tsx, src/**/_.ts cùng shared browser modules;
exclude **/__test.ts và các root server resource helpers như mod.ts, viewers.ts,
viewer-resource-paths.ts. Bật allowImportingTsExtensions với noEmit để shared
pure .ts dùng được cả Deno; khai báo alias ~ tương ứng Vite. Chứng minh cả bảy
main.tsx có mặt bằng --listFilesOnly, và Deno test vẫn kiểm shared tests. Thêm
script typecheck trong src/ui/package.json gọi tsc --noEmit -p tsconfig.json.

**Kiểm tra:**
`src/ui/node_modules/.bin/tsc --noEmit -p src/ui/tsconfig.json --listFilesOnly`
→ danh sách có đủ bảy viewer main.tsx; không kéo runtime.deno.ts hoặc Deno test
vào browser project.

### Bước 3: Sửa kiểu thật tại ranh giới UI

Dùng kiểu callback Recharts từ bản đang lock hoặc để inference chính xác, xử lý
undefined trong tooltip/pie label. Chuẩn hóa dữ liệu unknown bằng kiểm kiểu
trước JSX trong ItemDetailPanel/StockDetailPanel; không ép any/ReactNode để qua
check. Nếu gặp lỗi khác trong production browser, ghi cụ thể và mở rộng phạm vi
kế hoạch trước khi sửa.

**Kiểm tra:** `npm --prefix src/ui run typecheck` → exit 0; không thêm
ts-ignore/ts-nocheck hay bỏ file lỗi.

### Bước 4: Nối gate vào kiểm tra và preflight

Workflow Test chạy npm ci trước typecheck rồi build; release-check tương tự
trong khối UI. Giữ workflow_dispatch có chủ đích. CONTRIBUTING ghi lệnh
typecheck UI; chỉ sửa phần kiểm tra UI, mục release thuộc 022. Chạy gates
server, UI build và Node build. Bước kế tiếp cung cấp host local có fixture để
kiểm viewer thật.

**Kiểm tra:** `deno task release:check` → exit 0 với browser typecheck được thực
thi; nếu baseline ngoài scope chặn thì ghi BLOCKED.

### Bước 5: Cung cấp host local cho kiểm thử browser

Không thêm dependency. Tạo testing/host.html (không đặt index.html để build-all
không nhận nhầm viewer thứ tám), host.ts, fixtures.ts và README dưới src/ui.
Vite test-host config root src/ui, bind 127.0.0.1, port 5178 strictPort; thêm
script dev:test-host trong package.json. Dùng AppBridge/PostMessageTransport từ
@modelcontextprotocol/ext-apps/app-bridge có sẵn. Constructor: new
AppBridge(null,{name:'LocalTestHost',version:'0.0.0'},{serverTools:{},logging:{}}).
Đăng ký oncalltool trả fixture hoặc deferred promise; oninitialized gửi
sendToolInput trước sendToolResult. Iframe trỏ /dist/{viewer}/index.html, viewer
chỉ từ registry 7 tên. Fixture giả theo payload type thật; trace
id/args/outcome; nút release/reject để kiểm race, không gọi ERP/đọc env. Có
smoke cho 7 viewer, csv cho Doclist, detail-race/board-race cho Kanban và
initial-error/refresh-error. README ghi URL/reset/release, không dùng timeout
ngẫu nhiên. Typecheck cả host.ts, exclude src/ui/testing/** khỏi deno publish.
Build-all vẫn 7 viewer; Node package không ship testing.

**Kiểm tra:** `deno task ui:build && npm --prefix src/ui run dev:test-host` →
build đủ 7 viewer; server giữ chạy ở
http://127.0.0.1:5178/testing/host.html?viewer=doclist-viewer&scenario=csv;
browser handshake và dữ liệu fixture hiện trong viewer thật.

## Kiểm thử

- ListFilesOnly có bảy entrypoint và shared runtime dùng bởi chúng.
- Recharts callback đúng data shape, value undefined không crash.
- Lệnh typecheck chạy trước build trong workflow/preflight; Deno suite vẫn quét
  tests UI thuần.

## Tiêu chí hoàn tất

- [ ] npm --prefix src/ui run typecheck exit 0 và phủ đủ bảy viewer.
- [ ] Không giảm kiểm tra bằng xóa tests, nới strict hoặc bỏ production module.
- [ ] UI/Node build và tests đạt; evidence ghi danh sách entrypoint thực tế.
- [ ] Host local nạp được 7 viewer build, có trace và các scenario
      CSV/race/error; không ship vào bản phát hành.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/007.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu bản deps cài khác package-lock, cài đúng lock trước khi chẩn đoán; không
  nâng deps.
- Nếu cần dependency mới để kiểm UI, báo lựa chọn thay vì tự thêm.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Viewer mới phải được --listFilesOnly bao phủ. Shared pure modules nên không
import browser globals hoặc server adapters để cả Deno tests và tsc dùng được.
