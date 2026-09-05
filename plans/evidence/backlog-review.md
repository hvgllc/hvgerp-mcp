# Xử lý Codex finding của PR 25

## Phạm vi

- Review `5119802375`, HEAD trước sửa
  `53029141072a7772d6ce5299b57b710a7a21536b`.
- Chỉ sửa kế hoạch, manifest, validator, test validator và evidence dưới plans.
  Không sửa source ứng dụng, nâng dependency, gọi ERP hoặc tác động production.
- PR: https://github.com/hvgllc/hvgerp-mcp/pull/25

## Regression trước sửa

Chạy `node --test plans/test-validator.mjs` trên validator và kế hoạch chưa sửa:
exit 1, 27 ca, 3 đạt và 24 assertion thất bại. Phần lớn thất bại vì validator
nhận hiện vật không hợp lệ hoặc thiếu nội dung kế hoạch. Hai ca kiểm
drift/source sai đã bị validator cũ từ chối nhưng không khớp diagnostic mới;
không tính hai ca đó là phát hiện hành vi mới. Không có lỗi import hay thiếu
Git.

## Kết quả từng finding

| Finding ID | Ca đỏ đã xác minh                                                                            | Cách xử lý và ca xanh                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3939464494 | 007 không có glob include/exclude đúng trong backtick                                        | Sửa thành `src/**/*.ts`, `src/**/*.tsx`, `**/*_test.ts`; assertion contract kế hoạch đạt                                                                                    |
| 3939464495 | DONE 024 còn checkbox trống hoặc bỏ toàn bộ checklist vẫn exit 0                             | DONE bắt buộc checklist trong đúng mục Tiêu chí hoàn tất và mọi ô checked; checklist ngoài mục không bị tính; tick 024 theo review/merge có thật, 001/004 đã checked        |
| 3939464496 | NOT APPROVED, do not APPROVE, REVISE, BLOCK hoặc lời kể APPROVE vẫn được nhận                | Dùng field review_verdict duy nhất trong frontmatter đầu file, giá trị phải đúng APPROVE; mọi negative/absence/duplicate đều bị từ chối                                     |
| 3939464498 | 006 IN_PROGRESS khi 005 TODO không bị chặn; DONE không có diagnostic prerequisite            | IN_PROGRESS/DONE yêu cầu mọi dependency DONE, giữ gate DAG độc lập                                                                                                          |
| 3939464499 | Thiếu sourceRef hoặc Git object sai bị bỏ qua; fixture baseline mới bị ép mốc cũ             | sourceRef riêng từng record luôn được đọc bằng Git, độc lập trạng thái; fixture refresh 001 sang 013a1cf rồi TODO và DONE đều giữ baseline mới, ref không đọc được fail     |
| 3939464500 | Kế hoạch 021 chỉ chọn một runtime và mặc định Node hiện tại                                  | Bắt buộc hai path --node20/--node22, kiểm đúng major riêng, bốn smoke cho hai bundle x hai runtime, không tự tải binary                                                     |
| 3939464502 | Sales Invoice/SalesInvoice, hai space, ranh giới token và template literal thay đổi vẫn pass | So đúng các dòng source và fenced excerpt, không strip whitespace; migrate snippet sang source nguyên văn với marker bảo toàn format; mọi mutation literal/token bị từ chối |
| 3939464503 | Ẩn bản lưu executor mà nested evidence còn link tới vẫn pass                                 | Duyệt Markdown đệ quy, resolve link theo thư mục chứa file; nested missing link fail và link hợp lệ pass                                                                    |
| 3939464506 | 011 không yêu cầu build Dockerfile.shim, provenance hoặc container smoke thật                | Thêm bước build gắn VCS_REF, kiểm label/image ID và fixture trong container dùng network namespace cô lập; thiếu Docker là BLOCKED                                          |

Frontmatter mới ở evidence 001/004/024 chỉ biểu diễn lại kết luận review thật đã
ghi trong chính các file đó, không tạo approval mới bằng fixture. Bản lưu
executor 001 không bị sửa và vẫn khớp blob gốc. Các fixture negative chỉ thay
nội dung đọc trong bộ nhớ, không ghi dữ liệu review giả vào backlog.

## Kiến trúc và bảo toàn source

Mỗi record manifest có `sourceRef`, `path`, `line`, `code`. Baseline ban đầu
được lấy từ commit audit d2c5305; mỗi record được kiểm với Git source thật.
TODO/IN_PROGRESS còn kiểm source hiện tại cùng vị trí dòng. Mốc soạn không còn
quyết định nguồn đọc hoặc buộc mọi kế hoạch chứa chuỗi d2c5305.

Migration chỉ chép nguyên dòng Git đã kiểm, không dùng parser tự viết để xóa
whitespace. Khi Deno fmt tự bỏ indentation đầu fenced text, validator đã báo
excerpt mismatch. Đã thêm deno-fmt-ignore chỉ trước các snippet; formatter không
thay chúng nhưng validator vẫn kiểm exact text. Không nới điều kiện so.

007/011/021 chỉ được cập nhật cách kiểm chứng trong kế hoạch. Chưa chạy browser
typecheck thay cho executor 007, chưa triển khai fixture Docker 011 và chưa chạy
build/runtime 021 trong đợt này. Test contract của tài liệu không phải bằng
chứng implementation hoặc môi trường thật đã đạt.

## Gate cuối

Toàn bộ chín finding trong bảng được sửa tại commit
`3fdf65abad747ae0facdccb41b1e5118ba76e640`. Sau đó tích hợp main
`c1e74851077a1aff262c13116ce1d8f448302234` qua merge
`f2459126fc5a4b1ebead23a8eee0cd64154114f5`, không sửa source ngoài merge.

Đã chạy lại trên nền mới sau khi cập nhật 003 DONE từ review/CI/merge thật:

- `node plans/validate-plans.mjs`: exit 0, đủ 25 kế hoạch.
- `node --test plans/test-validator.mjs`: exit 0, 29 passed, 0 failed; gồm 27 ca
  của vòng đỏ cùng hai control giữ lại từ validator trước.
- `deno fmt --check plans/`: exit 0, 40 file.
- `deno lint plans/validate-plans.mjs plans/test-validator.mjs`: exit 0, 2
  script.
- `git diff --check`: exit 0.
- Diff source nhánh backlog so với main c1e7485 rỗng. Test ứng dụng trên nền
  tích hợp cuối sẽ do parent chạy lại, không suy ra từ 29 test validator.

PR vẫn cần Codex review sạch trên HEAD mới và CI đúng HEAD, không lấy gate tài
liệu local thay CI ứng dụng. Chưa push hoặc trả lời review trong lượt executor.

## Review bổ sung: nguồn build đã stage

Reviewer xác nhận `git diff --exit-code -- <paths>` không bắt thay đổi đã stage.
Bổ sung assertion contract yêu cầu chính lệnh
`git diff --exit-code HEAD -- shim.ts src/compat/legacy-shim.ts Dockerfile.shim`:
trước sửa kế hoạch, test riêng exit 1 vì thiếu HEAD; sau sửa phải exit 0. Lệnh
mới so working tree với commit, bao gồm staged và unstaged. Đây là kiểm contract
kế hoạch, không phải tuyên bố đã chạy image shim hoặc fixture Git staging.

Sau sửa: test validator 30/30, validator 25/25, format 40 file, lint hai script
với config local và diff check đều exit 0. SHA lock vẫn nguyên sau các gate này.

## Workaround local của nhánh backlog

Parent chạy Deno gate nhưng thiếu `deno.nojsr.json`, nên lần đó dừng trước khi
kiểm source. Đã đọc lại hướng dẫn workaround được duyệt và tạo artifact ignored
trong đúng worktree backlog, không tải hoặc nâng dependency:

- `deno.nojsr.json`: lấy config hiện tại, chỉ thay imports; Node deepEqual sau
  bỏ imports đạt.
- Vendor 58 file từ npm cache @casys/mcp-server 0.25.0, nằm ngoài node_modules;
  chép text bằng apply_patch, `diff -qr` với cache không có khác biệt.
- Lockfile từ donor worktree trước, SHA-256 đúng
  `f32268af50c10ba06223c9a0b7f2d7092555ffa90172cd573ecf8d3feb2d882a`.
- `git check-ignore -v` xác nhận cả config, vendor và lock được ignore; không
  thay manifest hoặc dependency tracked.
- Không chạy build/test ứng dụng trong lúc parent build UI. Parent tiếp tục gate
  Deno bằng config local và --sloppy-imports --frozen; CI JSR thật vẫn bắt buộc
  trên HEAD cuối.
