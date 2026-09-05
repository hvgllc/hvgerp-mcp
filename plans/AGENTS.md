# Quy tắc review bộ kế hoạch

## Code Review Rules

1. Chỉ áp dụng cho chứng cứ trong `plans/`: mỗi record phải giữ `sourceRef` đọc
   được bằng Git và trích đoạn exact text, kể cả DONE hoặc STALE. TODO,
   IN_PROGRESS và BLOCKED phải kiểm thêm source hiện tại; khi có drift, refresh
   đồng bộ ref/line/code/fence hoặc chuyển STALE rõ lý do, không im lặng bỏ kiểm
   hay dùng lỗi đọc Git như thành công. DONE cần checklist và verdict từ review
   thật; gate tài liệu không thay gate implementation/CI đúng HEAD. Git refs bắt
   buộc phải còn reachable trong clone một nhánh có đầy đủ history, không chỉ
   tồn tại nhờ các nhánh executor hoặc object cache của máy phát triển.
2. ID và file phải ánh xạ một-một đủ 25 kế hoạch. Phụ thuộc phải đồng nhất theo
   tập ID giữa manifest, metadata kế hoạch và cột README; trạng thái kế hoạch
   khớp README, IN_PROGRESS/DONE chỉ khi prerequisite DONE. Scope manifest phải
   bằng danh sách file trong Phạm vi và Git, trừ hai file quản trị README và
   evidence NNN mặc định. Khi thay phạm vi/phụ thuộc, sửa cả các biểu diễn liên
   quan và đối chiếu category của caller/tool thật, không xóa prerequisite, nới
   category hoặc giảm tiêu chí để vượt gate.

Gate cho mỗi delta: `node plans/validate-plans.mjs`,
`node --test plans/test-validator.mjs`, `deno fmt --check plans/` và
`deno lint --no-config plans/validate-plans.mjs plans/test-validator.mjs plans/test-history.mjs`.
Giữ ca vi phạm bị từ chối, ngoại lệ chủ ý được chấp nhận và thay đổi không liên
quan vẫn qua; ví dụ và kết quả ở
[evidence/backlog-review.md](evidence/backlog-review.md). Vòng review tiếp phải
xác minh quy tắc bắt đúng lỗi, không báo sai ngoại lệ; không suy ra rule đã hiệu
quả chỉ vì local regression xanh.

Sau commit local, trước push/merge, chạy thêm
`node --test plans/test-history.mjs` từ worktree có plans đã tracked và sạch.
Gate tạo clone một nhánh `--no-local --no-tags`, kiểm validator cùng ancestry
thật; ca âm dùng revision lịch sử trước sửa, không tạo bằng chứng review giả.
Checkout shallow phải fetch đầy đủ history trước. PR25 giữ provenance bằng merge
commit, không squash/rebase làm mất các reviewed revision đã ghim. Workspace
root cố ý giữ source d2c5305 cùng plans untracked không thay worktree đã commit
cho gate history này.
