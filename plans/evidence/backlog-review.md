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

## Review 5120400034: đối chiếu audit và phân loại file mới

Đã đọc nguyên văn hai comment GitHub trên đúng HEAD
`51f8476fabf6139645aad94c161d30175fcbbad0` và truy luồng validator. Cả hai là
FIX. Baseline thực trước sửa: validator 25/25 và 84 test helper/history đạt.

### Finding 3939947561: newFiles phải khớp khai báo trong kế hoạch

Ca đỏ tái hiện đúng ví dụ: chỉ thêm docs/concepts.md của 005 vào newFiles trong
manifest fixture và ẩn file khỏi existsSync. Validator cũ trả exit 0, làm
assertion yêu cầu từ chối thất bại. Không xóa file thật trên đĩa. Bổ sung ca
newFiles ngoài scope, hai chiều phân loại và dependency-created không được vượt
qua phân loại. Kiểm chiều ngược cuối dùng host.ts của 007 đã tracked: bỏ khỏi
newFiles trong manifest nhưng giữ marker trong plan, validator cũ vẫn trả exit
0; validator mới chỉ báo đúng một lỗi classification.

Validator mới yêu cầu newFiles là tập con của scope và bằng tập đường dẫn được
đánh dấu tạo mới trong danh sách Phạm vi và Git. Đọc cả continuation line của
list item; chấp nhận `(tạo mới)` hoặc `(tạo mới; giải thích)`, kể cả line wrap.
Marker trong prose ngoài scope không được coi là khai báo. Kiểm classification
chạy trước các ngoại lệ kiểm file. Không đổi nguyên tắc historical newFiles:
file tạo bởi kế hoạch đã DONE có thể hiện diện trong Git hiện tại; không buộc
file đó phải vắng mặt và không nới provenance của DONE.

Positive controls giữ file mới chưa tồn tại, host.ts lịch sử đã tracked,
prerequisite-created vắng trong Git/current source, marker có giải thích và
prose không liên quan. Helper scopePath trong test cập nhật marker khi tự tạo
fixture newFiles hợp lệ, không sửa metadata thật để làm xanh.

### Finding 3939947563: audit phải khớp giữa plan và manifest

Ca đỏ cuối dùng plan 005 đổi Mục audit từ 5 thành 6, giữ mọi phần khác:
validator cũ vẫn exit 0. Ma trận xanh sau sửa thay lần lượt nhãn của cả 25 plan,
gồm numeric audit 1-22 và Hướng phát triển 1-3 ở ID 023-025, yêu cầu mỗi ca chỉ
có đúng một diagnostic audit mismatch. Thiếu khai báo, khai báo trùng hợp lệ
hoặc malformed, sai dấu phân cách, nằm ngoài metadata, numeric/direction ngoài
miền đều phải bị từ chối. Prose nhắc audit khác không phải declaration vẫn qua.

auditOf chỉ nhận duy nhất dòng Mục audit trong Trạng thái và mục tiêu, theo
format metadata hiện có, rồi so với entry.audit. Giữ kiểm entry.id/audit cũ để
không cho sửa đồng thời hai nhãn thành ánh xạ sai. Không sửa các file plan,
manifest hoặc trạng thái thực thi trên đĩa.

### Red/green và gate

- Trước sửa:
  `node --test --test-name-pattern='newFiles cannot|audit metadata must match' plans/test-validator.mjs`
  có 0 passed, 2 failed vì validator sai pass. Nhóm mở rộng có 12 failed; một
  fixture chiều ngược ban đầu còn bị lỗi existing-file nên chưa cô lập đủ. Đã
  đổi sang host.ts lịch sử của 007 như trên, không coi lỗi existence đó là red
  riêng của classification.
- Sau chốt fixture, nạp validator nguyên bản từ
  `git show 51f8476:plans/validate-plans.mjs` vào test module trong bộ nhớ, chạy
  riêng chiều ngược và audit 005: 0 passed, 2 failed, đều do validator trả 0
  thay vì 1. Không rollback file làm việc, thay Git object hoặc tạo review
  artifact giả.
- Sau sửa, 17 regression mới đạt. Source helper commit:
  `886e68a09eaa15712f2b1d0070e07ba98a7dc127`.
- Trên commit sạch, `node plans/validate-plans.mjs` đạt 25/25;
  `node --test plans/test-validator.mjs plans/test-history.mjs` đạt **101
  passed, 0 failed, 0 skipped**, gồm 99 validator test và hai ca Git clone thật.
  Clean single-branch clone giữ đầy đủ ancestry và validator xanh; historical
  clone trước provenance fix vẫn đỏ đúng sáu object thiếu/bảy DONE.
- `deno fmt --check plans/` đạt 53 file;
  `deno lint --no-config plans/validate-plans.mjs plans/test-validator.mjs plans/test-history.mjs`
  đạt ba script; `git diff --check` đạt. Source ngoài plans vẫn bằng main
  `341cba437dba69348b6e11e2c6f599480d5fc212`.

Giữ sáu provenance merges và regression mọi TODO chuyển BLOCKED. Codex đã viện
dẫn rule scope hiện có đúng vào finding newFiles; đây là bằng chứng rule phát
hiện gap, không phải lý do miễn review. Không thêm rule trùng, không thay
AGENTS, dependency, source ứng dụng, workspace root hoặc source 017. Chỉ hai
helper và evidence này thay đổi. Chưa push/reply; delta cần fresh review của
parent và vòng Codex/CI tiếp theo, không dùng APPROVE trước đó cho commit mới.

### Fresh review và kiểm chứng parent trên bản sửa metadata

Reviewer độc lập APPROVE HEAD399f0a65c6489608f020b5d2a2a21bb1f59ae067,
source886e68a09eaa15712f2b1d0070e07ba98a7dc127, không có finding. Reviewer đọc
nguyên văn comment Codex và toàn delta, tự chạy validator25/25, 101 helper/
history test, format53 file, lint3 script và diff check: đều đạt.

Parent tự đọc toàn diff và evidence, chạy lại các gate tương tự: validator
25/25, 101 test đạt không bỏ qua, format53/lint3/diff đều exit0. Giữ nguyên sáu
provenance merges và regression không còn TODO; source ngoài plans không đổi.
PR25 vẫn cần Codex sạch cùng CI trên HEAD mới và bắt buộc merge commit.

## Lượt A: đường dẫn, full sourceRef và Git fixture cache

Phạm vi được parent giao trên base `dd993b765473f0e72ef5056b03fbba8c2be4f35c`,
source ứng dụng bằng main `67a7bc4d777cccced5255b0a43ae648752241f21`. Chỉ chỉnh
hai helper và báo cáo này. Bảo toàn 19 file metadata parent đã sửa và file mới
`002-contract-extension.md`; snapshot sẽ commit chung theo quyền rõ ràng của
parent. Không nhận main mới trong lúc metadata đang freeze, không sửa trạng thái
thật 005/006, AGENTS, root hoặc GitHub.

### Baseline và prerequisite fixture

`node plans/validate-plans.mjs` đạt 25 kế hoạch. Selftest gốc có **97 passed, 2
failed** trong 99 test, thời gian quan sát 42,945 giây. Cả hai ca tại fixture
prerequisite giả định 005 chưa DONE: IN_PROGRESS 006 thực tế hợp lệ và trả 0;
DONE 006 chỉ còn lỗi checklist/approval, không có diagnostic prerequisite. Đây
là lỗi tiền đề test, không phải lý do nới validator.

Fixture mới tự đặt 005 STALE với lý do tường minh trong bộ nhớ, giữ sourceRef và
historical source thật, đồng bộ hàng README rồi đặt 006 IN_PROGRESS/DONE. Mỗi ca
bắt riêng đúng diagnostic `006 prerequisite 005 must be DONE`, xác nhận
historical read vẫn diễn ra; control khôi phục 005 DONE phải bỏ diagnostic đó.
Hai ca bổ sung chạy cùng phép kiểm khi toàn bộ trạng thái được đặt DONE trong bộ
nhớ, rồi đổi riêng trạng thái 021. Fixture không tạo approval cho các mục tương
lai: các diagnostic checklist/approval hợp lệ khác vẫn được giữ, không dùng
chúng thay cho assertion prerequisite. Không có metadata giả ghi xuống đĩa hoặc
Git.

### Các finding helper đã xử lý

Lượt này xử lý ba finding helper `3940080329`, `3940080332`, `3940080342` theo
ba nhóm dưới đây.

- Đường dẫn: kiểm repo-relative canonical cho từng scope và newFiles trước mọi
  exemption tạo mới hoặc prerequisite-created. Từ chối absolute POSIX, Windows
  drive, backslash, thành phần `.`/`..`, slash lặp và giá trị rỗng/sai kiểu;
  không normalize traversal rồi chấp nhận. `scopedObject` dùng cùng guard. File
  mới hợp lệ, thư mục artifact có một trailing slash và exemption lịch sử tiếp
  tục đạt. Giá trị lỗi trả diagnostic, không gây exception không liên quan.
- SourceRef: evidence sourceRef cần đúng 40 ký tự hex. Hai prefix 7 và 39 ký tự
  được Git resolve về đúng commit thật vẫn bị từ chối. Giữ các ca 41 ký tự,
  nonhex, full SHA không tồn tại và full SHA hợp lệ. Hai fixture Git thiếu trước
  đây dùng `deadbee` chuyển thành full SHA không tồn tại để tiếp tục kiểm lỗi
  đọc Git thực, không chết sớm chỉ vì regex. Mốc soạn short label không đổi.
- Git fixture cache: test harness chia sẻ cache output Git bất biến giữa các
  run, khóa theo command, args, cwd và encoding. Chỉ cache show/cat-file/ls-tree
  dùng full object ID; HEAD/ref động, command ngoài allowlist và filesystem hiện
  tại luôn đọc lại. Chỉ lưu output đọc thành công; Buffer được copy cả khi lưu
  và khi trả. Run có gitOutput bỏ qua cache hoàn toàn, callback vẫn đọc Git thật
  và có thể ném lỗi/đổi output để bắt regression. Không sửa validator production
  để bỏ historicalReads hoặc thay Git bằng kết quả giả.

### Red/green và phép đo

Sau thêm regression nhưng trước sửa validator/cache, chạy nhóm trọng tâm:

```sh
node --test --test-name-pattern='completed prerequisites|prerequisite fixture|noncanonical|newFiles validates|sourceRef rejects|immutable Git fixtures' plans/test-validator.mjs
```

Kết quả **6 passed, 16 failed**. Mười đường dẫn không chuẩn đồng bộ ở plan và
manifest được validator cũ nhận sai, gồm `../outside-plan.ts`; prefix 7/39 ký tự
cũng sai pass, cache không giảm subprocess. Ba ca rỗng/null/newFiles ngoài scope
vốn đã bị guard khác từ chối, chỉ thiếu diagnostic canonical mới, không tính là
ba hành vi sai pass. Các fixture prerequisite đã sửa đạt ngay với validator cũ,
xác nhận không cần nới gate.

Green cuối: **124 passed, 0 failed, 0 skipped**. Bao gồm Buffer alias, khác
path/ref/cwd/encoding/command, đọc Git lỗi không được cache, mutable HEAD không
cache, callback ném lỗi và trả malformed output không làm nhiễm run sau, cùng
dependency-created traversal. Một cặp run validator thật đo được **81 Git
subprocess khi cold, 2 khi warm**, nhưng vẫn ghi đủ **81 historicalReads** ở cả
hai run. Không có threshold thời gian trong assertion. Lượt green quan sát 6,163
giây với 124 test, không coi đây là benchmark tương đương bộ 99 test cũ hoặc lời
hứa latency trên máy khác.

### Gate local trước snapshot

- Validator: 25 kế hoạch đạt; `node --test plans/test-validator.mjs`: 124 đạt.
- `deno fmt --check plans/`: 60 file đạt; lint ba helper bằng `--no-config` đạt;
  `git diff --check` đạt.
- Server check, UI typecheck, lint toàn repo 206 file và format 282 file đạt.
- UI cài đúng lock offline và build đủ 7 viewer; Node build offline và syntax
  check đạt. Pack dry-run từ `dist-node/bin` có đúng 10 file, gồm 7 HTML.
- Full Deno trên source main 67a7bc4: **1202 passed, 0 failed, 4 ignored**; chạy
  sau UI/Node build, không gọi ERPNext thật.
- Deno dùng `--config deno.nojsr.json --sloppy-imports --frozen`; đã so mọi
  trường ngoài imports với deno.json, vendor với npm 0.25.0 pristine và lock
  SHA-256 `f32268af50c10ba06223c9a0b7f2d7092555ffa90172cd573ecf8d3feb2d882a`:
  khớp. Không nâng dependency/runtime hoặc pin npm trong lượt này.

Chưa triển khai finding definition binding `3940080334`. Snapshot metadata cần
review độc lập trước lượt B; không dùng test helper xanh làm approval cho
definition. Yêu cầu pin npm của `3940080337` do parent ghi trong kế hoạch 021,
chưa phải implementation hoặc quyền cài package manager. Clean-history gate phải
chạy sau commit snapshot; kết quả được bàn giao riêng, không suy ra từ validator
chạy trong worktree có metadata chưa commit.

## Lượt B: binding định nghĩa DONE

Finding `3940080334` yêu cầu bảo vệ chính định nghĩa kế hoạch, không chỉ source
và artifact implementation. Reviewer độc lập `/root/goal_execute_006` đã APPROVE
supplemental definition snapshot `b9d6d02a9692c3efff11836b97d8cfbc69da1ec7`,
manifest blob `2ff4089ea1fef9ae82699d021bc51be346747952`, cho đúng 13 DONE:
001/003/004/005/007/008/009/010/011/012/018/019/024. Parent chuyển kết luận này
cho executor trước khi triển khai binding. Không cấp approval cho 006/015/017
hoặc definition khác; không đổi các file kế hoạch hay manifest snapshot.

Mỗi evidence của 13 mục trên thêm riêng `definition_review_verdict: APPROVE`,
`definition_commit`, `definition_plan_blob`, `definition_manifest_blob`. Blob
đọc từ đúng path tại snapshot Git đã được duyệt, không lấy hash mutable plan để
tự duyệt. Sáu field implementation giữ nguyên từng byte. Các source PR cũ không
được tuyên bố hồi tố là đã chứa hoặc được review cùng định nghĩa này.

Validator kiểm commit thật qua cat-file và tree; so đúng path/type/blob của plan
và manifest. Toàn bộ byte kế hoạch hiện tại phải bằng approved plan blob, kể cả
prose, prerequisite, scope và checklist. Historical manifest được đọc bằng Git
và kiểm blob, rồi so duy nhất record đúng ID với current record: canonical
object key order, không đổi array content/order. Record khác tiến độ không
invalidate mọi DONE. Binding nằm ngoài manifest để tránh self-reference. Git
thiếu/sai type/sai path/sai blob fail closed. Đây là kiểm nhất quán offline,
không xác thực danh tính reviewer, CI hoặc chứng minh implementation production.

Red thực trước sửa validator, sau khi thêm metadata từ approval có thật:
`node --test --test-name-pattern='DONE definition' plans/test-validator.mjs` có
**1 passed, 28 failed** trong 29 test. Validator cũ nhận sai việc xóa đồng thời
scope khỏi plan/manifest, xóa đồng thời prerequisite khỏi ba biểu diễn, bỏ một
acceptance đã checked, thêm prose, bỏ/trùng/sai metadata và dùng Git blob hoặc
commit không chứa kế hoạch. Không có lỗi import hoặc Git giả làm red. Control
thay record khác đạt ngay; test canonical object còn đỏ vì array đảo thứ tự chưa
bị definition gate chặn.

Sau implementation, 29 test mới đạt. Một lượt full suite còn tám assertion cũ
không phù hợp chính sách full-plan binding: prose/checklist ngoài acceptance,
refresh definition DONE, hoặc diagnostic mới đi kèm classification/audit. Đã giữ
invariant gốc và cập nhật expectation chính xác: DONE edit chỉ báo hai
diagnostic definition/approval nếu không vi phạm invariant khác; kiểm semantic
whitespace/marker/prose hợp lệ chạy trên non-DONE. Audit vẫn kiểm từng mục đủ 25
ID; classification vẫn yêu cầu đúng lỗi cũ, thêm lỗi definition khi phù hợp.
Không sửa plan thật hoặc nới source, prerequisite, checklist, artifact gates.

Gate trước commit: validator 25/25 và **153 passed, 0 failed, 0 skipped** gồm
124 regression cũ cùng 29 mới. Cache Git vẫn ghi đủ historicalReads; quan sát 84
subprocess khi cold và 2 khi warm, 84 historicalReads ở cả hai lượt. Callback
Git error/output vẫn bypass cache và không làm nhiễm lượt sau. Clean-history
gate sẽ chạy trên commit thật; không dùng kết quả local này thay phép kiểm đó.

### Gate Git thật sau commit

Implementation binding được lưu tại `db2f31fa0b332a7919e02b48f227ae1a6adf9b9e`.
Test history bổ sung tại `930f0b6b49b59c0de02a222e7c5140ef191b6b2a`. Trên commit
sạch này, `node --test plans/test-validator.mjs plans/test-history.mjs` đạt
**156 passed, 0 failed, 0 skipped**: 153 validator và ba Git history test.
Positive clone một nhánh kiểm thêm ancestry của mọi definition_commit; ca âm sáu
reviewed HEAD lịch sử thiếu vẫn được giữ nguyên.

Ca âm definition dùng clone sạch của parent trước b9d6d02 và xác nhận cat-file
không đọc được b9d6d02. Sau đó chép nguyên cây plans từ db2f31f thật vào working
tree biệt lập, không tạo commit/blob Git hoặc metadata approval giả. Validator
trước guard từ b9d6d02 trả exit 0 sai; validator hiện tại trả exit 1 với đúng 27
diagnostic: một lỗi Git ref và hai lỗi definition/approval cho từng 13 DONE.
Fetch riêng ref b9d6d02 bằng transport local, không đổi HEAD/source/metadata,
làm validator đạt 25/25. Repository tạm được dọn sau test. Phần overlay được ghi
rõ, không gọi working tree sau overlay là clean checkout đã commit.

Format toàn plans 60 file, lint ba helper, validator 25/25 và diff check đạt.
Đối chiếu Git xác nhận 13 plan cùng manifest giữ nguyên byte so với b9d6d02; 13
evidence chỉ thêm bốn field definition, tất cả byte còn lại giữ nguyên. Source
ngoài plans vẫn bằng main 67a7bc4, không chạy lại app build trong lượt B và
không suy từ helper gate ra CI JSR thật. Không sửa workspace root, AGENTS,
dependency, version, publish hoặc GitHub; parent tiếp tục fresh review và CI.

## Sửa P2 độc lập: tiền đề non-DONE của positive fixture

Reviewer trên `d37b6d43556c5688b2ce0bd8cebe3220bbc0b63f` phát hiện ba positive
fixture prose/marker/audit vẫn dùng trực tiếp trạng thái hiện tại của 015. Khi
015 DONE, definition binding đúng sẽ từ chối chỉnh kế hoạch và làm test báo đỏ
giả. Rà thêm các ca manifest record 021, dependency 013/021, new artifact
directory, file mới chưa tracked và thư mục tracked: cùng lỗi tiền đề.

Đã gom tám loại edit hiện có vào fixture dùng chung. Regression mới đặt cả 25 kế
hoạch DONE trong VM, xác nhận từng trạng thái được đổi và yêu cầu helper tự
thiết lập non-DONE trước khi edit. Trước sửa setup, chạy
`node --test --test-name-pattern='positive semantic fixture survives' plans/test-validator.mjs`
cho **0 passed, 8 failed**, đều đúng assertion thiếu tiền đề non-DONE ở 015, 013
hoặc 021. Đây là red của test harness, không gọi validator đang từ chối đúng là
bug, không dùng lỗi Git/approval chưa có làm red của source ứng dụng.

Helper mới đặt riêng các target thành STALE có lý do rõ trong bộ nhớ, đồng bộ
README và loại stale_reason cũ trước khi thêm một lý do duy nhất. Không sửa
metadata trên đĩa. Nó kiểm trạng thái được dựng, target không có diagnostic từ
baseline và edit thật sự thay đổi nội dung. Sau edit, toàn bộ diagnostic và exit
code phải bằng baseline; mọi historical sourceRef của target vẫn được đọc. Các
lỗi hợp lệ của DONE giả lập khác được giữ nguyên trong phép so, không chế
approval để ép toàn bộ nền giả lập xanh. Tám test positive cũ dùng chính helper
này, nên control không kiểm một đường code tách rời.

Sau sửa, **161 validator tests passed, 0 failed, 0 skipped**: giữ 153 test và
thêm tám control mọi kế hoạch DONE. Validator production, history helper,
manifest, 25 plan và 13 approval không đổi. Full helper/history và clean clone
được chạy trên commit local tiếp theo; không push hoặc sửa ứng dụng.
