# Thiết kế dòng thời gian biến động tồn kho

## Problem

Stock Ledger Timeline cần trả lời “mặt hàng này biến động thế nào trong kho và
kỳ đã chọn, giao dịch nào tạo ra điểm này?” thay vì chỉ cho biết tồn kho hiện
tại. Đây là giả thuyết trong roadmap, chưa có phỏng vấn người dùng hoặc chứng cứ
nhu cầu cho một màn hình mới.

Tài liệu thiết kế tại source `174cd29bd5bd7ced3cb231b56e786e4f982e422c`, sau
015. Không triển khai tool, schema API, viewer, mock UI hoặc thay roadmap thành
shipped. Không khảo sát ERP production. Quyết định cuối là defer phát hành
timeline; chỉ ưu tiên A cho khảo sát đọc có giới hạn sau khi được cho phép.

## Evidence

Nhãn **observed** chỉ điều đã đọc trong repository ở SHA trên; **proposed** là
yêu cầu chưa triển khai; **unverified** là giả thuyết cần kiểm riêng. Không suy
mock/fixture hoặc schema của một revision thành quyền và semantics mọi site.

| Nhãn       | Chứng cứ                                                                                                                                       | Kết luận và giới hạn                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| observed   | [Roadmap](../ROADMAP.md), dòng 38                                                                                                              | Đề xuất ghép chart line và doclist; chưa phải luồng đã chạy.                                                                                                                                                                                                                                                                  |
| observed   | [Inventory tool](../../src/tools/inventory.ts), dòng 17-91                                                                                     | `erpnext_stock_ledger_list` thuộc inventory, readOnlyHint, item ID hoặc tên, warehouse ID chính xác, limit integer 1..20/default 5. Projection 10 field, filter `is_cancelled = 0`, thứ tự ngày/giờ/name giảm dần, list dùng skipCache. Chỉ trả `{data: rows}`, không company/date/offset/count/has_more hoặc viewer binding. |
| observed   | [Chứng cứ 015](../../plans/evidence/015.md), phần nguồn và sửa ledger cache                                                                    | 015 ghi đã đọc schema ERPNext v15 commit `1a0bf0bf6c4aeaae5acde90c74b186312f49b95c`, có các field mà tool dùng và role đọc Stock User/Accounts Manager. Đây là nguồn đã lưu của 015, không phải lần xác minh upstream mới trong 023.                                                                                          |
| observed   | [Generic operations](../../src/tools/operations.ts), dòng 522, 561, 656                                                                        | GET nhận DocType/name; list nhận fields/filters/order_by/limit và bind doclist, không offset. Chuyển tiếp field không chứng minh field tồn tại hoặc đọc được. Generic list không truyền skipCache như tool 015.                                                                                                               |
| observed   | [List result](../../src/tools/list-result.ts), resolveTotal/listResult                                                                         | Trả count/returned/has_more; full page mới hỏi count, lỗi count giữ null/count_error. Count không phải tổng quantity và không phải snapshot chung với list.                                                                                                                                                                   |
| observed   | [Stock chart](../../src/tools/analytics.ts), dòng 65-165                                                                                       | Đọc Bin hiện thời và gom theo item, type chỉ bar/horizontal-bar; không đọc lịch sử SLE, không phải timeline hay opening balance.                                                                                                                                                                                              |
| observed   | [Chart payload](../../src/ui/shared/presentation.ts), ChartData; [Chart viewer](../../src/ui/chart-viewer/src/ChartViewer.tsx), dòng 450, 1010 | Có labels/datasets/unit và line; click chỉ lấy activeLabel rồi thay `{label}` vào text gửi sendMessage. Chưa có mapping typed point -> ledger row IDs. Không có MCP tool nhận mảng SLE tùy ý để render chart được chứng minh ở đây.                                                                                           |
| observed   | [Doclist](../../src/ui/doclist-viewer/src/DoclistViewer.tsx), dòng 456; [row action](../../src/tools/ui-refresh.ts), dòng 213                  | Pagination chỉ slice dữ liệu đã tải. SLE không có dedicated GET mapping, nên fallback `erpnext_doc_get` với doctype/name.                                                                                                                                                                                                     |
| observed   | [Inline detail](../../src/ui/doclist-viewer/src/components/InlineDetailPanel.tsx), dòng 190-216; [thiết kế 025](customer-360.md)               | Viewer có Submit/Cancel theo docstatus. Annotation read-only của list không biến viewer đích thành giao diện chỉ đọc được cưỡng chế.                                                                                                                                                                                          |
| observed   | [Movement helper](../../src/ui/shared/stock-movements.ts), buildStockMovementsRequest/parseStockMovements                                      | Panel 015 đọc 5 row, kiểm finite quantities và đúng item/kho; không chứng minh opening, tổng kỳ hoặc đủ lịch sử.                                                                                                                                                                                                              |
| observed   | [Caller client](../../src/api/frappe-client.ts), getFrappeClient; [resolver](../../src/api/resolve.ts), resolveUnique                          | HTTP có identity dùng client caller; stdio có thể dùng service account của operator. Resolver từ chối nhiều ứng viên, không tự chọn item đầu tiên.                                                                                                                                                                            |
| unverified | Company field, quan hệ Warehouse/Company, site timezone và quyền row/field trên ERP đích                                                       | Cần schema/version được ghim và tài khoản thử nghiệm có quyền giới hạn; không suy company từ hậu tố tên kho.                                                                                                                                                                                                                  |
| unverified | Thứ tự nghiệp vụ khi nhiều SLE cùng timestamp; repost/backdate/cancel ảnh hưởng số dư                                                          | `name` làm thứ tự truy xuất xác định, chưa chứng minh đó là thứ tự hạch toán nội bộ. Cần nguồn upstream/fixture sandbox được duyệt trước nối balance line.                                                                                                                                                                    |

## Alternatives

| Phương án                                                                              | Giá trị                                                                                                                     | Khoảng trống và chi phí                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: composition `erpnext_doc_list` trên Stock Ledger Entry với doclist và chart hiện có | Có thể kiểm bảng ledger trang đầu và GET đúng row bằng tool có sẵn; chi phí khảo sát thấp, không thêm tool để xem từng row. | Generic list không offset hoặc freshness bypass công khai; line chart không tự chuyển SLE thành ChartData, không có binding/point mapping an toàn sẵn. Muốn chart tương tác vẫn cần tích hợp riêng được duyệt; composition không đồng nghĩa chỉ gửi hai tool call là có timeline. |
| B: tool tổng hợp read-only mới, dùng lại viewer khi contract được bổ sung              | Có thể khóa scope, đọc đủ/budget, opening, quantity và provenance chung, tạo dữ liệu chart/doclist từ cùng tập row.         | Cần API mới, pagination/permission/error tests và cách đưa hai cách nhìn ra host. Chưa chọn tên/schema hoặc thêm viewer thứ tám. Một MCP call nhiều ERP request không thành atomic snapshot.                                                                                      |

A được ưu tiên cho khảo sát thủ công có kiểm soát, không phát hành timeline.
Tool 015 là control cho recent rows khi chỉ có category inventory; không gán
thêm company/date/offset mà schema từ chối. Nếu host không cho operations thì A
không khả dụng, không tự mở category hoặc dùng tài khoản quyền cao hơn. B chỉ
xem xét sau khi xác minh nhu cầu và các điều kiện chặn ở Decision.

## Contract

Mười vấn đề dưới đây là contract thiết kế **proposed**, không phải API đã thêm.
Mọi field hoặc semantics gắn unverified phải được xác minh trước sử dụng.

### C01: Identity và phạm vi company

Chọn một item chuẩn, một warehouse ID và một company ID cho mỗi chuỗi. Tool 015
đã nhận tên item qua resolveItem; generic list cần item ID đã xác nhận, không
coi helper nội bộ là MCP tool. Tên mơ hồ yêu cầu người dùng chọn ID. Xác minh
warehouse thuộc company qua field/quyền đã chứng minh; nếu không có chứng cứ,
defer scope company, không suy từ nhãn hoặc lọc sau khi tải dữ liệu toàn site.
Hai kho là hai chuỗi độc lập, kể cả cùng item/company; chưa cộng balance kho.

### C02: Khoảng ngày và múi giờ

Nhập date_from/date_to rõ YYYY-MM-DD, ngày đầu không sau ngày cuối. Khoảng bao
gồm hai ngày theo lịch site; lọc posting_date, giữ posting_time nguyên độ chính
xác. Timezone chưa biết thì yêu cầu xác nhận, không dùng locale/múi giờ máy để
gắn nhãn UTC hoặc tự chọn “hôm nay”. Dedicated ledger hiện không nhận date.

### C03: Chronology ổn định

Query recent giảm dần `posting_date desc, posting_time desc, name desc`, đúng
015; khi trình bày chuyển động trong kỳ, đề xuất query tăng dần cả ba field. Giữ
name độc nhất làm tie-break và row identity, không chỉ nhãn ngày. Đây là thứ tự
đọc xác định, không tự chứng minh thứ tự nghiệp vụ cùng timestamp. Nếu thứ tự
balance chưa xác minh, chỉ hiện row/điểm rời; không nối thành line số dư giả
liên tục. Giữ ledger name tách biệt voucher_no vì nhiều ledger row có thể trỏ
cùng chứng từ.

### C04: Movement và số dư sau giao dịch

`actual_qty` là lượng thay đổi có dấu, `qty_after_transaction` là số dư được
nguồn trả ở từng row. Không thay một trường bằng trường kia, không gọi delta là
tồn kho. Hiện điểm delta riêng; chỉ nối chuỗi balance khi C03/C06/C07/C08 đã
được chứng minh. Không suy mọi balance bằng `opening + sum(actual_qty)` nếu loại
giao dịch/reconciliation/repost chưa được xác minh; số dư nguồn và phép cộng
khác nhau phải báo không đối chiếu được, không tự sửa số.

### C05: UOM và tiền tệ

Mỗi row phải có stock_uom và quantity finite. Không gắn “units” chung hoặc cộng
Nos với Kg. Thiếu UOM hoặc mixed UOM trong một chuỗi làm phần tổng/line không
khả dụng, vẫn báo lỗi metadata. Phiên bản thiết kế này chỉ lượng tồn kho, không
valuation/cost/currency chart. Không suy company currency là đơn vị actual_qty;
muốn tiền sau này phải xác minh field amount/currency và quy tắc tỷ giá riêng.

### C06: Phân trang và mức đầy đủ

A dùng trang đầu limit 20, đọc returned/count/has_more. count null hoặc
has_more=true phải hiện “Một phần dữ liệu, không có tổng kỳ”. Không có offset
công khai; nút page 2 doclist chỉ chuyển trang local, không tải SLE tiếp. Không
tăng cap hoặc chia ngày tùy ý để giả đã đọc đủ: nhiều row có thể cùng timestamp.
Tool 015 chỉ có data, đúng 20 row không chứng minh hết dữ liệu.

B cần contract đọc trang riêng được duyệt, stable order, kiểm trùng name/không
tiến triển, kết thúc có chứng cứ và fail-closed khi hết budget. Hạn mức ứng viên
cho spike: tối đa 20 ERP request và 1000 ledger row cho toàn lượt xem, kể cả
lookup/opening/count/drill query trong lượt; chạm trần thì không có tổng/line
đầy đủ. Đây chưa phải giới hạn runtime hoặc API pagination. Không dùng SQL,
get_all hay bỏ quyền để đạt completeness.

### C07: Opening balance

Opening là số dư ngay trước đầu kỳ cho cùng item/kho/company, không phải 0 khi
trang đầu không có row cũ. Query ứng viên O: giữ item/kho/company/cancel policy
của Q, thay cả hai filter ngày trong Q bằng `posting_date < date_from`, sort
ngày/giờ/name giảm dần, limit 1, lấy số dư nguồn và ID row. O là query thiết kế
chỉ dùng sau khi field/quyền và chronology được chứng minh, không phải argument
cho tool 015.

Không dùng `first.qty_after_transaction - first.actual_qty` làm opening mặc
định: row đầu tải về có thể không đầu kỳ và phép trừ chưa hợp lệ với mọi loại
giao dịch. O trả rỗng vẫn là opening unknown trừ khi có chứng cứ toàn lịch sử
khởi đầu bằng 0 trong cùng phạm vi. O bị 403/timeout thì balance không khả dụng;
delta rows hợp lệ có thể xem độc lập với nhãn thiếu opening. Không nối từ 0.

### C08: Entry hủy và thay đổi hồi tố

Mặc định dùng `is_cancelled = 0` trước sort/limit như 015, không thay bằng
docstatus theo suy đoán. Không cộng cả entry hủy và entry thay thế. Muốn xem
cancelled là chế độ audit riêng chưa triển khai, không trộn vào series mặc định.
Backdate/repost có thể đổi lịch sử; skipCache của 015 chỉ đọc mới, không khóa
snapshot. A có thể đọc cache nên phải ghi chưa bảo đảm freshness. B cần read
fresh, thời điểm bắt đầu/kết thúc đọc, generation scope; đổi scope bỏ response
cũ. Nhiều trang vẫn không atomic, cần cảnh báo và yêu cầu đọc lại nếu phát hiện
trùng/đổi/mất row hoặc balance không đối chiếu.

### C09: Quyền và trạng thái lỗi

Chỉ list/get bằng identity caller được cấp. Cần xác minh quyền Item, Warehouse,
Company, SLE và voucher drill-down từng phần; role trong schema 015 không chứng
minh role site. 403 không thành empty, không bỏ company filter, không fallback
Stock Entry toàn site hoặc service account. Timeout giữ dữ liệu cùng scope đánh
dấu cũ, không xuất tổng hoàn chỉnh; đổi scope xóa dữ liệu cũ. Empty chỉ sau
response hợp lệ trong phạm vi được phép, không có nghĩa tồn kho bằng 0. Count
lỗi riêng giữ rows với count unknown. Read-only annotation là hint, không là
quyền: chưa có chế độ viewer/host allowlist cưỡng chế read-only thì không mở
inline detail chứa Submit/Cancel dưới nhãn “chỉ đọc”. Không tạo mutation.

### C10: Point drill-down và contract mẫu

Đề xuất mapping mỗi điểm rời sang chính xác `ledger_name` cùng scope và read
generation; nếu gom theo ngày phải lưu tập row IDs đầy đủ đã tạo điểm, không chỉ
date label. Click mở đúng các row đã đóng góp, rồi tùy chọn GET SLE name. Nếu
xem voucher: dùng voucher_type/voucher_no đã kiểm allowlist và quyền, không lấy
nhãn chart làm tool name. GET trả row khác scope hoặc lỗi quyền thì không hiển
thị như row của điểm đó. Không quét GET từng row để lấp metadata.

Doclist có fallback GET theo name; chart hiện chỉ sendMessage text chứa label,
không bảo đảm giữ scope hoặc typed navigation. A chỉ có drill-down thủ công khi
người/host đối chiếu ID và arguments thực; không hứa click tự mở đúng row. B cần
mapping được kiểm thử và rào read-only riêng, không chỉ thay template text.

Query mẫu Q dưới đây là cấu hình **proposed** cho API generic có sẵn, chưa gửi.
`company` trên SLE và quyền đọc/filter field đó còn **unverified**; nếu chưa xác
minh thì không chạy Q và tuyệt đối không bỏ filter. Các ID hoàn toàn giả:

```json
{
  "doctype": "Stock Ledger Entry",
  "fields": [
    "name",
    "item_code",
    "warehouse",
    "company",
    "posting_date",
    "posting_time",
    "actual_qty",
    "qty_after_transaction",
    "stock_uom",
    "voucher_type",
    "voucher_no"
  ],
  "filters": [
    ["item_code", "=", "ITEM-EXAMPLE"],
    ["warehouse", "=", "WH-EXAMPLE"],
    ["company", "=", "COMPANY-EXAMPLE"],
    ["is_cancelled", "=", 0],
    ["posting_date", ">=", "2026-09-01"],
    ["posting_date", "<=", "2026-09-30"]
  ],
  "order_by": "posting_date asc, posting_time asc, name asc",
  "limit": 20
}
```

Output logic đề xuất, không phải response schema mới: scope xác nhận; rows
`SLE-EXAMPLE-1: +3 Nos, qty_after_transaction=13`; point ID ánh xạ
`SLE-EXAMPLE-1`; opening 10 Nos chỉ khi O và semantics đã xác minh; coverage “1
row trong kỳ tại lượt đọc, không atomic”. Nếu O chưa chứng minh, opening unknown
và không có balance line hoàn chỉnh, dù delta +3 vẫn có thể hiện. ChartData line
tương lai có labels/dataset nhưng chưa đủ trường typed point mapping; không giả
output trên đã được chart-viewer tiêu thụ.

## Verification

Đây là **design walkthrough**, không phải test runtime, ERP hoặc Browser pass.
Q/O chỉ chạy sau điều kiện xác minh trong Contract. Tất cả dữ liệu là ví dụ.

| ID  | Input/điều kiện                                       | Query hoặc thao tác dự kiến                                | Output/error dự kiến                                                                                                                           |
| --- | ----------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| V01 | Một movement +3 Nos, O đã xác minh 10                 | Q cho I/W/C trong kỳ, O trước kỳ                           | Một row/point +3; số dư nguồn 13; drill vào đúng name, không voucher label chung.                                                              |
| V02 | I ở W1 +3 và W2 -2                                    | Q riêng từng warehouse, cùng company đã xác minh           | Hai chuỗi tách biệt, không trộn số dư; GET row W2 không gắn vào W1.                                                                            |
| V03 | Có 10 trước kỳ, trang hiện tại không chứa predecessor | O limit 1 ngoài kỳ với cùng quyền; hoặc O bị thiếu/403     | Có chứng cứ thì opening 10; thiếu thì unknown/permission error, không 0 hoặc tự trừ row đầu.                                                   |
| V04 | SLE-A/SLE-B cùng ngày/giờ, +1/-1                      | Q với name asc làm tie-break, không chỉ sort ngày          | Hai row định danh riêng; delta order xác định, balance line defer nếu thứ tự nghiệp vụ chưa rõ.                                                |
| V05 | 45 row trong kỳ, Q chỉ trả 20                         | Q limit 20, count 45; không truyền offset cho generic      | returned 20/has_more true, không tổng 45 row; local page không phải ERP page. B tương lai hết budget cũng incomplete/error.                    |
| V06 | Row hủy +999 và replacement +2                        | Q filter is_cancelled=0 trước limit                        | Chỉ +2, không +1001; predecessor O cùng policy. Semantics repost chưa rõ thì không khẳng định balance đã đối chiếu.                            |
| V07 | Caller không đọc được SLE                             | Q dưới identity caller trả 403                             | Permission error, không empty/0, không đổi tool thành Stock Entry hoặc mở operations.                                                          |
| V08 | Q timeout sau khi có cùng scope cũ                    | Retry Q khi người dùng yêu cầu, giữ generation             | Dữ liệu cũ có nhãn stale, không tổng mới; response cũ sau đổi W/C bị bỏ theo contract tương lai.                                               |
| V09 | Q hợp lệ rỗng, O chưa xác minh                        | Q trả data=[], count 0                                     | “Không có chuyển động trong kỳ được phép”; opening/balance vẫn unknown, không gọi tồn kho 0.                                                   |
| V10 | Q full page nhưng count bị 403                        | List thành công, count riêng lỗi                           | Giữ rows, count null/count_error, has_more true; không gán count=20 hoặc tổng quantity.                                                        |
| V11 | Metadata có Nos/Kg hoặc quantity NaN                  | Kiểm row Q trước aggregate/plot                            | Lỗi đơn vị/quantity, không cộng mixed UOM; không gán currency của company cho quantity.                                                        |
| V12 | Click điểm gom hai row cùng voucher                   | Mapping point -> [SLE-A,SLE-B], GET từng row khi được chọn | Hiện đúng hai row đóng góp; voucher GET bị 403 không làm ledger empty. sendMessage không bảo đảm routing nên A chỉ thao tác kiểm tra thủ công. |
| V13 | Gửi date/company/offset cho tool 015                  | Đối chiếu schema, không gửi argument ngoài contract        | Báo không hỗ trợ; không nói tool đã lọc kỳ/company hoặc tải trang kế.                                                                          |
| V14 | Host chỉ có inventory, hoặc viewer có Submit/Cancel   | Kiểm category/allowlist trước Q hoặc mở detail             | A unavailable hoặc chỉ bảng đọc không tương tác; không tự mở quyền, không claim viewer read-only đã được cưỡng chế.                            |

Một vòng phản biện phương án A: giả sử đã chọn ID đúng và ledger có đủ field,
vẫn không có public offset, fresh read option, transform/binding chart và point
mapping được bảo đảm; cùng timestamp còn chưa chứng minh chronology balance.
V05/V12 bác bỏ tuyên bố “chỉ ghép hai viewer là có timeline đầy đủ”. B cũng
không giải quyết quyền/schema chỉ bằng tool mới. Kết thúc khảo sát tại đây,
không mở rộng sang replenishment, valuation hoặc tính năng mutation.

## Decision

**Defer triển khai Stock Ledger Timeline.** Chọn A chỉ làm hướng khảo sát đọc
thủ công ít chi phí sau approval riêng; không gọi đó là tính năng timeline đã
hoạt động. Không triển khai B trong 023. 015 tiếp tục phục vụ recent movements
theo đúng giới hạn hiện có, không bị đổi API để đạt thiết kế này.

Muốn chuyển sang implementation phải xác nhận nhu cầu; chốt ERP revision/schema
Company/Warehouse/SLE, quyền caller và timezone; chứng minh C03/C07/C08 bằng
nguồn và sandbox không production được phép; chọn contract pagination/budget,
freshness, exact point mapping và read-only viewer/host. Nếu yêu cầu phải có
timeline đầy đủ, B là ứng viên có lợi hơn A về kiểm soát completeness, nhưng cần
quyết định API và chi phí riêng sau các kiểm chứng đó. Không dùng phép tổng một
trang hoặc bỏ opening để né điều kiện chặn. Reviewer độc lập cần đọc thiết kế và
các ca trước khi đóng kế hoạch thiết kế; không đánh đồng đóng 023 với shipped
feature.

## Open questions

- Người dùng cần delta, số dư lịch sử hay đối soát chứng từ; tần suất và kỳ xem
  bao nhiêu? Cần khảo sát người dùng, chưa có dữ liệu nhu cầu.
- Ai cung cấp revision ERP, chứng cứ company field/warehouse ownership và tài
  khoản sandbox giới hạn quyền? Nếu thiếu, tiếp tục defer, không query rộng.
- Timezone site và cách chọn mặc định ngày nào được duyệt? Chưa có quyết định
  dùng ngày máy hoặc tự đọc System Settings trong thiết kế này.
- Thứ tự nghiệp vụ khi trùng timestamp, stock reconciliation, backdate/repost và
  cancellation tác động qty_after_transaction ra sao? Cần kiểm nguồn và fixture
  theo phiên bản, không suy chỉ từ field name.
- Có chấp nhận A chỉ xem một phần qua bảng và drill thủ công, hay bắt buộc
  chart/typed drill-down và đọc đủ? Câu trả lời quyết định xem xét B.
- Budget ứng viên 20 request/1000 row có phù hợp? Cần đo trên sandbox được phép,
  duyệt API pagination và deadline toàn lượt; chưa có runtime guarantee.
- Host nào cưỡng chế read-only khi xem voucher, và ai duyệt allowlist? Các nút
  Submit/Cancel hiện tại không được coi là an toàn chỉ nhờ annotation.

Các giả thuyết unverified được giữ thành câu hỏi chặn có cách xác minh, không
được chuyển thành observed khi chỉ kiểm format/rubric hoặc chạy fixture local.
