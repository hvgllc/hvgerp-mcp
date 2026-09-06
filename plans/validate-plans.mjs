import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const planRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(planRoot, "..");
const manifest = JSON.parse(
  readFileSync(resolve(planRoot, "manifest.json"), "utf8"),
);
const failures = [];
const fail = (message) => failures.push(message);
const sameSet = (left, right) =>
  left.length === new Set(left).size && right.length === new Set(right).size &&
  left.length === right.length && left.every((item) => right.includes(item));
function dependencies(value) {
  if (value === undefined) return undefined;
  const text = value.replaceAll("`", "").trim().replace(/\.$/, "").trim();
  if (text === "không") return [];
  if (!/^\d{3}(?:\s*,\s*\d{3})*$/.test(text)) return undefined;
  return text.split(",").map((id) => Number(id.trim()));
}
// Mọi commit mà validator đem đi phân giải. Gate lịch sử phải kiểm đúng tập
// này: tự đọc lại tài liệu để đoán xem kế hoạch nào cần provenance là dựng một
// bộ đọc Markdown thứ hai, và hai bộ đọc sẽ hiểu cùng một tài liệu theo hai kiểu
// ngay lần đầu ai đó bọc metadata trong một block không render. Cờ
// --print-references in tập này ra để gate lịch sử nhận nó từ đúng một nguồn.
const gitReferences = new Set();
const sourceCache = new Map();
function evidenceSource(sourcePath, sourceRef) {
  gitReferences.add(sourceRef);
  const key = sourceRef + ":" + sourcePath;
  if (!sourceCache.has(key)) {
    try {
      sourceCache.set(
        key,
        execFileSync("git", ["show", key], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {
      fail("Cannot read historical source " + key);
      sourceCache.set(key, undefined);
    }
  }
  return sourceCache.get(key);
}
// Ngăn xếp thụt lề của các list container đang mở. Một dấu list chỉ mở container
// mới khi nó nằm trong ba cột kể từ content indent của container đang chứa nó;
// đo ba cột đó từ gốc tài liệu thì mọi cấp lồng từ cấp ba trở đi không được ghi
// nhận, và fence hay block HTML của chúng bị đọc như văn xuôi sống. Ba hàm quét
// dùng chung một bộ đếm để không hiểu cùng một tài liệu theo hai kiểu.
function listIndentTracker() {
  const stack = [];
  const innermost = () => stack.length ? stack[stack.length - 1] : 0;
  return (relative, width, blank) => {
    if (blank) return { indent: innermost(), marker: undefined };
    while (stack.length && width < innermost()) stack.pop();
    // Marker đánh số dài quá chín chữ số không mở list: chuẩn ghim đúng chín,
    // nên "1234567890. ~~~" là một đoạn văn thường. Nhận nó là list thì phần
    // sau dấu chấm mở được cả fence lẫn block HTML, và những dòng sống nằm dưới
    // bị ẩn khỏi mọi gate. Cùng giới hạn với containerPrefix, để hai đường quét
    // không hiểu một tài liệu theo hai kiểu.
    const marker = width <= innermost() + 3
      ? relative.match(/^(?:[-+*]|\d{1,9}[.)])[ \t]+/)
      : undefined;
    if (marker) stack.push(width + marker[0].length);
    return { indent: innermost(), marker: marker?.[0] };
  };
}
// Blockquote chỉ đặt tiền tố lên đầu dòng chứ không đổi bản chất khối bên
// trong: "> ~~~" mở một fence thật và "> <div>" mở một block HTML thật. Đo trên
// dòng thô thì dấu ">" đứng chắn trước mọi dấu mở, nội dung của khối bị đọc như
// Markdown sống, và cả một heading nằm trong ví dụ nhúng cũng đi vào tập anchor.
// Trả về cả số lớp đã lột, vì khối bên trong kết thúc khi chính blockquote chứa
// nó kết thúc.
function stripQuoteMarkers(line) {
  let text = line;
  let depth = 0;
  for (;;) {
    const marker = text.match(/^ {0,3}>[ \t]?/);
    if (!marker) return { text, depth };
    text = text.slice(marker[0].length);
    depth++;
  }
}
function outsideFencedCode(body, preserveOffsets = false) {
  let fence, fenceQuote = 0, fenceIndent = 0, listIndent = 0;
  const track = listIndentTracker();
  const hidden = (line) => preserveOffsets ? " ".repeat(line.length) : "";
  return body.split("\n").map((line) => {
    const quote = stripQuoteMarkers(line);
    // Ra khỏi blockquote là ra khỏi cả fence mở bên trong nó; giữ fence sống
    // tiếp thì phần còn lại của tài liệu bị ẩn và mọi gate sau đó đọc một tài
    // liệu rỗng.
    if (fence && quote.depth < fenceQuote) fence = undefined;
    const source = quote.text;
    const indentation = source.match(/^[ \t]*/)[0];
    const width = columnsOf(indentation);
    // "." trong JS không khớp "\r", nên "(.*)$" trượt trên mọi dòng fence kết
    // thúc CRLF và cả block code trong một file CRLF bị đọc như văn xuôi sống.
    // Phần còn lại của validator đã cố ý CRLF-tolerant, đây là chỗ lệch.
    const marker = source.match(/^[ \t]*(`{3,}|~{3,})(.*)\r?$/);
    // Ra khỏi list item là ra khỏi cả fence mở bên trong nó, y như blockquote:
    // "- ~~~" rồi một dòng không thụt là hai khối khác nhau, dòng dưới đã nằm
    // ngoài item nên nó là Markdown sống. Giữ fence tiếp thì phần còn lại của
    // tài liệu bị ẩn và mọi link ở đó vắng mặt khỏi cổng. Dòng trống không tính:
    // nó chưa đóng item nào.
    if (fence && source.trim() && width < fenceIndent) fence = undefined;
    if (fence) {
      // Dấu đóng đo thụt so với lề của container đang chứa fence, không so với
      // chính dòng mở: chuẩn cho closer thụt tối đa ba cột kể từ lề đó, nên một
      // fence mở ở cột ba và một hàng dấu ngã ở cột sáu không đóng gì cả. Lấy
      // mốc từ dòng mở thì hàng đó đóng khối sớm, phần thân còn lại bị đọc như
      // văn xuôi sống và gate báo hỏng những link chỉ có trong ví dụ.
      if (
        marker && width <= listIndent + 3 && marker[1][0] === fence[0] &&
        marker[1].length >= fence.length && /^[ \t\r]*$/.test(marker[2])
      ) fence = undefined;
      return hidden(line);
    }
    // Fence nằm trong list item mở ở content indent của item, không phải ở cột
    // 3 tuyệt đối. Đo thụt so với container thì một ví dụ có fence thụt đúng
    // chuẩn dưới list item mới được nhận là code; ghim cột 3 gốc thì nội dung
    // của nó bị đọc như văn xuôi sống và các gate tài liệu bắt nhầm.
    const container = track(
      source.slice(indentation.length),
      width,
      !source.trim(),
    );
    listIndent = container.indent;
    // Fence cũng mở được ngay trên dòng mang dấu list: trong "- ~~~", nội dung
    // của item bắt đầu sau "- " và chính là dấu mở. Thử trên phần chưa bỏ dấu
    // list thì không mẫu nào khớp, thân ví dụ bị quét như Markdown sống, và một
    // link chỉ có trong ví dụ bị báo hỏng.
    const content = container.marker
      ? source.slice(indentation.length + container.marker.length)
      : source.slice(indentation.length);
    const opener = container.marker
      ? content.match(/^[ \t]*(`{3,}|~{3,})(.*)\r?$/)
      : marker;
    const openWidth = container.marker
      ? listIndent + indentColumns(content)
      : width;
    if (
      opener && openWidth <= listIndent + 3 &&
      (opener[1][0] === "~" || !opener[2].includes("`"))
    ) {
      fence = opener[1];
      fenceQuote = quote.depth;
      fenceIndent = listIndent;
      return hidden(line);
    }
    return line;
  }).join("\n");
}
function outsideBlockCode(body) {
  let paragraph = false, code = false;
  const track = listIndentTracker();
  return outsideFencedCode(body).split("\n").map((line) => {
    const indentation = line.match(/^[ \t]*/)[0];
    let width = 0;
    for (const character of indentation) {
      width += character === "\t" ? 4 - width % 4 : 1;
    }
    if (!line.trim()) {
      paragraph = false;
      return "";
    }
    // Dòng tiếp của list vẫn là nội dung sống, không mặc nhiên thành code.
    const { indent: listIndent } = track(
      line.slice(indentation.length),
      width,
      false,
    );
    // Trong list item, code block bắt đầu ở content indent của item cộng bốn,
    // không phải bốn tuyệt đối. Tắt hẳn nhận diện code khi đang trong list thì
    // một ví dụ thụt đúng chuẩn trở thành văn xuôi và mọi link giả trong ví dụ
    // bị gate tài liệu báo hỏng.
    if (width >= listIndent + 4 && (code || !paragraph)) {
      code = true;
      return "";
    }
    code = false;
    // Một reference definition chưa có destination trên cùng dòng còn tiếp ở
    // dòng sau, nên dòng đó thuộc cùng block và không được thành code dù thụt
    // bốn; ngược lại thì definition đã trọn vẹn và đóng block như cũ.
    const definitionOpen = /^ {0,3}\[(?:\\[^\r\n]|[^\[\]\\\r\n])+\]:[ \t]*\r?$/
      .test(line);
    paragraph = definitionOpen ||
      (!/^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:=+|-+)[ \t]*$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/
        .test(line) &&
        !/^ {0,3}\[[^\]]+\]:/.test(line));
    return line;
  }).join("\n");
}
// HTML comment không render, nên một ghi chú bảo trì chứa link literal không
// phải link sống và không được đem đi phân giải. Nhận diện sau khi inline code
// đã bị xóa, để một backtick chứa "<!--" không mở được comment giả nuốt mất
// link thật; comment thiếu "-->" cũng không khớp và vẫn bị kiểm. Thay bằng
// khoảng trắng giữ nguyên dòng để các gate đọc theo dòng không lệch. Một comment
// thiếu "-->" chạy tới hết tài liệu chứ không phải là văn bản sống: đòi delimiter
// đóng thì mọi section sau một "<!--" bỏ quên vẫn được đọc như nội dung thật và
// một kế hoạch không còn hiển thị phạm vi, bước hay tiêu chí nào vẫn qua gate.
const htmlComment = /<!--[\s\S]*?(?:-->|$)/g;
function outsideHtmlComments(body) {
  // Code span và comment là hai token inline cùng cấp, nên chỉ thứ tự mở trong
  // tài liệu mới quyết định ai thắng. Gọi trên bản đã xóa inline code thì tập
  // span rỗng và hàm chạy y như trước; gọi trên bản còn backtick thì một "<!--"
  // viết trong backtick không mở được comment giả nuốt phần còn lại của tài
  // liệu, còn một backtick lẻ nằm trong comment thật vẫn không che được "-->".
  const spans = inlineCodeSpans(body);
  let output = "", cursor = 0, span = 0, match;
  htmlComment.lastIndex = 0;
  while ((match = htmlComment.exec(body))) {
    // "\<!--" render ra dấu literal chứ không mở comment, nên nội dung sau nó
    // vẫn là link sống. Xóa cả đoạn thì một link hỏng nấp sau dấu mở bị escape
    // không còn ai hỏi tới. Quét tiếp ngay sau dấu mở giả, để một comment thật
    // đứng sau trong cùng đoạn vẫn được nhận.
    if (markdownEscaped(body, match.index)) {
      htmlComment.lastIndex = match.index + 1;
      continue;
    }
    while (span < spans.length && spans[span][1] <= match.index) span++;
    if (span < spans.length && spans[span][0] <= match.index) {
      htmlComment.lastIndex = spans[span][1];
      continue;
    }
    output += body.slice(cursor, match.index) + match[0].replace(/[^\n]/g, " ");
    cursor = match.index + match[0].length;
  }
  return output + body.slice(cursor);
}
// Bên trong một block HTML, CommonMark không phân giải inline Markdown, nên
// "[x](y.md)" nằm trong <script>, <pre> hay <div> chỉ là văn bản thô chứ không
// phải link sống. Giữ nguyên nó thì một ví dụ nhúng hợp lệ làm gate link báo
// hỏng và chặn một thay đổi tài liệu không liên quan. Chạy sau khi inline code
// đã bị xóa, để một backtick chứa "<div>" ở đầu dòng không mở được block giả
// nuốt mất link thật. Thay bằng dòng rỗng để các gate đọc theo dòng không lệch.
const htmlBlockNames =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
// Khoảng trắng bên trong một thẻ HTML được phép chứa xuống dòng; chuẩn chỉ cấm
// dòng trống. Chỉ nhận space và tab thì một thẻ mở viết tách dòng không khớp mẫu
// nào, href của nó không bao giờ được thu, và một link hỏng đi qua gate. Mỗi
// khoảng nhận tối đa một lần xuống dòng, nên hai newline liền, tức dòng trống,
// vẫn kết thúc thẻ đúng chuẩn.
const htmlSpace = "(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)";
const htmlOptionalSpace = "(?:[ \\t]*\\r?\\n)?[ \\t]*";
const htmlAttributes = "(?:" + htmlSpace +
  "[A-Za-z_:][A-Za-z0-9_.:-]*(?:" + htmlOptionalSpace + "=" +
  htmlOptionalSpace +
  "(?:[^ \\t\\r\\n\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*";
// Điều kiện đóng null nghĩa là block chạy tới dòng trống đầu tiên. Không có
// dạng comment ở đây: "<!--" đã do outsideHtmlComments xử lý theo span, và
// nhánh <![A-Za-z] bên dưới không khớp dấu gạch nên hai đường không giẫm nhau.
const htmlBlockOpeners = [
  [
    /^ {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)/i,
    /<\/(?:script|pre|style|textarea)>/i,
  ],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [
    new RegExp("^ {0,3}</?(?:" + htmlBlockNames + ")(?:[ \\t]|/?>|$)", "i"),
    null,
  ],
];
// Dạng 7 là một thẻ bất kỳ đứng một mình trên dòng, và nó không được cắt ngang
// một đoạn văn đang mở. Điều kiện đúng là "dòng trước không phải đoạn văn đang
// mở", không phải "dòng trước trống": heading ATX và thematic break kết thúc
// ngay tại chính dòng của chúng, nên dòng kế không tiếp tục đoạn nào và một thẻ
// lẻ ở đó mở block đúng chuẩn. Đòi dòng trống thì một ví dụ nhúng viết ngay
// dưới heading không được ẩn, phần thân của nó bị quét như Markdown sống, và
// gate báo hỏng một tài liệu đúng. Các dòng khác vẫn giữ hướng fail-closed: dòng
// tiếp sau một đoạn văn, một bullet hay một blockquote đều có thể là phần tiếp
// của đoạn đó, nên thẻ lẻ ở đấy không mở block.
const htmlLeafEnd = new RegExp(
  "^ {0,3}(?:#{1,6}(?:[ \\t]|\\r?$)|(?:\\*[ \\t]*){3,}\\r?$|" +
    "(?:-[ \\t]*){3,}\\r?$|(?:_[ \\t]*){3,}\\r?$)",
);
const htmlLoneTag = new RegExp(
  "^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*" + htmlAttributes +
    "[ \\t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \\t]*>)[ \\t]*\\r?$",
);
// Trong nhãn của một link, thẻ HTML thô và autolink là nguyên khối: CommonMark
// parse mỗi cái thành một inline riêng, nên dấu "]" nằm trong giá trị thuộc
// tính hay trong URL của autolink không đóng nhãn. Đếm ngoặc mà không nhảy qua
// nguyên thẻ thì [<span title="]">x</span>](y.md) bị cắt nhãn ngay tại dấu "]"
// của thuộc tính, ký tự kế đó không phải "(", link thật không được thu, và
// destination hỏng đi qua gate. Mẫu neo đầu (cờ y) để chỉ khớp tại đúng vị trí
// con trỏ đang đứng.
const htmlInlineAtomic = new RegExp(
  "<(?:[A-Za-z][A-Za-z0-9-]*" + htmlAttributes + htmlOptionalSpace + "/?>" +
    "|/[A-Za-z][A-Za-z0-9-]*" + htmlOptionalSpace + ">" +
    "|!--[\\s\\S]*?-->" +
    "|\\?[\\s\\S]*?\\?>" +
    "|![A-Za-z][\\s\\S]*?>" +
    "|!\\[CDATA\\[[\\s\\S]*?\\]\\]>" +
    "|[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \\t\\r\\n<>]*>" +
    "|[^ \\t\\r\\n<>@]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?" +
    "(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>)",
  "y",
);
const htmlBlank = /^[ \t]*\r?$/;
const htmlFence = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/;
// Thẻ mở của HTML thô, giữ nguyên phần thuộc tính để đọc lại. Dùng chính
// htmlAttributes nên giá trị đặt trong nháy vẫn chứa được ">" mà không cắt sớm.
const htmlTagAttributes = new RegExp(
  "<([A-Za-z][A-Za-z0-9-]*)(" + htmlAttributes + ")" + htmlOptionalSpace +
    "/?>",
  "g",
);
// Một thuộc tính của thẻ mở, quét tuần tự từ trái sang phải. Dò thẳng tên
// thuộc tính bằng regex thì chuỗi trông như thuộc tính nằm bên trong giá trị
// của thuộc tính khác cũng trúng, và một <span title="href='missing.md'"> hoàn
// toàn vô hại làm gate báo link hỏng. Khớp cả cặp tên và giá trị thì giá trị đặt
// trong nháy bị nuốt trọn cùng thuộc tính chứa nó nên không còn tự đứng ra.
const htmlAttributePair = new RegExp(
  "([A-Za-z_:][A-Za-z0-9_.:-]*)(?:" + htmlOptionalSpace + "=" +
    htmlOptionalSpace + "(?:\"([^\"]*)\"|'([^']*)'|([^ \\t\\r\\n\"'=<>`]+)))?",
  "g",
);
// HTML giữ lần xuất hiện đầu tiên của một tên thuộc tính và bỏ mọi lần sau, kể
// cả lần đầu không mang giá trị. Trả về cả hai thì id thứ hai của
// <a id="real" id="ghost"> thành anchor và một fragment không tới đâu đi qua
// cổng, còn một href chết lặp lại thì bị đem đi phân giải.
function tagAttributes(text) {
  const pairs = [];
  const seen = new Set();
  htmlAttributePair.lastIndex = 0;
  let match;
  while ((match = htmlAttributePair.exec(text))) {
    const name = match[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}
// Nội dung của script, style và textarea là văn bản thô: CommonMark không đọc
// markup bên trong, nên một chuỗi JS trông như thẻ không phải link sống và đem
// href của nó đi phân giải sẽ báo hỏng một tài liệu đúng. Giữ nguyên thẻ mở để
// src của chính nó vẫn bị kiểm, chỉ xóa phần thân và thay bằng khoảng trắng để
// các đường quét theo dòng không lệch. Thiếu thẻ đóng thì thân chạy tới hết tài
// liệu, đúng như chuẩn mô tả.
// Comment và raw text element là hai token cùng cấp: cái nào mở trước trong
// tài liệu thì cái đó thắng. Chạy hai hàm nối tiếp thì hàm chạy trước luôn
// thắng bất kể vị trí, nên một chuỗi "<!--" nằm trong <script> mở được một
// comment giả nuốt tới hết tài liệu và mọi thẻ sau đó biến mất khỏi gate. Một
// alternation quét trái sang phải để thứ tự trong tài liệu quyết định.
// Một thẻ mở thường cũng là token cùng cấp, nên nó phải được nhận trước khi bất
// cứ thứ gì bên trong nó được đọc: chuỗi "<!--" nằm trong giá trị thuộc tính,
// như <a title="<!--" href="x.md">, là dữ liệu chứ không mở comment nào. Bỏ
// nhánh này thì comment giả nuốt tới hết tài liệu, mọi link sau đó biến mất
// khỏi gate và một đích hỏng đi qua cổng. Nhánh chỉ để nhảy qua nên không capture
// và không đổi văn bản.
const rawTextOrComment = new RegExp(
  "(?:<(?!(?:script|style|textarea)[ \\t\\r\\n/>])[A-Za-z][A-Za-z0-9-]*" +
    htmlAttributes + htmlOptionalSpace + "/?>)" +
    "|<!--[\\s\\S]*?(?:-->|$)" +
    "|(<(script|style|textarea)" + htmlAttributes + htmlOptionalSpace + ">)" +
    "([\\s\\S]*?)(</\\2" + htmlOptionalSpace + ">|$)",
  "gi",
);
function outsideRawTextAndComments(body) {
  // Backslash chỉ vô hiệu hóa ký tự trong văn bản Markdown. Bên trong một khối
  // HTML thô nó là ký tự thường của HTML, nên "\<!--" ở đó vẫn mở một comment
  // thật và phần thân comment không render. Hỏi luật Markdown ở mọi vị trí thì
  // thân comment đó ở lại trước mắt đường thu link và một tài liệu đúng bị báo
  // hỏng vì một href đã bị chú thích. Mặt nạ giữ nguyên offset nên hỏi được
  // theo vị trí, và chỉ dựng khi thật sự gặp một dấu mở có backslash đứng
  // trước, vốn hiếm.
  let htmlBlockMask;
  let output = "", cursor = 0, match;
  rawTextOrComment.lastIndex = 0;
  while ((match = rawTextOrComment.exec(body))) {
    // Thẻ mở thường chỉ chiếm chỗ để phần bên trong nó không mở token khác;
    // văn bản của nó ở lại nguyên vẹn.
    if (match[1] === undefined && !match[0].startsWith("<!--")) continue;
    // Dấu mở bị escape là ký tự literal, không mở token nào; quét tiếp ngay sau
    // nó để một token thật đứng sau vẫn được nhận, cùng cách outsideHtmlComments
    // xử lý "\<!--".
    if (markdownEscaped(body, match.index)) {
      htmlBlockMask ??= outsideHtmlBlocks(body, true);
      if (htmlBlockMask[match.index] === body[match.index]) {
        rawTextOrComment.lastIndex = match.index + 1;
        continue;
      }
    }
    // Comment xóa cả cụm; raw text giữ nguyên thẻ mở để src của chính nó vẫn bị
    // kiểm và chỉ xóa phần thân. Cả hai thay bằng khoảng trắng để các đường quét
    // theo dòng không lệch.
    const replacement = match[1] === undefined
      ? match[0].replace(/[^\n]/g, " ")
      : match[1] + match[3].replace(/[^\n]/g, " ") + match[4];
    output += body.slice(cursor, match.index) + replacement;
    cursor = match.index + match[0].length;
  }
  return output + body.slice(cursor);
}
// preserveOffsets giữ nguyên độ dài từng dòng, cho những đường quét cần chỉ số
// trong body gốc; mặc định trả dòng rỗng, đủ cho các đường đọc theo dòng.
function outsideHtmlBlocks(body, preserveOffsets = false) {
  let closer,
    fence,
    blockQuote = 0,
    fenceQuote = 0,
    listIndent = 0,
    loneTagAllowed = true;
  const track = listIndentTracker();
  const hidden = (line) => preserveOffsets ? " ".repeat(line.length) : "";
  return body.split("\n").map((line) => {
    // Cùng lý do với đường quét fence: blockquote chỉ là tiền tố, "> <div>" mở
    // một block HTML thật và mọi thứ trong nó không render. Đọc dòng thô thì
    // heading nằm giữa block đó vào tập anchor và một fragment không tới đâu đi
    // qua cổng. Khối cũng chết theo blockquote chứa nó.
    const quote = stripQuoteMarkers(line);
    const source = quote.text;
    const blank = htmlBlank.test(source);
    if (closer && quote.depth < blockQuote) closer = undefined;
    if (fence && quote.depth < fenceQuote) fence = undefined;
    if (closer) {
      if (closer === htmlBlank) {
        if (blank) closer = undefined;
        loneTagAllowed = blank;
        return blank ? line : hidden(line);
      }
      if (closer.test(source)) closer = undefined;
      loneTagAllowed = false;
      return hidden(line);
    }
    const indentation = source.match(/^[ \t]*/)[0];
    const width = columnsOf(indentation);
    // Một list item dời cột gốc của cả fence lẫn block HTML: dưới item có content
    // indent bốn, "    <script>" là HTML thô ở cột 0 của container chứ không phải
    // code. Đo thụt lề so với content indent, giống outsideFencedCode, rồi thử
    // các dấu mở trên phần đã bỏ thụt lề; ghim cột 3 tuyệt đối thì một ví dụ
    // nhúng đúng chuẩn dưới list bị đọc như link sống và gate báo hỏng.
    const relative = source.slice(indentation.length);
    // Fence mở trước thì nội dung của nó là code chứ không phải HTML, nên một
    // "<div>" viết trong ví dụ không được mở block và nuốt mất nội dung sống
    // đứng sau. Chiều ngược lại đã đúng sẵn: block mở trước thì dòng fence bên
    // trong nó bị xóa cùng block. Hai dấu mở không bao giờ khớp cùng một dòng.
    const marker = relative.match(htmlFence);
    if (fence) {
      // Cùng mốc với đường quét fence: closer đo so với lề container, không so
      // với dòng mở.
      if (
        marker && width <= listIndent + 3 && marker[1][0] === fence[0] &&
        marker[1].length >= fence.length && /^[ \t\r]*$/.test(marker[2])
      ) fence = undefined;
      loneTagAllowed = false;
      return line;
    }
    const container = track(relative, width, blank);
    listIndent = container.indent;
    // Một block HTML mở được ngay trên dòng có dấu list: trong "- <div>", nội
    // dung của item bắt đầu sau "- " và chính là dấu mở. Chỉ thử trên phần đã
    // bỏ thụt lề thì dấu list còn nguyên, không dấu mở nào khớp, và nội dung
    // của block bị quét như Markdown sống. Cả dòng bị ẩn kèm dấu list, tức một
    // bullet biến mất khỏi Markdown cấu trúc; đó là hướng fail-closed và đúng
    // với chuẩn, vì nội dung của item đó là HTML thô chứ không phải văn xuôi.
    const content = container.marker
      ? relative.slice(container.marker.length)
      : relative;
    // Dấu mở fence cũng đọc trên phần sau dấu list, đúng như đường quét fence,
    // để "- ~~~" mở một khối code chứ không phải một bullet có nội dung sống.
    const fenceOpener = container.marker ? content.match(htmlFence) : marker;
    const openWidth = container.marker
      ? listIndent + indentColumns(content)
      : width;
    if (
      fenceOpener && openWidth <= listIndent + 3 &&
      (fenceOpener[1][0] === "~" || !fenceOpener[2].includes("`"))
    ) {
      fence = fenceOpener[1];
      fenceQuote = quote.depth;
      loneTagAllowed = false;
      return line;
    }
    if (width > listIndent + 3) {
      loneTagAllowed = blank;
      return line;
    }
    for (const [opener, end] of htmlBlockOpeners) {
      if (!opener.test(content)) continue;
      // Điều kiện đóng có thể được thỏa ngay trên dòng mở, ví dụ "<pre>x</pre>".
      closer = end && end.test(source) ? undefined : end ?? htmlBlank;
      blockQuote = quote.depth;
      loneTagAllowed = false;
      return hidden(line);
    }
    if (loneTagAllowed && htmlLoneTag.test(content)) {
      closer = htmlBlank;
      blockQuote = quote.depth;
      loneTagAllowed = false;
      return hidden(line);
    }
    loneTagAllowed = blank || htmlLeafEnd.test(content);
    return line;
  }).join("\n");
}
// Markdown cấu trúc cho các gate metadata: bỏ code (fenced lẫn thụt đầu dòng)
// rồi bỏ HTML comment. Comment không render, nên một trường khai bên trong nó
// không phải nội dung sống: đọc nó khiến một kế hoạch có section hiển thị trống
// vẫn qua gate. Không xóa inline code ở đây vì chính các gate metadata đọc giá
// trị nằm trong backtick, và cả tập anchor cũng dựng từ khung nhìn này: một
// heading chứa code span phải giữ nguyên chữ trong backtick mới ra đúng slug.
// outsideHtmlComments tự bỏ qua dấu mở nằm trong code span, nên giữ backtick ở
// đây không còn mở được comment giả nuốt mọi heading và trường phía sau.
// Bỏ cả block HTML: một section metadata bọc trong <script type="text/plain">
// không render heading hay trường nào, nhưng nếu vẫn đọc nó thì audit, phụ
// thuộc, mốc soạn và trạng thái ẩn hẳn với người đọc vẫn thỏa được các gate ánh
// xạ bắt buộc. Bỏ block HTML trước code, cùng thứ tự với đường quét annotation:
// block mở trước nuốt luôn fence bên trong nó, còn fence mở trước thì
// outsideHtmlBlocks đã tự tránh không mở block. Chạy code trước thì một fence
// chưa đóng nằm trong <script> vẫn được coi là fence và nuốt phần còn lại của
// tài liệu.
const structuralMarkdown = (body) =>
  outsideHtmlComments(outsideBlockCode(outsideHtmlBlocks(body)));
// Những dòng tự mở một block mới nên không bao giờ là lazy continuation của
// đoạn văn phía trên: heading ATX, fence, list marker, thematic break, setext
// underline và thẻ HTML đầu dòng.
const blockStart =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|=+[ \t]*\r?$|(?:\*[ \t]*){3,}\r?$|(?:_[ \t]*){3,}\r?$|(?:-[ \t]*){3,}\r?$|<)/;
function markdownLinkSections(body) {
  const sections = [];
  let depth, fence, current = [];
  for (const original of outsideFencedCode(body).split("\n")) {
    let line = original, nextDepth = 0, prefix;
    while ((prefix = line.match(/^ {0,3}>[ \t]?/))) {
      if (fence && nextDepth === depth) break;
      nextDepth++;
      line = line.slice(prefix[0].length);
    }
    // Một dòng thiếu ">" vẫn thuộc đoạn văn đang mở của blockquote: CommonMark
    // gọi đó là lazy continuation, nên inline span mở ở dòng trước vẫn đóng
    // được ở dòng này. Cắt section chỉ vì độ sâu marker đổi thì một code span
    // viết vắt qua dòng lười bị tách làm đôi, destination bên trong nó thành
    // link sống và một tài liệu đúng bị báo hỏng. Lazy chỉ áp cho văn bản tiếp
    // nối của một đoạn: không áp khi đang trong fence, khi dòng trống, khi dòng
    // trước trống, hay khi chính dòng này mở một block mới.
    const lazy = nextDepth < depth && !fence && line.trim() !== "" &&
      (current[current.length - 1] ?? "").trim() !== "" &&
      !blockStart.test(line);
    // Rời container cũng kết thúc fence chưa đóng và inline span của container.
    if (nextDepth !== depth && !lazy) {
      if (current.length) sections.push(current.join("\n"));
      current = [];
      depth = nextDepth;
      fence = undefined;
    }
    current.push(line);
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)\r?$/);
    if (fence) {
      if (
        marker && marker[1][0] === fence[0] &&
        marker[1].length >= fence.length && /^[ \t\r]*$/.test(marker[2])
      ) {
        fence = undefined;
      }
    } else if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = marker[1];
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections;
}
// Vị trí tuyệt đối của từng inline code span. Tách khỏi outsideInlineCode vì
// đường quét comment cần biết span mở ở đâu chứ không cần bản đã xóa.
function inlineCodeSpans(body) {
  // Inline span không được nối qua heading, list, quote hoặc đoạn trống.
  const paragraphs = [];
  let current = "";
  function flush() {
    if (current) paragraphs.push(current);
    current = "";
  }
  for (const line of body.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const content = line.replace(/\r?\n$/, "");
    const standalone = /^ {0,3}#{1,6}(?:[ \t]|$)/.test(content) ||
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(content) ||
      /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(
        content,
      );
    if (
      standalone || /^[ \t]*$/.test(content) ||
      /^ {0,3}(?:(?:[-+*]|[0-9]+[.)])[ \t]+|>)/.test(content)
    ) flush();
    current += line;
    if (standalone || /^[ \t]*$/.test(content)) flush();
  }
  flush();
  const spans = [];
  let base = 0;
  for (const paragraph of paragraphs) {
    const runs = [...paragraph.matchAll(/`+/g)];
    for (let index = 0; index < runs.length; index++) {
      const open = runs[index];
      const escapes =
        paragraph.slice(0, open.index).match(/\\+$/)?.[0].length ?? 0;
      if (escapes % 2) continue;
      const closeIndex = runs.findIndex((candidate, next) =>
        next > index && candidate[0].length === open[0].length
      );
      if (closeIndex < 0) continue;
      const close = runs[closeIndex];
      spans.push([base + open.index, base + close.index + close[0].length]);
      index = closeIndex;
    }
    base += paragraph.length;
  }
  return spans;
}
function outsideInlineCode(body) {
  let output = "", cursor = 0;
  for (const [start, end] of inlineCodeSpans(body)) {
    output += body.slice(cursor, start) +
      body.slice(start, end).replace(/[^\n]/g, " ");
    cursor = end;
  }
  return output + body.slice(cursor);
}
// Cắt đúng thân của một section cấp hai, dừng ở heading cấp hai kế tiếp. Đếm
// theo section thay vì theo cả tài liệu để nội dung của section khác không đứng
// ra thay mặt section đang kiểm.
function structuralSection(body, heading) {
  const start = body.match(
    new RegExp(
      "^ {0,3}##[ \\t]+" + heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "[ \\t]*#*[ \\t]*\\r?$",
      "m",
    ),
  );
  if (!start) return "";
  const rest = body.slice(start.index + start[0].length);
  const next = rest.match(/^ {0,3}##[ \t]+/m);
  return next ? rest.slice(0, next.index) : rest;
}

// Destination của một link Markdown: dạng <...> hoặc chuỗi không khoảng trắng,
// theo sau có thể là title tùy chọn trong "...", '...' hoặc (...). Dùng chung
// cho inline link và reference definition để hai đường không hiểu khác nhau.
// Giữa destination và title, chuẩn cho phép khoảng trắng gồm tối đa một lần
// xuống dòng; chỉ nhận space và tab thì một link có title đặt ở dòng dưới không
// khớp mẫu, cả cụm bị đem đi phân giải như một đường dẫn và bị báo hỏng.
// Title chứa được chính dấu bao quanh nó khi dấu đó được escape, nên mẫu phải
// nuốt cặp backslash trước khi xét dấu đóng. Dừng ở dấu nháy đã escape thì cả
// destination lẫn title bị gộp làm một đường dẫn và một link đúng chuẩn tới
// file có thật bị báo hỏng.
// Destination trong ngoặc nhọn không chứa được xuống dòng: "[x](<a" ở cuối dòng
// này và "b.md>)" ở dòng sau là văn bản literal, không phải link. Cho "." nuốt
// qua newline thì cả hai dòng bị ghép làm một đường dẫn không ai viết và một tài
// liệu đúng bị báo hỏng.
const linkTitle =
  "(?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))";
const linkSeparator = "(?:[ \\t]+|[ \\t]*\\r?\\n[ \\t]*)";
const linkDestination = new RegExp(
  "^(?:<([^<>\\r\\n]*)>|([^\\s<>]+))(?:" + linkSeparator + linkTitle + ")?$",
);
// Inline link được phép rỗng hoàn toàn giữa hai ngoặc: "[home]()" render thành
// một link tới chính trang. Reference definition thì ngược lại, chuẩn đòi có
// destination ở đó, nên chỗ nới rỗng này chỉ dùng cho inline. Title vẫn phải
// đứng sau một destination: trong "[home]( "x")" chuẩn đọc chính chuỗi có dấu
// nháy làm destination, nên cho title đứng một mình là bịa ra một link tới
// trang hiện tại mà không renderer nào dựng.
const inlineDestination = new RegExp(
  "^(?:(?:<([^<>\\r\\n]*)>|([^\\s<>]+))(?:" + linkSeparator + linkTitle +
    ")?)?$",
);
// Ký tự ở vị trí position chỉ bị escape khi số backslash liền ngay trước nó là
// số lẻ. Chuỗi chẵn như \\[ là một backslash literal rồi mới tới [ còn hiệu
// lực, nên kiểm một ký tự đơn text[position - 1] === "\\" sẽ bỏ sót link thật.
function markdownEscaped(text, position) {
  let run = 0;
  while (position - run > 0 && text[position - 1 - run] === "\\") run++;
  return run % 2 === 1;
}
// Thẻ mở thật sự render ra HTML. Một dấu "\" ngay trước "<" vô hiệu thẻ:
// "\<a href="x.md">" là văn bản, không phải link, nên href trong đó không phải
// đích của ai cả và đem nó đi phân giải là báo hỏng một tài liệu đúng. Bên
// trong một HTML block thì ngược lại: nội dung là HTML thô, backslash không
// escape gì, nên thẻ ở đó vẫn sống và vẫn hỏng được. Hỏi escape ở đúng phần
// văn bản ngoài block, bằng chính bản đồ block giữ nguyên offset.
function renderedTags(text) {
  const outsideBlocks = outsideHtmlBlocks(text, true);
  return [...text.matchAll(htmlTagAttributes)].filter((tag) =>
    outsideBlocks[tag.index] !== "<" || !markdownEscaped(text, tag.index)
  );
}
// "href" và "src" chỉ là địa chỉ trên đúng những phần tử định nghĩa chúng.
// Trên <div href="missing.md"> thì href là thuộc tính lạ, trình duyệt không tải
// gì và không có link nào để hỏng; đem nó đi phân giải là báo hỏng một tài liệu
// đúng chỉ vì tác giả đặt tên thuộc tính trùng. Ngược lại danh sách phải đủ
// rộng: SVG dựng link bằng <use href> và <image href>, animation bằng <mpath
// href>, chữ chạy theo đường bằng <textPath href>, filter nạp ảnh bằng
// <feImage href>; bỏ sót nhóm này thì một đích hỏng đi qua cổng.
const hrefElements = new Set([
  "a",
  "area",
  "base",
  "link",
  "use",
  "image",
  "textpath",
  "mpath",
  "feimage",
  "script",
]);
const srcElements = new Set([
  "img",
  "script",
  "iframe",
  "embed",
  "source",
  "track",
  "audio",
  "video",
  "input",
  "frame",
]);
// SVG vẫn hỗ trợ dạng cũ "xlink:href" và trình duyệt phân giải nó y như "href",
// nên bỏ qua tên đó là để một tài nguyên SVG hỏng thật đi qua cổng.
const linkAttribute = (element, name) =>
  name === "href" || name === "xlink:href"
    ? hrefElements.has(element)
    : name === "src" && srcElements.has(element);
// "srcset" mang cả một danh sách ứng viên và trình duyệt tải đúng một trong số
// đó theo mật độ điểm ảnh hay khổ màn hình, nên mọi URL trong danh sách đều là
// tài nguyên thật và đều hỏng được. Chỉ đọc "src" thì một ảnh 2x thiếu file đi
// qua cổng và vỡ trên đúng những máy chọn nhánh đó.
const srcsetElements = new Set(["img", "source"]);
// Tách theo thuật toán của HTML chứ không split thô ở dấu phẩy: dấu phẩy kết
// thúc ứng viên chỉ khi nó đứng cuối URL hoặc cuối descriptor, nên "a.png 1x,
// b.png 2x" cho hai URL còn "a.png 1x" cho một. Cắt bừa ở mọi dấu phẩy thì một
// descriptor bị đem đi phân giải như tên file và báo hỏng một tài liệu đúng.
function srcsetTargets(value) {
  const found = [];
  let expectUrl = true;
  for (const token of value.split(/[ \t\r\n\f]+/).filter(Boolean)) {
    if (!expectUrl) {
      if (token.endsWith(",")) expectUrl = true;
      continue;
    }
    if (token.endsWith(",")) {
      const url = token.replace(/,+$/, "");
      if (url) found.push(url);
      continue;
    }
    found.push(token);
    expectUrl = false;
  }
  return found;
}
// "poster" của video là URL của khung hình trình duyệt vẽ trước khi ai bấm
// play, nên nó là một tài nguyên thật và hỏng được y như "src". Bỏ qua tên đó
// là để một video mất ảnh nền đi qua cổng và vỡ trên đúng lần xem đầu tiên.
const posterElements = new Set(["video"]);
// Mọi đích mà một thuộc tính dựng ra, đã tách sẵn: "href", "src" và "poster"
// cho đúng một đích, "srcset" cho cả danh sách, tên khác cho danh sách rỗng.
const attributeTargets = (element, name, value) =>
  linkAttribute(element, name) ||
    (name === "poster" && posterElements.has(element))
    ? [value]
    : name === "srcset" && srcsetElements.has(element)
    ? srcsetTargets(value)
    : [];
// Một ô bảng được phép chứa dấu | literal, viết là "\|". split("|") thô coi nó
// là vách ngăn và đẩy lệch mọi cột phía sau, nên một README đúng bị báo sai hàng
// lẫn sai phụ thuộc. Tách ở vách chưa escape rồi mới trả về ký tự literal.
function tableCells(row) {
  const cells = [];
  let current = "";
  for (let position = 0; position < row.length; position++) {
    if (row[position] === "|" && !markdownEscaped(row, position)) {
      cells.push(current);
      current = "";
      continue;
    }
    current += row[position];
  }
  cells.push(current);
  return cells.map((cell) => cell.replaceAll("\\|", "|"));
}
// CommonMark giải mã character reference trước khi phân giải một destination
// và trước khi dựng id của heading, nên "[x](link&amp;target.md)" trỏ tới file
// "link&target.md" còn "## Rights &alpha; marker" mang id "rights-α-marker".
// Bỏ sót một tên là gate tự dựng một chuỗi khác với thứ trình duyệt hiển thị:
// giữ nguyên văn "&alpha;" thì slug thành "rights-alpha-marker" và một link
// đúng bị báo hỏng. Nhúng trọn bảng tên của HTML5, mã hóa bằng code point hệ
// mười sáu để không đưa ký tự vô hình nào vào source; chỉ lấy các tên có dấu
// chấm phẩy vì CommonMark không nhận dạng viết tắt kiểu "&amp" trong Markdown.
const namedReferenceData = [
  "AElig=c6 AMP=26 Aacute=c1 Abreve=102 Acirc=c2 Acy=410 Afr=1d504",
  "Agrave=c0 Alpha=391 Amacr=100 And=2a53 Aogon=104 Aopf=1d538",
  "ApplyFunction=2061 Aring=c5 Ascr=1d49c Assign=2254 Atilde=c3 Auml=c4",
  "Backslash=2216 Barv=2ae7 Barwed=2306 Bcy=411 Because=2235",
  "Bernoullis=212c Beta=392 Bfr=1d505 Bopf=1d539 Breve=2d8 Bscr=212c",
  "Bumpeq=224e CHcy=427 COPY=a9 Cacute=106 Cap=22d2",
  "CapitalDifferentialD=2145 Cayleys=212d Ccaron=10c Ccedil=c7 Ccirc=108",
  "Cconint=2230 Cdot=10a Cedilla=b8 CenterDot=b7 Cfr=212d Chi=3a7",
  "CircleDot=2299 CircleMinus=2296 CirclePlus=2295 CircleTimes=2297",
  "ClockwiseContourIntegral=2232 CloseCurlyDoubleQuote=201d",
  "CloseCurlyQuote=2019 Colon=2237 Colone=2a74 Congruent=2261 Conint=222f",
  "ContourIntegral=222e Copf=2102 Coproduct=2210",
  "CounterClockwiseContourIntegral=2233 Cross=2a2f Cscr=1d49e Cup=22d3",
  "CupCap=224d DD=2145 DDotrahd=2911 DJcy=402 DScy=405 DZcy=40f Dagger=2021",
  "Darr=21a1 Dashv=2ae4 Dcaron=10e Dcy=414 Del=2207 Delta=394 Dfr=1d507",
  "DiacriticalAcute=b4 DiacriticalDot=2d9 DiacriticalDoubleAcute=2dd",
  "DiacriticalGrave=60 DiacriticalTilde=2dc Diamond=22c4 DifferentialD=2146",
  "Dopf=1d53b Dot=a8 DotDot=20dc DotEqual=2250 DoubleContourIntegral=222f",
  "DoubleDot=a8 DoubleDownArrow=21d3 DoubleLeftArrow=21d0",
  "DoubleLeftRightArrow=21d4 DoubleLeftTee=2ae4 DoubleLongLeftArrow=27f8",
  "DoubleLongLeftRightArrow=27fa DoubleLongRightArrow=27f9",
  "DoubleRightArrow=21d2 DoubleRightTee=22a8 DoubleUpArrow=21d1",
  "DoubleUpDownArrow=21d5 DoubleVerticalBar=2225 DownArrow=2193",
  "DownArrowBar=2913 DownArrowUpArrow=21f5 DownBreve=311",
  "DownLeftRightVector=2950 DownLeftTeeVector=295e DownLeftVector=21bd",
  "DownLeftVectorBar=2956 DownRightTeeVector=295f DownRightVector=21c1",
  "DownRightVectorBar=2957 DownTee=22a4 DownTeeArrow=21a7 Downarrow=21d3",
  "Dscr=1d49f Dstrok=110 ENG=14a ETH=d0 Eacute=c9 Ecaron=11a Ecirc=ca",
  "Ecy=42d Edot=116 Efr=1d508 Egrave=c8 Element=2208 Emacr=112",
  "EmptySmallSquare=25fb EmptyVerySmallSquare=25ab Eogon=118 Eopf=1d53c",
  "Epsilon=395 Equal=2a75 EqualTilde=2242 Equilibrium=21cc Escr=2130",
  "Esim=2a73 Eta=397 Euml=cb Exists=2203 ExponentialE=2147 Fcy=424",
  "Ffr=1d509 FilledSmallSquare=25fc FilledVerySmallSquare=25aa Fopf=1d53d",
  "ForAll=2200 Fouriertrf=2131 Fscr=2131 GJcy=403 GT=3e Gamma=393",
  "Gammad=3dc Gbreve=11e Gcedil=122 Gcirc=11c Gcy=413 Gdot=120 Gfr=1d50a",
  "Gg=22d9 Gopf=1d53e GreaterEqual=2265 GreaterEqualLess=22db",
  "GreaterFullEqual=2267 GreaterGreater=2aa2 GreaterLess=2277",
  "GreaterSlantEqual=2a7e GreaterTilde=2273 Gscr=1d4a2 Gt=226b HARDcy=42a",
  "Hacek=2c7 Hat=5e Hcirc=124 Hfr=210c HilbertSpace=210b Hopf=210d",
  "HorizontalLine=2500 Hscr=210b Hstrok=126 HumpDownHump=224e",
  "HumpEqual=224f IEcy=415 IJlig=132 IOcy=401 Iacute=cd Icirc=ce Icy=418",
  "Idot=130 Ifr=2111 Igrave=cc Im=2111 Imacr=12a ImaginaryI=2148",
  "Implies=21d2 Int=222c Integral=222b Intersection=22c2",
  "InvisibleComma=2063 InvisibleTimes=2062 Iogon=12e Iopf=1d540 Iota=399",
  "Iscr=2110 Itilde=128 Iukcy=406 Iuml=cf Jcirc=134 Jcy=419 Jfr=1d50d",
  "Jopf=1d541 Jscr=1d4a5 Jsercy=408 Jukcy=404 KHcy=425 KJcy=40c Kappa=39a",
  "Kcedil=136 Kcy=41a Kfr=1d50e Kopf=1d542 Kscr=1d4a6 LJcy=409 LT=3c",
  "Lacute=139 Lambda=39b Lang=27ea Laplacetrf=2112 Larr=219e Lcaron=13d",
  "Lcedil=13b Lcy=41b LeftAngleBracket=27e8 LeftArrow=2190",
  "LeftArrowBar=21e4 LeftArrowRightArrow=21c6 LeftCeiling=2308",
  "LeftDoubleBracket=27e6 LeftDownTeeVector=2961 LeftDownVector=21c3",
  "LeftDownVectorBar=2959 LeftFloor=230a LeftRightArrow=2194",
  "LeftRightVector=294e LeftTee=22a3 LeftTeeArrow=21a4 LeftTeeVector=295a",
  "LeftTriangle=22b2 LeftTriangleBar=29cf LeftTriangleEqual=22b4",
  "LeftUpDownVector=2951 LeftUpTeeVector=2960 LeftUpVector=21bf",
  "LeftUpVectorBar=2958 LeftVector=21bc LeftVectorBar=2952 Leftarrow=21d0",
  "Leftrightarrow=21d4 LessEqualGreater=22da LessFullEqual=2266",
  "LessGreater=2276 LessLess=2aa1 LessSlantEqual=2a7d LessTilde=2272",
  "Lfr=1d50f Ll=22d8 Lleftarrow=21da Lmidot=13f LongLeftArrow=27f5",
  "LongLeftRightArrow=27f7 LongRightArrow=27f6 Longleftarrow=27f8",
  "Longleftrightarrow=27fa Longrightarrow=27f9 Lopf=1d543",
  "LowerLeftArrow=2199 LowerRightArrow=2198 Lscr=2112 Lsh=21b0 Lstrok=141",
  "Lt=226a Map=2905 Mcy=41c MediumSpace=205f Mellintrf=2133 Mfr=1d510",
  "MinusPlus=2213 Mopf=1d544 Mscr=2133 Mu=39c NJcy=40a Nacute=143",
  "Ncaron=147 Ncedil=145 Ncy=41d NegativeMediumSpace=200b",
  "NegativeThickSpace=200b NegativeThinSpace=200b",
  "NegativeVeryThinSpace=200b NestedGreaterGreater=226b NestedLessLess=226a",
  "NewLine=a Nfr=1d511 NoBreak=2060 NonBreakingSpace=a0 Nopf=2115 Not=2aec",
  "NotCongruent=2262 NotCupCap=226d NotDoubleVerticalBar=2226",
  "NotElement=2209 NotEqual=2260 NotEqualTilde=2242,338 NotExists=2204",
  "NotGreater=226f NotGreaterEqual=2271 NotGreaterFullEqual=2267,338",
  "NotGreaterGreater=226b,338 NotGreaterLess=2279",
  "NotGreaterSlantEqual=2a7e,338 NotGreaterTilde=2275",
  "NotHumpDownHump=224e,338 NotHumpEqual=224f,338 NotLeftTriangle=22ea",
  "NotLeftTriangleBar=29cf,338 NotLeftTriangleEqual=22ec NotLess=226e",
  "NotLessEqual=2270 NotLessGreater=2278 NotLessLess=226a,338",
  "NotLessSlantEqual=2a7d,338 NotLessTilde=2274",
  "NotNestedGreaterGreater=2aa2,338 NotNestedLessLess=2aa1,338",
  "NotPrecedes=2280 NotPrecedesEqual=2aaf,338 NotPrecedesSlantEqual=22e0",
  "NotReverseElement=220c NotRightTriangle=22eb",
  "NotRightTriangleBar=29d0,338 NotRightTriangleEqual=22ed",
  "NotSquareSubset=228f,338 NotSquareSubsetEqual=22e2",
  "NotSquareSuperset=2290,338 NotSquareSupersetEqual=22e3",
  "NotSubset=2282,20d2 NotSubsetEqual=2288 NotSucceeds=2281",
  "NotSucceedsEqual=2ab0,338 NotSucceedsSlantEqual=22e1",
  "NotSucceedsTilde=227f,338 NotSuperset=2283,20d2 NotSupersetEqual=2289",
  "NotTilde=2241 NotTildeEqual=2244 NotTildeFullEqual=2247",
  "NotTildeTilde=2249 NotVerticalBar=2224 Nscr=1d4a9 Ntilde=d1 Nu=39d",
  "OElig=152 Oacute=d3 Ocirc=d4 Ocy=41e Odblac=150 Ofr=1d512 Ograve=d2",
  "Omacr=14c Omega=3a9 Omicron=39f Oopf=1d546 OpenCurlyDoubleQuote=201c",
  "OpenCurlyQuote=2018 Or=2a54 Oscr=1d4aa Oslash=d8 Otilde=d5 Otimes=2a37",
  "Ouml=d6 OverBar=203e OverBrace=23de OverBracket=23b4",
  "OverParenthesis=23dc PartialD=2202 Pcy=41f Pfr=1d513 Phi=3a6 Pi=3a0",
  "PlusMinus=b1 Poincareplane=210c Popf=2119 Pr=2abb Precedes=227a",
  "PrecedesEqual=2aaf PrecedesSlantEqual=227c PrecedesTilde=227e Prime=2033",
  "Product=220f Proportion=2237 Proportional=221d Pscr=1d4ab Psi=3a8",
  "QUOT=22 Qfr=1d514 Qopf=211a Qscr=1d4ac RBarr=2910 REG=ae Racute=154",
  "Rang=27eb Rarr=21a0 Rarrtl=2916 Rcaron=158 Rcedil=156 Rcy=420 Re=211c",
  "ReverseElement=220b ReverseEquilibrium=21cb ReverseUpEquilibrium=296f",
  "Rfr=211c Rho=3a1 RightAngleBracket=27e9 RightArrow=2192",
  "RightArrowBar=21e5 RightArrowLeftArrow=21c4 RightCeiling=2309",
  "RightDoubleBracket=27e7 RightDownTeeVector=295d RightDownVector=21c2",
  "RightDownVectorBar=2955 RightFloor=230b RightTee=22a2 RightTeeArrow=21a6",
  "RightTeeVector=295b RightTriangle=22b3 RightTriangleBar=29d0",
  "RightTriangleEqual=22b5 RightUpDownVector=294f RightUpTeeVector=295c",
  "RightUpVector=21be RightUpVectorBar=2954 RightVector=21c0",
  "RightVectorBar=2953 Rightarrow=21d2 Ropf=211d RoundImplies=2970",
  "Rrightarrow=21db Rscr=211b Rsh=21b1 RuleDelayed=29f4 SHCHcy=429 SHcy=428",
  "SOFTcy=42c Sacute=15a Sc=2abc Scaron=160 Scedil=15e Scirc=15c Scy=421",
  "Sfr=1d516 ShortDownArrow=2193 ShortLeftArrow=2190 ShortRightArrow=2192",
  "ShortUpArrow=2191 Sigma=3a3 SmallCircle=2218 Sopf=1d54a Sqrt=221a",
  "Square=25a1 SquareIntersection=2293 SquareSubset=228f",
  "SquareSubsetEqual=2291 SquareSuperset=2290 SquareSupersetEqual=2292",
  "SquareUnion=2294 Sscr=1d4ae Star=22c6 Sub=22d0 Subset=22d0",
  "SubsetEqual=2286 Succeeds=227b SucceedsEqual=2ab0",
  "SucceedsSlantEqual=227d SucceedsTilde=227f SuchThat=220b Sum=2211",
  "Sup=22d1 Superset=2283 SupersetEqual=2287 Supset=22d1 THORN=de",
  "TRADE=2122 TSHcy=40b TScy=426 Tab=9 Tau=3a4 Tcaron=164 Tcedil=162",
  "Tcy=422 Tfr=1d517 Therefore=2234 Theta=398 ThickSpace=205f,200a",
  "ThinSpace=2009 Tilde=223c TildeEqual=2243 TildeFullEqual=2245",
  "TildeTilde=2248 Topf=1d54b TripleDot=20db Tscr=1d4af Tstrok=166",
  "Uacute=da Uarr=219f Uarrocir=2949 Ubrcy=40e Ubreve=16c Ucirc=db Ucy=423",
  "Udblac=170 Ufr=1d518 Ugrave=d9 Umacr=16a UnderBar=5f UnderBrace=23df",
  "UnderBracket=23b5 UnderParenthesis=23dd Union=22c3 UnionPlus=228e",
  "Uogon=172 Uopf=1d54c UpArrow=2191 UpArrowBar=2912 UpArrowDownArrow=21c5",
  "UpDownArrow=2195 UpEquilibrium=296e UpTee=22a5 UpTeeArrow=21a5",
  "Uparrow=21d1 Updownarrow=21d5 UpperLeftArrow=2196 UpperRightArrow=2197",
  "Upsi=3d2 Upsilon=3a5 Uring=16e Uscr=1d4b0 Utilde=168 Uuml=dc VDash=22ab",
  "Vbar=2aeb Vcy=412 Vdash=22a9 Vdashl=2ae6 Vee=22c1 Verbar=2016 Vert=2016",
  "VerticalBar=2223 VerticalLine=7c VerticalSeparator=2758",
  "VerticalTilde=2240 VeryThinSpace=200a Vfr=1d519 Vopf=1d54d Vscr=1d4b1",
  "Vvdash=22aa Wcirc=174 Wedge=22c0 Wfr=1d51a Wopf=1d54e Wscr=1d4b2",
  "Xfr=1d51b Xi=39e Xopf=1d54f Xscr=1d4b3 YAcy=42f YIcy=407 YUcy=42e",
  "Yacute=dd Ycirc=176 Ycy=42b Yfr=1d51c Yopf=1d550 Yscr=1d4b4 Yuml=178",
  "ZHcy=416 Zacute=179 Zcaron=17d Zcy=417 Zdot=17b ZeroWidthSpace=200b",
  "Zeta=396 Zfr=2128 Zopf=2124 Zscr=1d4b5 aacute=e1 abreve=103 ac=223e",
  "acE=223e,333 acd=223f acirc=e2 acute=b4 acy=430 aelig=e6 af=2061",
  "afr=1d51e agrave=e0 alefsym=2135 aleph=2135 alpha=3b1 amacr=101",
  "amalg=2a3f amp=26 and=2227 andand=2a55 andd=2a5c andslope=2a58 andv=2a5a",
  "ang=2220 ange=29a4 angle=2220 angmsd=2221 angmsdaa=29a8 angmsdab=29a9",
  "angmsdac=29aa angmsdad=29ab angmsdae=29ac angmsdaf=29ad angmsdag=29ae",
  "angmsdah=29af angrt=221f angrtvb=22be angrtvbd=299d angsph=2222 angst=c5",
  "angzarr=237c aogon=105 aopf=1d552 ap=2248 apE=2a70 apacir=2a6f ape=224a",
  "apid=224b apos=27 approx=2248 approxeq=224a aring=e5 ascr=1d4b6 ast=2a",
  "asymp=2248 asympeq=224d atilde=e3 auml=e4 awconint=2233 awint=2a11",
  "bNot=2aed backcong=224c backepsilon=3f6 backprime=2035 backsim=223d",
  "backsimeq=22cd barvee=22bd barwed=2305 barwedge=2305 bbrk=23b5",
  "bbrktbrk=23b6 bcong=224c bcy=431 bdquo=201e becaus=2235 because=2235",
  "bemptyv=29b0 bepsi=3f6 bernou=212c beta=3b2 beth=2136 between=226c",
  "bfr=1d51f bigcap=22c2 bigcirc=25ef bigcup=22c3 bigodot=2a00",
  "bigoplus=2a01 bigotimes=2a02 bigsqcup=2a06 bigstar=2605",
  "bigtriangledown=25bd bigtriangleup=25b3 biguplus=2a04 bigvee=22c1",
  "bigwedge=22c0 bkarow=290d blacklozenge=29eb blacksquare=25aa",
  "blacktriangle=25b4 blacktriangledown=25be blacktriangleleft=25c2",
  "blacktriangleright=25b8 blank=2423 blk12=2592 blk14=2591 blk34=2593",
  "block=2588 bne=3d,20e5 bnequiv=2261,20e5 bnot=2310 bopf=1d553 bot=22a5",
  "bottom=22a5 bowtie=22c8 boxDL=2557 boxDR=2554 boxDl=2556 boxDr=2553",
  "boxH=2550 boxHD=2566 boxHU=2569 boxHd=2564 boxHu=2567 boxUL=255d",
  "boxUR=255a boxUl=255c boxUr=2559 boxV=2551 boxVH=256c boxVL=2563",
  "boxVR=2560 boxVh=256b boxVl=2562 boxVr=255f boxbox=29c9 boxdL=2555",
  "boxdR=2552 boxdl=2510 boxdr=250c boxh=2500 boxhD=2565 boxhU=2568",
  "boxhd=252c boxhu=2534 boxminus=229f boxplus=229e boxtimes=22a0",
  "boxuL=255b boxuR=2558 boxul=2518 boxur=2514 boxv=2502 boxvH=256a",
  "boxvL=2561 boxvR=255e boxvh=253c boxvl=2524 boxvr=251c bprime=2035",
  "breve=2d8 brvbar=a6 bscr=1d4b7 bsemi=204f bsim=223d bsime=22cd bsol=5c",
  "bsolb=29c5 bsolhsub=27c8 bull=2022 bullet=2022 bump=224e bumpE=2aae",
  "bumpe=224f bumpeq=224f cacute=107 cap=2229 capand=2a44 capbrcup=2a49",
  "capcap=2a4b capcup=2a47 capdot=2a40 caps=2229,fe00 caret=2041 caron=2c7",
  "ccaps=2a4d ccaron=10d ccedil=e7 ccirc=109 ccups=2a4c ccupssm=2a50",
  "cdot=10b cedil=b8 cemptyv=29b2 cent=a2 centerdot=b7 cfr=1d520 chcy=447",
  "check=2713 checkmark=2713 chi=3c7 cir=25cb cirE=29c3 circ=2c6",
  "circeq=2257 circlearrowleft=21ba circlearrowright=21bb circledR=ae",
  "circledS=24c8 circledast=229b circledcirc=229a circleddash=229d",
  "cire=2257 cirfnint=2a10 cirmid=2aef cirscir=29c2 clubs=2663",
  "clubsuit=2663 colon=3a colone=2254 coloneq=2254 comma=2c commat=40",
  "comp=2201 compfn=2218 complement=2201 complexes=2102 cong=2245",
  "congdot=2a6d conint=222e copf=1d554 coprod=2210 copy=a9 copysr=2117",
  "crarr=21b5 cross=2717 cscr=1d4b8 csub=2acf csube=2ad1 csup=2ad0",
  "csupe=2ad2 ctdot=22ef cudarrl=2938 cudarrr=2935 cuepr=22de cuesc=22df",
  "cularr=21b6 cularrp=293d cup=222a cupbrcap=2a48 cupcap=2a46 cupcup=2a4a",
  "cupdot=228d cupor=2a45 cups=222a,fe00 curarr=21b7 curarrm=293c",
  "curlyeqprec=22de curlyeqsucc=22df curlyvee=22ce curlywedge=22cf",
  "curren=a4 curvearrowleft=21b6 curvearrowright=21b7 cuvee=22ce cuwed=22cf",
  "cwconint=2232 cwint=2231 cylcty=232d dArr=21d3 dHar=2965 dagger=2020",
  "daleth=2138 darr=2193 dash=2010 dashv=22a3 dbkarow=290f dblac=2dd",
  "dcaron=10f dcy=434 dd=2146 ddagger=2021 ddarr=21ca ddotseq=2a77 deg=b0",
  "delta=3b4 demptyv=29b1 dfisht=297f dfr=1d521 dharl=21c3 dharr=21c2",
  "diam=22c4 diamond=22c4 diamondsuit=2666 diams=2666 die=a8 digamma=3dd",
  "disin=22f2 div=f7 divide=f7 divideontimes=22c7 divonx=22c7 djcy=452",
  "dlcorn=231e dlcrop=230d dollar=24 dopf=1d555 dot=2d9 doteq=2250",
  "doteqdot=2251 dotminus=2238 dotplus=2214 dotsquare=22a1",
  "doublebarwedge=2306 downarrow=2193 downdownarrows=21ca",
  "downharpoonleft=21c3 downharpoonright=21c2 drbkarow=2910 drcorn=231f",
  "drcrop=230c dscr=1d4b9 dscy=455 dsol=29f6 dstrok=111 dtdot=22f1",
  "dtri=25bf dtrif=25be duarr=21f5 duhar=296f dwangle=29a6 dzcy=45f",
  "dzigrarr=27ff eDDot=2a77 eDot=2251 eacute=e9 easter=2a6e ecaron=11b",
  "ecir=2256 ecirc=ea ecolon=2255 ecy=44d edot=117 ee=2147 efDot=2252",
  "efr=1d522 eg=2a9a egrave=e8 egs=2a96 egsdot=2a98 el=2a99 elinters=23e7",
  "ell=2113 els=2a95 elsdot=2a97 emacr=113 empty=2205 emptyset=2205",
  "emptyv=2205 emsp13=2004 emsp14=2005 emsp=2003 eng=14b ensp=2002",
  "eogon=119 eopf=1d556 epar=22d5 eparsl=29e3 eplus=2a71 epsi=3b5",
  "epsilon=3b5 epsiv=3f5 eqcirc=2256 eqcolon=2255 eqsim=2242",
  "eqslantgtr=2a96 eqslantless=2a95 equals=3d equest=225f equiv=2261",
  "equivDD=2a78 eqvparsl=29e5 erDot=2253 erarr=2971 escr=212f esdot=2250",
  "esim=2242 eta=3b7 eth=f0 euml=eb euro=20ac excl=21 exist=2203",
  "expectation=2130 exponentiale=2147 fallingdotseq=2252 fcy=444",
  "female=2640 ffilig=fb03 fflig=fb00 ffllig=fb04 ffr=1d523 filig=fb01",
  "fjlig=66,6a flat=266d fllig=fb02 fltns=25b1 fnof=192 fopf=1d557",
  "forall=2200 fork=22d4 forkv=2ad9 fpartint=2a0d frac12=bd frac13=2153",
  "frac14=bc frac15=2155 frac16=2159 frac18=215b frac23=2154 frac25=2156",
  "frac34=be frac35=2157 frac38=215c frac45=2158 frac56=215a frac58=215d",
  "frac78=215e frasl=2044 frown=2322 fscr=1d4bb gE=2267 gEl=2a8c gacute=1f5",
  "gamma=3b3 gammad=3dd gap=2a86 gbreve=11f gcirc=11d gcy=433 gdot=121",
  "ge=2265 gel=22db geq=2265 geqq=2267 geqslant=2a7e ges=2a7e gescc=2aa9",
  "gesdot=2a80 gesdoto=2a82 gesdotol=2a84 gesl=22db,fe00 gesles=2a94",
  "gfr=1d524 gg=226b ggg=22d9 gimel=2137 gjcy=453 gl=2277 glE=2a92 gla=2aa5",
  "glj=2aa4 gnE=2269 gnap=2a8a gnapprox=2a8a gne=2a88 gneq=2a88 gneqq=2269",
  "gnsim=22e7 gopf=1d558 grave=60 gscr=210a gsim=2273 gsime=2a8e gsiml=2a90",
  "gt=3e gtcc=2aa7 gtcir=2a7a gtdot=22d7 gtlPar=2995 gtquest=2a7c",
  "gtrapprox=2a86 gtrarr=2978 gtrdot=22d7 gtreqless=22db gtreqqless=2a8c",
  "gtrless=2277 gtrsim=2273 gvertneqq=2269,fe00 gvnE=2269,fe00 hArr=21d4",
  "hairsp=200a half=bd hamilt=210b hardcy=44a harr=2194 harrcir=2948",
  "harrw=21ad hbar=210f hcirc=125 hearts=2665 heartsuit=2665 hellip=2026",
  "hercon=22b9 hfr=1d525 hksearow=2925 hkswarow=2926 hoarr=21ff homtht=223b",
  "hookleftarrow=21a9 hookrightarrow=21aa hopf=1d559 horbar=2015 hscr=1d4bd",
  "hslash=210f hstrok=127 hybull=2043 hyphen=2010 iacute=ed ic=2063",
  "icirc=ee icy=438 iecy=435 iexcl=a1 iff=21d4 ifr=1d526 igrave=ec ii=2148",
  "iiiint=2a0c iiint=222d iinfin=29dc iiota=2129 ijlig=133 imacr=12b",
  "image=2111 imagline=2110 imagpart=2111 imath=131 imof=22b7 imped=1b5",
  "in=2208 incare=2105 infin=221e infintie=29dd inodot=131 int=222b",
  "intcal=22ba integers=2124 intercal=22ba intlarhk=2a17 intprod=2a3c",
  "iocy=451 iogon=12f iopf=1d55a iota=3b9 iprod=2a3c iquest=bf iscr=1d4be",
  "isin=2208 isinE=22f9 isindot=22f5 isins=22f4 isinsv=22f3 isinv=2208",
  "it=2062 itilde=129 iukcy=456 iuml=ef jcirc=135 jcy=439 jfr=1d527",
  "jmath=237 jopf=1d55b jscr=1d4bf jsercy=458 jukcy=454 kappa=3ba",
  "kappav=3f0 kcedil=137 kcy=43a kfr=1d528 kgreen=138 khcy=445 kjcy=45c",
  "kopf=1d55c kscr=1d4c0 lAarr=21da lArr=21d0 lAtail=291b lBarr=290e",
  "lE=2266 lEg=2a8b lHar=2962 lacute=13a laemptyv=29b4 lagran=2112",
  "lambda=3bb lang=27e8 langd=2991 langle=27e8 lap=2a85 laquo=ab larr=2190",
  "larrb=21e4 larrbfs=291f larrfs=291d larrhk=21a9 larrlp=21ab larrpl=2939",
  "larrsim=2973 larrtl=21a2 lat=2aab latail=2919 late=2aad lates=2aad,fe00",
  "lbarr=290c lbbrk=2772 lbrace=7b lbrack=5b lbrke=298b lbrksld=298f",
  "lbrkslu=298d lcaron=13e lcedil=13c lceil=2308 lcub=7b lcy=43b ldca=2936",
  "ldquo=201c ldquor=201e ldrdhar=2967 ldrushar=294b ldsh=21b2 le=2264",
  "leftarrow=2190 leftarrowtail=21a2 leftharpoondown=21bd",
  "leftharpoonup=21bc leftleftarrows=21c7 leftrightarrow=2194",
  "leftrightarrows=21c6 leftrightharpoons=21cb leftrightsquigarrow=21ad",
  "leftthreetimes=22cb leg=22da leq=2264 leqq=2266 leqslant=2a7d les=2a7d",
  "lescc=2aa8 lesdot=2a7f lesdoto=2a81 lesdotor=2a83 lesg=22da,fe00",
  "lesges=2a93 lessapprox=2a85 lessdot=22d6 lesseqgtr=22da lesseqqgtr=2a8b",
  "lessgtr=2276 lesssim=2272 lfisht=297c lfloor=230a lfr=1d529 lg=2276",
  "lgE=2a91 lhard=21bd lharu=21bc lharul=296a lhblk=2584 ljcy=459 ll=226a",
  "llarr=21c7 llcorner=231e llhard=296b lltri=25fa lmidot=140 lmoust=23b0",
  "lmoustache=23b0 lnE=2268 lnap=2a89 lnapprox=2a89 lne=2a87 lneq=2a87",
  "lneqq=2268 lnsim=22e6 loang=27ec loarr=21fd lobrk=27e6",
  "longleftarrow=27f5 longleftrightarrow=27f7 longmapsto=27fc",
  "longrightarrow=27f6 looparrowleft=21ab looparrowright=21ac lopar=2985",
  "lopf=1d55d loplus=2a2d lotimes=2a34 lowast=2217 lowbar=5f loz=25ca",
  "lozenge=25ca lozf=29eb lpar=28 lparlt=2993 lrarr=21c6 lrcorner=231f",
  "lrhar=21cb lrhard=296d lrm=200e lrtri=22bf lsaquo=2039 lscr=1d4c1",
  "lsh=21b0 lsim=2272 lsime=2a8d lsimg=2a8f lsqb=5b lsquo=2018 lsquor=201a",
  "lstrok=142 lt=3c ltcc=2aa6 ltcir=2a79 ltdot=22d6 lthree=22cb ltimes=22c9",
  "ltlarr=2976 ltquest=2a7b ltrPar=2996 ltri=25c3 ltrie=22b4 ltrif=25c2",
  "lurdshar=294a luruhar=2966 lvertneqq=2268,fe00 lvnE=2268,fe00 mDDot=223a",
  "macr=af male=2642 malt=2720 maltese=2720 map=21a6 mapsto=21a6",
  "mapstodown=21a7 mapstoleft=21a4 mapstoup=21a5 marker=25ae mcomma=2a29",
  "mcy=43c mdash=2014 measuredangle=2221 mfr=1d52a mho=2127 micro=b5",
  "mid=2223 midast=2a midcir=2af0 middot=b7 minus=2212 minusb=229f",
  "minusd=2238 minusdu=2a2a mlcp=2adb mldr=2026 mnplus=2213 models=22a7",
  "mopf=1d55e mp=2213 mscr=1d4c2 mstpos=223e mu=3bc multimap=22b8",
  "mumap=22b8 nGg=22d9,338 nGt=226b,20d2 nGtv=226b,338 nLeftarrow=21cd",
  "nLeftrightarrow=21ce nLl=22d8,338 nLt=226a,20d2 nLtv=226a,338",
  "nRightarrow=21cf nVDash=22af nVdash=22ae nabla=2207 nacute=144",
  "nang=2220,20d2 nap=2249 napE=2a70,338 napid=224b,338 napos=149",
  "napprox=2249 natur=266e natural=266e naturals=2115 nbsp=a0",
  "nbump=224e,338 nbumpe=224f,338 ncap=2a43 ncaron=148 ncedil=146",
  "ncong=2247 ncongdot=2a6d,338 ncup=2a42 ncy=43d ndash=2013 ne=2260",
  "neArr=21d7 nearhk=2924 nearr=2197 nearrow=2197 nedot=2250,338",
  "nequiv=2262 nesear=2928 nesim=2242,338 nexist=2204 nexists=2204",
  "nfr=1d52b ngE=2267,338 nge=2271 ngeq=2271 ngeqq=2267,338",
  "ngeqslant=2a7e,338 nges=2a7e,338 ngsim=2275 ngt=226f ngtr=226f",
  "nhArr=21ce nharr=21ae nhpar=2af2 ni=220b nis=22fc nisd=22fa niv=220b",
  "njcy=45a nlArr=21cd nlE=2266,338 nlarr=219a nldr=2025 nle=2270",
  "nleftarrow=219a nleftrightarrow=21ae nleq=2270 nleqq=2266,338",
  "nleqslant=2a7d,338 nles=2a7d,338 nless=226e nlsim=2274 nlt=226e",
  "nltri=22ea nltrie=22ec nmid=2224 nopf=1d55f not=ac notin=2209",
  "notinE=22f9,338 notindot=22f5,338 notinva=2209 notinvb=22f7 notinvc=22f6",
  "notni=220c notniva=220c notnivb=22fe notnivc=22fd npar=2226",
  "nparallel=2226 nparsl=2afd,20e5 npart=2202,338 npolint=2a14 npr=2280",
  "nprcue=22e0 npre=2aaf,338 nprec=2280 npreceq=2aaf,338 nrArr=21cf",
  "nrarr=219b nrarrc=2933,338 nrarrw=219d,338 nrightarrow=219b nrtri=22eb",
  "nrtrie=22ed nsc=2281 nsccue=22e1 nsce=2ab0,338 nscr=1d4c3 nshortmid=2224",
  "nshortparallel=2226 nsim=2241 nsime=2244 nsimeq=2244 nsmid=2224",
  "nspar=2226 nsqsube=22e2 nsqsupe=22e3 nsub=2284 nsubE=2ac5,338 nsube=2288",
  "nsubset=2282,20d2 nsubseteq=2288 nsubseteqq=2ac5,338 nsucc=2281",
  "nsucceq=2ab0,338 nsup=2285 nsupE=2ac6,338 nsupe=2289 nsupset=2283,20d2",
  "nsupseteq=2289 nsupseteqq=2ac6,338 ntgl=2279 ntilde=f1 ntlg=2278",
  "ntriangleleft=22ea ntrianglelefteq=22ec ntriangleright=22eb",
  "ntrianglerighteq=22ed nu=3bd num=23 numero=2116 numsp=2007 nvDash=22ad",
  "nvHarr=2904 nvap=224d,20d2 nvdash=22ac nvge=2265,20d2 nvgt=3e,20d2",
  "nvinfin=29de nvlArr=2902 nvle=2264,20d2 nvlt=3c,20d2 nvltrie=22b4,20d2",
  "nvrArr=2903 nvrtrie=22b5,20d2 nvsim=223c,20d2 nwArr=21d6 nwarhk=2923",
  "nwarr=2196 nwarrow=2196 nwnear=2927 oS=24c8 oacute=f3 oast=229b",
  "ocir=229a ocirc=f4 ocy=43e odash=229d odblac=151 odiv=2a38 odot=2299",
  "odsold=29bc oelig=153 ofcir=29bf ofr=1d52c ogon=2db ograve=f2 ogt=29c1",
  "ohbar=29b5 ohm=3a9 oint=222e olarr=21ba olcir=29be olcross=29bb",
  "oline=203e olt=29c0 omacr=14d omega=3c9 omicron=3bf omid=29b6",
  "ominus=2296 oopf=1d560 opar=29b7 operp=29b9 oplus=2295 or=2228",
  "orarr=21bb ord=2a5d order=2134 orderof=2134 ordf=aa ordm=ba origof=22b6",
  "oror=2a56 orslope=2a57 orv=2a5b oscr=2134 oslash=f8 osol=2298 otilde=f5",
  "otimes=2297 otimesas=2a36 ouml=f6 ovbar=233d par=2225 para=b6",
  "parallel=2225 parsim=2af3 parsl=2afd part=2202 pcy=43f percnt=25",
  "period=2e permil=2030 perp=22a5 pertenk=2031 pfr=1d52d phi=3c6 phiv=3d5",
  "phmmat=2133 phone=260e pi=3c0 pitchfork=22d4 piv=3d6 planck=210f",
  "planckh=210e plankv=210f plus=2b plusacir=2a23 plusb=229e pluscir=2a22",
  "plusdo=2214 plusdu=2a25 pluse=2a72 plusmn=b1 plussim=2a26 plustwo=2a27",
  "pm=b1 pointint=2a15 popf=1d561 pound=a3 pr=227a prE=2ab3 prap=2ab7",
  "prcue=227c pre=2aaf prec=227a precapprox=2ab7 preccurlyeq=227c",
  "preceq=2aaf precnapprox=2ab9 precneqq=2ab5 precnsim=22e8 precsim=227e",
  "prime=2032 primes=2119 prnE=2ab5 prnap=2ab9 prnsim=22e8 prod=220f",
  "profalar=232e profline=2312 profsurf=2313 prop=221d propto=221d",
  "prsim=227e prurel=22b0 pscr=1d4c5 psi=3c8 puncsp=2008 qfr=1d52e",
  "qint=2a0c qopf=1d562 qprime=2057 qscr=1d4c6 quaternions=210d",
  "quatint=2a16 quest=3f questeq=225f quot=22 rAarr=21db rArr=21d2",
  "rAtail=291c rBarr=290f rHar=2964 race=223d,331 racute=155 radic=221a",
  "raemptyv=29b3 rang=27e9 rangd=2992 range=29a5 rangle=27e9 raquo=bb",
  "rarr=2192 rarrap=2975 rarrb=21e5 rarrbfs=2920 rarrc=2933 rarrfs=291e",
  "rarrhk=21aa rarrlp=21ac rarrpl=2945 rarrsim=2974 rarrtl=21a3 rarrw=219d",
  "ratail=291a ratio=2236 rationals=211a rbarr=290d rbbrk=2773 rbrace=7d",
  "rbrack=5d rbrke=298c rbrksld=298e rbrkslu=2990 rcaron=159 rcedil=157",
  "rceil=2309 rcub=7d rcy=440 rdca=2937 rdldhar=2969 rdquo=201d rdquor=201d",
  "rdsh=21b3 real=211c realine=211b realpart=211c reals=211d rect=25ad",
  "reg=ae rfisht=297d rfloor=230b rfr=1d52f rhard=21c1 rharu=21c0",
  "rharul=296c rho=3c1 rhov=3f1 rightarrow=2192 rightarrowtail=21a3",
  "rightharpoondown=21c1 rightharpoonup=21c0 rightleftarrows=21c4",
  "rightleftharpoons=21cc rightrightarrows=21c9 rightsquigarrow=219d",
  "rightthreetimes=22cc ring=2da risingdotseq=2253 rlarr=21c4 rlhar=21cc",
  "rlm=200f rmoust=23b1 rmoustache=23b1 rnmid=2aee roang=27ed roarr=21fe",
  "robrk=27e7 ropar=2986 ropf=1d563 roplus=2a2e rotimes=2a35 rpar=29",
  "rpargt=2994 rppolint=2a12 rrarr=21c9 rsaquo=203a rscr=1d4c7 rsh=21b1",
  "rsqb=5d rsquo=2019 rsquor=2019 rthree=22cc rtimes=22ca rtri=25b9",
  "rtrie=22b5 rtrif=25b8 rtriltri=29ce ruluhar=2968 rx=211e sacute=15b",
  "sbquo=201a sc=227b scE=2ab4 scap=2ab8 scaron=161 sccue=227d sce=2ab0",
  "scedil=15f scirc=15d scnE=2ab6 scnap=2aba scnsim=22e9 scpolint=2a13",
  "scsim=227f scy=441 sdot=22c5 sdotb=22a1 sdote=2a66 seArr=21d8",
  "searhk=2925 searr=2198 searrow=2198 sect=a7 semi=3b seswar=2929",
  "setminus=2216 setmn=2216 sext=2736 sfr=1d530 sfrown=2322 sharp=266f",
  "shchcy=449 shcy=448 shortmid=2223 shortparallel=2225 shy=ad sigma=3c3",
  "sigmaf=3c2 sigmav=3c2 sim=223c simdot=2a6a sime=2243 simeq=2243",
  "simg=2a9e simgE=2aa0 siml=2a9d simlE=2a9f simne=2246 simplus=2a24",
  "simrarr=2972 slarr=2190 smallsetminus=2216 smashp=2a33 smeparsl=29e4",
  "smid=2223 smile=2323 smt=2aaa smte=2aac smtes=2aac,fe00 softcy=44c",
  "sol=2f solb=29c4 solbar=233f sopf=1d564 spades=2660 spadesuit=2660",
  "spar=2225 sqcap=2293 sqcaps=2293,fe00 sqcup=2294 sqcups=2294,fe00",
  "sqsub=228f sqsube=2291 sqsubset=228f sqsubseteq=2291 sqsup=2290",
  "sqsupe=2292 sqsupset=2290 sqsupseteq=2292 squ=25a1 square=25a1",
  "squarf=25aa squf=25aa srarr=2192 sscr=1d4c8 ssetmn=2216 ssmile=2323",
  "sstarf=22c6 star=2606 starf=2605 straightepsilon=3f5 straightphi=3d5",
  "strns=af sub=2282 subE=2ac5 subdot=2abd sube=2286 subedot=2ac3",
  "submult=2ac1 subnE=2acb subne=228a subplus=2abf subrarr=2979 subset=2282",
  "subseteq=2286 subseteqq=2ac5 subsetneq=228a subsetneqq=2acb subsim=2ac7",
  "subsub=2ad5 subsup=2ad3 succ=227b succapprox=2ab8 succcurlyeq=227d",
  "succeq=2ab0 succnapprox=2aba succneqq=2ab6 succnsim=22e9 succsim=227f",
  "sum=2211 sung=266a sup1=b9 sup2=b2 sup3=b3 sup=2283 supE=2ac6",
  "supdot=2abe supdsub=2ad8 supe=2287 supedot=2ac4 suphsol=27c9",
  "suphsub=2ad7 suplarr=297b supmult=2ac2 supnE=2acc supne=228b",
  "supplus=2ac0 supset=2283 supseteq=2287 supseteqq=2ac6 supsetneq=228b",
  "supsetneqq=2acc supsim=2ac8 supsub=2ad4 supsup=2ad6 swArr=21d9",
  "swarhk=2926 swarr=2199 swarrow=2199 swnwar=292a szlig=df target=2316",
  "tau=3c4 tbrk=23b4 tcaron=165 tcedil=163 tcy=442 tdot=20db telrec=2315",
  "tfr=1d531 there4=2234 therefore=2234 theta=3b8 thetasym=3d1 thetav=3d1",
  "thickapprox=2248 thicksim=223c thinsp=2009 thkap=2248 thksim=223c",
  "thorn=fe tilde=2dc times=d7 timesb=22a0 timesbar=2a31 timesd=2a30",
  "tint=222d toea=2928 top=22a4 topbot=2336 topcir=2af1 topf=1d565",
  "topfork=2ada tosa=2929 tprime=2034 trade=2122 triangle=25b5",
  "triangledown=25bf triangleleft=25c3 trianglelefteq=22b4 triangleq=225c",
  "triangleright=25b9 trianglerighteq=22b5 tridot=25ec trie=225c",
  "triminus=2a3a triplus=2a39 trisb=29cd tritime=2a3b trpezium=23e2",
  "tscr=1d4c9 tscy=446 tshcy=45b tstrok=167 twixt=226c",
  "twoheadleftarrow=219e twoheadrightarrow=21a0 uArr=21d1 uHar=2963",
  "uacute=fa uarr=2191 ubrcy=45e ubreve=16d ucirc=fb ucy=443 udarr=21c5",
  "udblac=171 udhar=296e ufisht=297e ufr=1d532 ugrave=f9 uharl=21bf",
  "uharr=21be uhblk=2580 ulcorn=231c ulcorner=231c ulcrop=230f ultri=25f8",
  "umacr=16b uml=a8 uogon=173 uopf=1d566 uparrow=2191 updownarrow=2195",
  "upharpoonleft=21bf upharpoonright=21be uplus=228e upsi=3c5 upsih=3d2",
  "upsilon=3c5 upuparrows=21c8 urcorn=231d urcorner=231d urcrop=230e",
  "uring=16f urtri=25f9 uscr=1d4ca utdot=22f0 utilde=169 utri=25b5",
  "utrif=25b4 uuarr=21c8 uuml=fc uwangle=29a7 vArr=21d5 vBar=2ae8",
  "vBarv=2ae9 vDash=22a8 vangrt=299c varepsilon=3f5 varkappa=3f0",
  "varnothing=2205 varphi=3d5 varpi=3d6 varpropto=221d varr=2195 varrho=3f1",
  "varsigma=3c2 varsubsetneq=228a,fe00 varsubsetneqq=2acb,fe00",
  "varsupsetneq=228b,fe00 varsupsetneqq=2acc,fe00 vartheta=3d1",
  "vartriangleleft=22b2 vartriangleright=22b3 vcy=432 vdash=22a2 vee=2228",
  "veebar=22bb veeeq=225a vellip=22ee verbar=7c vert=7c vfr=1d533",
  "vltri=22b2 vnsub=2282,20d2 vnsup=2283,20d2 vopf=1d567 vprop=221d",
  "vrtri=22b3 vscr=1d4cb vsubnE=2acb,fe00 vsubne=228a,fe00 vsupnE=2acc,fe00",
  "vsupne=228b,fe00 vzigzag=299a wcirc=175 wedbar=2a5f wedge=2227",
  "wedgeq=2259 weierp=2118 wfr=1d534 wopf=1d568 wp=2118 wr=2240 wreath=2240",
  "wscr=1d4cc xcap=22c2 xcirc=25ef xcup=22c3 xdtri=25bd xfr=1d535",
  "xhArr=27fa xharr=27f7 xi=3be xlArr=27f8 xlarr=27f5 xmap=27fc xnis=22fb",
  "xodot=2a00 xopf=1d569 xoplus=2a01 xotime=2a02 xrArr=27f9 xrarr=27f6",
  "xscr=1d4cd xsqcup=2a06 xuplus=2a04 xutri=25b3 xvee=22c1 xwedge=22c0",
  "yacute=fd yacy=44f ycirc=177 ycy=44b yen=a5 yfr=1d536 yicy=457",
  "yopf=1d56a yscr=1d4ce yucy=44e yuml=ff zacute=17a zcaron=17e zcy=437",
  "zdot=17c zeetrf=2128 zeta=3b6 zfr=1d537 zhcy=436 zigrarr=21dd zopf=1d56b",
  "zscr=1d4cf zwj=200d zwnj=200c",
].join(" ");
const namedReferences = new Map(
  namedReferenceData.split(" ").map((entry) => {
    const equals = entry.indexOf("=");
    return [
      entry.slice(0, equals),
      String.fromCodePoint(
        ...entry.slice(equals + 1).split(",").map((code) => parseInt(code, 16)),
      ),
    ];
  }),
);
// Numeric reference trong dải C1 không trả về chính code point đó: chuẩn HTML
// thay bằng ký tự windows-1252 tương ứng, và CommonMark dùng đúng phép giải mã
// ấy. Trả thẳng U+0080 thì một đường dẫn viết bằng "&#x80;" không còn trỏ tới
// file thật và một link đúng bị báo hỏng. Bảng ánh xạ theo số chứ không theo ký
// tự, để chính file này không phải chứa U+2014, thứ gate của repo cấm.
const c1Replacements = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);
// marker được chèn ngay trước mỗi ký tự do reference sinh ra, để chỗ gọi phân
// biệt được nó với ký tự viết thẳng: một "_" đến từ "&#95;" là ký tự thật, nó
// không mở được cặp nhấn.
// escapes tắt được vì luật backslash của Markdown chỉ sống trong văn bản
// Markdown. Bên trong giá trị thuộc tính của một thẻ HTML thô, "\" là ký tự dữ
// liệu bình thường: id của <a id="\&amp;"> đúng là "\&" và fragment tới nó là
// "#%5C%26". Áp luật escape ở đó thì gate giữ nguyên "&amp;", dựng ra một id
// không ai có và báo hỏng một link đúng.
const decodeReferences = (text, marker = "", escapes = true) =>
  text.replace(
    /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, name, offset) => {
      // Một "&" bị escape là ký tự literal, không mở được entity.
      if (escapes && markdownEscaped(text, offset)) return whole;
      if (name[0] !== "#") {
        const named = namedReferences.get(name);
        return named === undefined ? whole : marker + named;
      }
      const code = name[1] === "x" || name[1] === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      // Chuẩn thay code point không hợp lệ bằng U+FFFD. Ký tự đó không nằm trong
      // đường dẫn nào của repo nên link vẫn bị báo hỏng, đúng hướng.
      return marker +
        (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
          ? "�"
          : String.fromCodePoint(c1Replacements.get(code) ?? code));
    },
  );
// Dòng mở một khối chen được vào giữa đoạn đang chạy: dòng trống, ATX heading,
// thematic break, setext underline, và list item có nội dung. Blockquote không
// nằm trong danh sách vì "> " ở đầu dòng nối chỉ là chính khối đang mở; cắt ở
// đó sẽ bỏ qua một nhãn link viết trên nhiều dòng trong blockquote và thả một
// destination hỏng qua cổng.
const paragraphInterrupts = [
  /^[ \t]*$/,
  /^ {0,3}#{1,6}(?:[ \t]|$)/,
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  /^ {0,3}(?:=+|-+)[ \t]*$/,
  /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/,
];
function interruptsParagraph(text, newline) {
  const end = text.indexOf("\n", newline + 1);
  const line = text.slice(newline + 1, end === -1 ? text.length : end)
    .replace(/\r$/, "");
  return paragraphInterrupts.some((pattern) => pattern.test(line));
}
const inlineLinkTargets = (text) => scanInline(text).targets;
// Trả về cả cờ "đã nhận một link" để chỗ gọi biết label vừa quét có vô hiệu hóa
// opener bao ngoài hay không.
function scanInline(text) {
  // Regex phẳng \[[^\]]+\]\(...\) không parse được label lồng ngoặc vuông
  // như "[outer [inner]](x)": nó dừng ở ] đầu tiên rồi không khớp tiếp, nên
  // bỏ sót cả link, khiến destination hỏng lọt qua gate. Quét đếm độ sâu để
  // tìm đúng ] đóng label, có tính escape \[ \], rồi mới đọc (destination).
  const targets = [];
  let link = false;
  for (let index = 0; index < text.length; index++) {
    // Thẻ HTML inline là một token nguyên khối với cả vòng quét ngoài, không
    // riêng vòng cân bằng nhãn đang mở. Một dấu "[" nằm trong thuộc tính, như
    // <span title="[sample](missing.md)">, không mở link nào cả; nếu vòng ngoài
    // vẫn dừng ở đó thì destination trong thuộc tính bị đem đi phân giải và một
    // tài liệu đúng bị báo link hỏng.
    if (text[index] === "<" && !markdownEscaped(text, index)) {
      htmlInlineAtomic.lastIndex = index;
      const tag = htmlInlineAtomic.exec(text);
      if (tag) {
        index += tag[0].length - 1;
        continue;
      }
    }
    if (text[index] !== "[" || markdownEscaped(text, index)) continue;
    let depth = 1;
    let cursor = index + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      // Nhãn link không bắc qua ranh giới khối: CommonMark kết thúc đoạn ở dòng
      // trống và cũng ở dòng mở một khối chen được vào giữa đoạn, nên một "["
      // đứng cuối đoạn này và một "](x.md)" bên kia ranh giới là hai chuỗi
      // literal, không phải một link. Quét xuyên qua thì gate đem một
      // destination không ai viết đi phân giải và báo hỏng một tài liệu đúng.
      // Thoát với depth còn dương để nhánh bên dưới bỏ qua cả cụm.
      if (text[cursor] === "\n" && interruptsParagraph(text, cursor)) break;
      if (text[cursor] === "<") {
        htmlInlineAtomic.lastIndex = cursor;
        const tag = htmlInlineAtomic.exec(text);
        if (tag) {
          cursor += tag[0].length;
          continue;
        }
      }
      if (text[cursor] === "[") depth++;
      else if (text[cursor] === "]") depth--;
      cursor++;
    }
    // Label rỗng vẫn là một link sống, y như image ![](...): CommonMark không
    // đòi link text phải khác rỗng, nên bỏ qua "[](x.md)" để lọt một link hỏng
    // qua gate mà không ai hỏi tới destination của nó.
    if (depth !== 0) continue;
    if (text[cursor] !== "(") continue;
    // Tìm dấu ) đóng đúng cặp: bỏ qua ký tự bị escape, ngoặc lồng bên trong
    // destination, và dấu ) nằm trong title được trích dẫn. Title chỉ mở khi
    // dấu nháy đứng sau khoảng trắng, để dấu nháy trong tên file không tính.
    let scan = cursor + 1;
    let parens = 1;
    let quote;
    // Destination dạng <...> là một chuỗi nguyên khối: ngoặc bên trong nó không
    // tham gia cân bằng cặp ngoặc ngoài. Đếm cả ngoặc đó thì "[x](<a(b.md>)"
    // không bao giờ tìm thấy delimiter đóng và cả link biến mất khỏi gate.
    let angle = /^[ \t]*<[^\n]*>/.test(text.slice(cursor + 1));
    while (scan < text.length && parens > 0) {
      const character = text[scan];
      if (character === "\\") {
        scan += 2;
        continue;
      }
      // Destination cũng không bắc qua ranh giới khối: "[literal](" đứng cuối
      // đoạn này và "missing.md)" bên kia dòng trống là hai chuỗi literal, không
      // phải một link. Quét xuyên qua thì cặp ngoặc cân ở một dấu ")" tận đâu và
      // gate đem cả đoạn văn ở giữa đi phân giải như đường dẫn. Thoát với parens
      // còn dương để nhánh bên dưới bỏ qua cả cụm.
      if (character === "\n" && interruptsParagraph(text, scan)) break;
      if (angle) {
        // Dấu > chưa escape đóng destination; xuống dòng thì nó không còn là
        // dạng <...> nữa và phần còn lại cân bằng ngoặc như thường.
        if (character === ">" || character === "\n") angle = false;
        scan++;
        continue;
      }
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (
        (character === '"' || character === "'") &&
        // Chuẩn cho phép đúng một lần xuống dòng giữa destination và title, nên
        // ký tự đứng trước dấu nháy cũng có thể là "\n". Chỉ nhận space và tab
        // thì title mở ngay sau xuống dòng không vào chế độ trích dẫn, một "("
        // trong title bị đếm như ngoặc lồng của destination, cặp ngoặc không
        // bao giờ cân, và cả link hỏng biến mất khỏi gate. Nới ở đây cho khớp
        // với linkDestination, chỗ đã nhận separator xuống dòng.
        /^[ \t\r\n]$/.test(text[scan - 1] ?? "")
      ) {
        quote = character;
      } else if (character === "(") parens++;
      else if (character === ")") parens--;
      scan++;
    }
    if (parens !== 0) continue;
    // Tách destination khỏi title tùy chọn, nếu không title bị ghép vào đường
    // dẫn và bước kiểm tra file sau đó tìm một tên file không tồn tại. Phần
    // không parse được vẫn đẩy vào để bị báo lỗi thay vì im lặng bỏ qua.
    const inside = text.slice(cursor + 1, scan - 1).trim();
    const destination = inside.match(inlineDestination);
    // Trừ khi phần đó bắc qua nhiều dòng: một destination hợp lệ chỉ xuống dòng
    // được đúng một lần, giữa nó và title. Cụm không parse được mà lại nhiều
    // dòng, như "[x](<a" ở đây và "b.md>)" ở dòng dưới, là văn bản literal với
    // mọi renderer; đẩy nó vào gate là đem một chuỗi không ai viết đi phân giải
    // rồi báo hỏng một tài liệu đúng. Cụm một dòng thì giữ nguyên fail-closed,
    // vì ở đó cú pháp sai gần như luôn là một link tác giả gõ hụt.
    if (!destination && /[\r\n]/.test(inside)) continue;
    // Label của một link vẫn chứa được inline khác, thường gặp nhất là image:
    // "[![alt](a.png)](b.md)" render cả hai đích. Nhảy thẳng tới cuối link
    // ngoài thì đích của image bên trong không ai hỏi tới và một ảnh hỏng lọt
    // qua gate. Quét lại riêng phần label; nó ngắn hơn text nên đệ quy dừng.
    const label = scanInline(text.slice(index + 1, cursor - 1));
    const image = text[index - 1] === "!" && !markdownEscaped(text, index - 1);
    // Mô tả của một image render thành văn bản thuần: link viết trong đó không
    // dựng ra thẻ nào và destination của nó không phải đích của ai cả, nên thu
    // nó là đem một chuỗi không được render đi phân giải rồi báo hỏng một tài
    // liệu đúng. Chiều ngược lại vẫn giữ: image nằm trong nhãn của một link vẫn
    // tải ảnh thật, nên chỉ opener image mới bỏ target của nhãn.
    if (!image) targets.push(...label.targets);
    // Link không lồng trong link: khi label đã chứa một link thật, CommonMark
    // vô hiệu hóa opener bên ngoài và "[outer [inner](a.md)](b.md)" render ra
    // link tới a.md rồi "](b.md)" nguyên văn. Đẩy b.md vào gate là đem một
    // destination không ai viết đi phân giải và báo hỏng một tài liệu đúng.
    // Image không bị luật này: label của nó vẫn nằm trong một image sống, nên
    // "[![alt](a.png)](b.md)" giữ nguyên cả hai đích.
    if (image || !label.link) {
      targets.push(
        destination ? destination[1] ?? destination[2] ?? "" : inside,
      );
      if (!image) link = true;
    }
    // Một link nằm sâu trong label của image vẫn là link thật với opener bao
    // ngoài, nên cờ đi ngược lên qua cả image.
    link = link || label.link;
    index = scan - 1;
  }
  return { targets, link };
}
// Section metadata phải cắt từ Markdown cấu trúc. Split thô trên body lấy lần
// xuất hiện đầu tiên của chuỗi heading, kể cả khi nó nằm trong một fence ví dụ
// đứng trước section thật: khi đó cả audit, phụ thuộc, mốc soạn và trạng thái
// đều đọc từ văn bản không render, còn section thật thiếu trường vẫn qua gate.
// Dùng chung structuralSection với các gate khác để một tài liệu chỉ được hiểu
// theo một cách.
const metadataSection = (body) =>
  structuralSection(structuralMarkdown(body), "Trạng thái và mục tiêu");
function auditOf(body) {
  // Lọc trên Markdown cấu trúc: một dòng "Mục audit" nằm trong fence ví dụ hoặc
  // trong HTML comment không phải lần khai thứ hai, nhưng lọc trên body thô lại
  // đếm nó và bác bỏ kế hoạch đúng khuôn.
  const fields = structuralMarkdown(body).split("\n").filter((line) =>
    /^\s*-\s*Mục audit\b/.test(line)
  );
  if (
    fields.length !== 1 ||
    !metadataSection(body).split("\n").includes(fields[0])
  ) return undefined;
  const declaration = fields[0].match(
    /^- Mục audit: ([1-9]|1\d|2[0-2]|Hướng phát triển [1-3]); loại: `([^`]+)`\.$/,
  );
  return declaration ? [declaration[1], declaration[2]] : undefined;
}
// Loại của một mục audit là dữ kiện của bản audit, không phải chuỗi tự do của
// kế hoạch: nhận mọi text trong backtick thì "loại: `banana`" vẫn qua trong khi
// gate tự nhận là đã kiểm đủ ánh xạ audit. Ánh xạ canonical nằm ngay đây chứ
// không nằm trong manifest, vì bytes của manifest đã bị ghim trong snapshot
// provenance của các kế hoạch DONE và thêm một trường vào đó sẽ phá gate ấy.
const auditCategories = new Map([
  ["1", "security"],
  ["7", "tests"],
  ["8", "security"],
  ["18", "perf"],
  ["21", "dx"],
  ["22", "docs"],
  ["Hướng phát triển 1", "direction"],
  ["Hướng phát triển 2", "direction"],
  ["Hướng phát triển 3", "direction"],
]);
const auditCategory = (audit) => auditCategories.get(audit) ?? "bug";
// Đếm số lần khai một trường phải bỏ qua Markdown không render. Một fence ví dụ
// mang đúng khuôn metadata là tài liệu hợp lệ, không phải lần khai thứ hai, nên
// đếm trên body thô sẽ từ chối kế hoạch đúng. Cùng lý do đó, một ví dụ HTML thô
// nhắc "Trạng thái thực thi:" cũng không render thành trường: bỏ block HTML
// trước code, đúng thứ tự structuralMarkdown dùng. Vẫn đếm trên cả tài liệu cấu
// trúc chứ không riêng section metadata, để hai lần khai mâu thuẫn ở hai section
// khác nhau vẫn bị chặn.
const declarations = (body, field) =>
  outsideHtmlComments(
    outsideInlineCode(outsideBlockCode(outsideHtmlBlocks(body))),
  ).split(field).length - 1;
function statusOf(body) {
  if (declarations(body, "Trạng thái thực thi:") !== 1) return undefined;
  return metadataSection(body).match(
    /^- Mốc soạn: `[0-9a-f]{7,40}`, \d{4}-\d{2}-\d{2}\. Trạng thái thực thi: `(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)`\.$/m,
  )?.[1];
}
// Mốc soạn phải đọc từ đúng dòng metadata canonical. Một lần nhắc "Mốc soạn"
// trong văn xuôi đứng trước cũng khớp mẫu tự do và sẽ đứng ra làm mốc đối chiếu
// cho nhãn "(tạo mới)", trong khi trạng thái thực thi vẫn đọc từ metadata thật:
// hai trường cùng một dòng mà lại lấy từ hai chỗ khác nhau. Đòi hỏi duy nhất một
// lần xuất hiện, cùng khuôn với statusOf, để cách khai hai mốc bị chặn hẳn.
function draftingOf(body) {
  if (declarations(body, "Mốc soạn:") !== 1) return undefined;
  return metadataSection(body).match(
    /^- Mốc soạn: `([0-9a-f]{7,40})`, \d{4}-\d{2}-\d{2}\. Trạng thái thực thi: `(?:TODO|IN_PROGRESS|BLOCKED|DONE|STALE)`\.$/m,
  )?.[1];
}
// Một trường lý do trong metadata: đúng một lần khai trong tài liệu cấu trúc,
// nằm đúng mục metadata, giá trị là JSON string không rỗng sau trim.
function metadataReason(body, field) {
  const fields = structuralMarkdown(body).split("\n").filter((line) =>
    new RegExp("^\\s*-\\s*" + field + "\\s*:").test(line)
  );
  if (
    fields.length !== 1 ||
    !metadataSection(body).split("\n").includes(fields[0])
  ) return false;
  const value = fields[0].match(new RegExp("^- " + field + ": (.+)$"))?.[1];
  try {
    const reason = JSON.parse(value ?? "null");
    return typeof reason === "string" && reason.trim().length > 0;
  } catch {
    return false;
  }
}
const staleReason = (body) => metadataReason(body, "stale_reason");
const blockedReason = (body) => metadataReason(body, "blocked_reason");
const statusById = new Map(manifest.map((entry) => {
  const path = resolve(planRoot, entry.file);
  return [
    entry.id,
    existsSync(path) ? statusOf(readFileSync(path, "utf8")) : undefined,
  ];
}));
function exactLines(source, evidence) {
  return source.split("\n").slice(
    evidence.line - 1,
    evidence.line - 1 + evidence.code.split("\n").length,
  ).join("\n") === evidence.code;
}
const objectTypeCache = new Map();
// Loại của một Git object, hoặc undefined khi repository không có object đó.
// Thiếu object và có object sai loại là hai lỗi khác nhau, nên tách ra để nơi
// gọi báo đúng nguyên nhân thay vì gộp thành một thông điệp chung.
function gitObjectType(ref) {
  if (!objectTypeCache.has(ref)) {
    try {
      objectTypeCache.set(
        ref,
        execFileSync("git", ["cat-file", "-t", ref], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
      );
    } catch {
      objectTypeCache.set(ref, undefined);
    }
  }
  return objectTypeCache.get(ref);
}
const treeCache = new Map();
function gitTree(ref) {
  gitReferences.add(ref);
  if (!treeCache.has(ref)) {
    try {
      const options = {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (gitObjectType(ref) !== "commit") {
        throw new Error("Expected a Git commit");
      }
      const output = execFileSync("git", [
        "ls-tree",
        "-r",
        "-t",
        "-z",
        "--full-tree",
        ref,
      ], options);
      treeCache.set(
        ref,
        new Map(
          output.split("\0").filter(Boolean).map((line) => {
            const [header, path] = line.split("\t");
            const [mode, type, oid] = header.split(" ");
            return [path, { mode, type, oid }];
          }),
        ),
      );
    } catch {
      fail("Cannot read Git commit tree: " + ref);
      treeCache.set(ref, undefined);
    }
  }
  return treeCache.get(ref);
}
function canonicalScopePath(path) {
  return typeof path === "string" && path.length > 0 &&
    !path.startsWith("/") && !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") && !path.includes("\0") &&
    !path.split("/").some((part, index, parts) =>
      part.toLowerCase() === ".git" || part === "." || part === ".." ||
      (!part && index !== parts.length - 1)
    );
}
function scopedObject(tree, path) {
  if (!canonicalScopePath(path)) return undefined;
  const object = tree?.get(path.replace(/\/$/, ""));
  const directory = path.endsWith("/");
  return object?.type === (directory ? "tree" : "blob") &&
      (directory || object.mode === "100644" || object.mode === "100755")
    ? object
    : undefined;
}
function blobId(data) {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  return createHash("sha1").update("blob " + bytes.length + "\0")
    .update(bytes).digest("hex");
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}
// Các trường bản duyệt định nghĩa phải trùng nhau giữa báo cáo hiện tại và bản
// ghi bất biến, nếu không verdict và bộ hash có thể bị sửa lệch nhau về sau.
const definitionApprovalFields = [
  "plan_id",
  "definition_review_verdict",
  "definition_commit",
  "definition_plan_blob",
  "definition_manifest_blob",
];
// Bản duyệt định nghĩa phải nằm trong một commit bất biến tự mang verdict và bộ
// hash của chính nó. Nếu chỉ tin verdict APPROVE đọc từ báo cáo hiện tại trong
// working tree, người commit tự cấp được duyệt bằng cách trỏ definition_commit
// vào một commit bất kỳ có đúng bytes plan và manifest mong muốn, vì snapshot
// đối chiếu phía sau chỉ phủ sáu trường thực thi chứ không phủ phần định nghĩa.
function definitionApprovalRecorded(field, entry, ref, blob) {
  const reportPath = "plans/evidence/" + String(entry.id).padStart(3, "0") +
    ".md";
  const record = scopedObject(gitTree(ref), reportPath);
  if (!record || record.oid !== blob) return false;
  const snapshot = evidenceSource(reportPath, ref);
  if (snapshot === undefined || blobId(snapshot) !== blob) return false;
  const recorded = reportFields(snapshot);
  if (recorded("definition_review_verdict") !== "APPROVE") return false;
  return definitionApprovalFields.every((key) =>
    recorded(key) !== undefined && recorded(key) === field(key)
  );
}
function definitionApproved(field, entry, planBody) {
  if (field("definition_review_verdict") !== "APPROVE") return false;
  const ref = field("definition_commit");
  const planBlob = field("definition_plan_blob");
  const manifestBlob = field("definition_manifest_blob");
  const approvalRef = field("definition_approval_commit");
  const approvalBlob = field("definition_approval_blob");
  if (
    ![ref, planBlob, manifestBlob, approvalRef, approvalBlob].every((value) =>
      /^[0-9a-f]{40}$/.test(value ?? "")
    )
  ) {
    return false;
  }
  const tree = gitTree(ref);
  if (!tree) return false;
  if (!definitionApprovalRecorded(field, entry, approvalRef, approvalBlob)) {
    return false;
  }
  const planObject = scopedObject(tree, "plans/" + entry.file);
  const manifestObject = scopedObject(tree, "plans/manifest.json");
  if (
    !planObject || planObject.oid !== planBlob ||
    blobId(planBody) !== planBlob ||
    !manifestObject || manifestObject.oid !== manifestBlob
  ) return false;
  const historical = evidenceSource("plans/manifest.json", ref);
  if (historical === undefined || blobId(historical) !== manifestBlob) {
    return false;
  }
  try {
    const entries = JSON.parse(historical);
    if (!Array.isArray(entries)) return false;
    const matches = entries.filter((candidate) => candidate?.id === entry.id);
    return matches.length === 1 &&
      JSON.stringify(canonicalValue(matches[0])) ===
        JSON.stringify(canonicalValue(entry));
  } catch {
    return false;
  }
}
function reportFields(body) {
  const metadata = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  return (key) => {
    const lines = metadata?.split(/\r?\n/).filter((line) =>
      new RegExp("^\\s*" + key + "\\s*:").test(line)
    );
    return lines?.length === 1
      ? lines[0].match(new RegExp("^" + key + ": (.+)$"))?.[1]
      : undefined;
  };
}
let indexCache;
function trackedArtifacts() {
  if (indexCache !== undefined) return indexCache;
  try {
    const output = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    indexCache = output.split("\0").filter(Boolean).map((line) => {
      const [header, path] = line.split("\t");
      const [mode, oid, stage] = header.split(" ");
      return [path, { mode, oid, stage }];
    });
  } catch {
    fail("Cannot read Git index for completion artifacts");
    indexCache = null;
  }
  return indexCache;
}
// Tập đường dẫn Git thật sự theo dõi, tách sẵn file và thư mục. Một đích chỉ có
// trong cây làm việc không phải artifact của repo: nó không tồn tại ở bản clone
// sạch và link tới nó hỏng với mọi người đọc khác, nhưng existsSync trên máy
// người viết vẫn nói có.
let targetIndex;
function trackedTargets() {
  if (targetIndex !== undefined) return targetIndex;
  const tracked = trackedArtifacts();
  if (!tracked) {
    targetIndex = null;
    return targetIndex;
  }
  const files = new Set(), directories = new Set();
  for (const [name] of tracked) {
    files.add(name);
    const segments = name.split("/");
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  targetIndex = { files, directories };
  return targetIndex;
}
function unchangedArtifacts(path, artifacts) {
  const tracked = trackedArtifacts()?.filter(([name]) =>
    path.endsWith("/") ? name.startsWith(path) : name === path
  );
  if (!tracked || tracked.length !== artifacts.length) return false;
  const expected = new Map(artifacts);
  if (
    !tracked.every(([name, object]) => {
      const approved = expected.get(name);
      return object.stage === "0" && approved?.oid === object.oid &&
        approved.mode === object.mode;
    })
  ) return false;
  // Không nhận file thừa kể cả untracked/ignored; thư mục rỗng không phải Git artifact.
  function files(current) {
    const stat = lstatSync(resolve(repoRoot, current));
    if (!stat.isDirectory()) return [current];
    return readdirSync(resolve(repoRoot, current)).flatMap((name) =>
      files(current.replace(/\/$/, "") + "/" + name)
    );
  }
  try {
    const names = files(path);
    if (!sameSet(names, [...expected.keys()])) return false;
    return names.every((name) => {
      const current = resolve(repoRoot, name);
      const stat = lstatSync(current);
      const object = expected.get(name);
      return stat.isFile() &&
        (stat.mode & 0o111 ? "100755" : "100644") === object.mode &&
        blobId(readFileSync(current)) === object.oid;
    });
  } catch {
    return false;
  }
}
function approved(body, entry, planBody) {
  const field = reportFields(body);
  const id = String(entry.id).padStart(3, "0");
  const validDefinition = definitionApproved(field, entry, planBody);
  if (!validDefinition) {
    fail(entry.file + ": DONE requires approved definition snapshot");
  }
  if (field("review_verdict") !== "APPROVE" || field("plan_id") !== id) {
    return false;
  }
  const reviewed = field("reviewed_commit"),
    completed = field("completed_commit");
  if (![reviewed, completed].every((ref) => /^[0-9a-f]{40}$/.test(ref ?? ""))) {
    return false;
  }
  const reviewTree = gitTree(reviewed), completionTree = gitTree(completed);
  if (!reviewTree || !completionTree) return false;
  const reportPath = "plans/evidence/" + id + ".md";
  for (
    const [tree, key] of [[reviewTree, "reviewed_evidence_blob"], [
      completionTree,
      "completed_evidence_blob",
    ]]
  ) {
    const report = scopedObject(tree, reportPath);
    if (!report || report.oid !== field(key)) return false;
  }
  if (validDefinition) {
    const ref = field("definition_commit");
    const report = scopedObject(gitTree(ref), reportPath);
    const snapshot = report && evidenceSource(reportPath, ref);
    if (snapshot === undefined || !report || blobId(snapshot) !== report.oid) {
      return false;
    }
    const original = reportFields(snapshot);
    for (
      const key of [
        "review_verdict",
        "plan_id",
        "reviewed_commit",
        "completed_commit",
        "reviewed_evidence_blob",
        "completed_evidence_blob",
      ]
    ) {
      if (original(key) === undefined || original(key) !== field(key)) {
        return false;
      }
    }
  }
  for (const path of entry.scope) {
    const before = scopedObject(reviewTree, path),
      after = scopedObject(completionTree, path);
    if (
      !before || !after || before.oid !== after.oid ||
      before.mode !== after.mode
    ) return false;
    if (path.startsWith("plans/")) {
      const artifacts = path.endsWith("/")
        ? [...completionTree].filter(([name, object]) =>
          name.startsWith(path) && object.type === "blob"
        )
        : [[path, after]];
      if (!unchangedArtifacts(path, artifacts)) return false;
    }
  }
  return validDefinition;
}
function planFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return planFiles(path);
    return entry.isFile() && /\.(md|json|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const headings = [
  "Trạng thái và mục tiêu",
  "Hiện trạng và chứng cứ",
  "Quy ước cần giữ",
  "Phạm vi và Git",
  "Lệnh xác minh",
  "Các bước",
  "Kiểm thử",
  "Tiêu chí hoàn tất",
  "Điều kiện dừng",
  "Bảo trì",
];
const ids = new Set(manifest.map((entry) => entry.id));
if (manifest.length !== 25 || ids.size !== 25) {
  fail("Cần đúng 25 kế hoạch với ID duy nhất");
}
for (let id = 1; id <= 25; id++) if (!ids.has(id)) fail(`Thiếu ID ${id}`);
const files = readdirSync(planRoot).filter((name) =>
  /^\d{3}-.*\.md$/.test(name)
);
if (files.length !== 25) fail(`Có ${files.length} file kế hoạch thay vì 25`);
const manifestFiles = new Set();
for (const entry of manifest) {
  if (manifestFiles.has(entry.file)) {
    fail("Duplicate manifest file: " + entry.file);
  }
  manifestFiles.add(entry.file);
  const prefix = entry.file.match(/^(\d{3})-[^/\\]+\.md$/)?.[1];
  if (prefix !== String(entry.id).padStart(3, "0")) {
    fail("Manifest file prefix does not match ID: " + entry.file);
  }
}
for (const file of files) {
  if (!manifestFiles.has(file)) {
    fail("Numbered plan file missing from manifest: " + file);
  }
}
for (const file of manifestFiles) {
  if (!files.includes(file)) {
    fail("Manifest file is not a numbered plan file: " + file);
  }
}
const visiting = new Set();
const visited = new Set();
const order = [];
function visit(id) {
  if (visiting.has(id)) {
    fail(`Chu trình phụ thuộc tại ${id}`);
    return;
  }
  if (visited.has(id)) return;
  const entry = manifest.find((item) => item.id === id);
  if (!entry) {
    fail(`Phụ thuộc không tồn tại: ${id}`);
    return;
  }
  visiting.add(id);
  for (const dependency of entry.depends) visit(dependency);
  visiting.delete(id);
  visited.add(id);
  order.push(id);
}
for (const entry of manifest) {
  visit(entry.id);
  const path = resolve(planRoot, entry.file);
  if (!existsSync(path)) {
    fail(`Thiếu ${entry.file}`);
    continue;
  }
  const body = readFileSync(path, "utf8");
  const dependencyFields = [
    ...metadataSection(body).matchAll(
      /^- Phụ thuộc:[ \t]*(.*)$/gm,
    ),
  ];
  const planDependencies = dependencies(dependencyFields[0]?.[1]);
  if (
    dependencyFields.length !== 1 || !planDependencies ||
    !sameSet(planDependencies, entry.depends)
  ) {
    fail(entry.file + ": plan and manifest dependencies differ");
  }
  const structuralBody = structuralMarkdown(body);
  // Cắt bằng structuralSection chứ không split chuỗi literal: gate heading bắt
  // buộc đã chấp nhận closing marker ATX, nên "## Phạm vi và Git ##" qua được
  // gate đó trong khi split literal trả về rỗng và phạm vi biến mất.
  const scopeBody = structuralSection(structuralBody, "Phạm vi và Git");
  // Cắt tại đúng một khai báo out-of-scope đứng đầu dòng. Split theo chuỗi
  // literal ở bất cứ đâu thì một câu văn xuôi mở đầu có nhắc "Ngoài phạm vi:"
  // cũng cắt, phần scope thật phía sau biến mất và một manifest khai scope rỗng
  // vẫn khớp. Đòi đúng một khai báo, cùng cách declarations() đòi đúng một lần
  // khai trường metadata, để hai khai báo cũng không âm thầm chọn cái đầu.
  const outOfScopeMarkers = [...scopeBody.matchAll(/^ {0,3}Ngoài phạm vi:/gm)];
  if (outOfScopeMarkers.length !== 1) {
    fail(entry.file + ": scope needs exactly one out-of-scope declaration");
  }
  const scopeSection = outOfScopeMarkers.length === 1
    ? scopeBody.slice(0, outOfScopeMarkers[0].index)
    : scopeBody;
  const administrativeFiles = [
    "plans/README.md",
    "plans/evidence/" + String(entry.id).padStart(3, "0") + ".md",
  ];
  const scopeItems = [];
  const bulletStarts = [...scopeSection.matchAll(
    /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+[^\n]*$/gm,
  )];
  // Matcher ngoài chấp nhận thụt lề, nên mẫu kiểm và mẫu trích cũng phải chấp
  // nhận: một bullet thụt một khoảng trắng vẫn là Markdown hợp lệ và render y
  // hệt, nhưng với mẫu đòi "- " ở cột 0 thì nó bị báo malformed rồi kéo theo
  // lệch phạm vi, tức một thay đổi định dạng vô hại chặn cả gate.
  if (
    bulletStarts.some(([line]) => !/^[ \t]*- `[^`\n]+`(?:[ \t]|$)/.test(line))
  ) {
    fail(entry.file + ": malformed scope file bullet");
  }
  for (
    const bullet of scopeSection.matchAll(
      /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+[^\n]*(?:\n[ \t]+(?![-*+][ \t]|\d+[.)][ \t])[^\n]*)*/gm,
    )
  ) {
    const item = bullet[0].match(
      /^[ \t]*- `([^`\n]+)`(\s*\([\s\S]*\))?[ \t]*$/,
    );
    if (!item) {
      fail(entry.file + ": malformed scope file bullet");
    } else if (!administrativeFiles.includes(item[1])) {
      scopeItems.push([item[0], item[1], item[2] ?? ""]);
    }
  }
  const planScope = scopeItems.map((match) => match[1]);
  const planNewFiles = scopeItems.filter((match) =>
    /^\s*\(tạo\s+mới(?:\)|;)/.test(match[2])
  ).map((match) => match[1]);
  for (
    const [label, paths] of [["scope", entry.scope], [
      "newFiles",
      entry.newFiles,
    ]]
  ) {
    for (const scoped of paths) {
      if (!canonicalScopePath(scoped)) {
        fail(
          entry.file + ": invalid repo-relative " + label + " path: " +
            JSON.stringify(scoped),
        );
      }
    }
  }
  if (!sameSet(planScope, entry.scope)) {
    fail(entry.file + ": plan and manifest scope differ");
  }
  if (entry.newFiles.some((file) => !entry.scope.includes(file))) {
    fail(entry.file + ": newFiles contains paths outside scope");
  }
  if (!sameSet(planNewFiles, entry.newFiles)) {
    fail(entry.file + ": plan and manifest new-file classifications differ");
  }
  const structuralHeadings = [
    ...structuralBody.matchAll(/^ {0,3}##[ \t]+([^\r\n]+)\r?$/gm),
  ].map((match) => match[1].replace(/[ \t]+#+[ \t]*$/, "").trim());
  for (const heading of headings) {
    const occurrences = structuralHeadings.filter((name) =>
      name === heading
    ).length;
    if (!occurrences) {
      fail(`${entry.file}: thiếu ${heading}`);
    } else if (occurrences > 1) {
      // Mọi gate section đều cắt ở lần xuất hiện đầu tiên, nên một section
      // trùng tên phía sau hiển thị với người đọc mà không gate nào kiểm: một
      // "## Phạm vi và Git" thứ hai cho phép thêm file ngoài manifest mà vẫn
      // qua. Từ chối bản trùng thay vì gộp, để tài liệu chỉ có một nguồn.
      fail(`${entry.file}: duplicate section ${heading}`);
    }
  }
  const draftingReference = draftingOf(body);
  if (!draftingReference) {
    fail(entry.file + ": missing valid drafting reference");
  } else {
    // Mốc soạn là một tuyên bố về lịch sử, không phải một chuỗi trang trí: nó
    // định nghĩa đường cơ sở mà nhãn "(tạo mới)" đối chiếu. Chỉ kiểm cú pháp
    // hex thì một kế hoạch chưa có file mới nào khai được một mốc không tồn
    // tại, và tới lúc kế hoạch đó thêm file thì đường cơ sở mới vỡ, ở một
    // commit khác hẳn commit đã đưa lời khai vào. Phân giải mọi mốc ngay tại
    // chỗ khai, để lời khai sai hỏng đúng nơi nó được viết.
    gitTree(draftingReference);
  }
  const executionStatus = statusOf(body);
  if (!executionStatus) fail(entry.file + ": missing valid execution status");
  const validStale = executionStatus === "STALE" && staleReason(body);
  if (executionStatus === "STALE" && !validStale) {
    fail(entry.file + ": STALE requires one nonempty stale_reason in metadata");
  }
  // BLOCKED là trạng thái phải trả giá bằng bằng chứng: README đòi ghi lý do,
  // lệnh thất bại và quyết định/quyền còn thiếu. Nếu chỉ đổi hai chữ trong plan
  // và hàng README là qua thì BLOCKED thành chỗ trú cho kế hoạch chưa ai chạm
  // tới. Đòi cùng lúc lý do trong metadata và báo cáo evidence tương ứng: lý do
  // nêu quyết định còn thiếu, báo cáo giữ lệnh và kết quả thật.
  if (executionStatus === "BLOCKED") {
    const id = String(entry.id).padStart(3, "0");
    const blockedPath = resolve(planRoot, "evidence", id + ".md");
    if (!blockedReason(body) || !existsSync(blockedPath)) {
      fail(
        entry.file +
          ": BLOCKED requires one nonempty blocked_reason and an evidence report",
      );
    } else {
      // Sự tồn tại của file không phải bằng chứng: README đòi báo cáo giữ lệnh
      // thất bại và quyết định còn thiếu, nên một file rỗng hay một báo cáo cũ
      // bị xóa ruột vẫn giữ nguyên trạng thái BLOCKED mà không ai trả giá. Ba
      // dấu hiệu này đo được trên văn bản: báo cáo nói đúng kế hoạch nó thuộc
      // về, tự khai trạng thái, và giữ ít nhất một khối lệnh chạy thật. Nội
      // dung văn xuôi thì cổng không phán, đó vẫn là việc của review.
      const report = readFileSync(blockedPath, "utf8");
      const missing = [];
      if (!report.includes(id)) missing.push("the plan id " + id);
      if (!report.includes("BLOCKED")) missing.push("the BLOCKED status");
      if (!/^ {0,3}(?:```|~~~)/m.test(report)) missing.push("a command block");
      if (missing.length) {
        fail(
          "evidence/" + id + ".md: BLOCKED evidence report is missing " +
            missing.join(", "),
        );
      }
    }
  }
  if (executionStatus === "IN_PROGRESS" || executionStatus === "DONE") {
    for (const dependency of entry.depends) {
      if (statusById.get(dependency) !== "DONE") {
        fail(
          entry.file + ": prerequisite " + String(dependency).padStart(3, "0") +
            " must be DONE",
        );
      }
    }
  }
  if (executionStatus === "DONE") {
    // Đọc từ structuralBody (đã xóa nội dung trong fenced/indented code) để một
    // checklist mẫu nằm trong khối code không tự đứng ra làm bằng chứng hoàn tất.
    const completion = structuralSection(structuralBody, "Tiêu chí hoàn tất");
    const items = [
      ...completion.matchAll(
        /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]+\S/gm,
      ),
    ];
    if (!items.length) {
      fail(entry.file + ": DONE requires a completion checklist");
    }
    if (items.some((item) => item[1] === " ")) {
      fail(entry.file + ": DONE has unchecked completion criteria");
    }
    const evidencePath = resolve(
      planRoot,
      "evidence",
      String(entry.id).padStart(3, "0") + ".md",
    );
    if (
      !existsSync(evidencePath) ||
      !approved(readFileSync(evidencePath, "utf8"), entry, body)
    ) {
      fail(entry.file + ": DONE requires reviewer approval evidence");
    }
  }
  // Chỉ đếm trong section "Các bước": nếu đếm cả tài liệu thì một bước nằm ở
  // section khác (ví dụ "Bảo trì") vẫn tính vào hạn mức và section bước thật sự
  // có thể rỗng mà vẫn qua cổng.
  const structuralText = outsideInlineCode(
    structuralSection(structuralBody, "Các bước"),
  );
  // Đếm suông không phân biệt được bước trùng số với bước thiếu: hai "Bước 1"
  // và không có "Bước 2" vẫn ra đúng hạn mức. Đòi dãy số đọc được đúng bằng
  // 1..N theo thứ tự xuất hiện, để một bước bị nhân đôi hoặc bỏ sót lộ ra.
  // So tổng số marker với tổng số bước cũng chưa đủ: một bước mất gate còn bước
  // kế mang hai gate vẫn ra đúng tổng. Cắt section theo heading bước rồi đòi
  // đúng một marker sống trong thân của từng bước, và không marker nào đứng
  // trước bước đầu tiên.
  const stepParts = structuralText.split(/^ {0,3}### Bước (\d+):/gm);
  const checkMarker = /^ {0,3}\*\*Kiểm tra:\*\*(?=\s|$)/gm;
  const countChecks = (text) => [...text.matchAll(checkMarker)].length;
  const stepNumbers = [];
  const stepChecks = [];
  for (let index = 1; index < stepParts.length; index += 2) {
    stepNumbers.push(Number(stepParts[index]));
    stepChecks.push(countChecks(stepParts[index + 1]));
  }
  if (
    stepNumbers.length < 2 || countChecks(stepParts[0]) !== 0 ||
    stepNumbers.some((number, index) => number !== index + 1) ||
    stepChecks.some((count) => count !== 1)
  ) {
    fail(`${entry.file}: bước/gate không khớp`);
  }
  if (entry.id <= 22 && entry.audit !== String(entry.id)) {
    fail(`${entry.file}: sai ánh xạ audit`);
  }
  if (entry.id > 22 && entry.audit !== `Hướng phát triển ${entry.id - 22}`) {
    fail(`${entry.file}: sai hướng phát triển`);
  }
  const [planAudit, planCategory] = auditOf(body) ?? [];
  if (planAudit !== entry.audit) {
    fail(entry.file + ": plan and manifest audit mappings differ");
  } else if (planCategory !== auditCategory(entry.audit)) {
    fail(entry.file + ": plan audit category differs from the audit mapping");
  }
  for (const scoped of entry.scope) {
    if (!canonicalScopePath(scoped)) continue;
    const dependencyCreates = (id, seen = new Set()) => {
      if (seen.has(id)) return false;
      seen.add(id);
      const dependency = manifest.find((item) => item.id === id);
      return dependency &&
        (dependency.newFiles.includes(scoped) ||
          dependency.depends.some((next) => dependencyCreates(next, seen)));
    };
    if (entry.newFiles.includes(scoped)) {
      // Nhãn "(tạo mới)" phải đúng ở mốc soạn của chính kế hoạch: nếu file đã có
      // sẵn từ trước thì đây là sửa file cũ bị khai nhầm, và mọi kiểm tra tracked
      // /tồn tại/đúng kiểu bên dưới đều bị nhãn này miễn trừ.
      const baseline = draftingReference && gitTree(draftingReference);
      if (baseline && scopedObject(baseline, scoped)) {
        fail(
          entry.file + ": new file already exists at the drafting reference: " +
            scoped,
        );
      }
    } else if (!entry.depends.some((id) => dependencyCreates(id))) {
      if (!scopedObject(gitTree("HEAD"), scoped)) {
        fail(entry.file + ": existing scope is not tracked: " + scoped);
      }
      const current = resolve(repoRoot, scoped);
      if (!existsSync(current)) {
        fail(entry.file + ": existing scope is missing: " + scoped);
      } else {
        const stat = lstatSync(current);
        if (!(scoped.endsWith("/") ? stat.isDirectory() : stat.isFile())) {
          fail(entry.file + ": existing scope type mismatch: " + scoped);
        }
      }
    }
  }
  const blocks = [];
  // Chỉ annotation sống được mở block; snippet và vị trí citation vẫn đọc body gốc.
  // Quét theo span comment thay vì tìm thẳng chuỗi annotation: khi một "<!--" mở
  // trước đó, chính "-->" của annotation đóng comment ngoài, nên cả citation lẫn
  // annotation đều không render. Tìm thẳng chuỗi thì block vẫn được mở từ một
  // annotation đã bị ẩn và trích đoạn coi như có mặt. Span của một annotation
  // sống bắt đầu đúng ở nó, còn annotation bị bọc nằm giữa một span mở sớm hơn.
  // Bỏ cả block HTML, giữ nguyên offset: một hồ sơ chứng cứ bọc trong
  // <script type="text/plain"> không render trích đoạn nào, nhưng nếu annotation
  // trong đó vẫn được coi là sống thì kế hoạch không hiển thị trích đoạn nào vẫn
  // qua gate đối chiếu nguyên văn. Chạy trước outsideFencedCode để block mở
  // trước nuốt luôn fence bên trong nó, đúng thứ tự của CommonMark.
  const scanned = outsideFencedCode(outsideHtmlBlocks(body, true), true);
  for (const annotation of scanned.matchAll(htmlComment)) {
    if (
      !/^<!-- evidence: [^\n]+ -->$/.test(annotation[0]) ||
      markdownEscaped(scanned, annotation.index)
    ) continue;
    // Đọc trọn delimiter mở rồi đòi delimiter đóng cùng ký tự và dài ít nhất
    // bằng nó. Ghim cứng ba backtick thì backtick thứ tư của một fence dài hơn
    // rơi vào group ngôn ngữ, biến "````CONTRIBUTING" thành lang
    // "`CONTRIBUTING"; đòi đóng dài đúng bằng mở thì một fence đóng dài hơn,
    // vốn hợp lệ trong CommonMark, lại không được nhận.
    // Ký tự xuống dòng của chính fence có thể là CRLF: "\r" không thuộc info
    // string, nên gộp vào thì lang đọc ra "text\r" và một fence đúng bị báo lệch
    // ngôn ngữ. Chỉ nới ở ba dòng biên của fence; thân trích đoạn vẫn so nguyên
    // byte, vì chênh lệch ký tự xuống dòng giữa trích đoạn và nguồn là chênh
    // lệch thật, không phải chuyện định dạng.
    const block = body.slice(annotation.index).match(
      /^<!-- evidence: ([^\n]+) -->\s*(?:<!-- deno-fmt-ignore -->\s*)?(`{3,})([^\n\r]*)\r?\n([\s\S]*?)\r?\n\2`*[ \t]*(?:\r?\n|$)/,
    );
    if (block) {
      block.index = annotation.index;
      blocks.push(block);
    }
  }
  // Phép so số lượng thoả mãn được một cách rỗng nghĩa: xóa hết annotation rồi
  // khai evidence rỗng trong manifest thì 0 === 0, và kế hoạch mất luôn kiểm
  // drift với source hiện tại. Một kế hoạch không dẫn được dòng source nào thì
  // không có hiện trạng để đối chiếu, nên đòi ít nhất một record.
  if (entry.evidence.length === 0) {
    fail(entry.file + ": requires at least one evidence record");
  }
  if (blocks.length !== entry.evidence.length) {
    fail(entry.file + ": evidence excerpt count mismatch");
  }
  for (const [index, evidence] of entry.evidence.entries()) {
    if (!/^[0-9a-f]{40}$/.test(evidence.sourceRef ?? "")) {
      fail(entry.file + ": evidence requires a valid sourceRef");
      continue;
    }
    // "git show <ref>:<path>" đọc được cả tree, nên một sourceRef trỏ vào tree
    // vẫn khớp trích dẫn mà không neo vào lịch sử nào cả. Object thiếu hẳn thì
    // để evidenceSource báo, ở đây chỉ chặn object có thật nhưng sai loại.
    const sourceType = gitObjectType(evidence.sourceRef);
    if (sourceType !== undefined && sourceType !== "commit") {
      fail(
        entry.file + ": evidence sourceRef must be a commit: " +
          evidence.sourceRef,
      );
      continue;
    }
    if (
      !Number.isInteger(evidence.line) || evidence.line < 1 ||
      typeof evidence.code !== "string" || !evidence.code.length
    ) {
      fail(entry.file + ": invalid evidence line or code");
      continue;
    }
    const source = evidenceSource(evidence.path, evidence.sourceRef);
    if (source === undefined) continue;
    if (!exactLines(source, evidence)) {
      fail(
        entry.file + ": historical source mismatch " + evidence.sourceRef +
          ":" + evidence.path + ":" + evidence.line,
      );
    }
    if (executionStatus !== "DONE" && !validStale) {
      const currentPath = resolve(repoRoot, evidence.path);
      if (
        !existsSync(currentPath) ||
        !exactLines(readFileSync(currentPath, "utf8"), evidence)
      ) {
        fail(
          entry.file + ": current source drift " + evidence.path + ":" +
            evidence.line,
        );
      }
    }
    const block = blocks[index];
    const citation = block && body.slice(0, block.index).trimEnd()
      .split(/\r?\n/).at(-1)?.trim();
    if (citation !== `\`${evidence.path}:${evidence.line}\`:`) {
      fail(
        entry.file + ": missing adjacent evidence line citation " +
          evidence.path + ":" + evidence.line,
      );
    }
    if (!block || block[1] !== evidence.path || block[4] !== evidence.code) {
      fail(entry.file + ": excerpt mismatch " + evidence.path);
    }
    if (
      Object.hasOwn(evidence, "lang") &&
      (typeof evidence.lang !== "string" || block?.[3] !== evidence.lang)
    ) {
      fail(entry.file + ": evidence language mismatch " + evidence.path);
    }
  }
}
// Filesystem trên macOS và Windows không phân biệt hoa thường, nên existsSync
// trả true cho "plans/readme.md" trong khi bản clone trên Linux và trình duyệt
// repo chỉ có "plans/README.md": gate xanh trên máy dev còn link thì hỏng ở mọi
// nơi khác. realpathSync không cứu được, đã đo trên macOS nó trả lại đúng chuỗi
// hoa thường được đưa vào chứ không chuẩn hóa theo tên thật. Vì vậy so từng
// thành phần đường dẫn với đúng tên trong thư mục cha. Kết quả readdirSync được
// nhớ lại vì mỗi thư mục bị hỏi nhiều lần trên cùng một lần chạy.
const directoryNames = new Map();
function existsCaseExact(root, parts) {
  let current = root;
  for (const part of parts) {
    // resolve() đã rút gọn "." và ".." trước khi tới đây; nhánh này chỉ để một
    // đường dẫn có thành phần rỗng không bị hỏi tên trong thư mục cha.
    if (part === "" || part === ".") continue;
    let names = directoryNames.get(current);
    if (!names) {
      try {
        names = new Set(readdirSync(current));
      } catch {
        return false;
      }
      directoryNames.set(current, names);
    }
    if (!names.has(part)) return false;
    current = resolve(current, part);
  }
  return true;
}
// Anchor của một tài liệu Markdown gồm slug của mọi heading cộng mọi id hay
// name khai tay trong HTML thô. GitHub dựng slug bằng cách hạ hoa thường, bỏ
// ký tự không phải chữ, số, gạch dưới, khoảng trắng hay gạch nối, rồi đổi
// khoảng trắng thành gạch nối; heading trùng slug nhận hậu tố -1, -2 theo thứ
// tự xuất hiện.
const headingSlug = (text) =>
  text.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_ -]+/gu, "")
    .replace(/ /g, "-");
// Inline markup không vào slug vì GitHub lấy phần văn bản đã render: gỡ code
// span, nhãn link, thẻ HTML và backslash escape trước khi tính. Character
// reference cũng render thành ký tự thật, nên "## Probe &amp; heading" có
// anchor dựng từ "Probe & heading"; để nguyên tên entity thì slug ghi nhận
// "probe-amp-heading", một id không tồn tại, và link tới anchor thật bị báo
// hỏng trong khi link tới id tưởng tượng lại qua cổng. Giải mã trước khi gỡ
// backslash escape, vì chính decodeReferences dựa vào dấu escape còn nguyên để
// biết một "&" đã bị vô hiệu. Nhưng nội dung code span render nguyên văn: trong
// "## Probe `&amp;` code" thì "&amp;" là năm ký tự thật và id GitHub sinh ra là
// "probe-amp-code". Giải mã cả phần đó thì slug thành "probe--code" và mọi link
// tới heading có entity trong backtick bị báo hỏng, nên chỉ phần ngoài span mới
// đi qua decode, gỡ nhãn link, gỡ thẻ và gỡ escape.
// Autolink không phải thẻ: "## See <https://example.com>" render ra một link mà
// văn bản hiển thị chính là URL, nên id GitHub sinh ra là "see-httpsexamplecom".
// Gỡ nó như gỡ thẻ thì slug chỉ còn "see-" và mọi link tới heading có autolink
// bị báo hỏng, nên giữ lại phần trong dấu ngoặc trước khi gỡ thẻ thật.
const autolinkText = new RegExp(
  "<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^ \\t\\r\\n<>]*" +
    "|[^ \\t\\r\\n<>@]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?" +
    "(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>",
  "g",
);
// Reference link chỉ render thành văn bản nhãn khi label của nó có định nghĩa.
// "## [Ghost][undefined-ref]" không có "[undefined-ref]:" nào thì render nguyên
// văn cả cụm và id GitHub sinh ra là "ghostundefined-ref"; thu gọn vô điều kiện
// ghi "ghost", tức vừa nhận một link tới anchor không tồn tại vừa báo hỏng link
// tới anchor thật. Label rỗng của dạng collapsed thì thu gọn kiểu nào cũng ra
// một slug, nên không cần hỏi định nghĩa.
// Hai nhãn bằng nhau sau case folding của Unicode là một nhãn: "[Σ]" định nghĩa
// và "[ς]" tham chiếu cùng một link, vì sigma cuối từ gấp về cùng một ký tự với
// sigma thường. Chỉ hạ chữ thường thì "σ" và "ς" khác nhau, một reference link
// thật bị đọc thành văn bản literal, và slug của heading chứa nó sai theo. Hạ
// rồi nâng là đúng công thức normalizeReference của commonmark.js, thứ đang làm
// trọng tài cho mọi tranh chấp CommonMark ở đây.
const referenceLabel = (raw) =>
  raw.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase();
// Dấu nhấn không để lại ký tự nào trong văn bản render: "## _Emphasized_ probe"
// ra "Emphasized probe" và id GitHub là "emphasized-probe". Dấu sao đã tự biến
// mất vì headingSlug xóa mọi ký tự ngoài chữ, số, "_", " " và "-", nhưng gạch
// dưới thì được giữ lại, nên nếu không gỡ cặp mở đóng thì slug thành
// "_emphasized_-probe" và mọi link tới heading có nhấn bị báo hỏng. Gạch dưới
// giữa từ là ký tự thật và GitHub giữ nguyên, nên chỉ cặp mở ở ranh giới từ mới
// bị gỡ: "snake_case" đi qua nguyên vẹn. Lặp cho tới khi ổn định để cặp lồng
// kiểu "__strong _inner_ tail__" rụng hết.
// Gạch dưới sinh ra từ backslash escape, từ character reference hay từ nội dung
// code span là ký tự thật chứ không phải delimiter, nên chúng đi kèm một dấu
// NUL che phía trước và cả hai đầu của cặp nhấn đều từ chối dấu đó.
const underscoreEmphasis =
  /(?<![\p{L}\p{N}_\0])(__?)(?=\S)([\s\S]*?\S)(?<!\0)\1(?![\p{L}\p{N}_])/gu;
function stripUnderscoreEmphasis(text) {
  for (;;) {
    const stripped = text.replace(underscoreEmphasis, "$2");
    if (stripped === text) return text;
    text = stripped;
  }
}
// Một code span mở bằng run backtick nào thì chỉ đóng bằng run dài đúng bằng
// nó. Cắt bằng /(`+[^`]*`+)/ thì hai run lệch độ dài vẫn bị ghép thành span:
// trong "A `x &amp;`` B" chuẩn không thấy code span nào, "&amp;" giải mã thành
// "&" và slug thật là "a-x--b", nhưng cách cắt cũ giữ nguyên văn và ghi
// "a-x-amp-b", tức link tới heading thật bị báo hỏng còn link tới slug không
// tồn tại lại qua cổng. Trả về mảng xen kẽ: chỉ số chẵn là văn bản thường, chỉ
// số lẻ là nội dung span đã bỏ backtick bao ngoài.
// Nội dung một code span không render nguyên xi: mọi xuống dòng trong đó thành
// khoảng trắng, và khi cả hai đầu là khoảng trắng mà phần giữa không rỗng thì
// chuẩn bỏ đúng một ký tự mỗi đầu. Đệm đó tồn tại để viết được span chứa chính
// dấu backtick, nên giữ nó lại là ghi thừa hai gạch nối vào slug: "## A ` foo `
// B" có id thật là "a-foo-b" và link tới nó bị báo hỏng.
const codeSpanContent = (raw) => {
  const flat = raw.replace(/\r\n|[\r\n]/g, " ");
  return flat.length > 2 && flat.startsWith(" ") && flat.endsWith(" ") &&
      flat.trim()
    ? flat.slice(1, -1)
    : flat;
};
function splitCodeSpans(text) {
  const parts = [];
  let plain = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "`" || markdownEscaped(text, index)) {
      plain += text[index];
      continue;
    }
    const opener = index;
    while (text[index + 1] === "`") index++;
    const run = index - opener + 1;
    let closer = -1;
    for (let scan = index + 1; scan < text.length; scan++) {
      if (text[scan] !== "`") continue;
      const start = scan;
      while (text[scan + 1] === "`") scan++;
      if (scan - start + 1 === run) {
        closer = start;
        break;
      }
    }
    // Run không có bạn cùng độ dài thì nó là backtick literal.
    if (closer === -1) {
      plain += text.slice(opener, index + 1);
      continue;
    }
    parts.push(plain, codeSpanContent(text.slice(index + 1, closer)));
    plain = "";
    index = closer + run - 1;
  }
  parts.push(plain);
  return parts;
}
// Vị trí dấu "]" đóng đúng cặp với dấu "[" ở open, hoặc -1 khi không có. Đếm
// độ sâu vì nhãn lồng được, bỏ qua ký tự escape, và nhảy qua nguyên thẻ HTML
// inline vì dấu "]" trong giá trị thuộc tính không đóng nhãn nào.
function matchingBracket(text, open) {
  let depth = 1;
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "<") {
      htmlInlineAtomic.lastIndex = index;
      const tag = htmlInlineAtomic.exec(text);
      if (tag) {
        index += tag[0].length - 1;
        continue;
      }
    }
    if (text[index] === "[") depth++;
    else if (text[index] === "]" && --depth === 0) return index;
  }
  return -1;
}
// Phần đuôi ngay sau nhãn quyết định cụm có render thành link hay không: trả về
// vị trí ngay sau đuôi nếu có, -1 nếu cụm chỉ là văn bản trong ngoặc vuông.
// Cặp ngoặc cân bằng chưa đủ để cụm thành link: nội dung giữa hai ngoặc còn
// phải là destination hợp lệ. Trong "## [Ghost](https://example.com bad)" cái
// đích trần chứa khoảng trắng nên chuẩn render cả đuôi ra văn bản literal và
// heading không mang id "ghost". Gỡ đuôi vô điều kiện thì slug ghi "ghost",
// đường quét target lại bỏ qua chính chuỗi đó vì trông như scheme ngoài, và một
// link tới anchor không tồn tại đi trọn qua cổng.
function linkTail(text, position, definitions) {
  if (text[position] === "(") {
    let depth = 1;
    for (let index = position + 1; index < text.length; index++) {
      if (text[index] === "\\") {
        index++;
        continue;
      }
      if (text[index] === "(") depth++;
      else if (text[index] === ")" && --depth === 0) {
        return inlineDestination.test(text.slice(position + 1, index).trim())
          ? index + 1
          : -1;
      }
    }
    return -1;
  }
  if (text[position] !== "[") return -1;
  const close = matchingBracket(text, position);
  if (close === -1) return -1;
  const label = text.slice(position + 1, close);
  return !label.trim() || definitions.has(referenceLabel(label))
    ? close + 1
    : -1;
}
// Link render ra đúng phần nhãn của nó, nên slug lấy nhãn và bỏ destination.
// Regex phẳng /!?\[([^\]]*)\]\([^)]*\)/ dừng ở dấu "]" đầu tiên nên nhãn lồng
// ngoặc như "[Outer [inner]](x.md)" không khớp gì cả: cả cụm đi nguyên văn vào
// slug, ghi "outer-innerxmd" thay vì "outer-inner", và mọi link tới heading đó
// bị báo hỏng. Quét cân bằng độ sâu, rồi đệ quy vào chính nhãn vì image lồng
// trong link được và nhãn của nó cũng render ra văn bản.
function stripHeadingLinks(text, definitions) {
  let output = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "<" && !markdownEscaped(text, index)) {
      htmlInlineAtomic.lastIndex = index;
      const tag = htmlInlineAtomic.exec(text);
      if (tag) {
        output += tag[0];
        index += tag[0].length - 1;
        continue;
      }
    }
    const image = character === "!" && !markdownEscaped(text, index) &&
      text[index + 1] === "[";
    const open = image ? index + 1 : index;
    if (text[open] !== "[" || markdownEscaped(text, open)) {
      output += character;
      continue;
    }
    const close = matchingBracket(text, open);
    const tail = close === -1 ? -1 : linkTail(text, close + 1, definitions);
    // Không có đuôi thì cụm là văn bản thường; ghi đúng một ký tự rồi đi tiếp để
    // link nằm bên trong ngoặc vẫn được thu gọn ở vòng sau.
    if (tail === -1) {
      output += character;
      continue;
    }
    output += stripHeadingLinks(text.slice(open + 1, close), definitions);
    index = tail - 1;
  }
  return output;
}
// Thẻ HTML inline không để lại ký tự nào trong văn bản render. Xóa bằng
// /<[^>]*>/ thì thẻ có dấu ">" trong giá trị thuộc tính bị cắt ngay tại đó và
// phần đuôi của chính thẻ rơi vào slug: "<span title=">Ghost">B</span>" để lại
// "Ghost"B" và heading nhận một id không ai có. Dùng chính mẫu nguyên khối đã
// dùng ở đường quét inline.
function stripInlineHtml(text) {
  let output = "";
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "<" && !markdownEscaped(text, index)) {
      htmlInlineAtomic.lastIndex = index;
      const tag = htmlInlineAtomic.exec(text);
      if (tag) {
        index += tag[0].length - 1;
        continue;
      }
    }
    output += text[index];
  }
  return output;
}
const headingText = (raw, definitions) =>
  stripUnderscoreEmphasis(
    splitCodeSpans(raw).map((part, index) =>
      // Nội dung code span render nguyên văn: gạch dưới trong đó là ký tự thật,
      // không phải delimiter của cặp nhấn bao quanh span.
      index % 2 ? part.replaceAll("_", "\0_") : decodeReferences(
        stripInlineHtml(
          stripHeadingLinks(part, definitions).replace(autolinkText, "$1"),
        ),
        "\0",
      ).replace(/\\([!-/:-@[-`{-~])/g, "\0$1")
    ).join(""),
  ).replaceAll("\0", "");
// Blockquote và list item chỉ đặt tiền tố lên đầu dòng chứ không đổi bản chất
// khối bên trong: "> ## Ghi chú" vẫn render ra một heading và vẫn sinh id trên
// GitHub. Đọc nguyên dòng thì heading đó vắng mặt trong tập anchor và một link
// đúng bị báo hỏng. Gỡ lặp vì container lồng được; một thematic break kiểu
// "- - -" gỡ hết thành dòng rỗng nên không hóa thành setext underline giả.
// Nhánh khoảng trắng sau list marker chép đúng luật thụt của CommonMark: từ một
// tới bốn khoảng trắng thì nội dung bắt đầu ngay sau chúng, còn từ năm trở lên
// thì chỉ một khoảng trắng thuộc về marker và phần dư là indented code. Gỡ hết
// khoảng trắng sẽ biến "-     ## X" thành heading giả và cho một link tới anchor
// không tồn tại đi qua cổng.
const containerPrefix =
  /^ {0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])(?:[ \t]{1,4}(?![ \t])|[ \t](?=[ \t])|$))/;
// Container mở ra ở một dòng còn hiệu lực cho những dòng sau nó: nội dung của
// một list item nằm ở cột ngay sau marker, nên "123. item" rồi một dòng thụt
// năm khoảng trắng mang "## X" vẫn là heading thật bên trong item. Gỡ container
// theo từng dòng rời rạc thì dòng nối đó còn nguyên thụt, bị đọc thành indented
// code, và một link đúng tới heading bị báo hỏng. Quét tuần tự cả tài liệu và
// giữ ngăn xếp container đang mở, để dòng nối được gỡ đúng phần thụt kế thừa.
// Mỗi dòng trả về văn bản đã gỡ, độ sâu container của nó, và việc dòng đó có tự
// mở container mới hay không; nhánh setext cần cả ba để biết hai dòng có nằm
// trong cùng một khối hay không.
// Tab đưa con trỏ tới mốc bốn cột kế tiếp, nên thụt phải đo bằng cột chứ không
// bằng số ký tự: "1.\ttab item" đặt nội dung ở cột bốn và một dòng nối thụt
// đúng một tab vẫn nằm trong item. Đếm ký tự thì dòng nối đó chỉ được một cột,
// bị đẩy ra khỏi item, và một heading thật trong item vắng mặt khỏi tập anchor.
function columnsOf(text) {
  let column = 0;
  for (const character of text) {
    column += character === "\t" ? 4 - column % 4 : 1;
  }
  return column;
}
// Khai báo dạng function để các đường quét đứng trước trong file gọi được:
// gate trạng thái chạy ngay lúc module khởi tạo, sớm hơn mọi hằng ở đây.
function indentColumns(text) {
  return columnsOf(text.match(/^[ \t]*/)[0]);
}
// Ăn đúng want cột thụt ở đầu dòng. Một tab bắc qua mốc thì phần dư ở lại dưới
// dạng khoảng trắng, đúng như chuẩn mô tả khi tab bị cắt giữa chừng.
function consumeColumns(text, want) {
  let column = 0;
  let index = 0;
  while (index < text.length && column < want) {
    if (text[index] === " ") column++;
    else if (text[index] === "\t") column += 4 - column % 4;
    else break;
    index++;
  }
  return " ".repeat(Math.max(0, column - want)) + text.slice(index);
}
// Một list chỉ ngắt được đoạn văn đang chạy khi item đầu có nội dung và, với
// list đánh số, khi số bắt đầu là 1. "Paragraph" rồi "2. ## Ghost" vì thế vẫn
// là hai dòng của một đoạn văn: dấu chấm ở đó là văn bản literal và không có
// heading nào. Gỡ tiền tố vô điều kiện thì "## Ghost" hóa thành heading thật,
// documentAnchors ghi một id không renderer nào dựng, và link tới nó qua cổng.
function interruptingListMarker(marker, rest) {
  if (!rest.trim()) return false;
  const ordered = marker.match(/(\d{1,9})[.)]/);
  return !ordered || Number(ordered[1]) === 1;
}
function scanContainers(rawLines) {
  const open = [];
  let paragraphOpen = false;
  let paragraphDepth = 0;
  return rawLines.map((line) => {
    let rest = line.replace(/\r$/, "");
    let matched = 0;
    while (matched < open.length) {
      const container = open[matched];
      // Blockquote đòi marker trên mọi dòng, list item chỉ đòi đủ thụt.
      if (container.indent === null) {
        const quote = rest.match(/^ {0,3}>[ \t]?/);
        if (!quote) break;
        rest = rest.slice(quote[0].length);
      } else {
        if (!rest.trim()) break;
        if (indentColumns(rest) < container.indent) break;
        rest = consumeColumns(rest, container.indent);
      }
      matched++;
    }
    // Dòng trống không đóng container nào, nó chỉ không mang thụt để đo, nên
    // ngăn xếp phải sống qua khoảng trống giữa hai khối của cùng một item.
    if (!rest.trim()) {
      paragraphOpen = false;
      return { text: "", depth: matched, opened: false };
    }
    open.length = matched;
    let opened = false;
    for (;;) {
      const prefix = rest.match(containerPrefix);
      if (!prefix) break;
      // Luật ngắt đoạn chỉ ràng buộc list, và chỉ ở đúng khối đang chạy: thoát
      // ra khỏi container là đã đóng đoạn bên trong, còn blockquote ngắt được
      // mọi lúc. Container ngoài vừa mở cũng đóng đoạn cũ, nên từ vòng thứ hai
      // trở đi không hỏi lại.
      if (
        !opened && paragraphOpen && matched === paragraphDepth &&
        !/^ {0,3}>/.test(prefix[0]) &&
        !interruptingListMarker(prefix[0], rest.slice(prefix[0].length))
      ) break;
      open.push({
        indent: /^ {0,3}>/.test(prefix[0]) ? null : columnsOf(prefix[0]),
      });
      rest = rest.slice(prefix[0].length);
      opened = true;
    }
    const entry = { text: rest, depth: open.length, opened };
    paragraphOpen = Boolean(paragraphText(entry));
    paragraphDepth = open.length;
    return entry;
  });
}
// Một dòng chỉ góp vào heading setext khi nó là văn bản đoạn thường: heading
// ATX, hàng gạch của đoạn trước và thematic break đều kết thúc đoạn.
function paragraphText(entry) {
  return entry.text.trim() && !/^ {0,3}#/.test(entry.text) &&
    !/^ {0,3}(?:=+|-+)[ \t]*$/.test(entry.text) &&
    !/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(entry.text);
}
// Nhãn của một reference definition, dừng ở dấu "]" chưa escape nên không ăn
// sang chuỗi "]:" nằm trong title. "[^label]:" là footnote definition của GFM,
// phần sau dấu hai chấm là văn xuôi chứ không phải destination, nên đem đi khớp
// linkDestination sẽ bác bỏ một chú thích đúng chuẩn. Nhãn được phép bắc qua
// nhiều dòng: "[multi\nline]: dest" định nghĩa nhãn "multi line" và một link
// "[text][multi line]" phía dưới trỏ đích thật, nên lớp ký tự của nhãn không
// cấm xuống dòng; cấm thì cả definition lẫn đích của nó vắng mặt khỏi gate và
// một đích hỏng đi qua. Dấu hai chấm và destination vẫn phải nằm trên dòng cuối
// của cụm, còn dòng trống thì cắt đứt nhãn vì nó kết thúc đoạn.
const definitionHead =
  /^ {0,3}\[(?!\^)((?:\\[^\r\n]|[^\[\]\\])+)\]:[ \t]*([^\r\n]*)$/;
// Chuẩn giới hạn nhãn ở 999 ký tự, nên một dấu "[" mở ra ở đầu một đoạn văn dài
// không kéo cả đoạn vào một phép thử vô tận.
const definitionLabelLimit = 999;
// Cụm definition bắt đầu ở dòng start, nối thêm dòng chừng nào chúng còn là văn
// bản của cùng khối. Trả về nhãn, destination trên dòng cuối, và chính dòng
// cuối đó; null khi cụm không phải definition.
function definitionAt(lines, start) {
  const depth = lines[start].depth;
  let candidate = lines[start].text;
  for (let line = start;; line++) {
    if (line > start) {
      const next = lines[line];
      if (
        !next || next.opened || next.depth !== depth || !paragraphText(next)
      ) return null;
      candidate += "\n" + next.text;
    }
    const head = candidate.match(definitionHead);
    if (head) {
      // Nhãn dài quá giới hạn thì cả cụm là văn bản literal, không phải
      // definition: nhận nó là đem một đích không ai render đi phân giải rồi
      // báo hỏng một tài liệu đúng. Đo chính nhãn đã bắt được, chứ không đo cả
      // dòng, vì giới hạn của chuẩn nói về nội dung giữa hai dấu ngoặc.
      return head[1].length > definitionLabelLimit
        ? null
        : { label: head[1], destination: head[2], line };
    }
    if (!/^ {0,3}\[(?!\^)/.test(lines[start].text)) return null;
    if (candidate.length > definitionLabelLimit) return null;
  }
}
// Definition không ngắt được đoạn đang chạy: "Ordinary paragraph" rồi
// "[label]: dest" là hai dòng của cùng một đoạn văn, dấu ngoặc ở đó là văn bản
// literal và "dest" không phải đích của ai cả; đọc nó như definition là đem một
// chuỗi không ai viết đi phân giải rồi báo hỏng một tài liệu đúng. Ngược lại,
// container chỉ đặt tiền tố chứ không đổi bản chất khối bên trong: "> [ref]:
// dest" vẫn định nghĩa một nhãn thật, nên phải đọc trên dòng đã gỡ tiền tố,
// đúng như đường quét heading. Destination được phép nằm ở dòng ngay sau "]:".
function referenceDefinitions(lines, rawLines) {
  const found = [];
  let paragraphOpen = false;
  let depth = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].text.trim()) {
      paragraphOpen = false;
      continue;
    }
    // Một dòng tự mở container mới, hay một dòng đổi độ sâu container, bắt đầu
    // một khối khác: hai list item liên tiếp là hai đoạn riêng, nên definition
    // mở đầu item thứ hai không nối vào đoạn của item thứ nhất. Chỉ đếm dòng
    // trống thì "- [executor][report]" làm câm định nghĩa ngay dưới nó và một
    // đích hỏng đi qua cổng.
    if (lines[index].opened || lines[index].depth !== depth) {
      paragraphOpen = false;
    }
    depth = lines[index].depth;
    const head = paragraphOpen ? null : definitionAt(lines, index);
    if (!head) {
      paragraphOpen = paragraphText(lines[index]);
      continue;
    }
    const start = index;
    // Nhãn có thể đã ăn thêm mấy dòng, nên con trỏ nhảy tới dòng mang dấu hai
    // chấm trước khi đi tìm destination ở dòng kế.
    index = head.line;
    let destination = head.destination.trim();
    let raw = rawLines.slice(start, index + 1).join("\n");
    // Dòng nối chỉ mang destination khi nó vẫn là văn bản của cùng khối: một
    // dòng tự mở container, đổi độ sâu, hay mở một khối khác như list item và
    // heading thì "[nhãn]:" ở trên chỉ còn là một đoạn văn thường. Nhận bừa dòng
    // dưới thì "- missing.md" biến thành đích của một định nghĩa không tồn tại
    // và gate báo hỏng một tài liệu đúng.
    const next = lines[index + 1];
    if (
      !destination && next && !next.opened && next.depth === depth &&
      paragraphText(next)
    ) {
      destination = next.text.trim();
      raw += "\n" + rawLines[index + 1];
      index++;
    }
    // Title là phần tuỳ chọn của cùng một definition và chuẩn cho phép nó nằm
    // hẳn ở dòng dưới: '[ref]: dest' rồi '  "Title"' vẫn là một khối metadata,
    // không render ra chữ nào. Chỉ nuốt dòng nối khi destination còn trống thì
    // dòng title ở lại trong văn bản đưa cho vòng quét inline, một chuỗi trông
    // giống link nằm trong title bị đem đi phân giải, và gate báo hỏng một tài
    // liệu đúng. Điều kiện nhận là chính grammar: chỉ gộp khi cả cụm hai dòng
    // khớp destination kèm title, nên một dòng văn xuôi thường vẫn ở lại ngoài.
    const continuation = lines[index + 1];
    if (
      destination && continuation && !continuation.opened &&
      continuation.depth === depth && paragraphText(continuation) &&
      linkDestination.test(destination + "\n" + continuation.text.trim())
    ) {
      destination += "\n" + continuation.text.trim();
      raw += "\n" + rawLines[index + 1];
      index++;
    }
    // Không có destination thì cả cụm không phải definition: chuẩn trả nó về
    // đoạn văn thường, nên nhãn ở đó không định nghĩa gì và cũng không có đích
    // nào để đem đi phân giải.
    if (!destination) {
      paragraphOpen = true;
      continue;
    }
    found.push({
      label: head.label,
      destination,
      raw: raw.trim(),
      start,
      end: index,
    });
    paragraphOpen = false;
  }
  return found;
}
// Tập chỉ số dòng mà những definition này chiếm trọn. Chúng là metadata: chuẩn
// không render gì từ chúng, nên cả nhãn lẫn title đều không góp mặt vào tài
// liệu người đọc thấy.
function definitionLineNumbers(definitions) {
  const numbers = new Set();
  for (const definition of definitions) {
    for (let line = definition.start; line <= definition.end; line++) {
      numbers.add(line);
    }
  }
  return numbers;
}
const anchorCache = new Map();
function documentAnchors(path) {
  const cached = anchorCache.get(path);
  if (cached) return cached;
  const anchors = new Set();
  let body;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    anchorCache.set(path, anchors);
    return anchors;
  }
  const seen = new Map();
  const structural = structuralMarkdown(body);
  // Nhãn reference được định nghĩa ở bất kỳ đâu trong tài liệu, kể cả sau
  // heading dùng nó, nên tập định nghĩa phải dựng trước vòng quét heading. Cùng
  // một cách đọc với đường quét target, nên một nhãn định nghĩa trong blockquote
  // được thu gọn trong slug đúng như GitHub render nó.
  const rawLines = structural.split("\n");
  const lines = scanContainers(rawLines);
  const found = referenceDefinitions(lines, rawLines);
  const definitions = new Set(
    found.map((entry) => referenceLabel(entry.label)),
  );
  const definitionLines = definitionLineNumbers(found);
  for (let index = 0; index < lines.length; index++) {
    const atx = lines[index].text.match(
      /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/,
    );
    let text;
    if (atx) text = (atx[2] ?? "").replace(/[ \t]#+[ \t]*$/, "");
    // Setext: một dòng văn bản không rỗng theo sau bởi hàng chỉ có "=" hoặc
    // "-". Hàng toàn dấu gạch sau một đoạn văn là heading chứ không phải
    // thematic break, đúng thứ tự ưu tiên của CommonMark.
    // Hai dòng phải thuộc cùng một khối, nên chúng phải cùng độ sâu container
    // và hàng gạch không được tự mở container mới. Đọc trên dòng đã gỡ tiền tố
    // mà bỏ qua điều đó thì "- Ghost list item" theo sau bởi "---" trông như
    // setext, trong khi chuẩn render ra một list rồi một thematic break; anchor
    // tưởng tượng đó cho link hỏng đi qua cổng.
    // CommonMark gộp cả đoạn văn ngay trước hàng gạch thành một heading, nên
    // "Multiline setext" rồi "heading probe" rồi "---" mang id
    // "multiline-setext-heading-probe". Chỉ lấy dòng cuối thì slug ghi
    // "heading-probe": link tới id thật bị báo hỏng còn link tới id không tồn
    // tại lại qua cổng.
    // Một reference definition là khối riêng, không phải văn bản của đoạn, nên
    // nó chặn đứng vòng quét ngược: "[ref]: dest" rồi "Actual heading" rồi
    // "---" cho heading mang đúng id "actual-heading". Đọc dòng definition như
    // văn bản thì slug gộp cả nhãn lẫn đích, id thật vắng mặt khỏi tập anchor,
    // và link đúng tới nó bị báo hỏng trong khi một id bịa lại qua cổng.
    else if (
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index].text) &&
      !lines[index].opened && index > 0 && !definitionLines.has(index - 1) &&
      paragraphText(lines[index - 1]) &&
      lines[index - 1].depth === lines[index].depth
    ) {
      let start = index - 1;
      while (
        start > 0 && !lines[start].opened &&
        !definitionLines.has(start - 1) &&
        paragraphText(lines[start - 1]) &&
        lines[start - 1].depth === lines[index].depth
      ) start--;
      text = lines.slice(start, index).map((entry) => entry.text.trim())
        .join(" ");
    } else continue;
    const slug = headingSlug(headingText(text, definitions));
    if (!slug) continue;
    // GitHub bỏ qua id đã phát sinh khi chọn hậu tố: với "## Collision probe",
    // "## Collision probe-1" rồi "## Collision probe", heading thứ ba nhận
    // "collision-probe-2" chứ không nhận lại "collision-probe-1". Đếm riêng
    // từng slug gốc thì hai heading khác nhau cùng nhận một id, id thật sự được
    // sinh ra không có trong tập anchor, và một link đúng bị báo hỏng.
    let suffix = seen.get(slug) ?? 0;
    let unique = suffix ? slug + "-" + suffix : slug;
    while (anchors.has(unique)) unique = slug + "-" + ++suffix;
    seen.set(slug, suffix + 1);
    anchors.add(unique);
  }
  // id và name viết tay cũng là anchor thật, và chúng nằm trong chính những
  // block HTML mà structuralMarkdown đã bỏ, nên phải quét trước khi bỏ block.
  // Nhưng quét trên body thô thì một ví dụ <a id="x"> trong fence, trong inline
  // code hoặc trong comment cũng đứng ra làm anchor, và một link tới #x hỏng
  // vẫn qua cổng. Dựng đúng khung nhìn HTML render như đường quét href/src: bỏ
  // code và comment trước, xóa thân raw text, rồi chỉ đọc thuộc tính nằm trong
  // thẻ mở thật sự, để "id=" viết trong văn xuôi cũng không thành anchor.
  const renderedHtml = markdownLinkSections(body).map((section) =>
    outsideRawTextAndComments(outsideInlineCode(outsideBlockCode(section)))
  ).join("\n\n");
  // "id" là thuộc tính toàn cục nên phần tử nào cũng đặt được anchor bằng nó,
  // còn "name" chỉ dựng fragment trên chính thẻ <a>: trên <div> hay <input> nó
  // là tên trường, không phải đích cuộn. Nhận cả hai ở mọi thẻ thì một link tới
  // "#ghost-name" của <div name="ghost-name"> đi qua cổng trong khi bấm vào nó
  // không tới đâu cả.
  // Giá trị thuộc tính đi qua bộ giải mã character reference y như văn bản, nên
  // id thật của <a id="probe&amp;anchor"> là "probe&anchor" và link đúng tới nó
  // viết "#probe%26anchor". Ghi lại nguyên văn cách viết thì id thật vắng mặt
  // trong tập anchor còn một chuỗi không tồn tại lại có mặt.
  for (const tag of renderedTags(renderedHtml)) {
    const anchorTag = tag[1].toLowerCase() === "a";
    for (const [name, value] of tagAttributes(tag[2])) {
      if (name !== "id" && !(anchorTag && name === "name")) continue;
      if (value) anchors.add(decodeReferences(value, "", false));
    }
  }
  anchorCache.set(path, anchors);
  return anchors;
}
for (const filePath of planFiles(planRoot)) {
  const file = relative(planRoot, filePath);
  const body = readFileSync(filePath, "utf8");
  if (body.includes(String.fromCharCode(0x2014))) {
    fail(file + ": contains U+2014");
  }
  if (file.endsWith(".md")) {
    const markdown = markdownLinkSections(body).map((section) =>
      outsideHtmlComments(
        outsideHtmlBlocks(outsideInlineCode(outsideBlockCode(section))),
      )
    ).join("\n\n");
    const markdownLines = markdown.split("\n");
    const definitions = referenceDefinitions(
      scanContainers(markdownLines),
      markdownLines,
    );
    // Title của một definition là metadata, không phải văn bản render: trong
    // '[ref]: dest "Title [hidden](missing.md)"' cái ngoặc bên trong đi ra HTML
    // nguyên văn trong thuộc tính title và không có link nào tên missing.md.
    // Quét cả dòng definition như văn bản thường thì chuỗi đó bị đem đi phân
    // giải và một tài liệu đúng chuẩn bị báo hỏng. Đích thật của definition vẫn
    // vào gate ở vòng ngay dưới, nên che dòng không mở lỗ nào.
    const definitionLines = definitionLineNumbers(definitions);
    const targets = inlineLinkTargets(
      markdownLines.map((line, index) => definitionLines.has(index) ? "" : line)
        .join("\n"),
    );
    // Block HTML thô bị outsideHtmlBlocks xóa khỏi Markdown cấu trúc, đúng ở chỗ
    // Markdown bên trong nó không render; nhưng thuộc tính link của chính HTML
    // đó vẫn render và vẫn hỏng được. Quét lại trước khi block bị xóa, sau khi
    // code và comment đã bị xóa, nên một ví dụ <a href> trong fence không sống.
    const rawHtml = markdownLinkSections(body).map((section) =>
      outsideRawTextAndComments(outsideInlineCode(outsideBlockCode(section)))
    ).join("\n\n");
    for (const tag of renderedTags(rawHtml)) {
      const element = tag[1].toLowerCase();
      for (const [name, value] of tagAttributes(tag[2])) {
        if (value) targets.push(...attributeTargets(element, name, value));
      }
    }
    // Kiểm mọi definition, kể cả chưa dùng; không phụ thuộc kiểu
    // full/collapsed/shortcut. Container được gỡ trước nên một definition mở đầu
    // list item hay nằm trong blockquote vẫn vào gate; checklist "- [ ] việc"
    // không lọt vào đây vì sau "]" phải là ":". Link thật nằm trong thân một
    // footnote vẫn được inlineLinkTargets kiểm như mọi inline khác, nên việc bỏ
    // qua footnote definition không mở lỗ nào.
    for (const definition of definitions) {
      const destination = definition.destination.match(linkDestination);
      if (!destination) {
        fail(
          file + ": unsupported Markdown reference definition " +
            definition.raw,
        );
        continue;
      }
      targets.push(destination[1] ?? destination[2]);
    }
    for (const target of targets) {
      // Character reference được giải mã trước mọi câu hỏi khác về destination,
      // vì chuẩn giải mã nó khi dựng URL: ranh giới fragment, ranh giới query và
      // cả scheme đều đọc trên chuỗi đã giải mã. Tìm ranh giới trên chuỗi thô
      // thì "README.md&num;overview" không có dấu # nào và cả chuỗi bị đem đi mở
      // như một tên file, còn "&#35;" lại bị cắt ngay giữa chính reference của
      // nó; cả hai đều báo hỏng một link đúng chuẩn.
      const decoded = decodeReferences(target);
      // Bất kỳ URI scheme nào cũng là địa chỉ ngoài cây làm việc, không riêng
      // http(s): ghim hai scheme đó thì "mailto:" hay "ftp:" bị đem đi phân giải
      // như đường dẫn tương đối và một link đúng chuẩn bị báo hỏng. RFC 3986
      // cho phép scheme dài đúng một ký tự, nhưng ở đây vẫn đòi từ hai ký tự
      // trở lên, có chủ ý: không scheme một ký tự nào được đăng ký, còn
      // "c:outside.md", "c:\Users" và "c:/Users" đều là đường dẫn ổ đĩa Windows
      // và trỏ thẳng vào filesystem của người đọc. Hai dạng đó không phân biệt
      // được bằng cú pháp, nên cổng chọn phía an toàn: nhận nhầm một scheme một
      // ký tự giả định thành unsafe chỉ buộc tác giả viết khác đi, còn nhận
      // nhầm một drive path thành địa chỉ ngoài là thả nó qua cổng.
      // "//host/path" là network-path reference của RFC 3986: nó mượn scheme của
      // trang đang render và trỏ ra ngoài cây làm việc y như một URL đủ scheme.
      // Không nhận dạng thì isAbsolute() coi nó là đường dẫn tuyệt đối POSIX và
      // một link đúng chuẩn bị báo unsafe. Đòi authority không rỗng, nên
      // "///etc/passwd" vẫn rơi xuống nhánh unsafe bên dưới.
      // Backslash escape cũng được gỡ trước khi dựng URL, nên
      // "https\://example.com" render ra một địa chỉ ngoài đủ scheme. Hỏi câu
      // này trên chuỗi còn backslash thì nó rơi xuống nhánh đường dẫn cục bộ và
      // một link đúng chuẩn bị báo hỏng. Ranh giới fragment và query bên dưới
      // vẫn đọc trên bản còn escape, vì ở đó chính dấu escape mới phân biệt
      // được ký tự thật với vách ngăn.
      if (
        /^(?:[a-z][a-z0-9+.-]+:|\/\/[^\/])/i.test(
          decoded.replace(/\\([!-/:-@[-`{-~])/g, "$1"),
        )
      ) continue;
      // Destination là URL: bỏ query và fragment rồi giải mã percent-encoding
      // trước khi đụng tới filesystem. Đem chuỗi thô đi phân giải thì một link
      // đúng chuẩn tới "link target.md" viết là "link%20target.md" bị báo hỏng.
      // Kiểm an toàn cũng chạy trên chuỗi đã giải mã, để "%2e%2e%2f" hay "%5c"
      // không luồn qua được nhánh unsafe.
      // Dấu # hoặc ? bị escape là ký tự thật trong tên file, không phải ranh
      // giới fragment/query: cắt ở dấu chưa escape đầu tiên, rồi mới gỡ escape.
      // Cắt trước khi gỡ thì "a\#b.md" bị xẻ đôi và trỏ sang một file khác.
      let boundary = decoded.length;
      for (let position = 0; position < decoded.length; position++) {
        if (
          (decoded[position] === "#" || decoded[position] === "?") &&
          !markdownEscaped(decoded, position)
        ) {
          boundary = position;
          break;
        }
      }
      // CommonMark gỡ backslash escape trước khi mở đường dẫn, nên
      // "link\(target\).md" trỏ tới "link(target).md"; giữ nguyên backslash thì
      // một link đúng chuẩn bị báo unsafe. Chỉ gỡ trước dấu câu ASCII, đúng
      // phạm vi escape của CommonMark; "\\" thành một backslash thật và vẫn rơi
      // xuống nhánh unsafe bên dưới, là hướng lệch fail-closed.
      // Gỡ backslash sau khi đã giải mã reference, vì decodeReferences tự bỏ qua
      // "&" đã bị escape: gỡ trước thì "\&amp;" mất backslash rồi mới thành
      // "&", tức một chuỗi cố ý viết literal lại bị giải mã.
      const withoutFragment = decoded.slice(0, boundary)
        .replace(/\\([!-/:-@[-`{-~])/g, "$1");
      // Fragment là một lời hứa kiểm được y như đường dẫn: nó phải trỏ tới một
      // heading hay một id có thật. Ranh giới đường dẫn ở trên dừng cả ở "?",
      // nên tìm lại dấu "#" chưa escape đầu tiên để lấy đúng phần fragment,
      // bỏ luôn query nếu có.
      let hash = -1;
      for (let position = 0; position < decoded.length; position++) {
        if (decoded[position] === "#" && !markdownEscaped(decoded, position)) {
          hash = position;
          break;
        }
      }
      let fragment = "";
      if (hash >= 0) {
        const raw = decoded.slice(hash + 1)
          .replace(/\\([!-/:-@[-`{-~])/g, "$1");
        try {
          fragment = decodeURIComponent(raw);
        } catch {
          fragment = raw;
        }
      }
      // Destination chỉ có fragment trỏ vào chính tài liệu đang đọc. Bỏ qua nó
      // thì "[mục](#definitely-not-a-heading)" đi qua gate và người đọc bấm vào
      // không tới đâu cả.
      if (!withoutFragment) {
        if (fragment && !documentAnchors(filePath).has(fragment)) {
          fail(file + ": anchor hỏng " + target);
        }
        continue;
      }
      let clean;
      try {
        clean = decodeURIComponent(withoutFragment);
      } catch {
        clean = withoutFragment;
      }
      if (!clean) continue;
      if (isAbsolute(clean) || /^[a-z]:/i.test(clean) || clean.includes("\\")) {
        fail(file + ": unsafe Markdown link " + target);
        continue;
      }
      const resolved = resolve(dirname(filePath), clean);
      const scoped = relative(repoRoot, resolved);
      // Cho phép ../ trong repo, nhưng không hỏi filesystem về đường dẫn thoát repo.
      const parts = scoped.split(/[\\/]/);
      if (isAbsolute(scoped) || parts[0] === "..") {
        fail(file + ": unsafe Markdown link " + target);
        continue;
      }
      // Nội dung ".git" là metadata của bản checkout, không phải artifact được
      // theo dõi: cùng một link đó không mở được khi đọc tài liệu trên trình
      // duyệt repo và khác nhau giữa các máy. canonicalScopePath đã chặn cùng
      // thành phần này cho đường dẫn phạm vi, nên hai nơi hiểu như nhau.
      if (parts.some((part) => part.toLowerCase() === ".git")) {
        fail(file + ": unsafe Markdown link " + target);
        continue;
      }
      if (!existsSync(resolved) || !existsCaseExact(repoRoot, parts)) {
        fail(file + ": link hỏng " + target);
        continue;
      }
      // Chỉ mục là nguồn duy nhất nói đích có đi cùng repo hay không. Thư mục
      // không có mục riêng trong index, nên nó được nhận khi có ít nhất một file
      // được theo dõi nằm dưới; thư mục rỗng hoặc chỉ chứa file bị ignore không
      // phải artifact. trackedArtifacts đã báo lỗi khi không đọc được index, nên
      // ở đây im lặng để một sự cố không hóa thành hàng loạt lỗi link.
      // Gốc repo là thư mục được theo dõi như mọi thư mục khác, chỉ khác ở chỗ
      // relative() mô tả nó bằng chuỗi rỗng. Chuỗi đó không có trong tập file
      // lẫn tập thư mục, nên "[root](../../)" bị báo chưa theo dõi trong khi
      // chính nó chứa mọi artifact của repo.
      const indexed = trackedTargets();
      const posix = parts.join("/");
      if (
        indexed && posix !== "" && !indexed.files.has(posix) &&
        !indexed.directories.has(posix)
      ) {
        fail(file + ": link chưa được Git theo dõi " + target);
        continue;
      }
      // Chỉ tài liệu Markdown mới có anchor dựng từ heading. File nguồn thì
      // fragment là chuyện của trình duyệt repo, ví dụ "#L12", nên không hỏi.
      if (fragment && /\.md$/i.test(clean)) {
        if (!documentAnchors(resolved).has(fragment)) {
          fail(file + ": anchor hỏng " + target);
        }
      }
      // Kiểm ranh giới trên đường dẫn từ vựng không nhìn thấy symlink: một link
      // đi qua "plans/evidence/outside-link" trỏ ra /tmp vẫn nằm trong repo về
      // mặt chuỗi, nhưng đích thật ở ngoài checkout nên không phải artifact của
      // repo và sẽ không tồn tại ở một bản clone sạch. Phân giải cả hai đầu rồi
      // so lại; realpath cả repoRoot vì chính cây làm việc có thể nằm dưới một
      // symlink (trên macOS /tmp là symlink tới /private/tmp).
      let realScoped;
      try {
        realScoped = relative(realpathSync(repoRoot), realpathSync(resolved));
      } catch {
        fail(file + ": unsafe Markdown link " + target);
        continue;
      }
      if (isAbsolute(realScoped) || realScoped.split(/[\\/]/)[0] === "..") {
        fail(file + ": unsafe Markdown link " + target);
      }
    }
  }
}

const indexPath = resolve(planRoot, "README.md");
if (!existsSync(indexPath)) fail("Thiếu README.md");
else {
  // Danh mục cũng phải đọc trên Markdown cấu trúc: một hàng bảng trong fence ví
  // dụ được render thành code, không quảng cáo thêm kế hoạch nào, nhưng quét
  // thô lại coi nó là ID lạ và bác bỏ một README đúng.
  const index = structuralMarkdown(readFileSync(indexPath, "utf8"));
  // Ánh xạ một-một phải kiểm cả chiều ngược: vòng lặp dưới chỉ hỏi từng ID của
  // manifest có đúng một dòng, nên một dòng danh mục mang ID lạ không bị ai hỏi
  // tới và README quảng cáo thêm kế hoạch ngoài bộ đã duyệt. Đọc ô ID theo đúng
  // cách vòng lặp dưới đọc, để hai nơi không hiểu tài liệu theo hai kiểu.
  const planIds = new Set(
    manifest.map((entry) => String(entry.id).padStart(3, "0")),
  );
  const unexpectedIds = [
    ...new Set(
      // Ô ID nào cũng phải đối chiếu với manifest, không riêng ô đúng ba chữ
      // số: ghim độ dài thì một hàng mang "1000" không bị ai hỏi tới và README
      // quảng cáo thêm kế hoạch ngoài bộ đã duyệt. Manifest chỉ sinh ID ba chữ
      // số nên mọi ô toàn số khác ba chữ số đều là ID lạ.
      index.split("\n").map((line) => tableCells(line)[1]?.trim()).filter(
        (cell) => cell !== undefined && /^\d+$/.test(cell),
      ),
    ),
  ].filter((id) => !planIds.has(id));
  if (unexpectedIds.length) {
    fail(
      "README lists plan IDs outside the manifest: " + unexpectedIds.join(", "),
    );
  }
  for (const entry of manifest) {
    if (!index.includes(`](${entry.file})`)) {
      fail(`README thiếu ${entry.file}`);
    }
    const id = String(entry.id).padStart(3, "0");
    const rows = index.split("\n").filter((line) =>
      tableCells(line)[1]?.trim() === id
    );
    if (rows.length !== 1) fail("README requires exactly one row for ID " + id);
    const cells = tableCells(rows[0] ?? "");
    const target = cells[2]?.trim().match(/^\[[^\]]+\]\(([^)]+)\)$/)?.[1];
    if (target !== entry.file) fail("README row file does not match ID " + id);
    // Ô trạng thái đọc theo cùng bộ tách ô, để chỗ này và các ô khác không hiểu
    // một hàng theo hai kiểu. Ô cuối phải rỗng, tức hàng vẫn đóng bằng "|".
    const rowStatus = cells.at(-1)?.trim() === ""
      ? cells.at(-2)?.trim().match(/^(TODO|IN_PROGRESS|BLOCKED|DONE|STALE)$/)
        ?.[1]
      : undefined;
    const indexDependencies = dependencies(cells[5]);
    if (!indexDependencies || !sameSet(indexDependencies, entry.depends)) {
      fail(entry.file + ": index and manifest dependencies differ");
    }
    const planStatus = statusById.get(entry.id);
    if (!rowStatus || rowStatus !== planStatus) {
      fail(`${entry.file}: index and plan status differ`);
    }
  }
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Đạt: 25 kế hoạch, đủ audit, scope, trích đoạn, links và phụ thuộc không chu trình.`,
  );
  console.log(
    `Thứ tự hợp lệ: ${
      order.map((id) => String(id).padStart(3, "0")).join(", ")
    }`,
  );
  // Chỉ liệt kê khi mọi gate đã xanh: một tập references thu dở, từ một lần
  // chạy đã bỏ giữa chừng, sẽ khiến gate lịch sử báo sạch trên đúng những
  // commit mà validator chưa kịp hỏi tới.
  if (process.argv.includes("--print-references")) {
    for (const ref of [...gitReferences].sort()) {
      console.log("reference: " + ref);
    }
  }
}
