# Trạng thái soạn kế hoạch

Đây là ghi chép của lượt soạn đã hoàn tất. Trạng thái thực thi mới nhất nằm
trong [execution-run.md](execution-run.md) và bảng ở [README.md](README.md).

- Mục tiêu: đủ 25 kế hoạch cho 22 phát hiện và 3 hướng phát triển của audit
  deep.
- Mốc nguồn: d2c5305, ngày 2026-09-05.
- Phạm vi hiện tại: chỉ tạo và kiểm tra hiện vật trong plans/; chưa thực thi sửa
  lỗi.
- Đã tạo: 25 kế hoạch, README với ánh xạ/thứ tự/trạng thái, manifest và
  validator.
- Trạng thái thực thi của 25 kế hoạch: TODO, không có lỗi nào được tuyên bố đã
  sửa.
- Baseline audit: lint qua; format qua khi loại file cá nhân ở gốc; UI typecheck
  thất bại; Deno test/check chưa hoàn tất do thiếu JSR cache.
- Kiểm bộ kế hoạch: validator đạt 25/25, trích đoạn và số dòng khớp source,
  scope hợp lệ, liên kết đầy đủ, phụ thuộc không chu trình.
- Đã hoàn tất: format 29 hiện vật đạt; git diff --check đạt; không có diff
  tracked.
- Đã thử phản chứng validator trong bộ nhớ, không sửa file: baseline exit 0;
  thiếu kế hoạch, phụ thuộc có chu trình, số dòng sai và scope không tồn tại đều
  exit 1 như mong đợi.
- Chưa làm: sửa source, cài/nâng dependency, build phát hành, commit, push, tạo
  issue hoặc thao tác production.
- File cá nhân execution-notes.md ở gốc được giữ nguyên. Git không có diff
  tracked; chỉ thấy file cá nhân và plans/ untracked.

## Review độc lập

Ba lượt review chỉ đọc theo các nhóm 001-008, 009-016, 017-025 đã đối chiếu kế
hoạch với source. Các góp ý ảnh hưởng tính đúng đắn và khả năng thực thi đã được
xử lý:

- 002: bổ sung Asset/custodian và bỏ qua tất cả cache trên đường preflight, bao
  gồm negative cache.
- 007: thêm test host MCP cục bộ có AppBridge và fixture thật theo contract;
  không mở Vite viewer đơn lẻ rồi coi là kiểm MCP.
- 008: chốt byte CSV, kiểu dữ liệu, chống formula injection; kiểm artifact tải
  từ host.
- 008: review lại đã khép các góp ý trước; bổ sung CSV vào scope theo góp ý
  cuối. Thư mục evidence phụ trợ cho ảnh/trace UI và báo cáo build cũng được cho
  phép rõ trong các kế hoạch tương ứng.
- 009: dùng host và deferred response cho race chi tiết.
- 011: bao cả authorize/auth.blocked, giữ kết quả batch trước lỗi và challenge,
  phân biệt unknown/not executed.
- 014: không ép tổng item amount bằng invoice grand_total khi có thuế/chiết
  khấu/top N.
- 016: identity gồm phiên và arguments, thêm cùng Task khác project/page.
- 018/019: bỏ tuyên bố đo latency khi chưa có phép đo; giữ kiểm số entry và tính
  cách ly object.
- 021: hai lệnh bash -n riêng; helper được lên kế hoạch để so hai
  build/graph/hash/pack và smoke Node20/22, không gán các khả năng này cho
  release-check hiện tại.
- 022: thay đường dẫn không tồn tại bằng tài liệu migration thật, giữ riêng chỉ
  dẫn lịch sử.
- Các reviewer 009-016 và 017-025 đã kiểm lại sửa và không còn lỗi chặn trong
  phạm vi đã review. Góp ý cuối về expected của bash -n cũng đã sửa.
- Parent tự kiểm lại source, số dòng, diff và đầu ra validator; review không
  thay thế kiểm tra trực tiếp.

## Quyết định phạm vi

Ba hướng 023-025 chỉ tạo kế hoạch khảo sát/thiết kế. Rubric có phương án cạnh
tranh, phản chứng, query/contract map và tình huống kiểm chứng; không tự mở
quyền triển khai. Các dependency được khóa trong kế hoạch021 bằng phiên bản được
chấp thuận, không cho phép dùng latest để lấp chỗ thiếu dữ liệu.
