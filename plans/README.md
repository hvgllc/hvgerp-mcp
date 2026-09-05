# Bộ kế hoạch cải tiến

Soạn ngày 2026-09-05 từ audit `improve deep`, mốc source `d2c5305`. Đã bao phủ
22/22 phát hiện và 3/3 hướng phát triển. Đây là sản phẩm tư vấn: 25 kế hoạch đã
được viết và review. Ngày 2026-09-05, người dùng đã yêu cầu thực thi toàn bộ và
chấp thuận worktree Git tạo thủ công. Trạng thái thực thi nằm ở bảng bên dưới;
Theo goal hiện tại, DONE chỉ áp dụng khi đủ tiêu chí, review, CI bắt buộc và đã
merge vào main. Mục 001 và 024 đã merge qua PR #23 tại commit 013a1cf; mục 004
đã merge qua PR #24 tại commit fbe9528. Chi tiết ở
[execution-run.md](execution-run.md).

## Cách sử dụng và phạm vi

Đọc trọn một kế hoạch trước khi thực thi. Mỗi file có chứng cứ, phạm vi, bước
kiểm tra, regression tests, điều kiện dừng và tiêu chí hoàn tất. Số 001-022 ánh
xạ trực tiếp mục audit 1-22; mục020 chứa hai biên schema của cùng một phát hiện.
Số023-025 lần lượt là Stock Ledger Timeline, setup readiness và Customer360, chỉ
lập thiết kế, không xây tính năng.

Lượt soạn trước chỉ ghi trong `plans/`. Đợt execute hiện tại cho phép executor
sửa đúng phạm vi và commit trong worktree riêng; advisor giữ vai trò review.
Source của main, phiên bản và `execution-notes.md` cá nhân ở gốc vẫn giữ nguyên.
Goal đã cho phép commit, push, PR, workflow Test và merge sau đủ các gate. Không
tự publish hoặc tác động production. Kết quả từng lệnh phải được ghi trong
evidence, không suy ra đã chạy thành công từ bảng lệnh kế hoạch.

## Danh mục và thứ tự thực thi

Ưu tiên P1 là rủi ro đúng đắn/an toàn hoặc điều kiện kiểm thử cần xử lý sớm; P2
là độ bền, tái lập và tài liệu; P3 là khảo sát sản phẩm. S/M/L và LOW/MED/HIGH
là ước lượng công sức/rủi ro sửa, không phải cam kết thời hạn.

| ID  | Kế hoạch                                                                                            | Ưu tiên | Công sức / rủi ro                                         | Phụ thuộc     | Thực thi |
| --- | --------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------- | ------------- | -------- |
| 001 | [Từ chối cấu hình OAuth chưa đầy đủ](001-reject-partial-oauth.md)                                   | P1      | S / thấp; giữ chế độ không auth chủ động                  | không         | DONE     |
| 002 | [Kiểm câu trả lời MRTR trước mọi thao tác ghi](002-mrtr-preflight-before-write.md)                  | P1      | L / vừa; thay ranh giới phân giải và thực thi             | không         | BLOCKED  |
| 003 | [Trả dữ liệu mới sau giao và bỏ giao việc](003-assignment-cache-invalidation.md)                    | P1      | S / thấp; ảnh hưởng cache hit                             | không         | TODO     |
| 004 | [Áp timeout cho toàn bộ phản hồi ERPNext](004-response-body-timeout.md)                             | P1      | S / thấp; giữ chính sách không retry write                | không         | DONE     |
| 005 | [Tính analytics trong company và đồng tiền xác định](005-analytics-currency-context.md)             | P1      | L / vừa; thay ý nghĩa số tiền đang hiển thị sai           | không         | TODO     |
| 006 | [Tổng hợp đủ dữ liệu trước khi tạo KPI và top N](006-complete-analytics-aggregates.md)              | P1      | L / vừa; lượng truy vấn và ngữ nghĩa tổng                 | 005           | TODO     |
| 007 | [Thiết lập typecheck thực cho mã browser](007-browser-typecheck-gate.md)                            | P1      | M / thấp; không nới strict                                | không         | TODO     |
| 008 | [Xuất CSV đúng cấu trúc và giữ văn bản là văn bản](008-safe-csv-export.md)                          | P1      | S / thấp; cần giữ kiểu số                                 | 007           | TODO     |
| 009 | [Chỉ áp kết quả bất đồng bộ vào đúng phiên mở thẻ](009-kanban-detail-request-identity.md)           | P1      | M / vừa; không hủy mutation đã gửi                        | 007           | TODO     |
| 010 | [Kiểm trạng thái Kanban bằng dữ liệu mới và bảo vệ ghi](010-kanban-conflict-protection.md)          | P1      | M / vừa; phụ thuộc hợp đồng optimistic locking của Frappe | không         | TODO     |
| 011 | [Giữ kết quả batch đã thực thi khi upstream ném lỗi](011-shim-partial-batch-errors.md)              | P1      | M / vừa; semantics JSON-RPC batch                         | không         | TODO     |
| 012 | [Không tái nạp snapshot cũ sau cache invalidation](012-cache-inflight-invalidation.md)              | P1      | M / vừa; phối hợp cache nhiều caller                      | không         | TODO     |
| 013 | [Dùng ngày site cho cửa sổ analytics](013-analytics-site-date-windows.md)                           | P1      | M / thấp; sửa cận thời gian                               | 005, 006      | TODO     |
| 014 | [Áp include_drafts nhất quán cho sales chart](014-sales-chart-draft-filter.md)                      | P1      | S / thấp; lọc cùng business population                    | 005, 006, 013 | TODO     |
| 015 | [Hiện đúng chuyển động theo mặt hàng và kho](015-stock-item-movement-query.md)                      | P1      | M / vừa; đổi nguồn đọc lịch sử                            | 007           | TODO     |
| 016 | [Bỏ snapshot board cũ và giữ refresh sau mutation](016-kanban-refresh-generation.md)                | P1      | M / vừa; phối hợp queue và optimistic updates             | 007, 009      | TODO     |
| 017 | [Hiển thị lỗi tải đầu và giữ dữ liệu khi refresh lỗi](017-viewer-initial-error-state.md)            | P1      | M / MED                                                   | 007           | TODO     |
| 018 | [Giới hạn số entry và thu hồi cache hết hạn](018-bound-memory-cache.md)                             | P2      | M / MED                                                   | không         | TODO     |
| 019 | [Tách giá trị cache khỏi đối tượng bên ghi](019-cache-write-value-isolation.md)                     | P2      | S / LOW                                                   | 018           | TODO     |
| 020 | [Đồng bộ schema trạng thái Kanban và giới hạn tháng doanh thu](020-align-tool-schema-boundaries.md) | P2      | M / MED                                                   | 014           | TODO     |
| 021 | [Khóa đầu vào dependency của bản build](021-reproducible-build-inputs.md)                           | P2      | L / HIGH                                                  | không         | TODO     |
| 022 | [Sửa hướng dẫn release và chính sách hỗ trợ lỗi thời](022-release-security-documentation.md)        | P2      | S / LOW                                                   | 021           | TODO     |
| 023 | [Khảo sát thiết kế dòng thời gian biến động tồn kho](023-stock-ledger-timeline-design.md)           | P3      | M / LOW                                                   | 015           | TODO     |
| 024 | [Khảo sát kiểm tra điều kiện khởi tạo ERPNext](024-setup-readiness-design.md)                       | P3      | M / LOW                                                   | không         | DONE     |
| 025 | [Khảo sát hồ sơ khách hàng tổng hợp](025-customer-360-design.md)                                    | P3      | M / LOW                                                   | 005, 006      | TODO     |

Thứ tự số 001 → 025 là một thứ tự hợp lệ không có chu trình. Chỉ bắt đầu kế
hoạch phụ thuộc sau khi các mục được nêu đạt DONE và chứng cứ đã được đối chiếu.
Nếu phát hiện phụ thuộc chưa đạt hoặc code đã drift không giải thích được, dùng
BLOCKED, không bỏ gate để chạy tiếp.

Các chuỗi có tác động lớn:

- Analytics: 005 → 006 → 013 → 014 → 020. Company/currency và độ đầy đủ phải
  chốt trước date/filter.
- UI: 007 → 008, 009, 015, 017; 009 → 016. Host007 là fixture cục bộ để kiểm UI,
  không thay ERP integration.
- Cache: 018 → 019. Invalidation012 và clone019 tương tác trong FrappeClient dù
  không có phụ thuộc bắt buộc về chức năng.
- Build/tài liệu: 021 → 022.
- Khảo sát: 015 → 023; 005 và006 → 025. Mục024 độc lập.

Không dùng danh sách phụ thuộc như giấy phép sửa song song mọi file. Các kế
hoạch 002/003 cùng đụng assignment; 004/012/019 đụng client/tests;
005/006/013/014/020 đụng analytics; 009/010/016/020 đụng Kanban;
007/008/009/015/016/017 cùng host fixtures; 018/019 cùng cache. Thực thi nối
tiếp trong mỗi nhóm hoặc dùng worktree riêng với review tích hợp rõ ràng. Sửa kế
hoạch sau để phản ánh kết quả trước, không áp snippet cũ.

## Baseline và giới hạn bằng chứng

| Phép kiểm lúc audit                            | Kết quả đã quan sát                                            |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `deno lint`                                    | Đạt, 191 file                                                  |
| `deno fmt --check`                             | Không đạt do `execution-notes.md` cá nhân ở gốc                |
| `deno fmt --check --ignore=execution-notes.md` | Đạt, 266 file tại lúc audit                                    |
| UI `tsc --noEmit -p src/ui/tsconfig.json`      | Không đạt: lỗi kiểu UI thực và phạm vi config trộn test/server |
| Deno test với cached-only                      | Chưa chạy suite được vì thiếu JSR cache của `@std/assert`      |
| Deno check với deny-import                     | Chưa hoàn tất vì thiếu manifest `@casys/mcp-server`            |
| ERPNext production / bundle release            | Không kiểm trong đợt tư vấn                                    |

Kết quả lint/format ở bảng là baseline trước khi tạo bộ kế hoạch, không thay cho
gate hiện tại. Lỗi tải dependency là giới hạn môi trường, không tự động là bug
source. Không gọi fixture UI hoặc walkthrough thiết kế là kiểm chứng production.
Máy hiện tại dùng Deno2.9.5 và Node26.7.0; Node build cần smoke runtime20/22
theo021, không dùng việc chạy Node26 để khẳng định baseline được hỗ trợ.

## Kiểm bộ kế hoạch

Chạy từ repo root:

```bash
node plans/validate-plans.mjs
node plans/test-validator.mjs
deno fmt --check plans/
git diff --check
git status --short
```

Validator kiểm đúng25file, ánh xạ audit, mục bắt buộc, SHA, scope có thật hoặc
được kế hoạch phụ thuộc tạo, trích đoạn khớp source sau chuẩn hóa whitespace,
links nội bộ, ký tự cấm và phụ thuộc không chu trình. Nó không chứng minh tính
đúng đắn của các bản sửa chưa tồn tại. Review độc lập đối chiếu các kế hoạch với
source bổ sung cho kiểm tự động. Chi tiết kết quả và sửa sau review ở
[execution-notes.md](execution-notes.md).

[manifest.json](manifest.json) là dữ liệu cho kiểm tra, không thay nội dung kế
hoạch. Khi đổi scope/phụ thuộc/chứng cứ, cập nhật cả manifest lẫn kế hoạch. Mỗi
record evidence có `sourceRef` riêng trong manifest. Validator luôn đọc
`git show sourceRef:path` và so đúng toàn bộ các dòng `code`, không xóa khoảng
trắng trong literal hoặc token. Fenced evidence dùng `text` và marker
`<!-- deno-fmt-ignore -->` riêng cho trích đoạn để formatter không đổi source.
Validator vẫn so từng byte của các dòng đó, không miễn kiểm bằng marker này.
TODO/IN_PROGRESS còn phải khớp đúng các dòng source hiện tại để bắt drift trước
thực thi. Khi refresh, cập nhật đồng bộ code, line, sourceRef và fenced excerpt;
đổi trạng thái không tự đổi baseline. Mốc soạn chỉ là metadata. Cần giữ Git
history của các ref này, không fallback khi đọc Git thất bại.

IN_PROGRESS/DONE chỉ hợp lệ nếu các prerequisite đã DONE. DONE còn yêu cầu có
checklist trong mục Tiêu chí hoàn tất, không còn ô chưa đánh dấu, và field
`review_verdict: APPROVE` duy nhất trong YAML frontmatter đầu evidence tương
ứng. Chỉ thêm marker từ review có thật; lời kể có chữ APPROVE hoặc lời từ chối
không phải verdict dương. Links Markdown được kiểm cả dưới evidence lồng nhau,
tương đối với thư mục chứa file. Các kiểm tra này không thay review
implementation, CI hoặc bằng chứng môi trường bắt buộc.

`node --test plans/test-validator.mjs` chạy regression về checklist, verdict,
phụ thuộc, baseline đã refresh, literal/token, drift và link lồng nhau, cùng
contract kiểm tra của 007/011/021. Fixture chỉ thay nội dung đọc trong bộ nhớ và
dùng Git source thật; không ghi source hoặc giả làm reviewer đã duyệt kế hoạch.

## Trạng thái sau này

- TODO: chưa thực thi, không hàm ý lỗi đã được sửa.
- IN_PROGRESS: đang thực thi đúng phạm vi.
- BLOCKED: ghi lý do, lệnh thất bại và quyết định/quyền còn thiếu.
- DONE: mọi tiêu chí trong kế hoạch đạt, đã review diff và lưu
  `plans/evidence/NNN.md`.
- STALE: source/thiết kế đã thay đổi, phải cập nhật kế hoạch trước khi thực thi.

Thư mục evidence sẽ được executor tạo khi có bằng chứng thực thi. Không tạo
trước báo cáo test giả. Ba mục direction có DONE riêng là thiết kế được review;
DONE của chúng tuyệt đối không có nghĩa feature đã shipped.

## Đã cân nhắc và không coi là lỗi

- HTTP không auth khi không cấu hình: chế độ có chủ ý với cảnh báo. Mục001 chỉ
  sửa cấu hình OAuth dở dang bị bỏ qua.
- CI test chỉ workflow_dispatch và JSR opt-in: quyết định đã ghi, không tự bật
  lại trigger hoặc registry.
- Shared ERP account: mô hình triển khai hiện có, không tự chuyển thành
  multi-tenant identity trong đợt này.
- MRTR nonce chống replay đã nằm ở framework hiện dùng; không báo lại như thiếu
  hoàn toàn. Mục002 xử lý preflight trước write.
- Strict link resolution trên đường ghi, submit lấy modified mới và
  invalidation: guard có chủ ý, không xóa để đơn giản code.
- Single-file viewer bundle: yêu cầu MCP Apps, không đề xuất code splitting phá
  artifact.
- Shim entry point dùng Deno trực tiếp: ngoại lệ runtime-boundary có kiểm soát,
  không phải vi phạm adapter.
- Không suy ra lỗ hổng dependency chỉ từ phiên bản cũ. Mục021 giải quyết tái lập
  graph, không tự nâng thư viện.

## Chưa được kiểm toán bằng môi trường thật

Đã đọc source server, tools, cache, auth/shim, runtime, UI và build/docs liên
quan trong repo. Chưa kiểm permission/schema ERP theo từng phiên bản ở server
thật, khả năng tương thích mọi MCP host, độ trễ/tải production, registry live,
hoặc toàn bộ code bên trong dependency. Những giả định đó được đặt vào điều kiện
dừng và bước xác minh của kế hoạch liên quan.
