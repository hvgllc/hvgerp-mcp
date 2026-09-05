# Kiểm chứng workaround JSR

Ngày 2026-09-05, người dùng yêu cầu áp dụng hướng dẫn trong
docs/jsr-403-workaround.md vào worktree thực thi.

## Cấu hình đã áp dụng

- Worktree: `/private/tmp/hvgerp-improve.Lr8fHe/worktree`.
- `deno.nojsr.json` giữ mọi cấu hình của deno.json, kể cả version 3.4.0; chỉ
  thay import map theo hướng dẫn. Kiểm bằng Node assert: đạt.
- Vendor @casys/mcp-server 0.25.0 lấy từ cache npm có sẵn, nằm ngoài
  node_modules. Reviewer dùng diff -qr và xác nhận toàn bộ vendor giống cache
  theo byte.
- @std/assert và @std/yaml dùng deno.land/std@0.224.0 theo workaround được
  duyệt. Không coi việc thay nguồn này là kiểm chứng tương đương JSR thật.
- Ba artifact local đều bị Git ignore; không sửa config/vendor ở repo chính.
- Lockfile được copy từ repo chính và giữ SHA-256 trước/sau:
  `f32268af50c10ba06223c9a0b7f2d7092555ffa90172cd573ecf8d3feb2d882a`.
- Không tải thêm dependency để thiết lập workaround, không đổi version project.

## Kết quả trước sửa auth

Reviewer tự chạy lại trong worktree:

```bash
deno check --config deno.nojsr.json --sloppy-imports --frozen mod.ts server.ts
deno test --config deno.nojsr.json --sloppy-imports --allow-all --frozen --quiet src/
```

- Typecheck: exit 0.
- Full suite: exit 1; 762 passed, 16 failed, 4 ignored.
- Cả 16 lỗi thuộc ma trận test mới của kế hoạch 001, đều là assertion Expected
  function to throw; không có lỗi tải module JSR.
- Executor cũng chạy targeted auth test: 18 passed, 16 failed.
- Đây là bằng chứng test đỏ đúng lỗi trước implementation, không phải suite
  xanh.

## Giới hạn

Workaround đã gỡ blocker chạy local, chưa thay thế gate CI dùng JSR thật. Không
dùng deno task --config để chạy check/test. Không format vendor, không sửa
import map chính, không push hay dispatch workflow trong bước này.
