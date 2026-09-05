# Thiết kế hồ sơ khách hàng tổng hợp

## Problem

Customer360 cần giúp người đọc đi từ một khách hàng xác định tới bốn phần
orders, invoices, payments và contacts mà không đánh mất company, kỳ ngày hoặc
quyền truy cập. Đây là giả thuyết sản phẩm từ roadmap, chưa được phỏng vấn người
dùng hoặc đo tần suất sử dụng. Không coi nhu cầu, hiệu quả hay tính khả thi trên
mọi ERPNext là đã được chứng minh.

Tài liệu chỉ thiết kế tại source `67896f3208caee923659f1900c399d87e99c403c`.
Không tạo tool, viewer thứ tám, schema hoặc quyền mới. Mục tiêu trước mắt là khả
năng đọc và điều hướng an toàn, không phải số dư kế toán, đối soát thanh toán
hoặc một tổng doanh thu suốt đời.

## Evidence

Các citation dưới đây thuộc đúng source SHA nêu trên; đường dẫn tương đối tính
từ tài liệu này.

| Nguồn đã đọc                                                                                                                                                                         | Khả năng và giới hạn thực tế                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Roadmap](../roadmap.md), dòng 33                                                                                                                                                    | Đề xuất Customer360 ghép orders/invoices/payments/contacts qua `sendMessage`; không phải bằng chứng đã triển khai hoặc nhu cầu đã khảo sát.                                                                                                   |
| [Customer resolver](../../src/api/resolve.ts), dòng 77, 141, 225                                                                                                                     | `resolveCustomer` là helper nội bộ, không phải MCP tool. Thử ID bằng GET; chỉ 404 mới chuyển sang tìm tên chính xác rồi tên gần đúng. Nhiều ứng viên gây `AmbiguousLinkError`, không tự chọn. Probe 2/5 ứng viên không phải danh sách đầy đủ. |
| [Sales handlers](../../src/tools/sales.ts), dòng 269, 614                                                                                                                            | Hai dedicated list có customer, status, date_from/date_to, limit; không có company hoặc offset. Orders trả currency, invoices không trả currency/company.                                                                                     |
| [Payment handler](../../src/tools/accounting.ts), dòng 189                                                                                                                           | Có party_type/party, payment_type, date_from; không có date_to/company/offset. Trả paid_amount và hai account currency, không trả received_amount hoặc payment references.                                                                    |
| [Contact handler](../../src/tools/crm.ts), dòng 281                                                                                                                                  | Chỉ lọc company_name/status; không có customer filter hoặc liên kết Customer được chứng minh. company_name không được dùng làm khóa Customer hay Company.                                                                                     |
| [Generic list](../../src/tools/operations.ts), dòng 561, 656                                                                                                                         | `erpnext_doc_list` nhận fields/filters/order_by/limit, không nhận offset. Chuyển tiếp field không chứng minh field tồn tại hoặc người gọi có quyền đọc.                                                                                       |
| [List result](../../src/tools/list-result.ts), hàm listResult                                                                                                                        | Có count, returned, has_more, count_error. Count có thể null; count riêng không phải tổng tiền, cũng không tạo snapshot chung với trang dữ liệu.                                                                                              |
| [Doclist](../../src/ui/doclist-viewer/src/DocListViewer.tsx), dòng 456                                                                                                               | Pagination chỉ slice các dòng đã tải, không tải trang ERP tiếp theo.                                                                                                                                                                          |
| [Điều hướng](../../src/tools/ui-refresh.ts), dòng 53, 89, 193                                                                                                                        | `_rowAction` ánh xạ GET theo DocType; hint Customer chỉ mang ID. `refreshRequest` giữ arguments của lời gọi, không tự thêm company/date còn thiếu.                                                                                            |
| [Inline detail](../../src/ui/doclist-viewer/src/components/InlineDetailPanel.tsx), dòng 190; [Invoice viewer](../../src/ui/invoice-viewer/src/InvoiceViewer.tsx), dòng 254, 282, 736 | Có Submit/Cancel qua callServerTool. sendMessage gửi text với role=user, không phải router kiểu hóa; hint hiện tại không giữ đủ company/date.                                                                                                 |
| [Caller client](../../src/api/frappe-client.ts), dòng 948                                                                                                                            | Client theo caller khi có identity; stdio có thể dùng service account. Không suy quyền người dùng chỉ từ việc HTTP đã xác thực.                                                                                                               |
| [Analytics context](../../src/tools/analytics-context.ts), dòng 350, 420; [Pagination](../../src/tools/analytics-pagination.ts), dòng 42                                             | 005/006 khóa company/currency và đọc đủ trong analytics. Không tự áp dụng cho các dedicated list hoặc generic doc_list.                                                                                                                       |

Không đọc ERP production, không xác minh schema Contact upstream trong đợt này.
Các lời gọi GET đơn Customer/Sales Order/Sales Invoice/Payment Entry/Contact tồn
tại, nhưng khả năng trả tài liệu không chứng minh mọi field liên kết đều có
semantics cần cho hồ sơ tổng hợp.

## Alternatives

| Phương án                                                            | Lợi ích                                                                                                                         | Chi phí và điều kiện                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: composition các tool hiện có, hội thoại và viewer qua sendMessage | Tái sử dụng list/get, không cần viewer thứ tám để khảo sát hành trình. Có thể xem từng phần và dừng độc lập khi lỗi.            | Không có một panel bốn phần, pagination ERP hoặc khóa ngữ cảnh điều hướng sẵn có. Viewer đích có mutation. Chỉ khả thi như quy trình đọc có người kiểm tra, không được quảng cáo là giao diện read-only được cưỡng chế. |
| B: tool tổng hợp và viewer mới, thiết kế read-only từ đầu            | Có thể đặt contract section, identity, pagination, lỗi và điều hướng chung; allowlist read-only có thể được kiểm thử tập trung. | Đây là tính năng chưa có: cần khảo sát, duyệt API/quyền, xác minh schema, budget, bảo mật dữ liệu liên hệ và thêm build/test viewer. Một request MCP vẫn có nhiều query ERP, không thành atomic snapshot.               |

Phương án A không khắc phục thiếu company bằng cách thêm một argument mà handler
bỏ qua. Với phần cần company, có thể đề xuất dùng generic list đã có để truyền
filter đúng field; vẫn phải kiểm schema/quyền và báo rõ giới hạn trang đầu. Nếu
category `operations` không được phép, dừng phần đó, không tự mở category hoặc
quay về list rộng hơn. Phương án B không được dùng service account quyền cao hơn
để làm tất cả section xanh.

## Contract

Contract dưới đây là yêu cầu thiết kế, không phải schema runtime đã được thêm.

### Identity, company và quyền

Ngữ cảnh logic gồm customer_id, nhãn khách hàng, company_id, date_from, date_to,
date_basis của từng section và một generation của lượt xem. Các khóa này mô tả
thiết kế, không phải arguments có thể truyền tùy ý cho tool hiện có.

- ID chuẩn: `erpnext_customer_get({name: customer_id})` xác nhận khả năng đọc;
  lỗi 403 không được thử lại bằng identity khác. Customer không mặc nhiên chỉ
  thuộc một company; company phải chọn riêng, không suy từ tên khách hàng.
- Tên: đường backend tương lai tái sử dụng `resolveCustomer`, không viết một
  resolver tự chọn ứng viên đầu. Hiện các sales list và payment list đã gọi
  helper này nhưng không có tool riêng trả canonical ID trước khi tải bốn phần.
  Composition A chỉ đi tiếp sau khi đã xác nhận ID; nếu chỉ có tên và chưa lấy
  được ID rõ ràng, yêu cầu người dùng cung cấp/chọn ID. Không gọi một tool tưởng
  tượng mang tên resolveCustomer.
- Tên gần đúng duy nhất phải hiển thị cả ID lẫn nhãn trước khi tiếp tục. Tên mơ
  hồ yêu cầu chọn, không gộp dữ liệu các Customer trùng tên. Danh sách ứng viên
  có thể bị cắt, cho phép nhập ID khác, không gọi đó là toàn bộ khách hàng.
- Company bắt buộc cho hồ sơ giao dịch. Không tự dùng currency của company để
  gắn nhãn grand_total của chứng từ có currency khác.
- Cần quyền đọc Customer và từng DocType/field thực sự truy vấn. Thiếu quyền một
  section không bỏ filter hoặc làm mất section khác; count cũng dùng cùng filter
  và identity. Nhãn “không có dữ liệu trong phạm vi được phép” không suy rằng
  không tồn tại dữ liệu ngoài quyền caller.
- Ngày nhập rõ YYYY-MM-DD và từ ngày không sau đến ngày. Orders dùng
  transaction_date; invoices/payments dùng posting_date. Không lấy múi giờ máy
  làm ngày site. Cách lấy mặc định theo site cần duyệt riêng; contacts không bị
  áp kỳ giao dịch giả.

### Query map: orders

Hiện có
`erpnext_sales_order_list({customer: customer_id, date_from, date_to,
limit: 20})`:
lọc customer đã resolve và transaction_date, tùy chọn status; trả
name/customer/transaction_date/status/grand_total/currency. Thiếu company và
offset nên không đáp ứng hồ sơ đã khóa company.

Đường composition được đề xuất để giữ company là `erpnext_doc_list` với doctype
`Sales Order`, fields tối thiểu name/customer/company/transaction_date/
status/docstatus/grand_total/currency, filters customer bằng ID, company bằng
ID, transaction_date trong kỳ, docstatus != 2; order_by
`transaction_date desc, name asc`, limit 20. Đây là cấu hình đọc được đề xuất
cho API generic có sẵn, cần kiểm field/quyền trên phiên bản ERP đích trước sử
dụng. Không thêm total giữa các currency; đơn bị hủy không nằm trong mặc định,
draft được đánh dấu, không gọi tổng của draft là doanh thu đã ghi nhận.

### Query map: invoices

Hiện có
`erpnext_sales_invoice_list({customer: customer_id, date_from,
date_to, limit: 20})`:
date áp posting_date, trả name/customer/posting_date/
due_date/status/grand_total/outstanding_amount. Không có currency/company trong
projection. Không đoán currency từ locale, company hoặc một invoice khác.

Đề xuất dùng generic list với `Sales Invoice`, cùng customer/company exact,
posting_date trong kỳ, docstatus != 2, order_by `posting_date desc, name asc`;
fields thêm company/currency/docstatus vào tập trên, limit 20. Trước khi xác
minh đủ metadata, phần tiền hiển thị “Chưa xác minh đơn vị tiền”, không hiện số
tiền thiếu đơn vị. Không lấy outstanding_amount trừ payment list: chưa có
allocation, credit note và lịch sử tỷ giá. Report AR của 005 không có public
customer filter ở các analytics tool hiện tại, không gọi report toàn company rồi
coi đó là số dư riêng của Customer.

### Query map: payments

Hiện có
`erpnext_payment_entry_list({party_type: "Customer", party:
customer_id, date_from, limit: 20})`.
Dynamic link được phân giải theo Customer; không chỉ truyền party. Không truyền
date_to/company vì handler hiện bỏ qua. Không tự lọc payment_type=Receive rồi
coi đã bao gồm cả hoàn tiền Pay.

Đề xuất generic list `Payment Entry` với party_type=Customer, party và company
exact, posting_date trong kỳ, docstatus != 2, order_by
`posting_date desc, name asc`, limit 20. Field tối thiểu là name/company/
party_type/party/payment_type/posting_date/docstatus/paid_amount/
paid_from_account_currency/paid_to_account_currency. Cần kiểm field và ngữ nghĩa
amount phía nguồn trên ERP đích; hai currency khác nhau không thể thay thế cho
nhau. Tài liệu này chưa chứng minh mapping đơn vị của paid_amount hoặc
received_amount qua mọi loại Payment Entry: chưa đủ chứng cứ thì không trình bày
tổng tiền, chỉ trạng thái “Chưa xác minh đơn vị tiền”.

`erpnext_payment_entry_get({name})` có thể đọc tài liệu đầy đủ khi được phép,
nhưng không tự quét GET từng dòng để suy payment allocation hoặc lấp currency
bằng N+1 query. “Payments của Customer” khác “Payments đã phân bổ cho invoice”;
hint navigation của invoice hiện tại chỉ là text, không chứng minh quan hệ này.

### Query map: contacts

`erpnext_contact_list({company_name, status, limit})` đọc name/first_name/
last_name/company_name/email_id/mobile_no/status. Không có bằng chứng
company_name là liên kết đến Customer đã chọn. Không được lọc bằng nhãn khách
hàng hoặc tự phát minh Contact.customer, Contact.company hay child-link query.

Quyết định: defer tải contacts theo Customer, hiển thị “Chưa xác minh liên kết
Customer với Contact”, không gọi list rộng để tìm bằng email/tên. Muốn triển
khai sau phải chứng minh schema liên kết ở revision upstream/site đích, quyền
đọc parent/child và cardinality; chọn projection PII tối thiểu, chỉ mở email/
điện thoại khi nhu cầu và quyền được xác nhận. Một Contact ID được người dùng
chỉ định có thể GET riêng, không tự nhận nó thuộc hồ sơ này.

### Trạng thái và pagination từng section

| Section  | loading                                                      | error                                                                                           | empty                                                                          | success                                                              | Pagination, currency và permission                                                                                                                         |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| orders   | “Đang tải đơn hàng” với customer/company/kỳ hiện tại.        | 403 hoặc lỗi mạng: chỉ lỗi phần đơn, không bỏ company.                                          | “Không có đơn trong phạm vi được phép và kỳ đã chọn”, chỉ sau response hợp lệ. | Hiện các dòng cùng trạng thái, currency từng chứng từ và mức đầy đủ. | Trang đầu 20, đọc returned/has_more/count; không có offset để sang trang ERP. Không cộng mixed currency hoặc subset; Sales Order 403 không thành 0.        |
| invoices | “Đang tải hóa đơn”, không giữ số của Customer trước.         | Lỗi field/currency/quyền: báo giới hạn, không giả tổng bằng 0.                                  | Không có hóa đơn theo filter đã xác nhận.                                      | Hiện dòng và trạng thái, chỉ hiện tiền khi có currency xác minh.     | Trang đầu 20; count null là chưa biết, không là 0. Dùng quyền Sales Invoice; không tổng công nợ từ trang hiện tại.                                         |
| payments | “Đang tải thanh toán” và cùng company/kỳ.                    | Timeout/403: cho retry riêng, giữ các phần khác.                                                | Không có Payment Entry theo party_type/party/company/kỳ hợp lệ.                | Hiện từng Payment Entry, payment_type và tình trạng xác minh đơn vị. | Trang đầu 20; không giả date_to đã áp với dedicated list. Không cộng hai account currency hoặc suy thanh toán invoice; quyền Payment Entry riêng.          |
| contacts | Chỉ có loading khi linkage và query đã được duyệt ở đợt sau. | Hiện tại là deferred do chưa xác minh linkage; 403 tương lai ghi không đủ quyền, không là rỗng. | Chỉ được dùng sau query linkage hợp lệ trả rỗng, không dùng cho deferred.      | Chỉ các Contact đã chứng minh linkage, projection PII tối thiểu.     | Pagination ERP chưa được thiết kế vì chưa có query-map hợp lệ; không tự đọc toàn danh bạ. Không có đại lượng tiền; quyền Contact/link phải xác minh riêng. |

Nếu has_more=true hoặc count=null, ghi “Đang xem một phần; chưa tải toàn bộ”.
Không có nút tải trang ERP tiếp trong contract hiện tại; đề nghị thu hẹp kỳ hoặc
đọc qua quy trình ERP được phép. Không tăng limit vô hạn hoặc coi local page 2
của doclist là trang 2 server. has_more=false chỉ nói mức đầy đủ của lần đọc
được phép, không biến list/count thành snapshot kế toán. Hồ sơ không hiển thị
tổng tiền, kể cả một trang có vẻ đầy đủ, trước khi có policy amount/currency
được duyệt. Phân trang cursor/offset và budget chung của phương án B là API mới
phải thiết kế, không tự mượn complete-read analytics cho các list này.

### Điều hướng và read-only

Trace trên giấy: Customer ID đã xác nhận -> company/kỳ -> filter orders -> dòng
SO-EXAMPLE -> GET theo ID -> yêu cầu xem invoices của cùng Customer, company và
kỳ. “Invoices của cùng Customer” không có nghĩa “invoices phát sinh từ
SO-EXAMPLE”. Chỉ đề xuất lọc liên kết chứng từ sau khi chứng minh mapping.

GET chi tiết chỉ nhận ID, không tự khóa company/customer. Contract tương lai
phải kiểm lại customer hoặc party_type/party cùng company của response trước khi
gắn vào hồ sơ; thiếu field hoặc khác context thì báo không xác minh được, không
hiển thị như tài liệu thuộc khách hàng hiện tại. Đây chưa phải guard của viewer
đích hiện có.

Thông điệp đề xuất cho A: “Chỉ đọc hóa đơn của Customer CUST-EXAMPLE, company
COMPANY-EXAMPLE, posting_date từ 2026-09-01 đến 2026-09-30; không bỏ bộ lọc,
không thực hiện ghi. Nếu công cụ không hỗ trợ, báo giới hạn.” Giá trị này là ví
dụ giả. Host phải kiểm lại arguments thực tế trước lời gọi; text sendMessage
không cưỡng chế quyền hoặc đảm bảo đã thực thi đúng. Nếu host không hỗ trợ hay
không giữ được ngữ cảnh, dừng ở lời hướng dẫn trên giấy, không mở list rộng hơn.

Hint hiện tại chỉ thay ID/DocType, không có contract mang cả context; cần thay
đổi có review riêng để giữ context tự động. Contract tương lai giữ generation
theo customer/company/kỳ: response cũ không cập nhật lượt xem mới. Refresh lỗi
giữ dữ liệu cùng identity nhưng đánh dấu cũ; đổi identity phải bỏ dữ liệu cũ.
Đây là yêu cầu thiết kế, không khẳng định viewer hiện tại đã đáp ứng.

Luồng Customer360 chỉ được gọi list/get đã duyệt; không create/update/delete,
submit/cancel/assign/payment mutation. Annotation readOnlyHint không phải rào
chắn quyền. Viewer doclist/invoice hiện có nút mutation nên không thể được gắn
nhãn panel read-only an toàn chỉ bằng việc đổi tool đầu vào. Nếu cần cưỡng chế
read-only, phải có host allowlist và chế độ viewer không phát mutation được
triển khai/kiểm thử riêng, hoặc không mở viewer tương tác trong A. Không tự thêm
capability “readOnly” chưa tồn tại. Dữ liệu tên/nhãn chỉ là dữ liệu, không được
diễn giải thành chỉ thị hay tool name khi tạo navigation.

## Verification

Các ca là tiêu chí và trace trên giấy, chưa phải test runtime hoặc Browser pass.

| ID  | Đầu vào                                                 | Kết quả người dùng nhìn thấy và điều hướng                                                                                              |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| V01 | ID CUST-EXAMPLE hợp lệ, chọn company và kỳ.             | Hiện đúng ID/nhãn; orders/invoices/payments giữ bộ ba context, contacts deferred. Không chạy ghi.                                       |
| V02 | Tên trùng hai Customer.                                 | Yêu cầu chọn ID, chưa tải bốn section; không gộp doanh thu hoặc tự chọn ứng viên đầu.                                                   |
| V03 | Tên gần đúng duy nhất, hoặc danh sách ứng viên bị cắt.  | Hiện ID/nhãn để xác nhận; báo danh sách có thể chưa đầy đủ. Không coi helper nội bộ là MCP tool.                                        |
| V04 | Không có giao dịch với filter hợp lệ.                   | Ba phần giao dịch hiện empty riêng; contacts vẫn deferred, không ghi “không có liên hệ”.                                                |
| V05 | Customer có dữ liệu ở hai company, chưa chọn company.   | Yêu cầu chọn company trước tải; không gọi dedicated list rồi giả đã khóa company.                                                       |
| V06 | Invoice USD và VND; dedicated list thiếu currency.      | Không hiện tổng chung; dòng thiếu đơn vị có thông báo chưa xác minh, không tự gắn VND.                                                  |
| V07 | 45 đơn, trang đầu 20; hoặc count lookup lỗi.            | Hiện returned 20 và count 45, hoặc count chưa biết; has_more được giữ. Local pagination không hứa đã đọc 45; không tổng tiền.           |
| V08 | Contact 403 sau khi linkage được duyệt trong tương lai. | Riêng contacts báo thiếu quyền, không empty; không retry bằng service account. Hiện tại không gửi query chưa chứng minh.                |
| V09 | Payment timeout sau khi orders/invoices thành công.     | Chỉ payment báo lỗi và retry; hai phần kia giữ dữ liệu cùng context, không báo hồ sơ hoàn chỉnh.                                        |
| V10 | Receive/Pay có hai account currency khác nhau.          | Hiện loại giao dịch, không lấy paid_amount gắn tùy ý với một currency và không suy số tiền đã phân bổ invoice.                          |
| V11 | Mở invoices từ orders với company và kỳ.                | Yêu cầu gửi đầy đủ ID/company/date_basis/kỳ; host không giữ được filter thì báo giới hạn, không mở invoices toàn site.                  |
| V12 | Đổi Customer A sang B khi response A đang chờ.          | Contract tương lai chỉ hiển thị B; response A muộn không gắn vào B. A hiện tại chưa có panel chung nên không tuyên bố đã kiểm race này. |
| V13 | Host thiếu operations hoặc không cưỡng chế read-only.   | Báo phần không khả dụng; không mở category, không dùng viewer có Submit/Cancel như read-only panel.                                     |
| V14 | Gửi date_to cho dedicated payment list.                 | Nhận diện không được hỗ trợ; không nói kỳ đã được áp. Chỉ đề xuất generic query có upper bound sau xác minh.                            |

Kiểm tài liệu: đủ bảy heading rubric, hai phương án, bốn query-map và bốn trạng
thái mỗi section; các link nội bộ tồn tại; không có source diff hoặc dữ liệu
khách hàng thật. Khi triển khai sau, cần test pagination thật, quyền, đơn vị,
navigation arguments và Browser trên host mục tiêu; bảng trên không thay các
gate đó.

## Decision

Chọn A làm hướng khảo sát ít cam kết nhất, không chọn phát hành tính năng ở
đợt 025. Có thể khảo sát hành trình thủ công với ID xác nhận và kết quả đọc hạn
chế; không tuyên bố đã có hồ sơ hoàn chỉnh, panel read-only hay nút chuyển giữ
context. Defer contacts, tổng tài chính và pagination server cho tới khi có bằng
chứng/contract riêng. Không triển khai B hoặc viewer thứ tám lúc này.

Nếu nhu cầu một màn hình bốn section và khóa read-only được xác nhận, đưa B hoặc
thay đổi có giới hạn cho A ra quyết định mới. Trước triển khai phải chốt schema,
nguồn currency, filter company/date, quyền từng section, budget, xử lý response
muộn và ranh giới mutation. Không coi việc các plan 005/006 DONE là approval cho
API Customer360 mới.

## Open questions

- Ai sử dụng hồ sơ, quyết định nào cần hỗ trợ, và một bảng nhiều section có tốt
  hơn các lời hỏi hiện tại không? Cần khảo sát người dùng, chưa có số liệu.
- Có chấp nhận A chỉ là quy trình đọc thủ công, hay bắt buộc một panel và
  read-only được cưỡng chế? Ai duyệt host allowlist và API bổ sung nếu cần?
- ERPNext revision/customization nào là mục tiêu? Ai cung cấp chứng cứ schema
  Contact linkage và quyền parent/child mà không dùng dữ liệu production?
- Company được chọn từ đâu; caller có quyền xem Company không; default date theo
  site lấy qua đường đọc nào? Khi thiếu quyền phải hỏi, không đoán.
- Mỗi section có cần draft, cancelled, hoàn tiền, credit note hoặc allocation
  không? Paid/received amount và currency cần nguồn xác minh nào trước hiển thị?
- Giới hạn trang đầu 20 và yêu cầu thu hẹp kỳ có chấp nhận được không? Nếu
  không, cần duyệt pagination/budget/timeout mới và giới hạn nhất quán nhiều lần
  đọc.
- Có thực sự cần email/điện thoại contacts; cách hạn chế lưu/export/log PII là
  gì? Không mặc định đưa danh bạ vào hồ sơ hoặc chia sẻ qua sendMessage.
