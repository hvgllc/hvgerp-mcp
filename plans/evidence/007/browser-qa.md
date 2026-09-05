# Browser QA của parent cho 007

Ngày 2026-09-05, Chrome thật qua Browser plugin. Host local tại
http://127.0.0.1:5178/testing/host.html, title HVGERP Local Test Host. Không gọi
ERPNext hoặc dùng credential. DOM và trace nguyên bản lưu trong
[browser-qa.json](browser-qa.json); ảnh trong [browser/](browser/).

## Phần đã kiểm

- Cả bảy viewer hiện nội dung có nghĩa trong iframe build thật; trace có
  initialized, tool-input rồi tool-result. Không có Vite overlay.
- Doclist có ba Customer, invoice INV-LOCAL-001 tổng 30 USD, stock ITEM-LOCAL
  tồn 12, chart Alpha/Beta, KPI Local revenue 1.250 USD, funnel ba giai đoạn,
  Kanban Task A one/two. Không suy ra độ đúng nghiệp vụ từ fixture.
- Bar, horizontal-bar và pie click Alpha gửi message Show sales for Alpha;
  tooltip hiện 30 USD. Pie/donut có Alpha 60%, Beta 40%, donut tổng 50 USD. Lần
  click đầu sau khi focus iframe có thể bị refresh làm mất; click tiếp theo có
  message. Không sửa hành vi focus ngoài phạm vi typecheck.
- Invoice và stock mở detail panel với Name, Group, UOM, rate và dữ liệu stock
  hoặc movement. Trace gọi đúng item_get cùng stock_balance/stock_entry_list.
- Detail-race giữ request TASK-A-1 và TASK-A-2, trả A-2 rồi lỗi A-1 bằng nút
  release/reject cụ thể trong dưới 10 giây. Modal vẫn là Task A two. Fixture
  user_list bổ sung sau QA trả Local User, không còn lỗi unsupported đó. Một ca
  này không thay ma trận đầy đủ của kế hoạch 009.
- Board-race giữ get_board A và move A, gửi board B cùng task-board nhưng khác
  project, trả move rồi refresh A. Viewer bị ghi đè về board A. Đây là baseline
  lỗi kế hoạch 016, không phải lỗi đã được sửa trong 007. Host tái hiện được nó.
- Doclist initial-error hiện alert Local initial error; gửi dữ liệu thành công
  phục hồi ba dòng. Refresh-error hiện Refresh failed và giữ dữ liệu cũ.
- Click CSV tải Customer.csv thật, 177 byte, mtime 2026-09-05T12:00:50+0700. Đã
  đọc file vừa tải: dấu phẩy/nháy được quote, nhưng newline chưa quote và chuỗi
  =1+1 chưa trung hòa. Đây là baseline 008, không coi CSV đã an toàn.
- Viewport 390x844: Kanban chuyển thành tablist Open/Working/Completed và một
  tabpanel, hai thẻ hiện rõ. Đã reset viewport sau kiểm.

## Console và giới hạn

Không có error JavaScript trong lần đọc console cuối. Recharts có warning
width(-1)/height(-1) khi mount; sau layout vẫn thấy đầy đủ cột/pie/donut và
tooltip hoạt động. Không gọi console hoàn toàn sạch hoặc khẳng định warning đã
được sửa. Chưa tạo payload cố ý thiếu percent/value để kích formatter undefined
trong browser; phần đó được kiểm qua kiểu và đọc guard nguồn.

Host ban đầu thuộc executor đã dừng khi executor kết thúc, gây một lần
ERR_CONNECTION_REFUSED khi chuyển viewer. Parent khởi động lại cùng lệnh,
session 89114, rồi chạy lại các tương tác. Đây là vòng đời tiến trình QA, không
phải lỗi mạng production. Ảnh/detail-race trước bổ sung user_list là lịch sử;
detail-race-final.png phản ánh host cuối cùng.

Review độc lập review_007 APPROVE sau vòng sửa 1. Hash host được duyệt:
3ffaca5d659ca9b4f2ee413d07f5cffe72a983e1a4f817508c6132b7471c0691. Browser QA này
không thay CI trên HEAD cuối, release preflight hoặc gate JSR.
