# Kế hoạch 022: Sửa hướng dẫn release và chính sách hỗ trợ lỗi thời

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 022 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 22; loại: `docs`.
- Ưu tiên: P2; công sức: S; rủi ro sửa: LOW.
- Phụ thuộc: `021`.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

CONTRIBUTING chỉ dẫn sửa version trong server.ts và dispatch Publish thủ công
cho cả hai registry, khác code/workflow hiện tại. SECURITY ghi chỉ 2.x được hỗ
trợ trong khi source mang version3.4.0. Tài liệu cần nói đúng quy trình, không
tự cam kết hỗ trợ phiên bản mới ngoài chính sách hiện có.

## Hiện trạng và chứng cứ

`CONTRIBUTING.md:78`:

<!-- evidence: CONTRIBUTING.md -->

<!-- deno-fmt-ignore -->
```text
1. Update the version in `deno.json` **and** `server.ts` (it lives in both),
   plus `CHANGELOG.md`.
```

`src/version.ts:15`:

<!-- evidence: src/version.ts -->

<!-- deno-fmt-ignore -->
```text
export const SERVER_VERSION = "3.4.0";
```

`.github/workflows/publish.yml:15`:

<!-- evidence: .github/workflows/publish.yml -->

<!-- deno-fmt-ignore -->
```text
  release:
    types: [published]
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

- `CONTRIBUTING.md`
- `SECURITY.md`
- `docs/migration-mcp-spec-2026-07-28.md`
- `plans/README.md`
- `plans/evidence/022.md`

Ngoài phạm vi: Không đổi workflow, code, version, CHANGELOG hoặc chính sách hỗ
trợ bằng quyết định mới; không publish và không suy ra registry latest chỉ từ
source. Không sửa dữ liệu production, credential, `execution-notes.md` ở gốc;
không bump version hay tự nâng dependency. Định danh, chuỗi lỗi và commit bằng
tiếng Anh; phần giải thích tiếng Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- CONTRIBUTING.md SECURITY.md docs/migration-mcp-spec-2026-07-28.md`
và
`git diff -- CONTRIBUTING.md SECURITY.md docs/migration-mcp-spec-2026-07-28.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/022-release-security-documentation`. Không commit, push,
mở PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`docs: align release and security guidance with current policy`.

## Lệnh xác minh

| Mục đích       | Lệnh                                        | Kết quả mong đợi                      |
| -------------- | ------------------------------------------- | ------------------------------------- |
| Test trọng tâm | `deno test --allow-all src/version_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt |
| Kiểu server    | `deno check mod.ts server.ts`               | exit 0                                |
| Test hồi quy   | `deno test --allow-all src/`                | exit 0                                |
| Lint           | `deno lint`                                 | exit 0                                |
| Format         | `deno fmt --check`                          | exit 0                                |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Đối chiếu các tuyên bố với source

Lập bảng trước/sau: version=deno.json+src/version.ts; release published kích
hoạt Publish; JSR opt-in qua vars.PUBLISH_JSR, npm là đường phát hành mặc định.
Kiểm docs/migration-mcp-spec-2026-07-28.md: phân biệt chỉ dẫn migration lịch sử
với hướng dẫn hiện hành, chỉ sửa tuyên bố hiện hành đã sai, không viết lại lịch
sử. SECURITY giữ nguyên chính sách latest published, bỏ bảng major cứng đã lỗi
thời; không tự tuyên bố mọi3.x đều được hỗ trợ.

**Kiểm tra:**
`rg -n 'SERVER_VERSION|PUBLISH_JSR|published' src/version.ts server.ts .github/workflows/publish.yml`
→ bảng đối chiếu trỏ đúng các khai báo hiện tại.

### Bước 2: Sửa hướng dẫn có thể làm theo

CONTRIBUTING yêu cầu chấp thuận version, sửa đúng hai vị trí, release:check,
release/tag được chủ sở hữu cho phép; không dispatch thêm trừ rerun. Phân biệt
source version với version đã lên registry. Ghi lệnh npm view
@hvgllc/hvgerp-mcp@latest version --prefer-online là bước xác nhận của người
release, không thực thi trong kế hoạch docs. SECURITY diễn đạt một chính sách
latest published duy nhất và HTTP auth tùy cấu hình, không hứa auth tự bật.

**Kiểm tra:** `deno fmt --check CONTRIBUTING.md SECURITY.md` → exit 0; đối chiếu
thủ công đủ 5 tuyên bố ở bước1.

### Bước 3: Kiểm links và version gate

Kiểm mọi đường dẫn nội bộ vừa sửa tồn tại; version_test giữ nguyên và chạy đạt
khi dependency có sẵn. Ghi rõ chưa tra registry trực tiếp, không gọi bản source
là latest npm. Giữ quy ước tiếng Anh của các file tài liệu hiện có, không thêm
em dash.

**Kiểm tra:** `deno test --allow-all src/version_test.ts && git diff --check` →
exit 0; diff chỉ là tài liệu được phép.

## Kiểm thử

- Checklist5: vị trí version, trigger release, điều kiện JSR, xác minh registry,
  chính sách hỗ trợ.
- Các relative links của phần sửa phân giải tới file có thật.
- Không đổi version source hoặc tạo cam kết hỗ trợ nhiều major.

## Tiêu chí hoàn tất

- [ ] Hướng dẫn không còn yêu cầu sửa literal version trong server.ts hoặc luôn
      dispatch Publish thủ công.
- [ ] Policy không còn bảng chỉ2.x trái với lời mô tả latest published.
- [ ] Format và version_test đạt hoặc thiếu dependency được ghi là BLOCKED,
      không DONE.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/022.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Muốn cam kết hỗ trợ thêm major hoặc sửa chính sách bảo mật cần quyết định chủ
  sở hữu.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mỗi thay đổi workflow/versioning phải rà soát hướng dẫn release cùng commit.
