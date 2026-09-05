# Nhật ký thực thi improve

## Phạm vi được chấp thuận

- Thực thi 25 kế hoạch bằng executor; 023-025 chỉ tạo tài liệu thiết kế.
- Dùng worktree Git tạo thủ công vì công cụ spawn không có isolation tích hợp.
- Nhánh riêng: `advisor/improve-execute-all`.
- Worktree: `/private/tmp/hvgerp-improve.Lr8fHe/worktree`.
- Base: `d2c53058aa0d6bce8357f6f258dc812105aa38db`.
- Người dùng đã cho push nhánh riêng và chạy workflow ngày 2026-09-05, sau đó
  cho phép merge PR #23. Không publish, nâng dependency hay sửa production.
- Advisor chỉ chỉnh hiện vật trong plans/ ở repo chính, không sửa source.
- Executor được commit trong nhánh worktree riêng sau khi đủ bằng chứng.

## Trạng thái

Cập nhật goal tự động ngày 2026-09-05: đã được phép commit, push, PR, CI và
merge các kế hoạch sau khi đạt review và gate. Goal vẫn giữ đủ 25 mục; không
release/publish, không tự nâng dependency hoặc đổi production.

- 002 đang IN_PROGRESS: executor goal_execute_002 tại
  /private/tmp/hvgerp-goal.BTKxiY/002, branch
  advisor/002-mrtr-preflight-before-write.
- 004 đang IN_PROGRESS: executor goal_execute_004 tại
  /private/tmp/hvgerp-goal.BTKxiY/004, branch advisor/004-response-body-timeout.
- Hai worktree từ main 013a1cf; source thuộc scope chưa drift so với d2c5305.
- Worktree lưu backlog: /private/tmp/hvgerp-goal.BTKxiY/backlog, branch
  advisor/goal-backlog; chỉ lưu plans, không copy file cá nhân ở gốc.
- Tổng hiện tại: 2 DONE, 2 IN_PROGRESS, 21 TODO. Phần bên dưới lưu lịch sử.

## Lịch sử trước goal tự động

- 001: DONE, verdict APPROVE. Commit source 495cd98 đã qua review và gate local.
  CI Test 33940983646 trên HEAD bb78ace dùng JSR thật cũng đạt: 805 pass/0
  fail/4 ignored, format, lint, typecheck và build đủ 7 viewer.
- 024: DONE, commit 89a10e3 được APPROVE sau một vòng sửa. Reviewer đã chạy lại
  gate, đọc toàn bộ diff và kiểm 7 mục, 5 nhóm, 12 tình huống. Đây chỉ là thiết
  kế, không phải feature.
- 002-023 và 025: TODO, chưa giao executor. Không coi là đã thử hoặc đã đạt.
- Tổng kết: 2 DONE, 23 TODO. Đã merge PR #23, chưa publish.

## Merge và đối chiếu tiếp theo

- PR: https://github.com/hvgllc/hvgerp-mcp/pull/23
- Trạng thái GitHub MERGED lúc 2026-09-05T04:00:06Z, squash commit
  013a1cfda64d41b3e62658ff16f7e25be0b3b4c7 trên main.
- Tree của merge commit và HEAD bb78ace đã review/CI giống nhau:
  2c82ce38a0bea9d35e384535f35f8fbed616742c.
- Trước merge: Codex clean_comment đúng HEAD, không có review thread, workflow
  Test 33940983646 success; merge dùng match-head-commit.
- Main local vẫn tại d2c5305 vì có AGENTS.md đang sửa, docs và plans chưa
  commit. Không pull, reset, xóa worktree hoặc ghi đè các hiện vật này.
- Kiểm read-only bổ sung: tsc --noEmit -p src/ui/tsconfig.json exit 2, có lỗi
  Recharts và cấu hình lẫn mã Deno. Đây là baseline của 007; CI hiện chỉ build
  UI, chưa có browser typecheck. Chưa thực thi kế hoạch 007.
- Đã đối chiếu luồng code hiện tại của 002, 003, 004; các vấn đề trong backlog
  vẫn còn. Lượt này chỉ merge và thảo luận, không khởi động implementation.

## Workaround và điểm tiếp tục

Người dùng đã cho áp dụng docs/jsr-403-workaround.md. Vendor local khớp npm
cache @casys/mcp-server 0.25.0; cấu hình chỉ đổi import map và được Git ignore.
Không thay dependency project. Bằng chứng ở
[evidence/jsr-workaround.md](evidence/jsr-workaround.md).

CI dùng JSR thật đã đạt sau khi người dùng cho phép push và dispatch:
https://github.com/hvgllc/hvgerp-mcp/actions/runs/33940983646. Reviewer đối
chiếu headSha bb78ace với local HEAD và remote, đọc log nguồn JSR và kết quả
test trước khi khép lại 001 theo skill improve execute. Không tự khởi động lại
các kế hoạch còn lại sau yêu cầu hủy trước đó; lượt này chỉ push, chạy workflow
và ghi kết quả.

Reviewer đã khép lại hai lỗi do cách chạy xác minh: test chạy khi UI còn build,
và deno task ui:build làm đổi lockfile local. Đã phục hồi lock chính xác rồi
rerun test tuần tự thành công. Khi tiếp tục, gọi trực tiếp node build-all.mjs
trong src/ui rồi chạy test với --config deno.nojsr.json --sloppy-imports
--frozen. Chi tiết đầy đủ ở [evidence/001.md](evidence/001.md).

## Quy tắc review

Reviewer đọc toàn bộ diff, kiểm phạm vi, đọc assertion và chạy lại các gate. Tối
đa hai vòng yêu cầu sửa cho mỗi kế hoạch, sau đó BLOCK nếu vẫn không đạt. Kế
hoạch phụ thuộc chỉ chạy sau DONE. Không đổi lỗi thiếu môi trường thành test đã
qua và không lấy fixture thay bằng chứng bắt buộc từ hệ thống thật.
