# Bổ sung thiết kế 002: Challenge metadata đã được framework xác minh

Ngày 2026-09-05. Đây là thiết kế, chưa phải implementation hay bằng chứng DONE.
Không thay trạng thái kế hoạch 002, không sửa regression đỏ và không sửa vendor.

## Kết luận và phạm vi quyền

Ưu tiên mở rộng hợp đồng framework bằng một trường challenge tùy chọn trong
payload HMAC hiện có, rồi chuyển challenge đã xác minh qua context. Không cần
application challenge store, khóa HMAC thứ hai hoặc replay store thứ hai.
Framework tiếp tục sở hữu principal, digest của request gốc, expiry và nonce.

Câu trả lời "Cho phép" cho phép tiếp tục thiết kế phạm vi challenge contract đã
nêu. Không suy ra quyền sửa repository framework bên ngoài, nâng dependency,
bump version, phát hành framework hoặc phát hành hvgerp-mcp. Vì framework 0.25.0
chưa cung cấp hợp đồng này, chưa có đường triển khai được khuyến nghị hoàn toàn
trong repository hiện tại mà giữ dependency nguyên trạng.

Sau khi duyệt thiết kế cần quyền riêng cho: sửa framework trong repository được
chỉ định; quy trình review và phân phối phiên bản framework; cập nhật dependency
hvgerp-mcp tới đúng phiên bản đã phân phối. Không chọn số phiên bản trước khi
đối chiếu chính sách upstream. Các quyền push/PR/Test/merge của goal hiện tại
không tự mở rộng sang repository framework hoặc Publish.

## Chứng cứ đã đọc

Ứng dụng tại worktree 002, base `013a1cfda64d41b3e62658ff16f7e25be0b3b4c7`:

- `src/mrtr/link-disambiguation.ts:177`: chạy handler gốc trước khi đọc
  response.
- `src/mrtr/link-disambiguation.ts:27`: key chỉ mang inputPath.
- `src/client.ts:198`: nhận context framework, truyền vào wrapper và handler.
- `src/api/resolve.ts:29`: probe exact chỉ lấy hai bản ghi; không thể dùng sự
  vắng mặt trong probe mới làm bằng chứng rằng ID đã chọn không còn khớp.
- `src/tools/assignment.ts:97`: trim và deduplicate assignee trước phân giải.
- `src/transport_wire_test.ts:546`: đã có McpApp thật đi qua handler ghi, nhưng
  fixture hiện tại không đổi ứng viên giữa hai lượt.
- `scripts/build-node.sh:25` và `:86`: Deno dùng JSR; Node lấy npm theo version
  range đọc từ deno.json, có `MCP_SERVER_OVERRIDE` cho tarball thử nghiệm.

Các đường dẫn dưới đây tương đối với package framework local
`.nojsr-vendor/casys-mcp-server/`, không phải source của hvgerp-mcp:

- `src/mrtr/request-state.ts:50`: payload chỉ có sub, method, paramsDigest, exp,
  nonce; canonical JSON và HMAC đã có sẵn.
- `src/mcp-app.ts:2143`: digest được chụp từ args ingress trước middleware.
- `src/mcp-app.ts:2250`: verifier kiểm principal, method, digest và expiry.
- `src/mcp-app.ts:2300`: consume nonce trước khi chạy handler; lỗi store đóng
  đường retry, không tiếp tục ghi.
- `src/mcp-app.ts:2353`, `:1099`, `:1073`: ba chặng chuyển MRTR vào context chỉ
  mang inputResponses và retryVerified.
- `src/mcp-app.ts:3727`: có signing key thì framework thay requestState do
  application đưa ra bằng token tự tạo; tự seal trong handler không giải quyết
  được thiếu metadata.
- `src/mrtr/capability-check.ts:147`: inputRequests được canonicalize trước
  phát.
- `src/mrtr/replay-store.ts:48`: mặc định là state trong một process, không bảo
  vệ qua restart hay giữa nhiều instance độc lập.
- `src/http/request-guards.ts:34`: principal lấy từ authInfo.subject; không auth
  thì mọi caller dùng chung một principal, không có phân tách người dùng.
- `package.json`: version 0.25.0, repository khai báo
  `https://github.com/Casys-AI/mcp-server`. Chưa gọi mạng để xác minh quyền,
  branch, HEAD hoặc chính sách release của upstream.

SHA-256 `src/mcp-app.ts` của vendor và bản cache npm 0.25.0 giống nhau:
`d5dd46a5746ba960d9405e5ccd116bbbe74c5cc19cb36e1e983ebd896986e758`. Đây là kiểm
riêng file trung tâm; không phải tuyên bố vừa hash toàn package.

## Hợp đồng tối thiểu đề xuất

Tên trường dưới đây là đề xuất API để review, chưa tồn tại trong 0.25.0.
Framework không biết ERPNext, inputPath hay DocType; application chịu trách
nhiệm schema của data. Framework chỉ chấp nhận dữ liệu JSON có kích thước hữu
hạn và schema envelope đã xác định.

```typescript
interface MrtrChallenge {
  readonly kind: string;
  readonly version: 1;
  readonly data: JsonObject;
}

interface SignedMrtrChallenge extends MrtrChallenge {
  readonly inputRequestsDigest: string;
}

interface VerifiedMrtrChallenge {
  readonly challenge: SignedMrtrChallenge;
  readonly expiresAt: number;
}
```

`JsonObject` dùng kiểu JSON đệ quy thật, không dùng any hoặc type assertion để
chấp nhận function, undefined, bigint, cycle hoặc prototype đặc biệt. Giới hạn
đề xuất cho metadata là 16 KiB UTF-8 sau canonicalization, độ sâu tối đa 16;
giới hạn token phải tính thêm envelope và base64url. Chốt các số này bằng test
trước khi phát hành API. Không cắt ngắn metadata để vừa giới hạn.

Bổ sung đúng ba bề mặt:

1. `InputRequiredSignal.challenge?: MrtrChallenge`: dữ liệu do handler tạo,
   không lấy từ params hay response của client.
2. `RequestStatePayload.challenge?: SignedMrtrChallenge`: được HMAC bao phủ cùng
   năm trường hiện có. Framework tự tính inputRequestsDigest từ đúng bản
   canonicalRequests sẽ phát, không tin digest do application cung cấp.
3. `ToolHandlerContext.verifiedChallenge?: VerifiedMrtrChallenge`: chỉ được gắn
   sau verifier và consume nonce thành công. Chuyển qua executeToolCall,
   MiddlewareContext và cuối pipeline; không nhận field cùng tên từ client.

Không thêm trường wire bắt buộc. Client vẫn nhận inputRequests và opaque
requestState, trả inputResponses cùng requestState nguyên vẹn. Challenge không
được phát thành field top-level mới. Token HMAC có thể đọc, không mã hóa: data
chỉ chứa thông tin đã cho phép hiện trong câu hỏi, không credential hay secret.

Data của hvgerp-mcp cho một ambiguity:

```json
{
  "kind": "hvgerp.link-disambiguation",
  "version": 1,
  "data": {
    "requestKey": "link-disambiguation:assign_to",
    "inputPath": "assign_to",
    "identifier": "First Person",
    "doctype": "User",
    "candidateIds": ["first@example.test", "other@example.test"]
  }
}
```

`identifier` là giá trị đã normalize theo đúng quy tắc resolver khi phát câu
hỏi, không tự lowercase hoặc normalize Unicode. Scalar phải đối chiếu theo quy
tắc field; array dùng giá trị đã trim, không dùng index của array chưa
normalize. Raw args vẫn được bảo vệ bằng ingressDigest. candidateIds là tập ID
thực sự có trong enum đã phát, không suy rộng ra toàn bộ kết quả có thể tồn tại.
Application xây requestedSchema và data từ cùng một snapshot bất biến.

Không cần lặp toolName/principal trong data: `method=tools/call`, digest của
`{ arguments, name }`, sub, exp và nonce đã nằm trong cùng payload ký. Framework
không cho application override năm trường này. inputRequestsDigest gắn envelope
với câu hỏi đã canonicalize; nó không tự kiểm ngữ nghĩa của câu hỏi, nên test
application vẫn phải chứng minh enum và candidateIds đồng nhất.

## Luồng issuer, verifier và preflight

Issuer: prepare chỉ đọc tạo ambiguity; application tạo signal và challenge từ
cùng dữ liệu. Framework kiểm capability, canonicalize inputRequests và metadata,
kiểm kích thước, tạo digest câu hỏi, rồi seal toàn payload. Nếu có challenge mà
không có signing key thì trả lỗi cấu hình, không lặng lẽ phát challenge
unsigned. Không sửa quy tắc unsigned hiện có cho handler không dùng extension.

Verifier: kiểm giới hạn token trước decode, HMAC trước tin payload, rồi kiểm
binding hiện có và schema/version metadata có mặt. Sau đó consume nonce nguyên
tử. Chỉ đường thành công mới có retryVerified=true và verifiedChallenge. Expiry
và nonce vẫn do framework quyết định, không có nonce application thứ hai.

Application trên retry thực hiện tuần tự:

1. Kiểm retryVerified, verifiedChallenge, kind/version/schema và đúng một
   requestKey được hỗ trợ. Missing, extra key, malformed, decline/cancel hoặc
   action không hợp lệ đều dừng trước mutation. Không chạy handler ghi để xem
   còn AmbiguousLinkError hay không.
2. Kiểm inputPath thuộc resolver đăng ký của tool; DocType đúng, kể cả companion
   field của dynamic link. Kiểm identifier còn tương ứng giá trị trong args đã
   được framework xác minh. Không chọn một ambiguity mới có cùng inputPath.
3. Kiểm selected ID thuộc candidateIds của challenge đã ký. Sau đó đọc mới để
   xác minh ID đó vẫn khớp chính identifier và strict resolution policy hiện
   hành. Bypass positive cache, negative miss cache và list cache.
4. Kiểm trực tiếp selected ID với filter `name = selectedId` và điều kiện match
   gốc, hoặc GET mới và đối chiếu field theo cùng quy tắc resolver đã kiểm
   chứng. Không chỉ lấy probe hai hàng rồi kết luận ID biến mất khi thứ tự đổi.
   GET tồn tại đơn thuần cũng không đủ nếu tên/DocType liên quan đã đổi.
5. Thay đúng giá trị đã ký trong args; giữ mọi assignee khác. Prepare toàn bộ
   phần còn lại chỉ đọc. Ambiguity thứ hai hoặc validation lỗi phải có mutation
   bằng 0, không phát vòng hai giả như đã tích lũy đáp án vòng một.
6. Chạy handler mutation đúng một lần với args đã chuẩn bị. Không phân giải lại
   bằng dữ liệu cache cũ rồi ghi theo ID khác. Kiểm expiry ngay trước mutation
   nếu preflight có thể kéo dài qua expiresAt; không hứa giao dịch xuyên các
   request Frappe hoặc exactly-once completion.

Nhờ vậy H1 hỏi First Person rồi ambiguity chuyển sang Second Person sẽ không áp
đáp án sang Second Person. H2 thực sự hỏi Second Person vẫn được chấp nhận nếu
ID đã chọn còn hợp lệ. Không cấm toàn bộ retry array để né regression.

## Stateless, concurrency, replay và tương thích

- Challenge nằm trong token nên không cần lưu câu hỏi phía application.
  Stateless ở đây chỉ nói không lưu challenge, không có nghĩa replay protection
  không cần state.
- Hai initial request cùng principal/tool/args có nonce và challenge riêng. Cả
  hai challenge hợp lệ có thể cho phép hai thao tác nếu người dùng xác nhận cả
  hai; không hứa deduplicate business request giữa hai token khác nhau.
- Hai retry cùng token chạy song song: chỉ một consume thành công được tới
  preflight/handler. Retry thiếu/decline cũng đã tiêu nonce theo hành vi hiện
  hành; muốn thử lại phải bắt đầu interaction mới.
- Store mặc định không bảo vệ qua restart hoặc nhiều process. Triển khai nhiều
  instance cần cùng signing key và store dùng chung, bền vững với consume nguyên
  tử. Không tự triển khai Redis hoặc đổi production trong công việc này.
- App mới từ chối token cũ không có challenge đối với MRTR ghi, yêu cầu hỏi lại;
  không fallback về tái dựng ambiguity hiện tại. Framework vẫn xử lý token cũ
  cho handler không đòi extension, nếu các kiểm tra cũ đạt.
- Trường mới là tùy chọn, client không phải đổi schema tool. Mixed rollout có
  thể làm interaction đang dở thất bại an toàn; phải triển khai các instance
  tương thích hoặc drain token trong cửa sổ TTL. Không nới verifier vì rollout.
- Không auth nghĩa là không có phân tách principal giữa caller. Extension không
  biến endpoint công khai thành có auth. Tenant isolation ngoài subject hiện có
  là quyết định kiến trúc riêng, không gán khả năng đó cho challenge.

## Vì sao chưa chọn application challenge state

Map chỉ theo args/tool/inputPath không phân biệt H1/H2 và các interaction song
song. Một random ID do client echo chưa được framework ký cũng chưa đủ gắn với
token đã phát. Framework tạo nonce sau khi handler trả về, không chuyển nonce
hoặc metadata về context, nên ghép store vào wrapper hiện tại sẽ cần thêm một
hợp đồng vận chuyển hoặc cơ chế toàn vẹn độc lập.

Có thể thiết kế application envelope HMAC riêng và store dùng chung, nhưng phải
review riêng principal binding, phối hợp expiry/nonce, replay nguyên tử, giới
hạn bộ nhớ, restart và nhiều instance. Nó làm tăng bề mặt bảo mật trong khi
framework đã có issuer/verifier/replay store thích hợp. Không triển khai phương
án đó chỉ để tránh quy trình cập nhật dependency. Không sửa private method,
monkey-patch McpApp, đọc token bằng cast rồi gọi đó là verified metadata, hoặc
đổi import map sang vendor đã sửa và coi CI xanh là đạt.

## Ma trận regression bắt buộc

Framework: round-trip metadata nguyên vẹn; thay từng field ký bị từ chối; sai
principal/tool/args/method, expired, nonce lặp và retry song song; store ném
lỗi; không key; malformed/deep/oversized metadata; args bị middleware thêm
default không làm mất ingress binding; field verifiedChallenge giả từ
params/_meta không tới handler; context mới qua đủ ba chặng; token cũ và handler
không dùng extension giữ hợp đồng tương thích đã nêu.

Application: bảy regression đỏ hiện có chuyển xanh; wire thật tái hiện H1 và H2
với cùng args và cùng trạng thái ERP ở lượt retry; candidates 2→1, 2→0, đổi ID,
đổi tên, thay thứ tự probe; selected ID mới không có trong challenge; missing,
extra key, invalid, unverified, decline/cancel đều mutation=0. Cần fixture ID
vẫn hợp lệ nhưng ra ngoài probe hai hàng để không từ chối sai.

Mọi đường ghi MRTR, gồm Asset custodian, phải có ma trận preflight. Với
FrappeClient/MemoryCache thật và fetch giả, chứng minh reads mới, không ghi
trong prepare, accept đúng ID ghi một lần và giữ assignee khác. Không gọi ERP
thật trong suite chính. Test direct context giả chỉ bổ sung, không thay wire.

## Đường phân phối và gate

1. Sau khi có quyền riêng, sửa và review framework trong repository được chỉ
   định, lưu commit và test framework. Không sửa pristine vendor 0.25.0.
2. Tarball build từ commit framework đã review có thể dùng với
   `MCP_SERVER_OVERRIDE` để thử Node trước phát hành. Deno config thử nghiệm
   phải chỉ rõ source commit tương ứng, tách khỏi workaround 403 nguyên bản. Đây
   là bằng chứng prerelease, chưa đủ merge tiêu thụ API chưa có trên JSR.
3. Chỉ sau quyền release của framework và xác minh đúng artifact ở cả JSR lẫn
   npm mới cập nhật import range/lock của hvgerp-mcp theo quyền nâng dependency
   riêng. Không cho Deno kiểm bản mới nhưng Node bundle lấy bản cũ trong range.
   Lưu version, integrity và source provenance của cả hai artifact.
4. Re-vendor bản đã phát hành khi local JSR bị 403, không giữ vendor cũ mà nhận
   typecheck xanh. Không xóa lock hoặc đổi version chỉ để lách mạng.
5. Chạy typecheck, full tests, lint/format, UI build đủ bảy viewer, Node build
   và preflight. Wire test cùng ma trận bảo mật phải chạy với JSR thật trên CI
   và với npm bundle thực trên Node 20 lẫn 22. Tarball override không thay hai
   gate này; npm pack dry-run không phải publish.
6. PR hvgerp-mcp chỉ được merge khi independent review, Codex review và Test CI
   đúng HEAD đều đạt. Workflow giữ manual-only, không tự chạy Publish. Bump hay
   release hvgerp-mcp vẫn cần quyền riêng, không phải điều kiện để viết fix.

## Điểm bàn giao

Thiết kế đủ cụ thể để review hợp đồng nhưng chưa có code xanh. Chưa có quyền hay
bằng chứng upstream release, chưa chạy lại test đỏ và chưa chạy gate mới. Giữ
nguyên evidence 002 hiện tại và báo rõ các quyền còn thiếu trước bước sửa
framework hoặc tiêu thụ API mới. Không đánh dấu DONE chỉ vì đã có tài liệu này.
