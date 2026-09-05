# Kế hoạch 011: Giữ kết quả batch đã thực thi khi upstream ném lỗi

> Đây là kế hoạch giao cho agent thực thi sau này. Đọc trọn file, kiểm chứng
> từng bước và cập nhật hàng 011 trong `plans/README.md`; không coi việc tạo tài
> liệu này là đã sửa lỗi.

## Trạng thái và mục tiêu

- Mục audit: 11; loại: `bug`.
- Ưu tiên: P1; công sức: M; rủi ro sửa: vừa; semantics JSON-RPC batch.
- Phụ thuộc: không.
- Mốc soạn: `d2c5305`, 2026-09-05. Trạng thái thực thi: `TODO`.
- Độ tin cậy: cao về luồng mã; chưa xác minh với ERPNext production.

forwardOne throw trong entry thứ hai làm mất replies của entry đầu; shim.ts trả
một lỗi 502 id:null. Client không biết phần nào đã ghi và có thể gửi lại cả
batch. Đích là giữ kết quả thành công, đánh dấu entry lỗi là outcome unknown, và
các entry chưa gọi là not executed.

## Hiện trạng và chứng cứ

`src/compat/legacy-shim.ts:1783`:

<!-- evidence: src/compat/legacy-shim.ts -->

<!-- deno-fmt-ignore -->
```text
    const outcome = await forwardOne(
```

`shim.ts:92`:

<!-- evidence: shim.ts -->

<!-- deno-fmt-ignore -->
```text
    return Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Shim upstream failure" },
    }, { status: 502 });
```

## Quy ước cần giữ

Shim library chỉ dùng Web APIs, không Deno.* hoặc node:*; shim.ts là entrypoint
Deno ngoại lệ. Giữ auth/header/version translation, synthetic SSE và giới hạn
body hiện có. Không tự retry mutation.

Mẫu test có sẵn tại `src/tools/assignment_test.ts` dùng `Deno.test` và
`@std/assert`, ví dụ:

```typescript
Deno.test("prepareAssignment returns undefined without assign_to", () => {
  assertEquals(prepareAssignment({}, "tool"), undefined);
});
```

Test dùng mock client hoặc fetch giả, không gọi ERPNext thật trong suite chính.

## Phạm vi và Git

Các file được sửa khi thực thi:

- `src/compat/legacy-shim.ts`
- `src/compat/legacy-shim_test.ts`
- `shim.ts`
- `docs/migration-mcp-spec-2026-07-28.md`
- `plans/README.md`
- `plans/evidence/011.md`
- `plans/evidence/011/container-smoke.ts` (tạo mới, fixture cho container local)

Ngoài phạm vi: không thay single-request transport hoặc auth pipeline; không
replay batch, không đổi legacy versions hỗ trợ. Không sửa dữ liệu production,
credential, `execution-notes.md` ở gốc; không bump version hay tự nâng
dependency. Định danh, chuỗi lỗi và commit bằng tiếng Anh; phần giải thích tiếng
Việt có dấu, không dùng ký tự U+2014.

Trước khi sửa, chạy `git status --short`,
`git diff --stat d2c5305..HEAD -- src/compat/legacy-shim.ts src/compat/legacy-shim_test.ts shim.ts docs/migration-mcp-spec-2026-07-28.md`
và
`git diff -- src/compat/legacy-shim.ts src/compat/legacy-shim_test.ts shim.ts docs/migration-mcp-spec-2026-07-28.md`.
Bảo toàn thay đổi có sẵn. Nếu phụ thuộc đã thực thi, đối chiếu diff và làm mới
kế hoạch này theo code mới trước khi sửa; sai khác chưa giải thích được là điều
kiện dừng.

Nhánh đề xuất: `advisor/011-shim-partial-batch-errors`. Không commit, push, mở
PR hoặc merge nếu chưa có chỉ thị thực thi tương ứng; commit dự kiến
`fix(shim): preserve completed batch replies on upstream failure`.

## Lệnh xác minh

| Mục đích       | Lệnh                                                   | Kết quả mong đợi                      |
| -------------- | ------------------------------------------------------ | ------------------------------------- |
| Test trọng tâm | `deno test --allow-all src/compat/legacy-shim_test.ts` | exit 0; mọi ca trong mục Kiểm thử đạt |
| Kiểu server    | `deno check mod.ts server.ts`                          | exit 0                                |
| Test hồi quy   | `deno test --allow-all src/`                           | exit 0                                |
| Lint           | `deno lint`                                            | exit 0                                |
| Format         | `deno fmt --check`                                     | exit 0                                |

Baseline lúc tư vấn: lint qua; format toàn repo chỉ vướng file cá nhân chưa theo
dõi ở gốc; UI typecheck có lỗi; Deno test/check thiếu JSR cache. Các lệnh trên
là gate cần đạt khi thực thi, chưa phải kết quả đã đạt. Không tải/nâng
dependency để lách lỗi, không xóa hoặc giảm test. Nếu dependency đã khai báo
chưa có, báo rõ nhu cầu cài đúng lockfile và quyền mạng; với UI dùng
`deno task ui:install` khi được phép. Có thể xác minh format các file trong diff
riêng khi một lỗi có sẵn ngoài phạm vi chặn toàn repo, nhưng phải ghi trạng thái
toàn repo là bị chặn.

## Các bước

### Bước 1: Tạo ca batch dở dang có write

Dùng fetch giả cục bộ hoặc fake upstream của legacy-shim_test.ts: 3 entries, thứ
nhất success, thứ hai network throw hoặc JSON body lỗi, thứ ba spy chưa gọi.
Expected replies giữ id thứ nhất và outcome unknown cho id thứ hai, not executed
cho id thứ ba. Thêm batch có notification trước/sau lỗi, không tạo JSON-RPC
response cho notification.

**Kiểm tra:** `deno test --allow-all src/compat/legacy-shim_test.ts` →
regression đỏ vì handleShimRequest reject toàn bộ hoặc mất reply đầu.

### Bước 2: Catch ở ranh giới từng entry

Đặt ranh giới xử lý lỗi ở toàn bộ từng entry: authorize ở cả missing-method,
locally-answered và invalid-fields; auth.blocked; forwardOne; đọc/parse payload.
Theo dõi đã chuyển một entry lên upstream riêng với replies.length, vì
notification có thể đã ghi mà không có reply. Nếu chưa thực thi entry nào, giữ
nguyên auth response/challenge như trước. Nếu đã có entry thực thi, không return
auth.blocked làm mất replies: giữ kết quả trước đó, trả lỗi xác thực cho entry
hiện tại có id và not executed cho phần còn lại, dừng batch. Khi authorize bị
throw thì entry local chưa gọi mutation, ghi not executed/auth unavailable; khi
forwardOne throw thì outcome unknown vì có thể đã commit. Giữ WWW-Authenticate,
CORS và protocol headers theo response auth nếu có; không biến auth deny thành
success hoặc bỏ auth probe bắt buộc. HTTP status/body cho partial batch phải
được khóa bằng wire test để client còn đọc được completed replies. Không đưa raw
URL/internal exception ra client; không retry mutation.

**Kiểm tra:** `deno test --allow-all src/compat/legacy-shim_test.ts` → exit 0;
không entry nào sau lỗi gọi upstream và completed reply không biến mất.

### Bước 3: Kiểm wire và runtime boundary

Kiểm malformed response, network reject, lỗi đọc body, mixed notification,
non-JSON branch hiện có, 401/403, legacy revision. Chạy typecheck shim riêng và
test boundary. Không cần Node bundle vì shim không được npm ship; image shim
thật phải được kiểm ở bước 4 dù không đổi dependency. Bắt buộc kiểm authorize
throw/401 trong cả ba nhánh local và notification đầu batch; ghi HTTP status,
headers, JSON-RPC ids và số mutation.

**Kiểm tra:**
`deno check shim.ts && deno test --allow-all src/runtime-boundary_test.ts src/compat/legacy-shim_test.ts`
→ exit 0; shim library vẫn platform-free.

### Bước 4: Kiểm image shim thật và provenance

Tạo fixture Deno `plans/evidence/011/container-smoke.ts`, chỉ dùng HTTP local,
không credential thật. Fixture mở upstream giả ở `127.0.0.1:17655`, gửi request
đến shim ở `127.0.0.1:7654`, đếm mutation và kiểm wire cho success/error/auth
batch như bước 1-3. Mỗi ca reset trạng thái, assertion timeout hữu hạn và đóng
server/stream trong finally; có ca control initialize hoặc ping thành công.

Chạy
`git diff --exit-code HEAD -- shim.ts src/compat/legacy-shim.ts Dockerfile.shim`
để kiểm cả staged lẫn unstaged so với commit local đang gắn nhãn. Chỉ tiếp tục
khi source build khớp HEAD, không coi riêng index sạch là đủ. Sau đó:

```bash
docker build -f Dockerfile.shim --build-arg VCS_REF="$(git rev-parse HEAD)" -t hvgerp-shim-plan011:local .
docker image inspect hvgerp-shim-plan011:local --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
docker run --rm -d --name hvgerp-shim-plan011 --network none -e SHIM_UPSTREAM=http://127.0.0.1:17655 hvgerp-shim-plan011:local
docker run --rm --network container:hvgerp-shim-plan011 --mount "type=bind,src=$PWD/plans/evidence/011/container-smoke.ts,dst=/checks.ts,readonly" --entrypoint deno hvgerp-shim-plan011:local run --allow-net /checks.ts
```

Container fixture dùng chung network namespace với shim, nên upstream chỉ nằm
trong loopback của hai container; không mở port ra host và không gọi ERPNext.
Trước tạo container, kiểm tên chưa tồn tại; nếu trùng, dừng hoặc chọn tên khác
và cập nhật cả hai lệnh, không dừng/xóa container của người dùng. Chỉ cleanup
container vừa tạo bằng `docker stop hvgerp-shim-plan011`; `--rm` tự dọn nó. Lưu
image ID, source commit, revision label, assertion summary và log container.
Label phải bằng chính `git rev-parse HEAD`, không phải `unknown`. Không push
image hoặc đổi deployment. Nếu Docker thiếu/không chạy được hoặc image không
build được, ghi BLOCKED và không thay bằng test host-only.

**Kiểm tra:** chạy đủ nhóm lệnh trên: build và fixture exit 0, nhãn revision
khớp commit, image khởi động với đúng runtime Dockerfile.shim, partial replies,
auth headers và mutation count đúng contract. Gate này chưa được chạy khi chỉ
soạn hoặc cập nhật kế hoạch.

## Kiểm thử

- Success→network error→not executed; success→invalid JSON→not executed.
- Notification đầu tiên có thể đã thực thi nhưng không có reply: vẫn phân biệt
  batch đã chạy với replies.length=0.
- Exception trước entry đầu, auth deny, canceled body; không raw upstream URL
  trong client error.
- Số upstream mutation không tăng do catch/retry; fixture cleanup không leak
  server.
- Success write → ping/invalid entry → authorize throw hoặc401: giữ reply write,
  giữ challenge401, entry sau không chạy; lặp với notification write đầu tiên.

## Tiêu chí hoàn tất

- [ ] Client thấy toàn bộ kết quả đã biết và phân biệt unknown với not executed.
- [ ] Mọi regression batch và gate shim/runtime boundary đạt.
- [ ] Không làm giảm xác thực hoặc lộ chi tiết nội bộ.
- [ ] Image Dockerfile.shim thật build và container smoke đạt; revision label
      khớp source commit, có image ID/log/assertion và cleanup rõ ràng.
- [ ] Đã tự đọc diff; `git diff --check` đạt; mọi thay đổi thuộc phạm vi hoặc là
      hiện vật build bị Git bỏ qua từ lệnh xác minh được phép.
- [ ] Lưu lệnh, kết quả và giới hạn thực tế trong `plans/evidence/011.md`, cập
      nhật trạng thái ở `plans/README.md`. Không ghi giá trị bí mật.

## Điều kiện dừng

- Nếu lựa chọn HTTP status/header khiến client không đọc batch body, kiểm
  contract host và ghi tradeoff trước khi chốt.
- Nếu cần retry để biết write thành hay chưa, dừng: không replay operation không
  idempotent.
- Source không còn khớp chứng cứ mà diff của phụ thuộc không giải thích được;
  hoặc cần sửa ngoài phạm vi.
- Thiếu quyền/công cụ/chứng cứ bắt buộc sau các cách kiểm tra hợp lệ; không đánh
  dấu DONE bằng dữ liệu giả thay cho môi trường bắt buộc.

## Bảo trì

Mọi exception sau khi entry có thể đã chạy phải đi qua cùng bộ tổng hợp. Chỉ
kiểm replies.length không đủ vì notification không có reply.
