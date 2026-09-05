# Host kiểm thử browser local

Host dùng AppBridge và PostMessageTransport thật từ MCP Apps SDK đã khóa trong
package-lock. Iframe tải HTML build thật của một trong bảy tên trong UI_VIEWERS.
Không có ERPNext, credential, HTTP API hoặc dependency mới. Fixture là dữ liệu
kiểm thử có chủ đích, không phải bằng chứng tích hợp ERPNext production.

## Khởi động

```bash
npm --prefix src/ui ci
npm --prefix src/ui run typecheck
npm --prefix src/ui run build
npm --prefix src/ui run dev:test-host
```

Vite chỉ bind 127.0.0.1:5178 với strictPort. Mở:

http://127.0.0.1:5178/testing/host.html?viewer=doclist-viewer&scenario=csv

Chọn viewer và kịch bản rồi nhấn **Đặt lại** để tải trang mới, hủy bridge cũ và
bắt đầu trace từ đầu. Host không dùng thời gian chờ ngẫu nhiên. Timeout 10 giây
của viewer vẫn giữ nguyên, nên trả kết quả đang giữ trước timeout nếu muốn kiểm
thứ tự phản hồi thay vì kiểm timeout.

## Kiểm tra bắt buộc

- Trace phải có `initialized`, `tool-input`, rồi `tool-result` theo thứ tự.
- Nội dung phải hiện bên trong iframe `#viewer-frame`, không chỉ ở trace host.
- Kiểm URL/title, nội dung không trống, không có Vite overlay, console và ảnh
  chụp. Build hoặc typecheck xanh không thay thế bước này.
- Sau khi sửa viewer, build lại rồi **Đặt lại**. Vite không tự build lại `dist/`
  cho host này.

## Các kịch bản

| Kịch bản        | Thao tác và bằng chứng                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke`         | Chọn lần lượt cả bảy viewer. Invoice hiển thị INV-LOCAL-001, stock hiển thị ITEM-LOCAL, Doclist có ba Customer, chart có Alpha/Beta, KPI có Local revenue, funnel có Lead/Opportunity/Won, Kanban có Task A one/two. Nhấn Refresh để trace có tool/args và kết quả mới. |
| `csv`           | Doclist có dấu phẩy, dấu nháy, xuống dòng, tiếng Việt, số 0 và chuỗi mở đầu = hoặc +. Nhấn nút xuất CSV thật của viewer và kiểm file tải về. Fixture không sửa hay trung hòa giá trị trước khi viewer xuất.                                                             |
| `detail-race`   | Kanban: mở Task A one, đóng modal khi request còn giữ, mở Task A two. Trả request của A two trước, sau đó trả kết quả hoặc lỗi của A one. Quan sát modal hiện tại có bị đổi dữ liệu/lỗi sai hay không.                                                                  |
| `board-race`    | Kanban: nhấn Refresh hoặc nút chuyển cột để giữ phản hồi board A. Nhấn **Gửi board B** trên host, rồi trả kết quả hoặc lỗi request cũ. Quan sát board B có bị ghi đè bởi board A hay không.                                                                             |
| `initial-error` | Host gửi kết quả lỗi MCP có text Local initial error ngay sau tool-input. Kiểm viewer thoát loading và hiện lỗi, không biến lỗi thành dữ liệu rỗng. Nút **Gửi lại dữ liệu thành công** cho phép kiểm phục hồi.                                                          |
| `refresh-error` | Sau khi dữ liệu đầu tiên hiện, nhấn Refresh. Host trả kết quả lỗi MCP Local refresh error. Kiểm dữ liệu cũ được giữ cùng thông báo lỗi phù hợp.                                                                                                                         |

Hai board A/B giữ cùng boardId task-board như producer thật, nhưng khác project
trong refreshArguments. Không được chỉ so boardId rồi coi đó là cùng phạm vi.

Các request đang giữ xuất hiện trong `#pending` với `data-request-id`, tên tool
và args. Nút **Trả kết quả #ID** hoặc **Trả lỗi #ID** chỉ giải phóng request
tương ứng. Trace ghi `received`, `held`, rồi `released`/`rejected`/`cancelled`.
Request không được nhận diện trả lỗi `Unsupported local fixture tool`, không âm
thầm dùng một fixture khác.

Host ghi `message` khi viewer gọi sendMessage. Kiểm chart bar/horizontal-bar
bằng cách chọn kiểu ở form, nhấn cột Alpha rồi kiểm message có Alpha. Với pie
hoặc donut, kiểm label, hover tooltip và nhấn lát cắt. KPI/funnel có một liên
kết drill-down local để kiểm sendMessage.

Kịch bản có thể phơi bày lỗi hiện có thuộc backlog 008/009/016/017. Host chỉ
cung cấp đầu vào và điều khiển thứ tự, không sửa lỗi viewer hoặc coi kết quả
baseline đó là đạt. Ghi nhận lỗi thực tế cùng trace.

## Ranh giới phát hành

Host có tên host.html, không phải index.html nên build-all vẫn nhận đúng bảy
viewer. deno.json loại src/ui/testing/** khỏi publish. Node build loại thư mục
nguồn UI và chỉ đóng gói bundle cùng bảy HTML dưới ui-dist. Host không được
nhúng vào package phát hành.
