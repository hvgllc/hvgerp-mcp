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

## Review 5120105157: sáu khoảng trống còn lại

Đọc nguyên văn sáu finding trên HEAD `1535fe8`. Codex viện dẫn đúng hai rule
trong plans/AGENTS.md cho năm finding validator; đây là bằng chứng rule đã giúp
chỉ ra gap còn sót, không phải lý do miễn finding. Giữ nguyên rule hẹp, không
thêm rule rộng hoặc tuyên bố mọi khoảng trống đã hết trước review tiếp.

- `3939716577`: bổ sung README.md, docs/coverage.md, docs/architecture.md vào
  scope/manifest/diff commands/checklist 015. Catalog phải đếm registry thực lúc
  execute và tăng đúng một tool inventory, không chép số cũ 134/9.
- `3939716583`: bare/copied APPROVE, reviewed_commit sai/trùng/không đọc được bị
  từ chối. Parent duyệt binding plan_id + reviewed_commit + completed_commit
  thật; report blobs lấy đúng path NNN ở Git lịch sử. Sáu cặp final HEAD/merge
  đã đo trước code: toàn scope 001/003/004/007/008/024 lần lượt 3/5/2/20/6/1
  object khớp, kể cả CSV/PNG/trace. Không miễn plans. Mốc review độc lập gốc vẫn
  giữ trong narrative; metadata reviewed_commit chỉ HEAD cuối đã được Codex xác
  nhận sạch và CI thật được báo cáo. Không tạo revision hoặc verdict mới.
  Source/doc/artifact cùng object giữa reviewed/completed; artifact hiện tại
  trong scope plans còn so Git blob byte thật. Gate không xác thực danh tính
  reviewer hoặc CI offline.
- `3939716588`: chỉ đọc status từ dòng metadata Mốc soạn trong mục quy định;
  toàn plan có đúng một khai báo. Duplicate hợp lệ/malformed hoặc prose ngoài
  metadata không thể thay status điều khiển gate.
- `3939716594`: scope existing phải có Git tree membership trong HEAD, đúng
  blob/tree, mode và path boundary; kiểm loại file/dir trong working tree.
  Placeholder untracked hay thư mục mang tên file bị chặn. newFiles hoặc
  prerequisite-created vẫn được miễn đúng khai báo, kể cả root chưa nhận source
  của dependency. Lỗi đọc Git là failure, không fallback existsSync.
- `3939716598`: mỗi row ID README có đúng một link đúng manifest file, không chỉ
  tìm link toàn trang; hoán đổi 005/006 hoặc duplicate row bị chặn.
- `3939716604`: STALE chỉ miễn current drift khi có đúng một stale_reason là
  JSON string không rỗng trong metadata. Thiếu/rỗng/trùng/sai kiểu/sai vị trí bị
  chặn; historical source vẫn kiểm kể cả khi lý do hợp lệ.

Red đầu: 72 test, 52 pass, 20 fail đúng assertion của sáu lớp. Sau sửa 72/72
xanh. Bổ sung chín regression về object type, provenance report, source object
khác giữa revision, byte CSV/PNG, lỗi Git tree, prerequisite thiếu ở Git HEAD và
reason sai kiểu/vị trí: tổng 81/81 xanh. Fixture chỉ đổi dữ liệu đọc trong bộ
nhớ, không sửa artifact, source hoặc Git history. Các ca chủ ý hợp lệ gồm STALE
có lý do, docs-only/squash với blob khớp, newFiles/dependency-created; ghi chú
unrelated vẫn qua. Các mốc này chưa thay review fresh của delta mới.

Delta sáu finding đã commit local `6929657`, sau đó tích hợp main 009 bằng merge
`856784f` từ `99b1fa319590e60730faabdb033a5b48a44e1862`. Validator ngay sau
merge đỏ bốn snippet: hai của 009 đã được sửa và hai vị trí trong 016. Đọc toàn
evidence 009, so Git object scope 10 path giữa final HEAD 306a8ae và merge:
khớp, tree cùng d731bed. 009 DONE theo PR30/CI/Codex thật ghi tại
[009.md](009.md); binding dùng đúng report snapshot lịch sử. Scope host.ts và
ghi chú trước execute từ root được đưa vào plan/manifest backlog, không ghi
root.

Đọc requestBoardRefresh/processQueue xác nhận lỗi 016 vẫn nguyên byte, chỉ
chuyển dòng 1127/1224 sang 1131/1228. Refresh hai sourceRef thành 99b1fa3 và
citation tương ứng, không miễn drift hoặc đổi tiêu chí. 017 không drift nên giữ
baseline cũ. 005 và 011 không được đánh DONE trong lượt này.

Gate bản tích hợp: validator 25/25, regression 81/81, format 51 file, lint hai
script và diff check exit 0; source ngoài plans bằng main 99b1fa3. Không chạy
app build, ERPNext, push hoặc reply. Root chưa nhận delta sáu
finding/integration vì parent yêu cầu chờ fresh review; khi sync phải giữ
005/011 IN_PROGRESS, 002 permission và journal mới, cùng baseline 016/022 của
source local d2c5305.

## Đồng bộ chọn lọc sau review 0af23a9

Reviewer độc lập APPROVE commit `0af23a9263ae12b9465b7b5263176eadac545439`.
Parent đã đọc toàn delta và tự chạy validator 25/25, regression 81/81, format 51
file, lint hai script, diff check và so source ngoài plans với main
`99b1fa319590e60730faabdb033a5b48a44e1862`: đều đạt. Approval này áp dụng
revision đó, không tự chấp thuận delta quản trị tiến độ tiếp theo.

Đồng bộ root chỉ các hiện vật đã review: validator/test, binding evidence
001/003/004/007/008/024, kế hoạch/evidence 009 cùng 7 PNG, 2 JSON và script kiểm
host, catalog scope của 015 và hướng dẫn index. Source root vẫn d2c5305; 016/022
giữ sourceRef, line và fenced excerpt riêng của root, không chép baseline mới
của backlog. Giữ nguyên quyền/thiết kế 002 và mọi ghi chú có sẵn trong journal.
Không sửa ba file người dùng ngoài plans hoặc nhận source các nhánh chưa merge.

005, 010, 011 và 017 đang IN_PROGRESS, không phải DONE. Sao chép ghi chú
preflight/chính sách 005/010/011 từ root và ghi chú 017 đã được parent duyệt từ
worktree executor. Scope 005 giữ fixture src/client_test.ts; 011 dùng thư mục
plans/evidence/011/ chứa container-smoke.ts; 017 thêm host.ts chỉ dispatch
malformed-payload. Không giảm tiêu chí hoặc dùng fixture để che lỗi viewer.

Đã đọc evidence executor 005 và 011 làm nguồn tiến độ. 011 có image thật,
revision label đã đối chiếu source, smoke 32 ca/452 assertion và review độc lập
local; các hiện vật implementation chưa được nhập vào backlog. Parent xác nhận
CI [33950610743](https://github.com/hvgllc/hvgerp-mcp/actions/runs/33950610743)
thành công đúng HEAD `0eced8c`: 960 passed, 0 failed, 4 ignored, release-check
OK và JSR 0.25.0. [PR29](https://github.com/hvgllc/hvgerp-mcp/pull/29) đã reply
hai finding tại 3939765479/3939765516, đang chờ review mới, không dùng review
b896576 cũ. CI
[33950670879](https://github.com/hvgllc/hvgerp-mcp/actions/runs/33950670879)
thành công đúng HEAD `620d925`: 942 passed, 0 failed, 4 ignored, release-check
OK và JSR 0.25.0. [PR31](https://github.com/hvgllc/hvgerp-mcp/pull/31) có
trigger 5550065503 lúc 06:46:00Z. Review 5120223946 lúc 06:52:46Z đúng HEAD
620d925 còn hai finding hợp lệ: 3939783865 về response 304 của local auth probe
không được mang body, và 3939783866 về envelope thiếu id/jsonrpc không phải
notification hợp lệ, cần giữ Invalid Request. Parent đã đối chiếu code; đang chờ
executor sửa, chưa merge. Lượt quản trị plans này không sửa source 011.

009 DONE theo [PR30](https://github.com/hvgllc/hvgerp-mcp/pull/30), merge lúc
2026-09-05T06:31:28Z tại `99b1fa319590e60730faabdb033a5b48a44e1862`. HEAD
`306a8aea336dad45697d9c670b784ed201468687` có
[CI 33949707596](https://github.com/hvgllc/hvgerp-mcp/actions/runs/33949707596)
thành công: 899 passed, 0 failed, 4 ignored, release preflight OK và JSR 0.25.0.
Codex clean comment 5549973097 đúng HEAD, findings_error false, findings rỗng,
review threads 0; tree HEAD bằng tree merge
`d731bed844f689d2bb3a429e2cebf877f82b49c3`. Chi tiết binding và giới hạn ở
[evidence/009.md](009.md).

Tổng trạng thái sau đồng bộ: 7 DONE, 1 BLOCKED (002), 4 IN_PROGRESS (005, 010,
011, 017), 13 TODO. Việc IN_PROGRESS phản ánh executor đã bắt đầu trong worktree
riêng, không tuyên bố implementation đã có ở source root/backlog.

Scope 010 được parent mở hẹp thêm `src/tools/kanban_test.ts`: full suite 944
passed, 3 failed, 4 ignored do ba happy-path fixture Task/Opportunity/Issue
thiếu modified. Chỉ sửa ba fixture và assertion skipCache/PUT modified, không
đổi handler hoặc mock chung. Kế hoạch, manifest và diff commands root/backlog đã
ghi cùng phạm vi; chưa nhập source executor hoặc đánh DONE.

Gate sau đồng bộ: backlog validator 25/25, regression 81/81, format 51 file,
lint hai script và diff check đều đạt; source ngoài plans vẫn bằng main 99b1fa3.
Root validator 25/25, format 52 file và lint hai script đạt. Root không chạy
regression cần source mới, không chạy app build/test hoặc install. Đã kiểm hash
các file bảo vệ không đổi; journal và report root giữ nguyên prefix nội dung
trước lượt này. So sâu manifest root chỉ đổi record 010/011/015/017; 005/009 và
baseline 016/022 giữ nguyên. Mười artifact 009, kể cả bảy PNG, khớp byte giữa
backlog và root. Delta quản trị này chỉ ở plans, commit local do agent quản trị
tạo; push/review tiếp do parent quyết định.

Reviewer độc lập APPROVE delta quản trị tại
`dbbf2c28aa5c811171436c81877fcae41eeb2e17`, xác nhận tám file plans không giảm
tiêu chí, scope mở đúng phần đã duyệt, trạng thái/phụ thuộc và baseline riêng
root/backlog được giữ. Reviewer tự chạy validator 25/25, format 51 file và diff
check đạt. Parent đọc toàn delta và tự chạy lại validator 25/25, regression
81/81, format 51 file, lint hai script, diff check và so source ngoài plans với
main 99b1fa3: đều exit 0. Root validator cũng đạt, source vẫn d2c5305. Phần thêm
này chỉ lưu review/gate; CI và Codex review tiếp theo phải kiểm HEAD được push.

## Review 5120263910: giữ provenance trong clone sạch

Finding
[3939821509](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3939821509)
trên HEAD `24425057594124b5b8485c900e555c66834c342a` hợp lệ. Agent và parent độc
lập tái hiện bằng clone local một nhánh `--no-local --no-tags`: validator exit
1, thiếu sáu reviewed HEAD và từ chối đủ bảy DONE 001/003/004/007/008/009/024.
SourceRef và completed_commit đều reachable; lỗi không nằm ở snippet hoặc
verdict. Không sửa validator để bỏ lỗi Git.

Trước sửa, tự so từng scope cùng report snapshot: không mismatch ở bảy kế hoạch.
Toàn tree reviewed/completed cũng khớp ở cả sáu cặp revision khác nhau. Không
tạo object giả, đổi metadata approval hoặc tự gắn review cho merge chưa được
review. Các SHA thật được giữ bằng sáu merge `-s ours`, mỗi lần assert tree
không đổi và `git merge-base --is-ancestor reviewed HEAD` exit 0:

| Reviewed HEAD                            | Provenance merge                         |
| ---------------------------------------- | ---------------------------------------- |
| bb78ace761b7ae9b26900c8c80faad699a9adfa6 | 11c4e5555e4483948821640de9c4d2f017beafca |
| ecc1b69d7d0f3c7a3310a5696097e2497b482a29 | 72a3a9a2d05a66ecaa9f2e8e4e27df952126c3cf |
| 0c0d93c380220e36da53fafdc55841b568a277ef | 99ceadf2894b022b3b4bc2ebbda8401e95ec8df4 |
| 1aae3db9532ab6af2d332849e20c374d75984c6b | bb1d3cb9a6d1fbc5ef0cb721d10b49273508e288 |
| 9fb89c707dc7b2478cfa98e40ba6fbd678907b4a | 82d3bb32c15701c398991200e20bdf7b6d175c0e |
| 306a8aea336dad45697d9c670b784ed201468687 | 3d5b4997a3c46e8590c8df350eb66406395ac487 |

Main `341cba437dba69348b6e11e2c6f599480d5fc212` được nhận trước đó bằng merge
`728dc8dd614a0ad6b730ae4f640acd821bc3ac09`. Cả sáu provenance merge giữ tree
`3690708817a2fe1d0558b28d73de8e93c9a4c3ca` của lượt tích hợp này. Source ngoài
plans bằng main 341cba4; không nhận source các nhánh chưa merge.

010 DONE theo [PR32](https://github.com/hvgllc/hvgerp-mcp/pull/32). Reviewed
HEAD fa8df34046878143c2ea71d0c52392adb8885879 đã là parent của merge 341cba4,
nên reachable sẵn, không cần provenance merge bổ sung. Scope chín path cùng
report blob ca93ebc228f4358849ecadc10a71526d70be5efc khớp ở HEAD/merge; tree
cùng 38de6eaf493bfa52311927eb79f64f5301b5c532. CI
[33951342340](https://github.com/hvgllc/hvgerp-mcp/actions/runs/33951342340) 947
passed, 0 failed, 4 ignored; release-check gốc OK, JSR 0.25.0. Clean comment
5550181076 lúc 07:08:24Z đúng HEAD, findings_error false, findings rỗng,
threads 0. Merge lúc 07:13:47Z. Giữ mốc independent APPROVE source c261592 trong
[010.md](010.md), bổ sung binding từ evidence thật.

Validator ngay sau nhận source main đỏ đúng hai snippet 010 còn IN_PROGRESS;
chuyển DONE theo chứng cứ thật, giữ baseline lịch sử, không bỏ drift. Regression
current-source cũ gắn 010 cần đổi tiền đề: chọn kế hoạch TODO thật rồi chỉ sửa
đúng dòng current source trong bộ nhớ, không dùng DONE để kỳ vọng drift.

Thêm plans/test-history.mjs kiểm Git thực, không chỉ VM fixture: clean clone của
HEAD đã commit phải qua validator và mọi ref cần thiết phải là ancestor. Ca âm
fetch riêng revision 2442505 thật vào repository tạm, rồi clone một nhánh: đúng
sáu object thiếu, 13 diagnostic gồm sáu lỗi Git và bảy lỗi approval. Chạy riêng
ca âm đã đạt đúng nguyên nhân. Gate dọn repository tạm, không sửa source
worktree. Gate xanh của HEAD mới cần chạy sau commit local.

Cập nhật rule provenance hiện có trong plans/AGENTS.md, không thêm rule trùng
hoặc nới validator. README nêu PR25 phải merge commit, checkout shallow cần đầy
đủ history. GitHub API read-only xác nhận allow_merge_commit true.

## Gate sau sửa provenance

Commit local `7f6b1ddc4e3a8707d3fc3b3effafd63e731ce325` đã chạy
`node --test plans/test-history.mjs`: 2 passed, 0 failed, 0 skipped. Ca xanh
clone HEAD một nhánh bằng Git transport local, validator 25/25 và ancestry mọi
sourceRef/reviewed/completed đều đạt; ca âm clone revision thật 2442505 vẫn
thiếu đúng sáu reviewed HEAD và từ chối đủ bảy DONE. Không dùng objects chia sẻ
hoặc nhánh executor để tạo kết quả xanh. Repository tạm của hai test đã được
dọn; source/worktree gốc không bị sửa.

Regression validator 81/81, validator 25/25, format 53 file, lint ba script,
diff check và so source ngoài plans với main 341cba4: đều đạt. Root validator
25/25, format 54 file, lint ba script đạt. Không chạy history gate hoặc
regression phụ thuộc source mới ở root d2c5305. Manifest root giữ nguyên byte;
hash 002/quyền, 005/011/017, 016/022 và ba file người dùng không đổi. Journal
root giữ nguyên prefix nội dung, chỉ append tiến độ/gate. Không có app build,
dependency install, push/reply hoặc merge PR. Delta mới vẫn cần fresh review và
CI do parent quản lý; không dùng APPROVE cũ của 0af23a9 thay thế.

## Sửa REVISE độc lập: fixture drift không phụ thuộc TODO còn lại

Reviewer độc lập phát hiện P2 trong plans/test-validator.mjs trên HEAD
`a5fe5d24f98b173ac3a7064aabeab596a1f65588`: test chọn một TODO từ backlog thật,
nên khi mọi TODO chuyển BLOCKED hợp lệ thì test tự thất bại. Đây là lỗi tiền đề
fixture, không phải lỗi validator hoặc lý do bỏ current-source gate.

Thêm regression trước sửa: trong bộ nhớ, đổi toàn bộ metadata TODO thành BLOCKED
cùng hàng README; assert không còn plan TODO và validator vẫn 25/25. Sau đó gọi
đúng regression current-source cũ. Lệnh
`node --test --test-name-pattern='TODO detects|without TODO' plans/test-validator.mjs`
đỏ đúng nguyên nhân: 1 passed, 1 failed tại assertion
`The fixture requires a TODO plan with current evidence`. Không dùng lỗi Git,
scope hoặc checklist để làm ca đỏ.

Sửa fixture tự đặt kế hoạch 001 thành TODO trong bộ nhớ, đồng bộ index,
checklist và mọi record evidence/fenced excerpt/citation bằng exact text từ Git
HEAD thật. Không đổi trạng thái hoặc report approval thực trên đĩa. Ghép fixture
lên backlog nền sau khi đã đổi hết TODO thành BLOCKED, không tìm TODO sẵn có.
Fixture hợp lệ phải qua validator trước; sau đó chỉ thay một dòng current
source, yêu cầu đúng một diagnostic current source drift của 001. Historical
source vẫn được đọc từ cùng ref Git thật; không skip hoặc giảm assertion.

Lần soạn fixture đầu chỉ thay một record trong khi 001 có hai fenced excerpt,
nên baseline bị từ chối vì count mismatch. Đã sửa đồng bộ toàn bộ
record/excerpt, không coi lỗi soạn này là bằng chứng đỏ của finding. Hai ca
trọng tâm sau sửa đều xanh. Ca nền không TODO, ca TODO tự dựng hợp lệ và ca
current-source sai được kiểm riêng; regression unrelated prose và provenance cũ
vẫn giữ nguyên.

Commit test riêng: `467c74c4fadb92970ae1290f3552289bc6bd39fa`. Sau commit, chạy
`node --test plans/test-validator.mjs plans/test-history.mjs`: 84 passed, 0
failed, 0 skipped, gồm 82 validator regression và hai phép kiểm Git clone thật.
Validator 25/25, format 53 file, lint ba script, diff check đều đạt; source
ngoài plans bằng main 341cba4. Không đổi validator, metadata thật hoặc
history/provenance merge. Root chưa đồng bộ theo chỉ thị chờ review lại; không
sửa source ứng dụng, push, reply hoặc merge PR. Evidence được commit riêng sau
test; delta mới vẫn cần fresh review.

## Fresh review sau sửa fixture

Reviewer độc lập APPROVE HEAD `a1b18e18a8fcca85c62067597b9491fa86b2cd92`, test
source `467c74c4fadb92970ae1290f3552289bc6bd39fa`. Reviewer tự xác minh
validator 25/25, 84 test đạt không bỏ qua, fmt 53 file, lint 3 file, diff sạch
và không có delta ngoài plans so với main 341cba4. Fixture không còn phụ thuộc
TODO thật; không có kế hoạch phụ thuộc 001 nên TODO tổng hợp không tạo lỗi
prerequisite.

Parent đọc đầy đủ delta test/evidence và tự chạy cùng các gate: đều exit 0. Sáu
provenance merge và test clean clone vẫn được giữ; không đổi validator
production hoặc tự bỏ gate. PR25 bắt buộc merge commit để giữ các reviewed
commit trong lịch sử truy cập được từ clean clone, không squash hoặc rebase.
