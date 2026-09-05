# Thiết kế kiểm tra điều kiện khởi tạo ERPNext

## Problem

Một ERPNext mới có thể thiếu master data cần cho giao dịch, nhưng lỗi khi đọc dữ
liệu cũng có thể đến từ quyền, mạng hoặc server. Kiểm tra phải phân biệt ba
trạng thái `present`, `missing`, `unknown`, giữ nguyên quyền của caller và tuyệt
đối không tự tạo, sửa hoặc submit tài liệu.

Phạm vi readiness ở đây chỉ là năm nhóm kiểm tra được chỉ định cho một Company
và nhu cầu UOM cụ thể. Nó không xác nhận setup wizard đã hoàn tất, cấu hình kế
toán, thuế, currency, naming series hoặc mọi điều kiện nghiệp vụ đã sẵn sàng. Vì
vậy, master data có mặt không chứng minh một giao dịch bất kỳ sẽ submit thành
công.

## Evidence

- `docs/ROADMAP.md` liệt kê Company, Price List, Warehouse, Item Group và UOM là
  chuỗi master data cần xem xét cho instance mới.
- `src/tools/setup.ts` có `erpnext_company_list`, trả về `name`, `abbr`,
  `default_currency`, `country`, `domain` và mang `readOnlyHint: true`.
- `src/tools/inventory.ts` có `erpnext_warehouse_list`, hỗ trợ filter `company`,
  trả về `name`, `warehouse_name`, `warehouse_type`, `company` và mang
  `readOnlyHint: true`.
- `src/tools/operations.ts` có `erpnext_doc_list`, cho phép chọn `fields`,
  `filters`, `limit` cho DocType bất kỳ và mang `readOnlyHint: true`. Đây là
  đường đọc hiện có cho Price List, Item Group và UOM.
- `docs/erpnext-quirks.md` ghi nhận instance chưa hoàn tất setup wizard từng làm
  submit lỗi do giá trị rounding chưa được khởi tạo. Đây là bằng chứng rằng năm
  phép kiểm master data không tương đương trạng thái hoàn tất wizard.

Các nguồn trong repo không cung cấp một setup flag ổn định, cũng không chứng
minh predicate đầy đủ cho mọi phiên bản ERPNext. Thiết kế không suy diễn flag
đó.

## Alternatives

| Phương án                                | Lợi ích                                                                 | Giới hạn                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Ghép các tool list hiện có ở phía client | Không thêm API; annotation đã là read-only                              | Nhiều round trip; client phải tự hợp nhất lỗi và rất dễ nhầm `403` thành danh sách rỗng |
| Thêm `erpnext_setup_check`               | Một contract thống nhất, kiểm soát allowlist và phân loại lỗi tập trung | Cần code, test, thêm tool và tối đa năm query; chưa giải quyết setup wizard flag        |
| Trì hoãn                                 | Không tăng bề mặt API khi nhu cầu chưa được xác nhận                    | Người gọi tiếp tục tự kiểm tra không nhất quán                                          |

Ghép tool hiện tại đủ cho khảo sát thủ công. Nếu nhu cầu lặp lại được xác nhận,
tool chuyên dụng là cách an toàn hơn để chuẩn hóa `unknown`; viewer mới không
cần thiết vì báo cáo có cấu trúc và doclist viewer hiện có đã đủ để xem chi
tiết.

## Contract

Input dự kiến gồm `company` bắt buộc, `sellingPriceList` và `buyingPriceList`
mặc định lần lượt là `Standard Selling`, `Standard Buying`, cùng
`requiredItemGroups` và `requiredUoms` do caller chỉ định. Danh sách trống nghĩa
là caller không yêu cầu tên custom nào, không có nghĩa mọi Item Group hoặc UOM
đều hợp lệ cho mọi giao dịch.

Allowlist chỉ gồm các phép list sau, chạy bằng quyền hiện tại của caller:

| Nhóm       | Tool/query hiện có                                                                 | Fields thật                                             | Scope                                                                          | Predicate `present`                                                                                |
| ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Company    | `erpnext_company_list`, hoặc `erpnext_doc_list` trên `Company` để filter chính xác | `name`, `abbr`, `default_currency`, `country`, `domain` | `name = company`                                                               | Query thành công và có đúng một Company khớp tên                                                   |
| Price List | `erpnext_doc_list` trên `Price List`                                               | `name`, `selling`, `buying`, `enabled`                  | Hai tên Price List được chỉ định; không có field Company trong bằng chứng repo | Selling list có `selling = 1`, buying list có `buying = 1`, và cả hai không có `enabled = 0`       |
| Warehouse  | `erpnext_warehouse_list` với `company`                                             | `name`, `warehouse_name`, `warehouse_type`, `company`   | `company = input.company`                                                      | Query thành công và có ít nhất một Warehouse thuộc đúng Company                                    |
| Item Group | `erpnext_doc_list` trên `Item Group`                                               | `name`, `is_group`                                      | Mỗi tên trong `requiredItemGroups`; không scope theo Company                   | Mọi tên được yêu cầu tồn tại; group hay leaf phải do use case chỉ định, không tự suy từ `is_group` |
| UOM        | `erpnext_doc_list` trên `UOM`                                                      | `name`, `enabled`                                       | Mỗi tên trong `requiredUoms`; không scope theo Company                         | Mọi tên được yêu cầu tồn tại và không có `enabled = 0`                                             |

Mỗi nhóm có một trong ba trạng thái:

- `present`: query thành công trên toàn bộ scope của nhóm và predicate đúng.
- `missing`: query thành công trên toàn bộ scope nhưng không có đủ bản ghi đáp
  ứng predicate. Chỉ response thành công mới được kết luận `missing`.
- `unknown`: không thể đánh giá toàn bộ scope, bao gồm `403`, timeout, lỗi mạng,
  `5xx`, response không hợp lệ hoặc kết quả bị cắt bởi limit.

Không chuyển lỗi quyền hay lỗi hạ tầng thành `missing`. Query phải dùng filter
chính xác và limit đủ cho scope nhỏ đã biết; nếu server không thể bảo đảm kết
quả đầy đủ thì trả `unknown`.

Output dự kiến:

```json
{
  "overall": "ready-for-specified-checks",
  "checkedAt": "2026-09-05T08:00:00.000Z",
  "checks": [
    {
      "group": "Company",
      "status": "present",
      "scope": { "company": "Example Co" },
      "evidence": [{ "name": "Example Co" }]
    }
  ],
  "limitations": [
    "This report does not confirm that the ERPNext setup wizard is complete."
  ],
  "recommendations": []
}
```

`overall` là `unknown` nếu có bất kỳ nhóm nào `unknown`; nếu không thì là
`incomplete` khi có nhóm `missing`, còn lại là `ready-for-specified-checks`.
`checkedAt` là thời điểm UTC lúc bắt đầu kiểm tra. `limitations` luôn nêu giới
hạn setup wizard và phạm vi input. `recommendations` chỉ là hướng dẫn để người
duyệt quyết định, không chứa hoặc kích hoạt mutation. Tool không đọc credential,
không gọi create/update/delete/submit/cancel và không đề nghị tự động sửa.

## Verification

Các ca dưới đây dùng mock client hoặc fetch giả, không gọi ERPNext thật:

| Ca                       | Input/tình huống                                                                                           | Kết quả quan sát                            | Phân loại                             | Khuyến nghị không mutation                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| 1. Đầy đủ                | Company `ACME`, hai Price List mặc định, một Warehouse đúng Company, các Item Group/UOM yêu cầu đều hợp lệ | Mọi predicate đúng                          | `ready-for-specified-checks`          | Cho phép người duyệt tiếp tục kiểm tra giao dịch              |
| 2. Thiếu Company         | Query Company thành công, không có `ACME`                                                                  | Company `missing`, tổng thể `incomplete`    | Thiếu dữ liệu                         | Yêu cầu quản trị viên xem xét tạo Company                     |
| 3. Thiếu Price List      | Selling list không tồn tại trong response thành công                                                       | Price List `missing`, tổng thể `incomplete` | Thiếu dữ liệu                         | Nêu đúng tên và vai trò Price List cần xem xét                |
| 4. Warehouse sai Company | Chỉ có Warehouse của `OTHER`                                                                               | Warehouse `missing`, tổng thể `incomplete`  | Thiếu trong scope                     | Yêu cầu kiểm tra Warehouse thuộc `ACME`                       |
| 5. Thiếu UOM custom      | `requiredUoms = ["Box"]`, query thành công nhưng không có `Box`                                            | UOM `missing`, tổng thể `incomplete`        | Thiếu dữ liệu                         | Yêu cầu xem xét UOM `Box`; không tự tạo                       |
| 6. Forbidden             | Bất kỳ query nào trả `403`                                                                                 | Nhóm đó `unknown`, tổng thể `unknown`       | Không đủ quyền, không phải thiếu      | Yêu cầu caller có quyền đọc hoặc quản trị viên xác minh       |
| 7. Server error          | Bất kỳ query nào trả `500`                                                                                 | Nhóm đó `unknown`, tổng thể `unknown`       | Lỗi server                            | Thử lại sau hoặc kiểm tra server, không sửa master data       |
| 8. Timeout               | Bất kỳ query nào hết thời gian                                                                             | Nhóm đó `unknown`, tổng thể `unknown`       | Lỗi kết nối                           | Thử lại có kiểm soát; không kết luận dữ liệu thiếu            |
| 9. Phản chứng wizard     | Cả năm nhóm đều `present`, nhưng setup wizard chưa hoàn tất và submit vẫn lỗi                              | `ready-for-specified-checks` kèm limitation | Không phát hiện giả trạng thái wizard | Dừng trước submit nếu quy trình yêu cầu xác nhận wizard riêng |

Test contract cần xác nhận ưu tiên `unknown` hơn `incomplete`, không trộn
response rỗng thành công với lỗi, không gọi ngoài allowlist và không có
mutation. Test tool nếu được triển khai dùng `Deno.test`, `@std/assert` và mock
`FrappeClient` theo quy ước hiện tại.

## Decision

Chọn thiết kế `erpnext_setup_check` read-only nếu triển khai sau khảo sát nhu
cầu, thay vì bắt mỗi client ghép năm query. Tool mang
`annotations: { readOnlyHint:
true }`, dùng quyền caller và trả evidence có giới
hạn. Chi phí tối đa là năm query logic; có thể gộp các tên trong từng DocType
bằng filter `in`, nhưng không được dùng cache hoặc limit theo cách biến kết quả
chưa đầy đủ thành `missing`.

Hiện tại chỉ chốt contract, không triển khai tool, viewer, schema, test hay gọi
dữ liệu thật. Nếu chưa có nhu cầu sử dụng lặp lại hoặc chưa thống nhất predicate
theo phiên bản ERPNext hỗ trợ, trì hoãn triển khai vẫn là lựa chọn hợp lệ.

## Open questions

- ERPNext có setup flag ổn định, được hỗ trợ qua REST và đọc được bằng quyền tối
  thiểu nào trên toàn bộ phiên bản mục tiêu? Chưa có bằng chứng trong repo nên
  không đưa vào predicate.
- Price List có cần kiểm thêm currency, country hoặc Company theo cấu hình cụ
  thể không? Bằng chứng hiện tại chỉ hỗ trợ `name`, `selling`, `buying`,
  `enabled`.
- Warehouse hợp lệ có cần loại group warehouse qua field `is_group` không? Tool
  chuyên dụng hiện chưa trả field này.
- `requiredItemGroups` cần phân biệt parent group và leaf theo từng luồng tạo
  Item như thế nào?
- UOM mặc định nào thực sự bắt buộc, thay vì chỉ kiểm các UOM custom caller nêu?
- Chính sách retry và timeout của check nên kế thừa `FrappeClient` hay có
  deadline tổng riêng để giới hạn chi phí năm query?
