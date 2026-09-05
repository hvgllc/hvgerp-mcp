# Lưu bộ kế hoạch vào Git

## Phạm vi và nguồn

- Ngày 2026-09-05, goal đã cho phép lưu backlog và bằng chứng vào Git.
- Base: `013a1cfda64d41b3e62658ff16f7e25be0b3b4c7`, branch
  `advisor/goal-backlog`.
- Đọc và sao chép 33 file văn bản của `plans/` từ workspace chính bằng
  `apply_patch`. Không ghi vào workspace chính hoặc worktree của executor khác.
- Không đưa `AGENTS.md`, `execution-notes.md` ở gốc,
  `docs/jsr-403-workaround.md`, credential hoặc artifact build vào commit.
- Evidence 001 mới lưu kết luận reviewer, CI và merge. Báo cáo executor cũ được
  giữ nguyên tại [001-executor-local.md](001-executor-local.md), không xóa chi
  tiết giai đoạn trước CI. Evidence 024 giữ nội dung cũ và bổ sung merge proof.
- Index trong snapshot có 2 DONE, 2 IN_PROGRESS và 21 TODO. Đây là tiến độ tại
  lúc sao chép, không phải tuyên bố các executor vẫn chạy hoặc đã hoàn tất.

## Phát hiện trong validator

DONE trước đây có thể dùng source hiện tại nếu nhãn Mốc soạn bị thiếu hoặc sai.
Phản chứng đổi nhãn của 024 thành Mốc lỗi vẫn exit 0 dù bỏ qua Git history.
Guard mới bắt buộc ref hợp lệ trước khi đọc chứng cứ. Không bắt và bỏ qua lỗi
Git; object không tồn tại vẫn làm validator thất bại.

`test-validator.mjs` đọc file qua wrapper trong bộ nhớ, chỉ sửa văn bản trả về
cho validator và gọi `git show` thật. Không sửa file để tạo test case.

| Ca kiểm                          | Trước guard | Sau guard   |
| -------------------------------- | ----------- | ----------- |
| DONE 001 dùng source tại d2c5305 | exit 0      | exit 0      |
| TODO có trích đoạn sai           | exit 1      | exit 1      |
| DONE có trích đoạn sai           | exit 1      | exit 1      |
| DONE thiếu APPROVE               | exit 1      | exit 1      |
| DONE thiếu nhãn mốc soạn         | exit 0, sai | exit 1      |
| DONE trỏ Git object không có     | ném lỗi Git | ném lỗi Git |

Baseline còn kiểm trực tiếp source auth hiện tại không có nhánh lỗi cũ và Git
thật được yêu cầu đọc `d2c5305:src/auth/config.ts`. Ca Git object thiếu xác nhận
chính lệnh `git show deadbee:docs/ROADMAP.md` bị lỗi, không coi một lỗi bất kỳ
là bằng chứng đạt.

## Kiểm tra

- `node plans/validate-plans.mjs`: exit 0, đủ 25 kế hoạch, scope và trích đoạn
  hợp lệ, không có chu trình phụ thuộc.
- `node plans/test-validator.mjs`: exit 0, sáu ca đúng kết quả mong đợi.
- `deno fmt --check plans/`: exit 0, kiểm đủ 36 file của snapshot cuối.
- `deno lint plans/validate-plans.mjs plans/test-validator.mjs`: exit 0, kiểm
  hai script. Deno có thử đọc metadata JSR khi nạp config, nhưng đây không phải
  gate test hoặc typecheck dùng JSR thật.
- `git diff --check` và `git diff --cached --check`: exit 0.
- So từng byte với snapshot gốc: 29 file giống nguyên bản; chỉ README, validator
  và evidence 001/024 được chỉnh có chủ đích. Thêm ba file: bản lưu evidence
  executor, test validator và báo cáo này. Tổng 36 file được stage, tất cả nằm
  trong plans; bản lưu executor chứa nguyên văn byte của báo cáo cũ.
- So tree `bb78ace` và base `013a1cf`: cùng
  `2c82ce38a0bea9d35e384535f35f8fbed616742c`.
- Quét toàn bộ nội dung plans: không có U+2014, token pattern phổ biến, private
  key hoặc giá trị gán vào các tên secret/password/API key. Đây là kiểm tránh
  sao chép credential, không phải bảo đảm tuyệt đối về mọi dạng secret.

## Giới hạn

Đợt này chỉ lưu tài liệu và kiểm validator, không sửa source ứng dụng hoặc nâng
dependency. Không chạy lại test ứng dụng, browser hoặc build vì không thay hành
vi ứng dụng. Không suy ra 23 mục còn lại đã được thực thi từ validator xanh.
Chưa push, tạo PR hoặc merge nhánh backlog; reviewer độc lập và CI do parent
điều phối tiếp.
