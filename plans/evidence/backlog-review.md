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

Parent đã chạy lại trên source tích hợp c1e7485: server check, lint 193 file,
format 249 file, UI build đủ 7 viewer, Node build với framework 0.25.0, node
--check và full suite 847 passed, 0 failed, 4 ignored đều exit 0. Source không
đổi bởi bản sửa provenance 3099afd. Reviewer độc lập APPROVE 3099afd sau khi tự
chạy validator 25/25 và regression 30/30. CI/Codex của HEAD mới vẫn chờ.

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

## Tích hợp 007 đã merge

Nhận source main `0cf6a69463fef96f95512d36dda92ec2ad286f22` bằng merge
`dfedde02cc4f12f52cb53e5b15482298566d02e5`. Không sửa source ứng dụng ngoài
merge hoặc đồng bộ source sang workspace root. Review/CI/merge proof của 007
được bổ sung tại [007.md](007.md), giữ nguyên toàn bộ bằng chứng browser.

Validator ngay sau merge exit 1 với đúng hai diagnostic: 007 tsconfig không còn
ở baseline TODO, và 022 CONTRIBUTING không còn đúng dòng 78. Sau khi 007 DONE từ
bằng chứng thật, record lịch sử của 007 vẫn giữ ref d2c5305. Đọc lại
CONTRIBUTING xác nhận nội dung lỗi release không đổi, chỉ chuyển sang dòng 81;
record 022 cập nhật riêng sourceRef thành 0cf6a69, line 81 và citation tương
ứng. Không thay hoặc thu hẹp tiêu chí 022.

Sau reconcile: validator 25/25, test validator 30/30, format 43 file, lint hai
script với --no-config và diff check đều exit 0. Diff ngoài plans so với main
0cf6a69 rỗng. Gate ứng dụng tích hợp cuối do parent điều phối tiếp; không dùng
test validator thay browser, Deno hoặc CI.

005 không được đánh DONE. Không ghi đè trạng thái IN_PROGRESS hoặc ghi chú
002/005 của parent ở root. Nhánh backlog chưa được push trong lượt này.

## Codex vòng tiếp: review 5119892746

Review trên HEAD `10cb145` của
[PR 25](https://github.com/hvgllc/hvgerp-mcp/pull/25) phát hiện hai lỗi kế
hoạch/validator. Không áp dụng verdict APPROVE của `d00356d` cho delta mới này.

- Finding `3939553020`: glob phải tương đối với `src/ui/tsconfig.json`.
  Assertion đọc include/exclude thực của config đã merge; trước sửa kế hoạch, đỏ
  đúng lỗi thiếu `*-viewer/src/**/*.ts`. Sau sửa, cả năm include và bốn exclude
  xuất hiện nguyên văn trong kế hoạch, kiểm tra xanh. Giữ Deno test excludes và
  giải thích registry thuần được import gián tiếp. Không sửa production
  tsconfig.
- Finding `3939553022`: ba regression riêng kiểm filename trùng, prefix không
  khớp ID và file vật lý bị bỏ khỏi manifest. Fixture chọn hai plan cùng trạng
  thái, thay đồng thời file/evidence để không fail vì status hoặc snippet. Trước
  sửa, cả ba fixture đều được validator chấp nhận sai (exit 0). Sau sửa, từng
  fixture exit 1 với diagnostic đúng guard tương ứng. Validator kiểm uniqueness,
  prefix và đối chiếu tập file theo cả hai chiều; đủ 25 ID không còn thay thế
  cho coverage 25 file.

Kết quả đỏ: 33 test, 29 pass, 4 fail đúng các assertion trên. Kết quả xanh:
33/33 test, validator 25/25. Đây là fixture trong bộ nhớ, không sửa Git history
hoặc dữ liệu thực để tạo phản chứng.

Parent đã xác nhận gate ứng dụng trên `d00356d`, source bằng main `0cf6a69`:
browser tsc và server check exit 0; lint 195 file; format 257 file; UI đủ 7
viewer; Node bundle framework 0.25.0 và node check exit 0; full suite 847
passed, 0 failed, 4 ignored, session 94737 exit 0. Hai sửa đổi mới chỉ nằm trong
plans, không dùng kết quả này thay review/CI đúng HEAD cuối. Root chỉ nhận delta
của 007 và validator/test/báo cáo; giữ trạng thái và ghi chú mới 002, 005, 008,
manifest 022 và nhật ký parent. Chưa push, chưa reply finding trong lượt này.

Gate tài liệu sau sửa: backlog format 43 file, lint hai script, diff check và
đối chiếu source ngoài plans với main 0cf6a69 đều exit 0. Root validator 25/25,
format bốn file chạm và diff check plans exit 0. Full format root còn một dòng
chưa wrap trong ghi chú 005 của parent, nằm ngoài delta này; không tự sửa file
đó. Root source vẫn d2c5305; không chạy regression phụ thuộc source mới ở root.

## Codex vòng tiếp: review 5119983762

Đọc đủ ba comment trên HEAD `9fd274a` bằng GitHub API. Trước sửa, backlog nhận
source main `e09537b25e133c21b2c1915b15937d78c6dd0bbc` bằng merge `7275cb9`.
Validator ngay sau merge chỉ đỏ hai trích đoạn của 008 đã sửa; đối chiếu
evidence APPROVE, CSV/browser, CI và merge proof thật rồi chuyển 008 DONE.
Record lịch sử 008 vẫn giữ d2c5305. Các kế hoạch TODO khác không có drift cần
refresh vì 008.

- Finding
  [3939631487](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3939631487):
  sáu ca thêm/bỏ dependency ở plan, README hoặc manifest được chấp nhận sai
  trước sửa. Ca bỏ manifest prerequisite đồng thời cho 006 IN_PROGRESS không còn
  lách được tài liệu vẫn yêu cầu 005. Sau sửa, parser so cả ba tập ID, không phụ
  thuộc thứ tự, whitespace hoặc backtick. Hai ca thêm/bỏ scope cũng đỏ trước
  sửa, xanh sau guard đồng bộ scope; đây là kiểm thêm invariant cùng lớp, không
  mở rộng source implementation.
- Finding
  [3939631491](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3939631491):
  thay đúng dòng execute trong source hiện tại của BLOCKED 002 trước sửa vẫn
  exit 0. Sau sửa, exit 1 diagnostic current source drift. STALE tường minh cho
  phép current drift nhưng vẫn đọc sourceRef; code lịch sử sai hoặc ref Git
  không đọc được đều bị từ chối riêng. Không dùng lỗi unrelated làm ca đỏ.
- Finding
  [3939631490](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3939631490):
  contract 015 đỏ vì chưa có tool ledger thuộc inventory. Đọc stock_entry_list,
  category filter client và host thật: inventory-only có balance nhưng không có
  doc_list. Kế hoạch mới thêm tool đọc hẹp, item/kho required, fields/filter/
  sort cố định, kiểm client category thật, fixture typed và lỗi rõ. Scope thêm
  inventory/test, client_test, host và CHANGELOG; bỏ operations_test. Không sửa
  schema/nghĩa tool cũ, category filter, version hoặc triển khai source 015.

Đọc schema upstream ERPNext version-15 tại commit
`1a0bf0bf6c4aeaae5acde90c74b186312f49b95c`; link và field thực ghi trong 015.
Sort thời gian/name là lựa chọn request được chốt từ field thực, không nhầm với
sort mặc định modified của DocType. Chưa kiểm schema/permission site người dùng;
executor phải đối chiếu phiên bản mục tiêu, không để fixture định nghĩa ERP.

Kết quả đỏ: 49 test, 39 pass, 10 fail đúng các assertion nêu trên. Sau sửa:
49/49 test và validator 25/25 xanh. Ca thay tool ledger bằng operations bị
contract test từ chối. Các fixture chỉ đổi dữ liệu đọc trong bộ nhớ, không ghi
source hoặc giả review. Chưa dùng verdict cũ làm APPROVE cho delta này.

Theo mục Repeat findings của skill codex-pr-review-loop, thêm đúng hai rule hẹp
tại plans/AGENTS.md, không sửa AGENTS.md gốc của người dùng. Quy tắc được kiểm
local theo ba nhóm: vi phạm source/dep/scope bị từ chối; ngoại lệ STALE với
historical hợp lệ và dependency khác whitespace/order được chấp nhận; ghi chú
trình bày không liên quan vẫn qua. Đây là bằng chứng regression cho invariant,
chưa phải bằng chứng Codex vòng sau đã áp rule đúng. Parent phải đánh giá lại
khi review mới đến, không dùng rule miễn finding hoặc giảm gate.

Gate cuối: backlog validator 25/25, regression 49/49, format 47 file, lint hai
script và diff check đều exit 0; diff source ngoài plans so với main e09537b
rỗng. Root validator 25/25, format toàn plans 48 file và diff check plans exit
0. Không chạy application build/test cùng parent trong lượt này; review/CI fresh
của HEAD mới vẫn cần parent điều phối.

Đồng bộ root chỉ thay record 015 trong manifest, các record khác so sâu giữ
nguyên, gồm 005/009 scope mới và 022 sourceRef d2c5305. Hash tám file bảo vệ
(002, hồ sơ quyền 002, 005, 009, 022 và ba file cá nhân/quy tắc gốc) không đổi;
journal giữ nguyên prefix và chỉ append kết quả. Ghi chú trước execute 008 được
giữ và đưa vào snapshot backlog. Plan/evidence 007 giữ nguyên; CSV/PNG 008 được
copy và cmp byte-identical. Root 6 DONE, 1 BLOCKED, 2 IN_PROGRESS (005, 009), 16
TODO; backlog giữ TODO cho 005/009 vì chưa tích hợp implementation.

Review độc lập mới APPROVE commit `64e1116797c0b049445a85c995d41f6fec663f33`: đã
đọc hai rule mới, toàn delta và ba finding; tự kiểm thêm bảy ca trong bộ nhớ.
Dependency trùng, scope thừa và historical sai bị chặn; file quản trị, đổi thứ
tự scope và ghi chú không liên quan được chấp nhận. Reviewer chạy lại validator
25/25, regression 49/49, format/lint/diff; source ngoài plans bằng main e09537b.
Parent cũng đọc toàn delta và tự chạy các gate tài liệu đạt. Hiệu quả kiểm local
của rule được xác nhận, chưa suy ra Codex vòng tới sẽ áp dụng đúng; cần CI và
review mới trên HEAD được push.
