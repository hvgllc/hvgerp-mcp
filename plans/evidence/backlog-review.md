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

Commit fixture `231fc3472c7492b0ece2480e2b3dbf230322065e` đã được kiểm khi
worktree sạch: `node --test plans/test-validator.mjs plans/test-history.mjs` đạt
**164 passed, 0 failed, 0 skipped**, gồm 161 validator và ba Git clone test.
Validator 25/25, format 60 file, lint ba helper và diff check đạt. Git diff xác
nhận validator production, history helper, toàn bộ plan/manifest và 13 approval
giữ nguyên so với d37b6d4. Không dùng trạng thái giả lập để sửa tiến độ thật.

## Review bổ sung và đồng bộ sau khi 006/017 merge

Reviewer `/root/goal_execute_006` APPROVE sửa fixture P2 tại
`ca55a96fd4ed50de06e98f7d2acf05f117d8bdc9`, tree
`2da9ac0784457deaf359022b07ba90549e0d2775`. Tự chạy 164 test, validator 25/25,
format 60 file, lint ba helper, history và diff check đều đạt. Bỏ riêng bước
thiết lập non-DONE trong VM làm cả tám control thất bại đúng premise; giữ bước
này thì cả tám đạt. Không tạo approval giả, không nới production validator.

Merge main `67896f3208caee923659f1900c399d87e99c403c` sạch vào backlog tại
`2ce89ffb719a32ee3501d44a11d03fea0a0b2690`. Source ngoài plans bằng main này.
Đồng bộ trạng thái DONE và proof thật của 006/017, 38 artifact 017 có sẵn từ
merge; cập nhật quote 013/014/020 theo dòng mới của 006, không thay literal hoặc
thu hẹp scope. 013 và 025 bắt đầu IN_PROGRESS, phụ thuộc 005/006 đã DONE.
Snapshot tiến độ `ed1bd95affd1b09bf45d35c16e4279073fd7d004` chưa được tự cấp
approval cho hai định nghĩa mới; validator báo đúng bốn diagnostic thiếu
binding.

Reviewer `/root/execute_integration_015_017` tìm qualifier host017 cũ chỉ nhắc
malformed-payload, chưa phản ánh fixture ngày SO/QTN và held refresh của R2.
Parent đọc diff source R2 và cập nhật qualifier cùng maintenance, giữ nguyên
acceptance. Reviewer đọc lại và APPROVE riêng definition 006/017 tại snapshot
`a6a80dfcd88094ecd6e2475f9cde6cba0af72b5d`:

- Manifest blob: `db1f4a97d6de9e73608191b781537f8aa7f6c25b`.
- Plan 006 blob: `4c006989f10e7e8ed9b687cca2da02a5dfd92b2f`.
- Plan 017 blob: `7a75bd2b93a07aade32d08416d859ec84d4a51da`.

Review xác nhận sáu implementation field, source scope và artifact của hai mục
khớp Git thật; 13 DONE cũ giữ nguyên plan blob, manifest record và binding tại
b9d6d02. Đây là supplemental definition/proof-ledger review, không xác thực danh
tính reviewer bằng offline, không hồi tố rằng PR implementation chứa plan và
không thay review source/CI đã có.

Sau khi nhận APPROVE mới thêm bốn field của 006/017, commit
`c2154bc59893bec940654bba459ddadacb5a456f`, tree
`7ce0faa45e4f9f746f813d1e1928046200437cc8`. Parent tự chạy validator 25/25 và
164 helper/history test: 0 failed, 0 skipped. Build lại trên source main mới:
server check, lint 208 file, format 288 file với vendor ignored, UI typecheck,
UI build 7 viewer, Node build/syntax, pack dry-run 10 file/7 HTML và full Deno
1314 passed, 0 failed, 4 ignored đều đạt. Node bundle SHA-256
`da72878ff0b321a5e5e0477425d28f2e70dc2d85f96178fa2b82cd21b84cca35` khớp build
tích hợp 006 đã kiểm trước đó. Các gate local dùng workaround frozen, không thay
JSR thật; cần CI và Codex mới sau push PR25. Giữ merge history, không
squash/rebase các commit provenance được clean-clone test bảo vệ.

## Review 5120906080: khóa implementation binding và tập artifact

Parent giao ba finding `3940332280`, `3940332282`, `3940332286` trên PR25.
Executor bắt đầu tại `7fcfc9da79bfd5344e1b5e75de0d08e96bf83c3e`, chỉ sửa
validator, hai test helper có tên thực `test-validator.mjs`/`test-history.mjs`
và báo cáo này. Không sửa định nghĩa kế hoạch, manifest, README, source ứng dụng
hoặc metadata approval.

Baseline ban đầu có đúng bốn diagnostic: mỗi 013/025 thiếu definition snapshot
và reviewer approval evidence. Trong lúc executor viết regression, parent nhận
supplemental APPROVE thật cho snapshot trên và bổ sung metadata riêng tại
`184c0ba2a8162aabf956c2662736c2378fb9bf46`. Validator gốc sau metadata đạt
25/25. Executor không tự tạo approval để làm xanh; regression mới đối chiếu
diagnostic trước/sau cùng fixture nên không lấy lỗi thiếu metadata làm red.

### Ba thay đổi

- `3940332280`: sáu field implementation hiện tại phải bằng frontmatter trong
  `definition_commit:plans/evidence/NNN.md`. Snapshot này được đọc từ Git thật,
  đúng path/blob; field phải duy nhất và không thiếu. Không yêu cầu report của
  PR implementation cũ chứa metadata bổ sung về sau, không viết lại history.
  Commit/tree/report blob của implementation và scope equality cũ vẫn được kiểm.
  Đây là kiểm nhất quán offline, không xác thực danh tính người review.
- `3940332282`: artifact trong scope plans được so đủ tập path, Git object và
  mode với completed snapshot, dùng Git index thực gồm cả staged changes. Sau đó
  duyệt filesystem và kiểm byte/mode từng file. File thừa trong thư mục approval
  bị từ chối kể cả untracked hoặc ignored; symlink cũng không được chấp nhận.
  Thư mục rỗng không phải Git artifact nên không tính; file nằm ngoài đúng
  boundary thư mục không bị bắt nhầm. Không áp freeze artifact cho source ứng
  dụng đã tiến triển sau implementation.
- `3940332286`: kiểm mọi bullet trong danh sách scope trước `Ngoài phạm vi:`;
  bullet file phải theo dạng backtick hiện có, qualifier nằm trong ngoặc và có
  thể wrap. Plain bullet, marker khác, numbered/indented bullet, thiếu backtick
  hoặc qualifier malformed không được im lặng bỏ qua. Giữ ngoại lệ hai file quản
  trị và phân loại tạo mới; positive fixture vẫn tự dựng non-DONE.

### Red và green thực

- Trước sửa validator, năm regression ban đầu chạy bằng
  `node --test --test-name-pattern='PR25' plans/test-validator.mjs`: **0 passed,
  5 failed**. Đổi đồng thời reviewed/completed cùng report blob sang definition
  commit thật, thêm entry index artifact và ba kiểu plain scope bullet đều không
  tạo diagnostic cần thiết. Các phép đọc Git còn nguyên, không tạo approval
  object giả hoặc dùng exception không liên quan làm red.
- Ca artifact được kiểm thêm bằng clone một nhánh thật của HEAD `184c0ba`: tạo
  file mới trong `plans/evidence/007/` rồi `git add`; validator cũ vẫn trả
  exit 0. Test riêng **0 passed, 1 failed**, đúng assertion `0 !== 1`. Sau sửa
  và commit, cùng test đạt, gồm staged, untracked, staged nhưng bị xóa khỏi
  working tree, executable-mode drift, symlink và ignored file. Control ngoài
  boundary đạt; clone cuối sạch và thư mục tạm được dọn.
- Source helper commit: `5f9527db1ccc9a46fc9319ed91d4619bd8cdccf8`, tree
  `8f6ffc52be97b53d57d7691934bd7b1a580fb5c9`.
- Trên source commit sạch,
  `node --test plans/test-validator.mjs plans/test-history.mjs`: **187 passed, 0
  failed, 0 skipped**. Giữ 161 validator test và ba history test cũ; thêm 22
  validator test và một history test thực. Clean clone/provenance ancestry và
  hai historical negative vẫn đạt, không giảm gate.
- Cache vẫn chỉ giữ Git output bất biến. Run đo cold 126 subprocess, warm 3, cả
  hai ghi 126 historicalReads; index đọc lại giữa các run, callback lỗi hoặc
  biến đổi Git output vẫn bypass cache và không nhiễm lượt sau.
- Validator đạt 25/25; format toàn plans 66 file, lint ba helper với
  `--no-config` và `git diff --check` đều exit 0. Không chạy application/UI
  build trong lượt helper-only này; không dùng 187 test thay CI JSR thật.

Không sửa workspace root, definition/manifest/README hoặc 17 report approval.
Không push, trả lời GitHub, Browser, release hoặc publish. Delta helper mới cần
review độc lập và vòng Codex/CI tiếp do parent điều phối.

# Kiểm chứng bổ sung sau khi main nhận 015

Parent xác nhận reviewer độc lập APPROVE helper tại
`f4618e5cb7d87407b5e38cd472d1029c3de75e57`. Các definition 013/025 được review
tại `7fcfc9da79bfd5344e1b5e75de0d08e96bf83c3e`; definition 015 được review tại
`a4b41f160170289759a2f9022d3ec22ff2645242`. Đây là approval bổ sung sau
implementation, không viết lại lịch sử approval. Reviewer kiểm scope, tiêu chí,
sáu trường provenance và artifact 015 đúng byte; các binding cũ không thay đổi.
Metadata hiện ghi 18 DONE, 3 IN_PROGRESS, 1 BLOCKED và 3 TODO; không coi các
quyền framework/dependency chưa trả lời là đã duyệt.

Gate tại HEAD `35b91d98cef5047cbc86a99d5a8a24b50347df87`, tree
`63f14c7a96e22a1f7109d3ca09a9490f83d39743`: 187 helper/history tests pass, 0
failed/skip; validator 25/25; format 71 file, lint 3 helper; full Deno frozen
1363 passed, 0 failed, 4 ignored; server check, UI typecheck, UI build 7 viewer,
Node build/syntax và pack dry-run đúng 10 file/7 HTML đạt. Build hoàn tất trước
full tests. Worktree sạch. Executor gate là tác giả helper, nên kết quả gate này
không thay thế review độc lập đã nêu trên. Probe tên lock ban đầu bị ENOENT;
kiểm lại đúng `deno.lock` có SHA-256
`f32268af50c10ba06223c9a0b7f2d7092555ffa90172cd573ecf8d3feb2d882a`. Không
publish hoặc nâng dependency.

## Review 5121099562: namespace Git và citation liền kề

Parent giao finding `3940494459` và `3940494465` trên remote HEAD `ca793fa`.
Executor bắt đầu tại `b65979a67f97dddf03445f4c817be566db6ab939`, chỉ sửa
`validate-plans.mjs`, `test-validator.mjs` và báo cáo này. History helper giữ
nguyên. Finding thứ ba về kế hoạch 021 do parent xử lý riêng, không nằm trong
delta helper của executor.

Baseline ban đầu có đúng bốn diagnostic thiếu definition/approval của 014/023.
Sau reviewer độc lập APPROVE snapshot b65979a, parent tự thêm bốn trường vào hai
report và validator gốc đạt 25/25. Các regression mới tự dựng target non-DONE
trong VM và so diagnostic trước/sau, không tạo approval giả hoặc lấy diagnostic
metadata đang thiếu làm bằng chứng đỏ.

- `3940494459`: canonical scope guard từ chối thành phần `.git` ở mọi cấp, không
  phân biệt hoa/thường, trước exemption file mới hoặc dependency-created. Áp
  dụng cùng guard cho scope, newFiles và tra Git object. `.github`,
  `.gitignore`, `src/git/` và tên có prefix `.git-` vẫn hợp lệ. Đây là ranh giới
  namespace metadata Git, không phải bộ chuẩn hóa mọi alias filesystem.
- Đã kiểm Git thật trong repository tạm với protectNTFS/protectHFS bật:
  update-index từ chối `.git/config`, hooks, `.GIT`, `.GiT` và nested
  `src/.git`/`src/.GIT` bằng `Invalid path`; bốn control tương ứng trên đạt. Chỉ
  tạo blob fixture và index trong repository tạm, không tạo commit hoặc
  approval; thư mục tạm được dọn sau phép kiểm.
- `3940494465`: citation phải là dòng không rỗng liền trước marker của đúng
  block evidence theo index manifest, có chính xác path và line. Blank lines và
  deno-fmt-ignore hiện hữu vẫn được giữ. Citation đúng nằm ở prose nơi khác
  không thể thay citation bị thiếu, stale, bị đổi chỗ hoặc bị ngăn bởi đoạn giải
  thích khác. Historical/current source và fenced excerpt vẫn kiểm như cũ.

Red trước sửa validator:

```sh
node --test --test-name-pattern='Git metadata namespace|Git namespace guard|evidence citation must|adjacent citations retain' plans/test-validator.mjs
```

Kết quả **5 passed, 16 failed**. Tám biến thể namespace được nhận sai do
newFiles exemption; tám ca citation tại 001/003 giữ citation đúng ở nơi khác
hoặc tráo hai nhãn mà validator cũ không có diagnostic. Ca 003 cùng một file
source nhưng khác số dòng, ca 001 khác cả path; cả hai đều cần binding từng
block. Bốn control tên file hợp lệ và control formatting/prose đúng đều đạt
trước sửa. Không dùng exception, import hoặc lỗi Git làm red.

Sau sửa: `node plans/validate-plans.mjs` đạt 25/25;
`node --test plans/test-validator.mjs` đạt **204 passed, 0 failed, 0 skipped**,
giữ 183 selftests cũ và thêm 21 ca mới. Format toàn plans đạt 73 file, lint ba
helper với `--no-config` và `git diff --check` đều exit 0. Parent còn ba file
metadata/kế hoạch chưa commit trong worktree; clean-history gate chỉ chạy sau
khi các thay đổi đã review của parent và helper được commit, không bỏ assertion
worktree sạch để lấy kết quả xanh.

Không sửa source ứng dụng, plan/manifest/README hoặc approval; không chạy
application build, network, Browser, push hay trả lời GitHub trong lượt này.
Review độc lập helper mới do parent điều phối, không lấy verdict cũ làm approval
cho delta này.

## Parent xác nhận review helper và các snapshot sau 020

Reviewer độc lập `/root/goal_execute_006` APPROVE helper tại
`bcb57ccea3bcdab129c84d14bec3842c1c3b315a`, tree
`1efa539c2480a03f97bc919684f4adb2d625add0`, report blob
`e5b1939ffcc97886fba1da9b3d964726e068ba2d`. Reviewer tự chạy toàn bộ208
self/history tests, validator25/25, fmt73, lint3; red trên validator trước sửa
đạt5control và thất bại16ca đúng nguyên nhân, HEAD đạt21/21ca mới. Các183
selftests cũ nguyên byte, history helper không đổi. Probe VM đầu có lỗi thay
chuỗi đã sửa trong bộ nhớ, không tính là behavioral red.

Gate application độc lập ở cùng bcb57cc đạt full1385/0/4, server check, lint213,
fmt303, UI typecheck, UI7, Node build/syntax và pack10file/7HTML. Build xong
trước full suite, worktree sạch, frozen lock giữ SHA-256
`f32268af50c10ba06223c9a0b7f2d7092555ffa90172cd573ecf8d3feb2d882a`. Bundle là
`ba5a6e147950660ca408b27b3db00972aef2d5072448e9015761de147cb04bd1`. Gate này
trước khi merge source020; không dùng số1385 thay kiểm tích hợp mới.

Finding3940494468 được xử lý trong plan021 tại bcb57cc, plan blob
`7ff97786d71cba206a0d42d3e15628d9d828257d`, reviewer độc lập APPROVE delta. Kế
hoạch nay buộc so toàn bộ path/mode/size/SHA-256 của từng file trong package, kể
cả7HTML, và negative control chỉ đổi byte HTML trong khi bundle/list không đổi.
Có control thiếu/thừa file, mode và hai package giống nhau. Đây là tiêu chí
triển khai021 còn TODO, không phải tuyên bố đã thực hiện hai build tái lập.

Sau PR43 merge, parent merge main7d4546b vào backlog tại
`e36592bad028e442203b055ed8c2911c0311f1a8`, giữ application đúng main mới.
Definition020 snapshot `55bb74697d3d731bda0c3cb297fcdce29f8e9045` được reviewer
độc lập `/root/goal_execute_011` APPROVE: plan
`115b585038233f71f1faffd93369776e253bc546`, manifest
`72559f33368a0624fe8e569a44cb528126c08708`, report
`1df02f77b294c32d484407951ce79497fc585402`. Sáu provenance fields khớp Git,
scope/tiêu chí không giảm,20definition cũ nguyên byte. Snapshot lúc chưa có bốn
definition fields thất bại đúng hai diagnostic020; parent chỉ thêm binding sau
review, chưa push snapshot thiếu approval. Tổng metadata nay21DONE.

## Sửa finding 3940650166: ranh giới link Markdown

Executor bắt đầu ở `8436a48f687a5e119bfff164bc6ffeaf591db922`, source sửa tại
`42d1b51057c669994217bb7743797c6c6ce41945`. Chỉ sửa hai helper
`plans/validate-plans.mjs`, `plans/test-validator.mjs` và bổ sung mục báo cáo
này. P1 ancestry là nhiệm vụ riêng của parent, không nằm trong bản sửa này.

Validator cũ resolve link rồi hỏi `existsSync`, do đó đường dẫn tuyệt đối hoặc
`../` thoát repository có thể được nhận khi file ngoài checkout tồn tại. Test
mới chèn link vào báo cáo nested trong VM và khai báo file đích tồn tại trong
fixture filesystem. Không đọc nội dung file hệ thống, không phụ thuộc máy chạy
có thật file đích, không tạo source hoặc approval giả.

Red thực chạy trước sửa validator:

```sh
node --test --test-name-pattern='Markdown repository boundary' plans/test-validator.mjs
```

Kết quả exit 1, **6 passed, 10 failed**. Cả mười ca sai đều thất bại ở assertion
validator đã nhận link không an toàn với exit 0; không dùng lỗi import, Git,
exception hoặc thiếu file làm bằng chứng đỏ. Sáu control hợp lệ đã qua trước
sửa.

Guard mới từ chối đường dẫn tuyệt đối, dạng drive Windows kể cả `C:relative`,
UNC và backslash trước resolve. Với đường dẫn tương đối, resolve từ thư mục chứa
Markdown rồi kiểm kết quả `relative(repoRoot, resolved)` không ra ngoài repo
trước `existsSync`. Không dùng so prefix chuỗi có thể nhận nhầm thư mục anh em.
Relative `../` hoặc `./` vẫn được nhận nếu kết quả nằm trong repo; HTTP/HTTPS và
anchor giữ semantics cũ. Đường dẫn hợp lệ nhưng thiếu file vẫn bị guard link
hỏng hiện hữu từ chối.

Mười negative control bao gồm POSIX absolute, traversal trực tiếp và qua segment
trung gian, thư mục anh em, Windows drive/drive-relative/UNC và backslash. Mỗi
ca phải có đúng một diagnostic `unsafe Markdown link`, không exception, và danh
sách lookup ghi nhận trong VM không chứa đích bị chặn. Sáu positive control bao
gồm relative về README repo, normalization `src/..`, fragment nội bộ, HTTP,
HTTPS và anchor. Đây là ranh giới lexical của link mà parser hiện tại nhận được,
không tuyên bố đã viết lại parser CommonMark hoặc kiểm mọi alias/symlink
filesystem.

Gate sau sửa:

- Focused 16 passed, 0 failed; `node plans/validate-plans.mjs` đạt 25/25.
- `node --test plans/test-validator.mjs`: 220 passed, 0 failed, 0 skipped, giữ
  204 selftests cũ và thêm 16 ca.
- `deno fmt --check plans/`: 74 file; lint ba helper với `--no-config` và
  `git diff --check` đều exit 0.
- Sau commit source sạch, `node --test plans/test-history.mjs`: 4 passed, 0
  failed, 0 skipped. Giữ nguyên helper history và toàn bộ provenance merges;
  clone một nhánh dùng Git transport local, không cần mạng. Tổng self/history là
  224 ca, giữ toàn bộ 208 ca trước sửa.

Không sửa plan/manifest/README, approval metadata, source ứng dụng hoặc
dependency. Không chạy application build, Browser, Publish, push hoặc thao tác
GitHub. Đây là evidence executor; review độc lập delta mới do parent điều phối.

Reviewer độc lập APPROVE HEAD `76dc06d07d801f50e38e7919f631bb3d151136d6`, tree
`29a47ee8363f81748208fd04ba98fb6c6ffa4d10`, report blob
`cf2124ca7650e4c06f61621f368d65941974b25e`. Reviewer tự tái hiện red trên
validator8436: 6 control đạt, 10 assertion thất bại; bản mới đạt 16/16 và toàn
bộ 224 self/history. Kiểm 204 selftests cũ nguyên assertions, history helper và
manifest/README không đổi. Parent đọc toàn diff và tự chạy lại validator25, 220
selftests, 4 history, fmt74/lint3/diff đều đạt. Giới hạn lexical được giữ, không
dùng APPROVE này cho những thay đổi metadata sau đó.

## Đối chiếu finding 3940650163 về ancestry

Parent clone mới trực tiếp từ GitHub bằng
`--single-branch --no-tags --branch
advisor/goal-backlog`, không dùng object
cache hoặc worktree local. HEAD clone là
`8436a48f687a5e119bfff164bc6ffeaf591db922`, không phải 8818303 trong finding.
Hai lệnh `git merge-base --is-ancestor` với
b9d6d02a9692c3efff11836b97d8cfbc69da1ec7 và
bb78ace761b7ae9b26900c8c80faad699a9adfa6 đều exit 0. Validator đạt 25 kế hoạch;
history suite đạt 4/4, gồm positive clone một nhánh và negative lịch sử squash
thật. Finding không tái hiện trên HEAD remote hiện tại, parent trả lời bác bỏ
tại discussion3940678021. Không sửa các approval hợp lệ hoặc bỏ gate history.
PR25 vẫn phải merge commit, không squash/rebase, rồi kiểm ancestry trên main
mới.

## Sửa finding 3940727090 và 3940727091

Executor bắt đầu tại `5a3631946c188eace908ea252ea80581603f7f62`, source sửa
`d97f092cf3b9f553a002adfeccaad159070ec9fe`. Chỉ sửa validator, selftests và mục
báo cáo này; không sửa rule ancestry, `plans/AGENTS.md`, history helper,
metadata approval, kế hoạch hoặc source ứng dụng. P1 ancestry lần hai do parent
xử lý riêng.

`3940727090`: bộ kiểm cũ chỉ lấy destination trong inline link, bỏ qua các
reference definitions. Bản sửa thu destination từ definition rồi đưa qua chính
guard HTTP/anchor, absolute/Windows/backslash, traversal và tồn tại file hiện
hữu. Path được resolve từ thư mục chứa Markdown, không từ repo root. Test unsafe
khai báo file đích tồn tại trong VM, kiểm đúng một diagnostic và xác nhận không
có filesystem lookup đích bị chặn; không đọc nội dung file hệ thống.

Phạm vi cú pháp được hỗ trợ là definition một dòng dạng `[label]: destination`,
destination bare không whitespace hoặc bọc angle brackets, có thể có title được
bọc bằng nháy đơn, nháy kép hoặc ngoặc tròn trên cùng dòng. Kiểm mọi definition,
kể cả chưa được dùng hoặc trùng label, nên full/collapsed/shortcut reference đều
không thể bỏ kiểm destination. Definition nhiều dòng, angle bị thiếu hoặc phần
đuôi không parse được bị từ chối bằng diagnostic
`unsupported Markdown reference definition`, không bỏ qua âm thầm.

Đây là cú pháp giới hạn phục vụ tài liệu kế hoạch, không phải triển khai đầy đủ
CommonMark: không thêm dependency parser, không tuyên bố phân tích toàn bộ
escape/HTML/entity/code-block grammar. Bộ quét definition có tính bảo thủ, kể cả
declaration chưa dùng cũng phải có đích hợp lệ. Các giới hạn lexical/symlink của
guard đường dẫn trước vẫn giữ nguyên.

`3940727091`: checklist DONE nay nhận cả unordered `-`, `*`, `+` lẫn ordered
number-dot/number-parenthesis, kể cả indentation. Bất kỳ `[ ]` nào được nhận
trong mục Tiêu chí hoàn tất làm DONE thất bại; `[x]` và `[X]` đều được nhận.
Checklist ở section khác không trở thành completion gate. Definition binding vẫn
hoạt động độc lập: sửa checklist của DONE đã review vẫn phải review lại
definition, không tạo approval giả để lấy control xanh.

Red thực chạy trước sửa production:

```sh
node --test --test-name-pattern='Markdown reference|DONE ordered completion' plans/test-validator.mjs
```

Exit 1, **7 passed, 18 failed**. Bốn ordered unchecked không tạo diagnostic
unchecked; bốn ordered checked bị báo sai là thiếu checklist. Mười reference
negative/unsupported được validator cũ nhận sai: ba missing destination theo
full/collapsed/shortcut, bốn absolute/traversal/Windows/backslash và ba
definition không được hỗ trợ. Bảy control hợp lệ đã đạt trước sửa. Red không dựa
lỗi import, Git hoặc exception; với DONE, assertion tìm diagnostic checklist
riêng, không lấy lỗi definition binding sẵn có làm bằng chứng.

Sau sửa, focused 25/25 và `node plans/validate-plans.mjs` đạt 25 kế hoạch.
`node --test plans/test-validator.mjs` đạt 245 passed, 0 failed, 0 skipped, giữ
đủ 220 selftests trước đó và thêm 25 ca. `deno fmt --check plans/` đạt 75 file;
lint ba helper `--no-config` và `git diff --check` đều exit 0. Sau commit source
với worktree sạch, `node --test plans/test-history.mjs` đạt 4/4, giữ nguyên
clean single-branch clone và các negative provenance. Tổng 249 self/history, giữ
toàn bộ 224 ca cũ. Chỉ dùng Git transport local, không cần mạng.

Không push, trả lời GitHub, chạy application build, Browser, Publish hoặc thay
dependency. Đây là evidence executor, không phải approval độc lập của delta mới.

## Sửa REVISE: label reference ăn sang title

Reviewer độc lập phát hiện lỗi mới được đưa vào ở helper
`4f83fff8847f93da34db3af7a5bc6b5980ca2dec`: phần regex label greedy đi tới chuỗi
`]:` trong title, biến fragment của title thành destination. Destination thực là
absolute, traversal hoặc file thiếu vì vậy có thể bị bỏ kiểm như anchor. Không
dùng kết quả green hoặc review trước đó để phủ nhận finding này.

Source sửa: `3f8c9c8dd217c3fb9a855c1850151cde237179fb`. Regex label nay chỉ nhận
ký tự thuộc label và cặp escape, kết thúc ở dấu `]` không escape. Destination và
title được tách sau delimiter đó bằng bộ kiểm hiện hữu. Title chứa `]:` không
thể trở thành label hoặc thay đích link; label chứa `\]` vẫn được nhận. Không
đổi guard path/lookup, checklist, approval, ancestry hoặc cú pháp giới hạn đã
nêu ở mục trước.

Red thực chạy khi production helper còn nguyên 4f83fff:

```sh
node --test --test-name-pattern='Markdown reference title boundary' plans/test-validator.mjs
```

Kết quả 6 passed, 18 failed. Mười tám negative có destination unsafe/missing đều
bị helper cũ nhận sai với exit 0, không phải lỗi import/exception hoặc thiếu
Git. Sáu control destination tồn tại hợp lệ vẫn qua. Ma trận 24 ca gồm bốn đích
(absolute, traversal, missing, valid), ba kiểu delimiter title (nháy kép, nháy
đơn, ngoặc tròn) và hai label (thường, có escaped closing bracket). Title trong
mọi ca chứa `]:` trước fragment anchor.

Sau sửa: 24/24 focused và 269/269 selftests; giữ nguyên 245 ca trước sửa.
Negative yêu cầu đúng diagnostic của destination thực; unsafe phải bị chặn trước
lookup, missing phải được lookup rồi báo thiếu. File unsafe được khai báo tồn
tại trong VM để test không lệ thuộc filesystem máy; không đọc file hệ thống.
Validator đạt 25/25, format toàn plans 75 file, lint ba helper và diff check
đạt. Sau commit source sạch, bốn clean-history tests đạt, giữ nguyên helper
history và provenance merges. Tổng self/history là 273 ca, giữ đủ 249 ca trước
sửa.

Chỉ thay validator, selftests và mục evidence này. Không sửa AGENTS, journal,
plan/manifest/approval hoặc source ứng dụng; không mạng ngoài Git transport
local của history gate, không push/GitHub/Browser/build. Delta sửa REVISE cần
review độc lập mới, không tự tạo APPROVE.

Reviewer độc lập APPROVE toàn delta d97f092 + 3f8c9c8 so với 5a36319 tại HEAD
`d96148906c0299b953b051714a848642c145b6c9`, tree
`93ee282e2cb0e8397a0d83c0f111b34024ba8d3d`, report blob
`6c2d6c5871f2ffb3c785f12d9af2614df2cf06d9`. Reviewer tự tái hiện red 6/18 trên
4f83fff, green focused 24 và full 273; kiểm 245 selftests cũ nguyên byte,
history helper và metadata không đổi. Validator 25, fmt 75, lint 3, diff check
đạt. Parent đọc toàn diff helper/tests và chạy lại 273 self/history cùng các
gate đó đều đạt. Approval áp cho cú pháp giới hạn đã nêu, không mở rộng thành
cam kết phân tích toàn bộ CommonMark hoặc approval metadata chưa review.

## Đối chiếu finding 3940727088 về đúng SHA remote

Review 5121375631 ghi Reviewed commit 5a3631946c nhưng mô tả ancestry của
051daf1d296c9b4b835c44088dfd935397d30176. API commit của HEAD remote thật
`5a3631946c188eace908ea252ea80581603f7f62` cho parent
`76dc06d07d801f50e38e7919f631bb3d151136d6`, không phải main 7d4546b làm parent
duy nhất. Parent fetch rồi fast-forward clone trực tiếp một nhánh từ GitHub tới
5a36319: validator 25 và history 4 đạt; b9d6d02 và bb78ace đều còn là ancestor.
Đã trả lời tại discussion3940743803, không sửa các approval hợp lệ.

Quy tắc `plans/AGENTS.md` blob `7c24cfc6cb953064097151c4b60fa7684674ac38` được
reviewer độc lập APPROVE riêng. Phải đối chiếu SHA remote và parent chính SHA
đó; không lấy checkout khác SHA để kết luận nhánh thật mất history. Nếu actual
HEAD hoặc merge main mất pinned refs, vẫn báo lỗi và chặn DONE. Negative history
tests vẫn bắt buộc; PR 25 giữ merge commit, không squash/rebase. Reviewer kiểm
rule, format và parent Git local; chứng cứ GitHub/remote clone là của parent,
không gán cho reviewer.

## Đối chiếu finding 3940823895 trên HEAD 72fb6a7

Review 5121477739 ghi Reviewed commit 72fb6a728c nhưng finding lại kiểm
d3990b6c544b3e40d5cf862f26cfb93639bc1bfb. API HEAD remote thật
`72fb6a728c4eec38b24b15c69d51dbac9b66e92a` trả parent
`d96148906c0299b953b051714a848642c145b6c9`. Parent fetch và fast-forward clone
trực tiếp một nhánh từ GitHub tới 72fb6a7: hai pinned refs b9d6d02/bb78ace là
ancestor, validator 25 và history 4 đạt. Reply discussion3940853839 yêu cầu kiểm
đúng SHA, giữ rule hiện có và không rebind approval sang checkout khác. Không
suy đoán ai tạo d399 hoặc bỏ kiểm ancestry thật sau merge.

## Sửa findings 3940924244 và 3940924246: code không phải cấu trúc Markdown

Ngày 2026-09-06. Base đúng HEAD PR25 `7d20671284bbaadbadcd7fbf297635ee116a68b1`,
review `5121591635`. Executor đọc đủ validator, toàn bộ selftests/history và
plans/AGENTS trước khi sửa. Source commit
`b4ef4ba2f6b6f93130efa4c3df9a88b425acd81c`, tree
`15a60b710ee5b80126a4ef2cce5a28e40e0be284`. Chỉ sửa validator, selftests và mục
report này; không thay AGENTS, journal, plan/manifest/approval, history helper
hoặc source ứng dụng.

Helper cũ dùng raw substring cho required heading và quét link/definition trên
toàn bộ Markdown. Vì vậy ví dụ link hỏng/unsafe trong code vẫn báo lỗi, còn
heading chỉ nằm trong fenced example có thể làm tiêu chí cấu trúc qua sai.

### Red thực và giới hạn parser đã chọn

Trước sửa production helper, chạy trên 7d206:

```sh
node --test --test-name-pattern='Markdown (code fence|inline code|require)' plans/test-validator.mjs
```

Kết quả **1 passed, 16 failed, 0 cancelled**, exit 1, đủ 17 ca. Các failure là
assertion quan sát được: validator cũ báo diagnostic cho link/reference ví dụ
trong code, hoặc nhận heading thiếu với exit 0. Một control heading được bọc
inline tick đã bị từ chối đúng từ trước. Không lấy exception/import/Git thiếu
làm red, không đổi trạng thái hoặc approval thật để tạo kết quả xanh. Fixture
heading đặt plan021 ở STALE trong bộ nhớ với lý do rõ, giữ các kiểm lịch sử.

Bản sửa thêm lớp bỏ nội dung fenced code trước kiểm heading và link, rồi bỏ
inline code trước thu thập link/definition. Quy tắc hẹp:

- Fence top-level bắt đầu sau 0 đến 3 dấu cách, dùng ít nhất ba backtick hoặc
  tilde. Backtick info không được chứa backtick. Closing fence phải cùng marker,
  dài bằng hoặc hơn opener và chỉ có whitespace theo sau. Fence ngắn, khác loại
  hoặc có text sau marker không đóng block. Không cắt bỏ snippet nguồn trong
  phần kiểm evidence exact text; phần đó vẫn đọc body nguyên bản.
- Fence chưa đóng được coi kéo dài tới EOF, không tự phát sinh lỗi syntax riêng.
  Ví dụ link trong vùng đó không thành live target; required heading bị che
  trong vùng đó vẫn bị báo thiếu. Không tự kết thúc fence để làm tài liệu qua
  gate.
- Inline code dùng cặp run backtick có cùng độ dài, giữ các backtick lẻ bên
  trong. Opener đã escape hoặc không có closer không che link; không ghép span
  qua đoạn trống LF/CRLF. Link và reference definition bên ngoài span vẫn kiểm
  như cũ.
- Required heading phải là dòng ATX cấp 2 ngoài fence, không phải substring
  trong prose hoặc heading cấp 3. Cho phép indentation 0 đến 3 space và closing
  hashes có whitespace đúng dạng. Không thay contract metadata/scope section
  hiện hữu.

Đây không phải parser CommonMark đầy đủ: không mở phạm vi sang indented code,
fence lồng list/blockquote, HTML block hoặc toàn bộ grammar link. Các giới hạn
destination/reference title đã được duyệt trước vẫn giữ nguyên. Validator vẫn
kiểm mọi reference definition thật, kể cả chưa dùng; definition chỉ nằm trong
fence không sinh target ngay cả khi có usage ngoài fence.

### Green và bảo toàn regression

Thêm 38 selftests: backtick/tilde, indentation, delimiter length/type, info sai,
fence chưa đóng, inline run/escape/unmatched/blank paragraph, required heading
trong code/prose/cấp sai và controls heading/link/definition thật sau code.
Focused Markdown ban đầu đạt 93/93; ba control bổ sung sau đó được bao phủ trong
full selftest cuối. So sánh bằng Node assertion, sau khi bỏ duy nhất đoạn test
mới, toàn bộ selftest cũ khớp byte với 7d206.

| Lệnh                                                                                             | Kết quả                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `node --test plans/test-validator.mjs`                                                           | 307 passed, 0 failed, gồm 269 cũ + 38 mới |
| `node plans/validate-plans.mjs`                                                                  | exit 0, đủ 25 kế hoạch                    |
| `deno fmt --no-config --check plans/`                                                            | exit 0, 75 file                           |
| `deno lint --no-config plans/validate-plans.mjs plans/test-validator.mjs plans/test-history.mjs` | exit 0, 3 file                            |
| `git diff --check`                                                                               | exit 0                                    |
| `node --test plans/test-history.mjs` sau commit source sạch                                      | 4 passed, 0 failed                        |

Tổng 311 self/history tests, giữ đủ 273 ca cũ. History gate dùng Git transport
local và disposable clone, không gọi mạng; giữ ca thiếu reviewed refs và thiếu
definition ref bị từ chối rồi phục hồi đúng khi fetch local ref thật. Không
build ứng dụng, Browser, GitHub, push hoặc publish. Kết quả này chỉ là kiểm
consistency offline, không chứng thực danh tính reviewer. Source và evidence mới
còn chờ review độc lập, không tự ghi APPROVE.

### Bổ sung theo review: không nối inline span qua block mới

Reviewer phát hiện thiếu sót trong source b4ef4ba: chỉ tách đoạn trống chưa đủ.
Backtick mở ở paragraph trước có thể ghép với backtick sau heading/list mới, làm
che link thật trong block đó. Executor tái hiện trên HEAD5cb87fb bằng lệnh:

```sh
node --test --test-name-pattern='Markdown inline code (cannot cross a structural|retains multiline)' plans/test-validator.mjs
```

Red **1 passed, 2 failed, 0 cancelled**, exit 1: heading chứa link thiếu và list
chứa link unsafe đều bị helper nhận sai với exit 0. Control inline code nhiều
dòng trong cùng paragraph đã qua. Sau sửa focused ba ca đều xanh.

Source mới `a9a5e738bb22889ca70cdbd6ff2a8a4a27d2474c`, tree
`7cf60e4ddc45335e43c42326d24acd54752c9fda`. Bộ chia paragraph nay dừng span tại
heading ATX, dòng setext/thematic break, list marker, quote marker và đoạn
trống. Heading được xử lý riêng để opener trong heading cũng không che paragraph
sau. Ordered list nhận marker số bất kỳ theo `[0-9]+[.)]`; có controls `2.` và
`42)` bên cạnh `1.`/`1)`. Đây là nhận diện boundary bảo thủ, không bổ sung
parser CommonMark đầy đủ hoặc đổi grammar metadata/evidence. Multiline inline
code không gặp boundary vẫn hoạt động. Giới hạn fence top-level và HTML ở trên
vẫn giữ, không dùng chúng để phủ nhận lỗi block boundary vừa sửa.

Thêm 14 tests, giữ 307 tests trước vòng bổ sung. Full
`node --test plans/test-validator.mjs` đạt **321 passed, 0 failed**. Validator
25, `deno fmt --no-config --check plans/` 75 file, lint ba helper và
`git diff --check` đều đạt. Sau source commit sạch,
`node --test plans/test-history.mjs` đạt **4 passed, 0 failed**, tổng **325**
self/history, giữ đủ 273 tests trước hai findings Codex. Lệnh và phạm vi không
mạng/build/metadata giống bảng trước. Report này ghi kết quả thực thi, chưa phải
verdict review độc lập cho source a9a5e73 và không cho phép push/merge.

### Review độc lập validator cuối

Reviewer độc lập APPROVE snapshot `a444fb464798ee64cb486064a39b50de710b2e18`,
tree `f1f6220b3480ac5a87c3bc7428a68034bf9872a9`, report
`f91aee15da6c83c12aa68938e781a8cdd5a8e47a`. Review xác nhận năm nhóm fix mới:
indented code, reference definition trong block quote, steps structural ngoài
code, dependency chỉ trong metadata và fence language theo manifest. Binding
definition 007 hợp lệ, execution/completion không đổi; 021/022 chỉ đồng bộ nhãn.

Gate độc lập: validator 25, selftests/history 365/365, format 75 file, lint ba
helper và diff check đạt. 321 selftests trước vòng này được giữ nguyên byte.
Review không chứng thực CI/GitHub và không mở phạm vi thành CommonMark đầy đủ.

## Thực thi năm P2 tại ce94ec9: đang bị chặn bởi ngôn ngữ fence có sẵn

Ngày 2026-09-06. Base review đúng PR25
`ce94ec9b0fb768ad68708f22d13f3b2b4a59cab9`. Source mới
`f83acbad04b3ea7495301d9179a03ba774dd5a4b`, tree
`19a017bb8c46f5bc2f1d906a17cad19d558c13bb`. Chỉ sửa validator, selftests và
report này. Không sửa plan definition, manifest, metadata approval, AGENTS,
history helper hoặc source ứng dụng. Trạng thái: source đã triển khai, gate chưa
đạt; không có verdict review độc lập hoặc quyền push/merge.

### Hành vi đã triển khai

- Bỏ indented code bắt đầu tại ranh giới paragraph, indentation ít nhất bốn cột;
  tab tiến tới tab stop bốn cột. Không để indentation ngắt paragraph sống hoặc
  che dòng tiếp của list. Sau code, link sống vẫn được kiểm.
- Bóc prefix blockquote, kể cả quote lồng nhau và indentation 0 đến 3 space,
  trước khi kiểm reference definition. Mỗi container có ranh giới riêng; fence
  chưa đóng không che link sau khi thoát container. Marker quote nằm trong code
  vẫn là nội dung ví dụ, không tạo container mới. Target unsafe vẫn bị từ chối
  trước filesystem lookup. Reference destination xuống dòng chưa được hỗ trợ,
  báo lỗi rõ thay vì im lặng bỏ kiểm.
- Đếm bước và gate từ nội dung cấu trúc ngoài fenced/indented/inline code. Bước
  phải là heading cấp 3; nhãn kiểm tra phải đứng đầu dòng. Các snippet evidence
  tiếp tục được so exact text trên body gốc, không qua lớp lọc code.
- Chỉ nhận đúng một dòng `- Phụ thuộc:` sống trong section metadata. Dòng ở
  prose ngoài section không thể thay trường bị thiếu và không tạo duplicate.
  Không cho whitespace regex ăn sang giá trị ở dòng sau.
- Khi manifest có own property `lang`, yêu cầu string và fence language khớp
  nguyên giá trị; chuỗi rỗng yêu cầu fence không nhãn. Khi không có property,
  không suy ra language mặc định mới. Không bỏ kiểm code/path/ref/line vì có
  language mismatch.

Đây vẫn là parser giới hạn, không phải toàn bộ CommonMark: chưa diễn giải HTML
block, toàn bộ grammar reference nhiều dòng hoặc code lồng list. Dòng tiếp list
được giữ để kiểm target theo hướng bảo thủ. Không quảng cáo các giới hạn đó là
đã được hỗ trợ đầy đủ.

### Red thực, controls và gate không đạt

Trước khi sửa production helper, chạy:

```sh
node --test --test-name-pattern='^PR25 (indented|live target after|indentation|quoted|execution steps|example checks|inline check|dependency|evidence language|absent evidence|explicit matching)' plans/test-validator.mjs
```

Kết quả **34 ca: 6 pass, 28 fail, 0 cancelled, 0 skipped**, exit 1. Failure là
assertion diagnostic/exit code ở đủ năm nhóm, không phải import/Git hoặc
exception ngoài ý nghĩa test. Sau đó thêm sáu controls về quote trong fence,
inline nhiều dòng, code trong quote, language rỗng và kiểu language sai; tổng 40
test mới. Node assertion xác nhận sau khi bỏ duy nhất đoạn test mới, toàn bộ 321
selftests cũ khớp byte với ce94ec9.

Lượt chạy helper mới chưa thể ghi green vì rule language phát hiện năm mismatch
thật có sẵn. Parent đã yêu cầu giữ rule và không sửa definition/approval để lách
gate. Bảng đối chiếu đọc từ manifest và fence tại snapshot:

| Plan | Trích đoạn                         | Manifest lang | Fence thực tế |
| ---- | ---------------------------------- | ------------- | ------------- |
| 007  | `src/ui/tsconfig.json:19`          | `json`        | `text`        |
| 007  | `deno.json:16`                     | `json`        | `text`        |
| 021  | `scripts/build-node.sh:65`         | `json`        | `text`        |
| 021  | `scripts/build-node.sh:80`         | `bash`        | `text`        |
| 022  | `.github/workflows/publish.yml:15` | `yaml`        | `text`        |

Không thay các assertion cũ để dung thứ năm diagnostic này. Probe thuần trong VM
trên các helper mới đạt 12 controls về indented/fenced/quoted code, quote
reference sống, list continuation và container exit; probe không đổi plan hoặc
approval trong bộ nhớ. Lần đầu gõ probe gặp SyntaxError do escape chuỗi trong
script tạm, đã sửa script và chạy lại; không tính lỗi đó là red nghiệp vụ.

| Lệnh                                                                                             | Kết quả thực tế                                                                              |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `node plans/validate-plans.mjs`                                                                  | exit 1, đúng năm language mismatch trong bảng                                                |
| `node --test plans/test-validator.mjs`                                                           | exit 1: 361 ca, 242 pass, 119 fail, 0 cancelled, 0 skipped                                   |
| `node --test plans/test-history.mjs` sau source commit sạch                                      | exit 1: 1 pass, 3 fail; baseline clone và expected diagnostics bị chặn bởi cùng năm mismatch |
| `deno fmt --no-config --check plans/`                                                            | exit 0, 75 file trước report                                                                 |
| `deno lint --no-config plans/validate-plans.mjs plans/test-validator.mjs plans/test-history.mjs` | exit 0, 3 file                                                                               |
| `git diff --check`                                                                               | exit 0                                                                                       |

History negative về missing/squashed reviewed refs vẫn chạy, nhưng không lấy một
ca đạt làm bằng chứng full history xanh. Chưa có full green sau khi xử lý
definition, chưa gọi source này đã được duyệt. Cần parent xử lý mismatch bằng
workflow review definition hợp lệ, sau đó chạy lại full validator/self/history.
Không network, Browser, build, push, publish hoặc sửa approval trong lượt này.

### Gate sau khi parent đồng bộ definition và fence

Parent cung cấp snapshot `ce0899d7cbeeeebd72cedf5cb56926c432fae52d`, gồm commit
đồng bộ fence `3533d18e4cd58273b940e22d7aab2c69edc246ca` và binding definition
007 mới. Executor chỉ đọc những thay đổi này, không tự tạo hoặc thay approval.
Trên snapshot đó, validator 25 đã qua; full self/history đạt 364/365. Ca đỏ duy
nhất là expected diagnostics của clone lịch sử, không còn là lỗi dữ liệu của
snapshot hiện tại. Cả 361 selftests đều qua, không cần sửa fixture selftest.

Fixture history cố ý archive nguyên `db2f31fa0b332a7919e02b48f227ae1a6adf9b9e`:
năm nhãn fence cũ trong snapshot ấy vẫn không khớp manifest. Fetch definition
ref không sửa nội dung Markdown. Vì vậy test nay yêu cầu chính xác 32 diagnostic
trước fetch: 27 lỗi provenance cũ và năm lỗi language đã liệt kê; sau fetch chỉ
được còn đúng năm lỗi language. Không bỏ assertion missing ref, không thay
archived bytes, không đổi Git object hoặc tạo approval giả. Current clean clone
vẫn phải qua validator với exit 0 trong test history riêng.

Source fixture mới `ab4b966eb5730a90fe9e4a1613194b0c063ce8c7`, tree
`37c46b38d2f74b50f1bbea23ee531a59d6b72558`, chỉ sửa `plans/test-history.mjs`.
Production validator, toàn bộ selftests, manifest và AGENTS giữ nguyên byte so
với ce0899d. Lượt history trước commit đạt 3/4, ca còn lại bị dirty-check chặn
đúng vì test đang sửa; không lấy lượt đó làm green. Sau commit và worktree sạch:

| Lệnh                                                                                             | Kết quả                                                                    |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `node --test plans/test-validator.mjs plans/test-history.mjs`                                    | 365 pass, 0 fail, 0 cancelled, 0 skipped: 361 selftests và 4 history tests |
| `node plans/validate-plans.mjs`                                                                  | exit 0, đủ 25 kế hoạch                                                     |
| `deno fmt --no-config --check plans/`                                                            | exit 0, 75 file                                                            |
| `deno lint --no-config plans/validate-plans.mjs plans/test-validator.mjs plans/test-history.mjs` | exit 0, 3 file                                                             |
| `git diff --check ce94ec9b0fb768ad68708f22d13f3b2b4a59cab9..HEAD`                                | exit 0                                                                     |

Kết quả green này thay trạng thái gate bị chặn ở mục trước cho snapshot mới,
không hồi tố snapshot f83acba hoặc cb120bd thành green. Phạm vi vẫn là kiểm
consistency offline, không chứng thực danh tính reviewer. Source và report chờ
review độc lập; executor không push, network, build hoặc ghi APPROVE.

### Review độc lập sau correction

Reviewer độc lập đã đọc snapshot cuối
`e22aa790e3c440b9db309d383b5f9cde8dbb73fe`, tree
`049df1932df9b86f8df1926b7848fc7aa54cdc2c` và report
`bc9c6456d0ea53156496b700325e79d089e5514b`. Reviewer tái hiện source cũ che sai
hai link thật qua heading/list, xác nhận source mới chặn cả hai ca và vẫn cho
phép inline code nhiều dòng trong cùng paragraph. Toàn bộ 307 test trước
correction được so sánh byte-preserved.

Verdict: **APPROVE**, không có finding trong phạm vi parser đã công bố. Gate độc
lập đạt 321 selftests cộng 4 history tests, validator 25 kế hoạch, format 75
file, lint 3 helper và `git diff --check`. Review này chỉ xác nhận consistency
source/report offline; không thay thế xác minh CI, GitHub hay danh tính
reviewer, và không tự cho phép merge.

## Sửa P2 3942538497 và 3942538499: không lấy evidence hoặc scope từ fenced example

Ngày 2026-09-06, base đúng HEAD PR25 `c897f0fbce5008059f0c5832be274b87a2cbeefa`.
Source mới `1d21220cfd30d175502a0d0f8be4acc7683549eb`, tree
`4fa162f99cd4422582e1689f4aced941853a8621`. Chỉ sửa validator, selftests và
report này; không thay scope/definition/manifest/approval, AGENTS, history
helper hoặc source ứng dụng.

Parser trước quét evidence bằng regex trên body gốc, nên annotation và snippet
chỉ nằm trong outer fenced example vẫn có thể thay evidence thật hoặc tạo
duplicate. Scope cũng được tách từ body gốc: heading, bullet và chuỗi kết thúc
trong fenced example có thể bị hiểu là scope sống.

Bản sửa cho lớp lọc fence giữ offset khi cần: thay các ký tự trong vùng code
bằng khoảng trắng cùng độ dài, giữ newline. Chỉ annotation ngoài fence mới được
dùng để mở evidence block. Sau khi chọn annotation, regex snippet vẫn đọc body
gốc tại đúng offset; path/code/lang và citation liền trước vẫn được kiểm nguyên
văn. Không làm sạch snippet để che drift. Mỗi annotation được xét riêng, không
để một annotation giả trong code kéo regex qua evidence thật phía sau.

Scope dùng cùng structural body đã loại fenced/indented code như kiểm heading.
Heading giả, bullet giả và `Ngoài phạm vi:` trong code không còn thay đổi scope
sống. Ngữ nghĩa marker fence, closing length/type và fence chưa đóng tới EOF giữ
nguyên; không mở phạm vi thành parser CommonMark đầy đủ.

### Red/green và bảo toàn kiểm thử

Trước sửa production helper, chạy:

```sh
node --test --test-name-pattern='^PR25 (outer fence|outer fenced|live evidence after|unclosed outer|fenced scope)' plans/test-validator.mjs
```

Kết quả **1 pass, 16 fail, 0 cancelled, 0 skipped**, exit 1. Có cả lỗi nhận
evidence/scope giả và lỗi báo duplicate/scope mismatch cho example hợp lệ. Ca
đối chứng scope thật thiếu vẫn bị từ chối. Đây là assertion nghiệp vụ, không
phải exception hoặc lỗi Git. Sau sửa cùng 17 ca đạt 17/17.

Các fixture gồm outer backtick dài 4/5, tilde và indentation 3 space, fence chưa
đóng, annotation giả trước evidence thật, sửa snippet thật sau example, scope
list chỉ có trong fence, heading giả trước section thật, terminator giả trong
code và scope mismatch thật. Node assertion xác nhận toàn bộ 361 selftests trước
lượt này còn nguyên byte sau khi bỏ duy nhất đoạn test mới.

| Lệnh                                                                                             | Kết quả                                  |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `node --test plans/test-validator.mjs`                                                           | 378 pass, 0 fail, 0 cancelled, 0 skipped |
| `node --test plans/test-history.mjs` sau source commit sạch                                      | 4 pass, 0 fail, 0 cancelled, 0 skipped   |
| `node plans/validate-plans.mjs`                                                                  | exit 0, đủ 25 kế hoạch                   |
| `deno fmt --no-config --check plans/`                                                            | exit 0, 75 file                          |
| `deno lint --no-config plans/validate-plans.mjs plans/test-validator.mjs plans/test-history.mjs` | exit 0, 3 file                           |
| `git diff --check`                                                                               | exit 0                                   |

Tổng 382 self/history tests. Kiểm `fc39` chỉ là chẩn đoán Git local riêng:
`git rev-parse --verify fc39^{commit}` exit 128 vì object là tree;
`git rev-parse --disambiguate=fc39` trả duy nhất
`fc3999c2ee85b667adbed01db7393063c5548dd2`, `git cat-file -t fc39` trả `tree`.
Chưa có full reviewed SHA của P1 để kiểm ancestry đúng đối tượng; không dùng
prefix này làm bằng chứng nhánh remote mất ref và không nới guard lịch sử.

Không network, Browser, build, push hoặc sửa approval. Gate là consistency
offline, không chứng thực danh tính reviewer. Source/report còn chờ review độc
lập; executor không ghi APPROVE.

## Codex vòng tiếp: review 5125519048

Sáu finding P2 trên reviewed commit `c751e98`, tái hiện đúng bằng chính
validator trước khi sửa. Năm cái được sửa, một cái từ chối kèm số đo.

- Finding
  [3944147990](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944147990):
  block HTML dạng 7 trước sửa chỉ mở khi dòng trước trống, nên một ví dụ nhúng
  viết ngay dưới heading ATX không được ẩn và link trong thân nó bị quét như
  Markdown sống. Thay điều kiện bằng "dòng trước không phải đoạn văn đang mở":
  heading ATX và thematic break kết thúc ngay tại dòng của chúng. Ca sau heading
  và sau thematic break xanh sau sửa; ca thẻ lẻ tiếp ngay sau một đoạn văn vẫn
  đỏ, tức hướng fail-closed không bị nới.
- Finding
  [3944147994](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944147994):
  ranh giới fragment và query trước sửa đọc trên chuỗi thô, nên
  `README.md&num;overview` bị đem cả cụm đi mở như một tên file và `a&#35;b.md`
  bị cắt giữa chính reference. Giải mã character reference trước mọi câu hỏi
  khác về destination, rồi mới tìm ranh giới, kiểm scheme và gỡ backslash.
  Backslash escape vẫn đi đường riêng: `a\#b.md` giữ dấu `#` làm ký tự thật
  trong tên file, còn `a&#35;b.md` giải mã thành `#` viết thẳng vào href nên là
  ranh giới fragment; hai test cạnh nhau giữ hai đường này.
- Finding
  [3944147996](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944147996):
  không sửa, kèm số đo. Đo cả 21 kế hoạch DONE: không cái nào có thân report
  hiện tại khớp `reviewed_evidence_blob` hay `completed_evidence_blob`, ở mọi
  quan hệ đã thử. Bằng nhau nguyên file 0/21, bằng nhau sau khi bỏ frontmatter
  0/21, prefix 0/21; nới nhất là prefix sau khi bỏ frontmatter cả hai phía thì
  cũng chỉ 1/21. Lý do là thiết kế: blob đã duyệt là ảnh chụp tại thời điểm
  reviewer APPROVE, khi frontmatter còn nhỏ và các mục sau chưa được ghi, còn
  report thì tiếp tục được ghi thêm sau approval. Ràng buộc thân hiện tại vào
  blob đó làm gate đỏ ngay 20 tới 21 kế hoạch và chỉ xanh lại được bằng cách tự
  hash report mới như thể reviewer đã duyệt nó, đúng điều `plans/README.md` cấm.
- Finding
  [3944147999](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944147999):
  `existsSync` trên macOS và Windows không phân biệt hoa thường, nên
  `../readme.md` xanh trên máy dev còn hỏng ở bản clone Linux và trên trình
  duyệt repo. Đã đo `realpathSync` không cứu được: trên macOS nó trả lại đúng
  chuỗi hoa thường được đưa vào chứ không chuẩn hóa theo tên thật. Thêm
  `existsCaseExact` so từng thành phần đường dẫn với tên trong thư mục cha, nhớ
  lại kết quả `readdirSync` theo thư mục. Ca sai hoa thường ở tên file và ở tên
  thư mục đều đỏ sau sửa.
- Finding
  [3944148002](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944148002):
  vòng đếm ngoặc của nhãn trước sửa coi mọi dấu `]` là ranh giới, nên
  `[<span title="]">x</span>](y.md)` bị cắt nhãn ngay trong giá trị thuộc tính
  và cả link biến mất khỏi gate. Thêm mẫu neo đầu cho thẻ HTML thô và autolink
  rồi nhảy qua nguyên khối. Code span và comment đã bị `outsideInlineCode` và
  `outsideHtmlComments` xóa trước khi hàm chạy, nên chỉ còn hai dạng này cần
  nguyên khối. Ca thuộc tính và ca autolink chứa `]` đều đỏ sau sửa.
- Finding
  [3944148006](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944148006):
  destination chỉ có fragment trước sửa được bỏ qua hoàn toàn, và fragment của
  link liên file cũng không ai hỏi tới. Thêm `documentAnchors` dựng anchor từ
  heading ATX và setext theo cách GitHub tính slug, cộng mọi `id` và `name` khai
  tay trong HTML thô; heading trùng slug nhận hậu tố `-1`, `-2`. Chỉ hỏi anchor
  khi đích là `.md`, vì fragment trên file nguồn là chuyện của trình duyệt repo.
  Ca `#definitely-not-a-heading` và ca `README.md#` không có thật đỏ sau sửa; ca
  trỏ đúng heading, ca heading lặp và ca `id` tường minh xanh. Hai fixture cũ
  dùng anchor hư cấu `#local-anchor` và `#overview` được đổi sang anchor có
  thật, giữ nguyên ý định kiểm ranh giới destination của chúng.

Harness test đổi theo một chỗ: `readdirSync` một tham số giờ hợp nhất mục ảo của
fixture, vì kiểm hoa thường đọc tên thật trong thư mục cha và một file chỉ có
trong fixture sẽ không bao giờ xuất hiện nếu chỉ đọc đĩa. Nhánh `withFileTypes`
giữ nguyên đường đọc đĩa, để mục ảo không trở thành một kế hoạch mới.

| Lệnh                                   | Kết quả                |
| -------------------------------------- | ---------------------- |
| `node plans/validate-plans.mjs`        | exit 0, đủ 25 kế hoạch |
| `deno fmt --check`                     | exit 0, 315 file       |
| `deno lint`                            | exit 0, 160 file       |
| `node --test plans/test-validator.mjs` | 473 pass, 0 fail       |
| `git diff --check`                     | exit 0                 |

Chạy lại các mẻ probe guard của vòng 14, 15, 16, 17, 18 và 19: không mẻ nào đổi
kết quả, nên năm sửa lần này không nới guard cũ.

## Codex vòng tiếp: review 5125641639

Reviewed commit `90c3bc31ca`, năm finding P2, tất cả trên
`plans/validate-plans.mjs`. Ba trong số đó là hệ quả trực tiếp của chính hai sửa
vòng trước, nên lần này tái hiện từng ca bằng chính validator trước khi chạm vào
code.

- Finding
  [3944262980](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944262980):
  `htmlInlineAtomic` mới chỉ nguyên khối trong vòng cân bằng nhãn đang mở, còn
  vòng quét ngoài vẫn dừng ở mọi dấu `[`, kể cả dấu nằm trong thuộc tính thẻ. Ca
  `<span title="[sample](missing-attribute.md)">` báo `link hỏng` trước sửa,
  xanh sau sửa; ca `<span>nhãn</span> [gone](missing-after-tag.md)` vẫn đỏ, nên
  sửa không nới guard link thật.
- Finding
  [3944262982](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944262982):
  `documentAnchors` quét `id` và `name` trên body thô, nên một ví dụ trong fence
  cũng đứng ra làm anchor. Dựng lại đúng khung nhìn HTML render như đường quét
  `href`/`src`, rồi chỉ đọc thuộc tính nằm trong thẻ mở thật. Ca `#ghost-anchor`
  trong fence đỏ sau sửa; ca comment và ca `id=` viết trong văn xuôi cũng đỏ; ca
  `<a name="...">` thật vẫn xanh.
- Finding
  [3944262984](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944262984):
  split theo chuỗi literal `Ngoài phạm vi:` cắt cả ở câu văn xuôi mở đầu, làm
  danh sách scope biến mất và manifest khai `scope: []` vẫn khớp. Cắt tại đúng
  một khai báo đứng đầu dòng, đòi số khai báo bằng một, cùng cách
  `declarations()` đòi đúng một lần khai trường metadata. Đo trên cây: cả 25 kế
  hoạch đều có đúng một khai báo đầu dòng.
- Finding
  [3944262987](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944262987):
  phép so số lượng trích đoạn thoả mãn được bằng `0 === 0`, đồng thời mất luôn
  kiểm drift với source hiện tại. Đòi ít nhất một evidence record. Đo trước khi
  thêm: cả 25 kế hoạch đã có tối thiểu 1 và tối đa 4 record.
- Finding
  [3944262988](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944262988):
  đổi hai chữ trong plan và hàng README là đủ để vào BLOCKED. `staleReason` được
  tổng quát thành `metadataReason(body, field)`; BLOCKED đòi đúng một
  `blocked_reason` không rỗng cộng `plans/evidence/NNN.md` đã tồn tại. Hai kế
  hoạch BLOCKED là 002 và 021, cả hai đã có sẵn báo cáo, nên chỉ thêm dòng lý do
  lấy từ chính báo cáo đó chứ không dựng vật liệu mới.

Hai test có sẵn phải đổi theo hợp đồng mới, không phải đổi để né. Test
`current source drift regression works without TODO plans in the backlog` chuyển
mọi TODO sang BLOCKED nên giờ phải dựng đủ lý do và báo cáo; báo cáo chỉ tồn tại
trong fixture, không ghi ra đĩa. Test provenance dùng snapshot `5b7d00e` chụp
trước hợp đồng này, nên chỉ chèn đúng dòng metadata mới vào hai kế hoạch BLOCKED
của snapshot, thay vì chép nguyên bản plan hiện tại và kéo theo độ trôi tài
liệu.

| Lệnh                                   | Kết quả                |
| -------------------------------------- | ---------------------- |
| `node plans/validate-plans.mjs`        | exit 0, đủ 25 kế hoạch |
| `deno fmt --check`                     | exit 0, 315 file       |
| `deno lint`                            | exit 0, 160 file       |
| `node --test plans/test-validator.mjs` | 486 pass, 0 fail       |
| `git diff --check`                     | exit 0                 |
| `node --test plans/test-history.mjs`   | 5 pass, 0 fail         |

Chạy lại các mẻ probe guard của vòng 14, 15, 16, 17, 18, 19 và 21: không mẻ nào
đổi kết quả.

## Codex vòng tiếp: review 5125774509

Reviewed commit `9d3c0371f8`, sáu finding P2, tất cả trên
`plans/validate-plans.mjs`. Tái hiện đủ sáu ca bằng chính validator trước khi
chạm vào code, cộng một ca đối chứng cho finding về heading slug.

- Finding
  [3944392985](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944392985):
  comment và raw text element bị xử lý bằng hai hàm nối tiếp, nên hàm chạy trước
  luôn thắng bất kể vị trí. Một chuỗi `"<!--"` viết trong `<script>` mở được
  comment giả nuốt tới hết tài liệu. Gộp thành một lượt quét bằng alternation để
  thứ tự trong tài liệu quyết định; ca ngược lại, `<script>` viết trong comment,
  cũng được kiểm và vẫn phải ở trạng thái đã bị comment hóa.
- Finding
  [3944392989](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944392989):
  numeric reference dải C1 phải đổi theo bảng windows-1252 của chuẩn HTML. Bảng
  ánh xạ viết theo số chứ không theo ký tự, vì `&#x97;` giải mã ra U+2014, thứ
  mà chính gate của repo cấm xuất hiện trong file.
- Finding
  [3944392995](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944392995):
  `headingText` giữ nguyên tên entity nên slug ghi nhận một id không tồn tại,
  trong khi id thật bị coi là anchor hỏng. Giải mã đặt giữa bước gỡ thẻ và bước
  gỡ backslash escape, vì `decodeReferences` dựa vào dấu escape còn nguyên để
  biết một `&` đã bị vô hiệu.
- Finding
  [3944392996](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944392996):
  đổi độ sâu marker luôn cắt section, nên một code span vắt qua lazy
  continuation của blockquote bị tách làm đôi và destination bên trong nó thành
  link sống. Nhận lazy continuation, giới hạn bằng bốn điều kiện để không nới
  quá: không trong fence, dòng này không trống, dòng trước không trống, và dòng
  này không tự mở một block mới.
- Finding
  [3944392999](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944392999):
  vòng cân bằng nhãn quét xuyên dòng trống, dựng ra một link từ hai chuỗi
  literal ở hai đoạn khác nhau. Dừng đúng tại ranh giới đoạn, thoát với `depth`
  còn dương để nhánh sẵn có bỏ qua cả cụm. Chỉ dừng ở dòng trống chứ không dừng
  ở mọi ranh giới block: nhãn được phép xuống dòng trong cùng một đoạn.
- Finding
  [3944393001](https://github.com/hvgllc/hvgerp-mcp/pull/25#discussion_r3944393001):
  bộ đếm theo từng slug gốc cấp lại một id đã có chủ. Chọn hậu tố theo tập id đã
  phát sinh, giữ bộ đếm cũ làm điểm bắt đầu để trường hợp thường vẫn một lần tra
  và vẫn đánh số theo thứ tự tài liệu.

| Lệnh                                   | Kết quả                |
| -------------------------------------- | ---------------------- |
| `node plans/validate-plans.mjs`        | exit 0, đủ 25 kế hoạch |
| `deno fmt --check`                     | exit 0, 315 file       |
| `deno lint`                            | exit 0, 160 file       |
| `node --test plans/test-validator.mjs` | 500 pass, 0 fail       |
| `git diff --check`                     | exit 0                 |
| `node --test plans/test-history.mjs`   | 5 pass, 0 fail         |

Chạy lại các mẻ probe guard của vòng 14, 15, 16, 17, 18, 19, 21 và 22, cộng mẻ
đối kháng 13 ca dựng sau vòng 22: không mẻ nào đổi kết quả.

## Codex vòng tiếp: review 5125832394

Review đọc đúng head `fa7fe14f1a`, nêu ba finding P2, tất cả trên
`plans/validate-plans.mjs`. Mẻ dò đối kháng chạy sau khi vá xong ba finding đó
lộ thêm hai lỗi cùng họ, nên vòng này khép năm sửa.

Cả năm đều tái hiện bằng chính validator trước khi động vào code, và sau khi sửa
đều đảo chiều. Hai ca đối chứng phải giữ xanh (`<a name>` và `<div id>`) vẫn
xanh ở cả probe lẫn suite.

- **Heading trong container không vào tập anchor.** `> ## Quoted anchor probe`
  và `- ## Listed anchor probe` đều render ra heading thật và đều sinh id trên
  GitHub, nhưng `documentAnchors` đọc nguyên dòng nên link đúng bị báo
  `anchor hỏng`. Thêm `outsideContainers` gỡ lặp tiền tố blockquote và list
  marker trước khi khớp heading. Gỡ lặp an toàn với nhánh setext vì một thematic
  break kiểu `- - -` gỡ hết thành dòng rỗng chứ không thành `-`.
- **`name` trên phần tử thường bị nhận là anchor.** `name` chỉ dựng fragment
  trên chính thẻ `<a>`; trên `<div>` hay `<input>` nó là tên trường. Cho
  `htmlTagAttributes` bắt luôn tên thẻ, rồi dựng mẫu thuộc tính theo thẻ:
  `id|name` cho `<a>`, chỉ `id` cho phần còn lại.
- **Đích link chỉ có trong cây làm việc vẫn qua cổng.** `existsSync` trả lời cho
  đúng máy người viết, còn một bản clone sạch thì không có file đó. Thêm
  `trackedTargets()` dựng sẵn tập file và tập thư mục hàm ý từ
  `git ls-files --stage -z`; đích cục bộ phải là file được theo dõi hoặc thư mục
  có ít nhất một file được theo dõi bên dưới. Chỉ mục không đọc được thì
  `trackedArtifacts()` đã báo một lần, nên chỗ này im lặng.
- **`<!--` viết trong backtick nuốt mọi heading phía sau** (tự phát hiện).
  `structuralMarkdown` cố ý không xóa inline code, nên một chuỗi `<!--` trong
  backtick ở giữa tài liệu mở comment giả chạy tới hết file: chính section vòng
  23 của báo cáo này làm mọi heading sau nó biến mất khỏi tập anchor. Đây là
  cùng một sai lầm thứ tự đã vá ở vòng 23 cho raw text element, chỉ khác đường:
  code span và comment là hai token cùng cấp nên phải so ai mở trước.
  `outsideInlineCode` được tách thành `inlineCodeSpans` trả vị trí tuyệt đối, và
  `outsideHtmlComments` bỏ qua dấu mở nằm trong một span mở trước nó. Đảo thứ tự
  hai hàm không giải được, vì hướng ngược lại (một backtick lẻ trong comment
  thật che mất `-->`) hỏng y hệt; test giữ cả hai chiều.
- **Entity trong code span của heading bị giải mã** (tự phát hiện). Nội dung
  code span render nguyên văn, nên ``## Probe `&amp;` code`` có id
  `probe-amp-code`; giải mã nó ra `&` cho slug `probe--code` và link đúng bị báo
  hỏng. `headingText` giờ tách theo code span, chỉ đưa phần ngoài span qua
  decode, gỡ nhãn link, gỡ thẻ và gỡ backslash escape.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 513 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 13 test, lên 513. Harness đổi một chỗ đi kèm sửa thứ ba: filesystem
ảo của fixture đại diện cho artifact có thật trong repo nên `run()` nối nó vào
output `ls-files --stage`; mục khai `{ kind: "file", tracked: false }` là ca chỉ
có trong cây làm việc.

Chạy lại toàn bộ mẻ dò guard của các vòng 14, 14b, 14c, 15, 15b, 16, 17, 18,
18f, 18g, 19, 21, 22 và 23, lần này so từng dòng với chính chúng chạy trên một
worktree tách ở `fa7fe14`. Mọi ca giữ nguyên kết quả trừ đúng một chỗ: ca `v2`
của vòng 19 đổi từ `Đạt` sang `link chưa được Git theo dõi`. Đó là gate mới hoạt
động đúng chứ không phải hồi quy, vì ca ấy dựng fixture `link©target.md` ngay
trên đĩa mà không thêm vào chỉ mục. Thông báo mới vẫn chứng minh đúng điều ca đó
đo: đường dẫn phải giải mã ra `©` mới đi qua được kiểm tồn tại và kiểm hoa
thường, rồi mới vướng kiểm chỉ mục; giải mã sai thì lỗi đã là `link hỏng`.

## Codex vòng tiếp: review 5125941162

Review đọc đúng head `e1ddf95596`, nêu tám finding: một P1 về cách đưa nhánh vào
main và bảy P2 trên `plans/validate-plans.mjs`. Mẻ dò đối kháng chạy trước khi
review về lộ thêm một lỗi cùng họ, nên vòng này khép tám sửa code.

Cả tám đều tái hiện bằng chính validator trước khi động vào code, và sau khi sửa
đều đảo chiều. Bốn ca đối chứng phải giữ xanh vẫn xanh: thẻ thật trong heading
vẫn bị gỡ, setext trong blockquote vẫn là heading, comment thật trong khối HTML
vẫn che link, và ngoài khối HTML thì backslash vẫn vô hiệu hóa dấu mở comment.

- **Provenance phải còn trong ancestry của commit được đưa vào main** (P1).
  Finding đo đúng thứ đã ghi: một commit chỉ mang cây kết quả làm mất mọi
  revision đã ghim, và validator không đọc nổi `definition_commit` lẫn
  `reviewed_commit` trong một clone sạch. Không có gì để sửa trong code; ràng
  buộc nằm ở `plans/AGENTS.md` dòng 30-35 và `plans/README.md` dòng 137, và
  nhánh phải vào main bằng merge commit chứ không squash hay rebase.
- **Nội dung thụt năm khoảng trắng sau list marker bị nhận là heading** (tự phát
  hiện). `outsideContainers` gỡ sạch khoảng trắng sau marker, nên
  `-     ## Indented probe` hóa thành ATX heading trong khi CommonMark render nó
  là indented code. Anchor tưởng tượng đó cho một link hỏng đi qua cổng. Nhánh
  khoảng trắng của `containerPrefix` giờ chép đúng luật thụt: một tới bốn khoảng
  trắng thì nội dung bắt đầu ngay sau chúng, từ năm trở lên thì chỉ một khoảng
  trắng thuộc về marker và phần dư là code.
- **Autolink trong heading bị gỡ như thẻ.** `## See <https://example.com>`
  render ra link mà văn bản hiển thị chính là URL, nên id là
  `see-httpsexamplecom`; gỡ cả cụm để lại `see-`. `headingText` giờ trả autolink
  URI và thư điện tử về văn bản hiển thị trước khi gỡ thẻ thật.
- **Character reference trong `id` và `name` không được giải mã.** Trình duyệt
  đọc id của `<a id="probe&amp;anchor">` là `probe&anchor`, và phía link đã
  percent-decode fragment từ trước. Ghi nguyên văn cách viết thì id thật vắng
  mặt còn một chuỗi không tồn tại lại có mặt; giá trị giờ đi qua
  `decodeReferences`.
- **Thuộc tính được dò bằng chuỗi con thay vì tách token.**
  `<span title="href='missing.md'">` làm gate báo link hỏng vì mẫu `href|src`
  khớp vào bên trong giá trị của thuộc tính khác. `tagAttributes()` quét cặp tên
  và giá trị từ trái sang phải, nên giá trị trong nháy bị nuốt cùng thuộc tính
  sở hữu nó. Cùng hàm này thay luôn đường dò `id`/`name` vốn mắc y hệt.
- **Title của link không nhận dấu bao quanh đã escape.**
  `[readme](../../README.md "a \"quoted\" title")` bị đem cả destination lẫn
  title đi phân giải như một đường dẫn. Ba dạng title trong `linkDestination`
  giờ nuốt cặp backslash trước khi xét dấu đóng.
- **Scheme được phân loại trước khi gỡ backslash.**
  `[external](https\://example.com/path)` render ra địa chỉ ngoài đủ scheme
  nhưng rơi xuống nhánh đường dẫn cục bộ. Phân loại giờ chạy trên bản đã gỡ
  escape, còn ranh giới fragment và query vẫn đọc bản còn escape, vì ở đó chính
  dấu escape phân biệt ký tự thật với vách ngăn.
- **Setext được suy ra qua ranh giới container.** `- Ghost list item` theo sau
  bởi `---` render ra một list rồi một thematic break, nhưng tiền tố container
  bị xóa trước phép kiểm kề nhau nên hai dòng trông như một đoạn và underline
  của nó. `documentAnchors` giữ lại tiền tố từng dòng và chỉ nhận setext khi hai
  dòng cùng tiền tố. Một underline thụt sâu hơn trong cùng list item bị bỏ qua
  thay vì nhận nhầm, tức lệch về phía báo hỏng chứ không phía bỏ lọt.
- **Backslash được coi là escape cả bên trong khối HTML thô.** Trong một khối
  HTML, backslash là ký tự thường nên `\<!--` vẫn mở comment thật và thân
  comment không render. Hỏi luật Markdown ở mọi vị trí thì một href đã bị chú
  thích ở lại trước mắt đường thu link. `outsideRawTextAndComments` giờ tra một
  mặt nạ khối HTML giữ nguyên offset, và chỉ dựng mặt nạ khi thật sự gặp dấu mở
  có backslash đứng trước.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 529 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 16 test, lên 529.

Chạy lại toàn bộ mẻ dò guard của các vòng 14, 14b, 14c, 15, 15b, 16, 17, 18,
18f, 18g, 19, 21, 22, 23 và 24 trên một worktree tách ở `e1ddf95` rồi so từng
dòng với chính chúng chạy trên cây đã sửa. Mọi ca giữ nguyên kết quả; khác biệt
duy nhất là thời gian chạy in kèm một test của mẻ 18f.

Hai phía phải chạy tuần tự chứ không song song, và chín mẻ dò cũ vốn ghim cứng
đường dẫn cây làm việc đã được sửa để nhận tham số. Chạy chồng thì hai tiến
trình cùng ghi rồi cùng khôi phục một tập tin, và bảng so ra hàng loạt khác biệt
giả không thuộc về sửa nào cả.

## Codex vòng tiếp: review 5126018121

Review đọc đúng head `ca744cde2c`, nêu bốn finding P2, tất cả trên
`plans/validate-plans.mjs`. Cả bốn tái hiện bằng chính validator trước khi động
vào code, và sau khi sửa đều đảo chiều. Mẻ dò đối kháng mười bốn ca chạy trước
review không lộ thêm lỗi nào, và chạy lại sau khi sửa vẫn giữ nguyên kết quả.

- **Nhãn reference chết bị thu gọn trong slug heading.**
  `## [Ghost][undefined-ref]` không có định nghĩa nào thì CommonMark render
  nguyên văn cả cụm và id GitHub sinh ra là `ghostundefined-ref`; thu gọn vô
  điều kiện ghi `ghost`, tức vừa nhận link tới anchor không tồn tại vừa báo hỏng
  link tới anchor thật. `documentAnchors` giờ dựng tập nhãn có định nghĩa từ
  Markdown cấu trúc, chuẩn hóa nhãn theo cách CommonMark so khớp, và
  `headingText` chỉ thu gọn khi nhãn sống. Dạng collapsed nhãn rỗng vẫn thu gọn
  vô điều kiện vì hai lối đọc cùng ra một slug.
- **Heading setext nhiều dòng chỉ lấy dòng cuối.** `Multiline setext` rồi
  `heading probe` rồi `---` là một heading với id
  `multiline-setext-heading-probe`; ghi mỗi `heading-probe` thì link tới id thật
  bị báo hỏng còn link tới id tưởng tượng lại qua cổng. Nhánh setext giờ lùi hết
  đoạn văn ngay trước hàng gạch rồi nối bằng một khoảng trắng, dừng ở dòng
  trống, ở heading ATX, ở một hàng gạch khác, ở thematic break, và ở dòng tự mở
  container.
- **Nhãn link bắc qua ranh giới khối.** Một đoạn kết thúc bằng `[` rồi ngay dòng
  sau là `# Boundary heading probe` rồi `](missing.md)` không render ra link
  nào, nhưng vòng cân bằng nhãn chỉ dừng ở dòng trống nên gate đem destination
  đó đi phân giải và báo hỏng một tài liệu đúng. Phép kiểm dòng trống giờ là một
  mục trong danh sách dòng chen được vào giữa đoạn: dòng trống, heading ATX,
  thematic break, hàng gạch setext, và list item có nội dung. Blockquote cố ý
  vắng mặt, vì `>` đầu dòng nối thuộc về chính khối đang mở và cắt ở đó sẽ thả
  một destination hỏng qua cổng.
- **Dòng nối của list item không được gỡ thụt kế thừa.** `123. list item` rồi
  một dòng thụt năm khoảng trắng mang `## Continued list heading` là heading
  thật bên trong item, nhưng phép gỡ container chạy rời rạc từng dòng để lại
  nguyên thụt và đọc nó thành indented code. `outsideContainers` được thay bằng
  `scanContainers`, một lượt quét giữ ngăn xếp container đang mở: blockquote đòi
  marker trên mọi dòng, list item chỉ đòi đủ thụt, và dòng trống không đóng
  container nào. Nhánh setext giờ so độ sâu container cùng cờ tự mở container
  thay vì so chuỗi tiền tố, nên vừa giữ được guard của vòng trước vừa nhận đúng
  `- Setext in item` theo sau bởi một hàng gạch thụt.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 542 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 13 test, lên 542.

## Codex vòng tiếp: review 5126092642

Review đọc đúng head `9064486852`, nêu một P1 provenance và bốn P2, tất cả trên
`plans/validate-plans.mjs`. P1 lặp lại điểm của vòng trước và vẫn được trả lời
như cũ: phép kiểm ancestry là chủ ý, nhánh vào `main` bằng merge commit chứ
không squash, điều đã ghi ở `plans/AGENTS.md` và `plans/README.md`. Bốn P2 tái
hiện bằng chính validator trước khi động vào code; ba trong số đó đã đảo chiều
sau khi sửa, còn P2 về scheme một ký tự được giữ nguyên có chủ ý vì bản sửa làm
hỏng một phép chặn drive path đã có test. Một lỗi tự phát hiện cùng họ, dòng nối
thụt bằng tab, được sửa trong cùng đợt.

- **Thẻ mở bị escape vẫn bị thu href.** `\<a href="missing.md">` là văn bản chứ
  không phải thẻ, CommonMark không render link nào, nhưng gate vẫn đem
  destination đó đi phân giải và báo hỏng một tài liệu đúng. Vòng quét HTML thô
  giờ đi qua `renderedTags`, hỏi `markdownEscaped` ở đúng phần văn bản ngoài
  HTML block: bên trong block thì backslash không escape gì nên thẻ vẫn sống.
  Vòng quét anchor trên `renderedHtml` fail-open theo cùng cách với `id`/`name`,
  nên dùng chung helper.
- **Scheme một ký tự bị coi là đường dẫn cục bộ: giữ nguyên có chủ ý.** RFC 3986
  cho phép scheme dài đúng một ký tự, nên `x:opaque` đúng là địa chỉ ngoài. Bản
  sửa thử, nhận scheme một ký tự trừ khi sau `:` là `\` hoặc `/`, làm đỏ một
  test đã có: `C:outside-plan.md` là đường dẫn ổ đĩa Windows tương đối, không có
  dấu phân cách sau dấu hai chấm, và trùng hình dạng với `x:opaque`. Hai dạng
  không phân biệt được bằng cú pháp, nên cổng chọn phía an toàn: từ chối một
  scheme một ký tự giả định chỉ buộc tác giả viết khác đi, còn nhận nhầm một
  drive path thành địa chỉ ngoài là thả nó vào filesystem của người đọc. Lý do
  đó được ghi vào comment ngay trên phép kiểm, và phía drive path có thêm hai
  test cho dạng `c:\temp\file.md` và `c:/temp/file.md`. Một khối comment bị dán
  lặp hai lần ngay trên phép kiểm này cũng được gỡ.
- **Dấu nhấn gạch dưới lọt vào slug heading.** `## _Emphasized_ probe` render ra
  `Emphasized probe` và id GitHub là `emphasized-probe`; dấu sao tự biến mất vì
  `headingSlug` xóa nó, còn gạch dưới thì được giữ nên slug thành
  `_emphasized_-probe` và mọi link tới heading có nhấn bị báo hỏng.
  `headingText` gỡ cặp nhấn trước khi slug, lặp cho tới khi ổn định để cặp lồng
  rụng hết, và chỉ gỡ cặp mở đóng ở ranh giới từ nên `snake_case` nguyên vẹn.
  Gạch dưới không phải delimiter được che bằng một dấu NUL mà cả hai đầu của
  pattern từ chối: ký tự sinh từ backslash escape, ký tự sinh từ character
  reference, và nội dung code span.
- **Link lồng link không vô hiệu opener ngoài.** CommonMark cấm link trong link,
  nên `[outer [inner](a.md)](b.md)` render ra link tới `a.md` rồi `](b.md)`
  nguyên văn; đẩy `b.md` vào gate là báo hỏng một tài liệu đúng.
  `inlineLinkTargets` giờ là lớp mỏng bọc `scanInline`, hàm trả về cả cờ đã nhận
  một link. Label được quét trước khi ghi destination ngoài; label đã chứa link
  thì destination ngoài bị bỏ còn đích bên trong vẫn giữ. Image được miễn vì
  label của image không vô hiệu link bao ngoài, nhưng cờ vẫn đi ngược lên qua
  image vì link nằm sâu trong đó vẫn là link thật với opener bao ngoài.
- **Thụt bằng tab không được quy đổi thành cột.** Lỗi tự phát hiện bằng mẻ dò
  đối kháng chạy sau vòng trước, cùng họ với lỗi dòng nối của list item. `1.`
  rồi một tab đặt nội dung ở cột bốn, nên dòng nối thụt đúng một tab vẫn nằm
  trong item; đếm ký tự thì nó chỉ được một cột, bị đẩy ra khỏi item và một
  heading thật trong item vắng mặt khỏi tập anchor. `scanContainers` đo thụt
  bằng cột với mốc bốn, và phần dư của một tab bắc qua mốc ở lại dưới dạng
  khoảng trắng.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 557 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 15 test, lên 557. Mười lăm mẻ dò guard của các vòng trước chạy lại
trên cây mới cho kết quả trùng ảnh chụp ở vòng trước.

## Codex vòng tiếp: review 5126196497

Review đọc đúng head `f9e33adc7f9bba4b54def95c1f5900fb80c2d09d` và nêu bảy P2,
tất cả trên `plans/validate-plans.mjs`. Cả bảy tái hiện hai chiều bằng mẻ dò
mười bảy ca (gồm đối chứng) trước khi động vào code.

- **`href` và `src` bị đọc trên mọi thẻ.** `<div href="x.md">` không tải gì cả
  nên không có link để hỏng, mà cổng vẫn đem thuộc tính chết đó đi phân giải và
  báo hỏng một tài liệu đúng. Hai thuộc tính giờ chỉ đọc trên phần tử thật sự
  định nghĩa chúng; danh sách vẫn giữ nhóm SVG (`use`, `image`, `mpath`,
  `textPath`, `feImage`) để một đích hỏng ở đó không đi qua.
- **Code span ghép từ hai run backtick lệch độ dài.** Một run chỉ đóng bằng run
  dài đúng bằng nó, nên phép cắt cũ dựng ra một span không tồn tại, giữ nguyên
  văn phần lẽ ra được giải mã, và sinh slug khác slug thật của GitHub.
  `splitCodeSpans` quét run, bỏ qua backtick bị escape, và để run lẻ đôi ở lại
  làm văn bản.
- **Nhãn link lồng ngoặc vuông trong heading.** Mẫu phẳng dừng ở dấu `]` đầu
  tiên nên cả cụm kể cả destination rơi vào slug. `stripHeadingLinks` quét cân
  bằng độ sâu, nhảy qua thẻ HTML nguyên khối, đọc đuôi `(...)` hoặc `[label]`,
  rồi đệ quy vào chính nhãn vì image lồng trong link được.
- **Definition trong container không được thu.** Cả hai đường quét definition
  giờ đi qua một hàm chung đọc dòng đã gỡ container, cùng khung nhìn với vòng
  quét heading, nên một nhãn định nghĩa trong blockquote vẫn sống.
- **Thẻ inline bị cắt ở dấu `>` trong giá trị thuộc tính.** Gỡ bằng chính mẫu
  nguyên khối đã dùng ở đường quét inline, nên phần đuôi của thẻ không còn rớt
  vào slug.
- **Destination bắc qua ranh giới đoạn.** Vòng cân bằng ngoặc dừng ở dòng ngắt
  đoạn, cùng phép kiểm mà vòng quét nhãn đang dùng, nên một dấu `(` cuối đoạn
  không còn cặp với một dấu `)` tận đâu và nuốt cả đoạn văn ở giữa làm đường
  dẫn.
- **Definition ngắt được đoạn đang chạy.** Hàm chung giữ cờ đoạn: dòng trống,
  dòng tự mở container và dòng đổi độ sâu container đều đóng đoạn, còn một dòng
  trông như definition viết nối ngay dưới văn xuôi là văn bản literal.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 575 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 18 test, lên 575. Mười lăm mẻ dò guard chạy lại trên cây mới: mười
bốn mẻ trùng ảnh chụp vòng trước, mẻ còn lại lệch đúng một ca có chủ ý. Ca đó
viết một title sau dòng trống; chuẩn không cho destination hay title chứa dòng
trống nên cả cụm là văn bản literal, cổng cũ báo hai lỗi cho một link không tồn
tại còn cổng mới im lặng đúng. Ca đó đã thành một test riêng.

## Codex vòng tiếp: review 5126308309

Review đọc đúng head `20d51a206a4a6bea94809c98db66a17af3637fc0` và nêu mười ba
P2, tất cả trên `plans/validate-plans.mjs`. Cả mười ba tái hiện hai chiều bằng
một mẻ dò mười tám ca trước khi động vào code, và mười hai ca đúng. Ca còn lại
được bác bỏ bằng chính cmark 0.31.2, xem mục cuối.

- **Destination trong nhãn image bị đem đi phân giải.** Nội dung giữa `![` và
  `]` là văn bản thay thế, không renderer nào tải link lồng trong đó, nên cổng
  báo hỏng một đường dẫn không tồn tại trong tài liệu dựng ra. `scanInline` chốt
  cờ `image` trước khi đẩy đích của nhãn; chiều ngược lại, ảnh lồng trong nhãn
  của một link, vẫn tải nguồn như cũ.
- **Code span không gỡ một khoảng trắng đệm.** Chuẩn bỏ đúng một dấu cách ở mỗi
  đầu khi cả hai đầu đều có và phần còn lại không rỗng, để một span chứa được
  dấu backtick. Thiếu phép gỡ đó, slug của heading lệch khỏi slug GitHub đúc và
  một link đúng bị báo `anchor hỏng`. `codeSpanContent` làm phép gỡ đó, sau khi
  quy mọi ký tự xuống dòng về dấu cách.
- **Bảng named reference chỉ có Latin-1.** `&alpha;` không giải mã nên slug
  thiếu ký tự thật của heading. Fail-closed sai chiều ở đây: một tên chưa giải
  mã không làm cổng chặt hơn, nó làm cổng mô tả một heading không tồn tại. Bảng
  thay bằng toàn bộ 2125 tên HTML5 có dấu chấm phẩy, mã hoá dạng `name=hex` nên
  không ký tự vô hình nào lọt vào mã nguồn.
- **Dấu chéo ngược trong giá trị thuộc tính bị coi là escape.** Trong HTML thô
  đó là dữ liệu thường, nên `<a id="\&amp;">` đúc ra id `\&`. Cổng áp
  `markdownEscaped` ở đó và từ chối một fragment đúng. `decodeReferences` thêm
  cờ `escapes`, mặc định bật cho văn bản Markdown và tắt ở đường thuộc tính.
- **Fence không mở trên dòng có marker container.** `> ~~~` và `- ~~~` đều mở
  một khối mã, nhưng cổng đọc nguyên dòng nên không thấy. Hậu quả hai chiều: một
  heading trong ví dụ lọt vào tập anchor, và một link chết viết trong ví dụ bị
  báo hỏng. `outsideFencedCode` gỡ marker blockquote bằng `stripQuoteMarkers`
  dùng chung, thử mở fence trên phần sau marker danh sách, và đóng fence khi
  blockquote chứa nó kết thúc.
- **Fence đóng đo thụt lề sai gốc.** Dòng đóng được thụt tối đa ba cột tính từ
  lề container, không phải từ dòng mở. Cả hai đường quét giờ so với
  `listIndent + 3`, nên một dòng thụt sâu không còn đóng sớm khối mã và kéo theo
  cả phần nội dung phía dưới.
- **Destination trong ngoặc nhọn bắc qua dòng.** Chuẩn cấm ký tự xuống dòng
  trong dạng `<...>`, nên cụm bắc hai dòng là văn bản literal. `linkDestination`
  và `inlineDestination` dựng từ một nguồn chung có nhánh nhọn `[^<>\r\n]*`, và
  `scanInline` bỏ qua cụm nhiều dòng không parse được. Cụm một dòng vẫn
  fail-closed, vì ở đó cú pháp sai gần như luôn là link gõ hụt.
- **`xlink:href` không được đọc.** Cách viết cũ của SVG trỏ đích thật, nên một
  đích hỏng ở đó đi qua cổng. `linkAttribute` nhận thêm tên này trên đúng nhóm
  phần tử đang nhận `href`.
- **Thuộc tính trùng tên đăng ký cả hai giá trị.** HTML giữ lần xuất hiện đầu và
  bỏ mọi lần sau, kể cả khi lần đầu không có giá trị. `tagAttributes` theo dõi
  tên đã gặp, nên một id ma không còn làm fragment chết đi qua cổng.
- **Chuỗi `<!--` trong giá trị thuộc tính mở một comment.** Comment giả đó chạy
  tới cuối tài liệu và nuốt mọi link phía sau, một lỗ hổng im lặng chứ không
  phải cách đọc chặt. `rawTextOrComment` thêm nhánh đầu khớp thẻ mở thường và
  scanner bước qua nguyên vẹn; `script`, `style`, `textarea` giữ cách xử lý raw
  text như cũ.
- **HTML block trong blockquote không được nhận.** `> <div>` không mở khối nào
  nên heading bên trong lọt vào tập anchor. `outsideHtmlBlocks` gỡ marker
  blockquote trước khi thử dòng mở, dòng đóng và dòng trống, và đóng khối khi
  blockquote chứa nó kết thúc, dùng chung `stripQuoteMarkers` với đường fence.
- **Dòng nối của definition vượt ranh giới khối.** Một dòng mở container ngay
  dưới nhãn không phải phần tiếp của definition. `referenceDefinitions` chỉ nhận
  dòng nối khi nó không mở container, giữ nguyên độ sâu và là văn xuôi; một nhãn
  không có destination nào trả về nguyên đoạn văn.
- **Bác bỏ: `[home]( "tooltip")` không phải destination rỗng kèm title.** cmark
  0.31.2 dựng cụm đó thành `<a href="%22tooltip%22">`: bộ phân giải đọc
  destination trước, và một chuỗi trong dấu nháy là destination hợp lệ. Dạng cho
  `href` rỗng kèm title là `[home](<> "tooltip")`, và dạng đó vốn đã đúng.
  `inlineDestination` chỉ nới thêm dạng rỗng hoàn toàn `[home]()`.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 597 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 22 test, lên 597. Mười lăm mẻ dò guard của các vòng trước chạy lại
trên cây mới cho kết quả trùng ảnh chụp vòng trước, và mẻ mười tám ca của vòng
này cho mười bảy ca đổi chiều đúng như mong đợi, ca thứ mười tám giữ nguyên vì
đó là ca bị bác bỏ.

## Codex vòng tiếp: review 5126488095

Review đọc đúng head `669c6638`, nêu năm P2 và không P1 nào. Cả năm tái hiện
bằng một mẻ dò mười tám ca trước khi động vào code, và cmark 0.31.2
(`npm:commonmark`, chạy qua `deno run -A`) làm trọng tài cho từng ca. Cả năm
đúng.

- **`srcset` không vào tập đích.** Trình duyệt chọn và tải đúng một ứng viên
  trong danh sách theo mật độ điểm ảnh hay khổ màn hình, nên mọi URL ở đó là tài
  nguyên thật. `attributeTargets` tách `srcset` trên `img` và `source` theo đúng
  thuật toán của HTML: dấu phẩy chỉ kết thúc ứng viên khi đứng cuối URL hoặc
  cuối descriptor, nên `a.png 1x, b.png 2x` cho hai URL còn `a.png 1x` cho một,
  và không descriptor nào bị đem đi phân giải như tên file.
- **List ngắt đoạn văn vô điều kiện.** Chuẩn chỉ cho một list ngắt đoạn đang
  chạy khi item đầu có nội dung và, với list đánh số, khi số bắt đầu là 1;
  `Paragraph` rồi `2. ## Ghost` vì thế vẫn là một đoạn văn. `scanContainers`
  mang theo trạng thái đoạn và từ chối mở container list không đủ điều kiện.
  Luật khoanh hẹp: blockquote vẫn ngắt được mọi lúc, thoát khỏi container là đã
  đóng đoạn bên trong nên `1. item` rồi `2. item` vẫn mở hai item, và container
  ngoài vừa mở trên cùng dòng cũng đóng đoạn cũ.
- **Title của definition bị đọc như văn bản render.** Title là metadata, đi ra
  HTML nguyên văn trong thuộc tính `title`, nên nhãn trông giống link nằm trong
  đó không phải link của ai cả. Definition được phân giải trước vòng quét inline
  và những dòng chúng chiếm bị che khỏi văn bản đưa cho `inlineLinkTargets`;
  đích thật vẫn vào gate ở vòng definition ngay dưới, nên che dòng không mở lỗ
  nào. Một cụm có title hỏng vẫn bị bác như cũ.
- **Đuôi link trong heading chỉ cần ngoặc cân bằng.** Đích trần chứa khoảng
  trắng làm cả đuôi thành văn bản literal, nên một heading viết
  `## [Ghost](https://example.com bad)` không mang id `ghost`. `linkTail` đòi
  phần trong ngoặc khớp grammar destination trước khi báo có đuôi; đuôi đúng
  grammar vẫn cho slug lấy từ nhãn.
- **Setext gộp cả reference definition vào slug.** Definition là khối riêng và
  không góp gì vào heading. `referenceDefinitions` trả thêm phạm vi dòng của
  từng definition, và vòng quét ngược của setext dừng ở những dòng đó, cả với
  dòng ngay trên hàng gạch lẫn mọi dòng nó lùi qua.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 614 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 17 test, lên 614. Mẻ dò mười hai ca của vòng này cho cả mười hai đổi
chiều đúng như mong đợi, và mẻ sáu ca biên kèm theo giữ đúng chiều cả sáu.

## Codex vòng tiếp: review 5126566649

Review đọc đúng head `a1ac4898`, nêu bốn P2 và không P1 nào. Cả bốn tái hiện
bằng một mẻ dò tám ca trước khi động vào code, và cmark 0.31.2
(`npm:commonmark`, chạy qua `deno run -A`) làm trọng tài cho ca tranh chấp. Cả
bốn đúng.

- **Nhãn definition không bắc được qua dòng.** Chuẩn cho nhãn trải nhiều dòng:
  `[multi` rồi `line]: missing.md` định nghĩa nhãn `multi line`, và cmark render
  `[visible][multi line]` phía dưới thành một link thật. Lớp ký tự của nhãn cấm
  ký tự xuống dòng nên cả definition lẫn đích của nó vắng mặt khỏi cổng, và một
  đích chết đi qua. `definitionAt` nối các dòng kế chừng nào chúng còn là văn
  bản của cùng khối (`!opened`, cùng `depth`, `paragraphText`) và dừng ở giới
  hạn 999 ký tự của chuẩn; con trỏ nhảy tới dòng mang dấu hai chấm nên phạm vi
  che dòng vẫn phủ trọn cụm. Dòng trống vẫn cắt đứt nhãn vì nó kết thúc đoạn,
  đúng cmark.
- **Báo cáo BLOCKED chỉ cần tồn tại.** README đòi báo cáo giữ lệnh thất bại và
  quyết định còn thiếu, nhưng cổng chỉ hỏi file có mặt hay không, nên một báo
  cáo bị xóa ruột vẫn giữ nguyên trạng thái. Cổng giờ đọc nội dung và đòi ba dấu
  hiệu đo được: báo cáo nói đúng mã kế hoạch nó thuộc về, tự khai `BLOCKED`, và
  giữ ít nhất một khối lệnh. Văn xuôi vẫn là việc của review, không phải của
  cổng.
- **Link tới gốc repo bị bác oan.** `relative` mô tả gốc repo bằng chuỗi rỗng,
  thứ không nằm trong tập file lẫn tập thư mục theo dõi, nên `[root](../../)` bị
  báo là chưa được Git theo dõi dù gốc chứa đầy file theo dõi. Nhánh báo lỗi bỏ
  qua đúng chuỗi rỗng; thư mục con và đường dẫn ngoài chỉ mục vẫn xử như cũ.
- **Ô ID README bị ghim ba chữ số.** Manifest chỉ sinh ID ba chữ số, nên mọi ô
  toàn số khác ba chữ số cũng là ID lạ; ghim độ dài thì một hàng mang `1000`
  không bị ai hỏi tới và danh mục quảng cáo thêm kế hoạch ngoài bộ đã duyệt. Bộ
  lọc đổi sang mọi ô toàn số.

| Cổng                                   | Kết quả            |
| -------------------------------------- | ------------------ |
| `node plans/validate-plans.mjs`        | Đạt: 25 kế hoạch   |
| `deno fmt --check`                     | 315 file           |
| `deno lint`                            | 160 file           |
| `node --test plans/test-validator.mjs` | 624 pass           |
| `git diff --check`                     | exit 0             |
| `node --test plans/test-history.mjs`   | 5 pass, sau commit |

Suite thêm 10 test, lên 624. Harness đọc thêm khoá `content` của filesystem ảo,
để một gate đọc nội dung file ảo không còn vấp ENOENT. Mẻ dò tám ca của vòng này
cho cả tám đúng chiều: bốn ca lỗi đổi sang đỏ, bốn ca đối chứng giữ nguyên chiều
cũ.
