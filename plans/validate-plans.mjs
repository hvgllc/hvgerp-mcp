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
    const marker = width <= innermost() + 3
      ? relative.match(/^(?:[-+*]|[0-9]+[.)])[ \t]+/)
      : undefined;
    if (marker) stack.push(width + marker[0].length);
    return { indent: innermost(), marker: marker?.[0] };
  };
}
function outsideFencedCode(body, preserveOffsets = false) {
  let fence, fenceIndent = 0, listIndent = 0;
  const track = listIndentTracker();
  const hidden = (line) => preserveOffsets ? " ".repeat(line.length) : "";
  return body.split("\n").map((line) => {
    const indentation = line.match(/^[ \t]*/)[0];
    let width = 0;
    for (const character of indentation) {
      width += character === "\t" ? 4 - width % 4 : 1;
    }
    // "." trong JS không khớp "\r", nên "(.*)$" trượt trên mọi dòng fence kết
    // thúc CRLF và cả block code trong một file CRLF bị đọc như văn xuôi sống.
    // Phần còn lại của validator đã cố ý CRLF-tolerant, đây là chỗ lệch.
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})(.*)\r?$/);
    if (fence) {
      if (
        marker && width <= fenceIndent + 3 && marker[1][0] === fence[0] &&
        marker[1].length >= fence.length && /^[ \t\r]*$/.test(marker[2])
      ) fence = undefined;
      return hidden(line);
    }
    // Fence nằm trong list item mở ở content indent của item, không phải ở cột
    // 3 tuyệt đối. Đo thụt so với container thì một ví dụ có fence thụt đúng
    // chuẩn dưới list item mới được nhận là code; ghim cột 3 gốc thì nội dung
    // của nó bị đọc như văn xuôi sống và các gate tài liệu bắt nhầm.
    listIndent =
      track(line.slice(indentation.length), width, !line.trim()).indent;
    if (
      marker && width <= listIndent + 3 &&
      (marker[1][0] === "~" || !marker[2].includes("`"))
    ) {
      fence = marker[1];
      fenceIndent = width;
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
function tagAttributes(text) {
  const pairs = [];
  htmlAttributePair.lastIndex = 0;
  let match;
  while ((match = htmlAttributePair.exec(text))) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value !== undefined) pairs.push([match[1].toLowerCase(), value]);
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
const rawTextOrComment = new RegExp(
  "<!--[\\s\\S]*?(?:-->|$)" +
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
  let closer, fence, fenceIndent = 0, listIndent = 0, loneTagAllowed = true;
  const track = listIndentTracker();
  const hidden = (line) => preserveOffsets ? " ".repeat(line.length) : "";
  return body.split("\n").map((line) => {
    const blank = htmlBlank.test(line);
    if (closer) {
      if (closer === htmlBlank) {
        if (blank) closer = undefined;
        loneTagAllowed = blank;
        return blank ? line : hidden(line);
      }
      if (closer.test(line)) closer = undefined;
      loneTagAllowed = false;
      return hidden(line);
    }
    const indentation = line.match(/^[ \t]*/)[0];
    let width = 0;
    for (const character of indentation) {
      width += character === "\t" ? 4 - width % 4 : 1;
    }
    // Một list item dời cột gốc của cả fence lẫn block HTML: dưới item có content
    // indent bốn, "    <script>" là HTML thô ở cột 0 của container chứ không phải
    // code. Đo thụt lề so với content indent, giống outsideFencedCode, rồi thử
    // các dấu mở trên phần đã bỏ thụt lề; ghim cột 3 tuyệt đối thì một ví dụ
    // nhúng đúng chuẩn dưới list bị đọc như link sống và gate báo hỏng.
    const relative = line.slice(indentation.length);
    // Fence mở trước thì nội dung của nó là code chứ không phải HTML, nên một
    // "<div>" viết trong ví dụ không được mở block và nuốt mất nội dung sống
    // đứng sau. Chiều ngược lại đã đúng sẵn: block mở trước thì dòng fence bên
    // trong nó bị xóa cùng block. Hai dấu mở không bao giờ khớp cùng một dòng.
    const marker = relative.match(htmlFence);
    if (fence) {
      if (
        marker && width <= fenceIndent + 3 && marker[1][0] === fence[0] &&
        marker[1].length >= fence.length && /^[ \t\r]*$/.test(marker[2])
      ) fence = undefined;
      loneTagAllowed = false;
      return line;
    }
    const container = track(relative, width, blank);
    listIndent = container.indent;
    if (
      marker && width <= listIndent + 3 &&
      (marker[1][0] === "~" || !marker[2].includes("`"))
    ) {
      fence = marker[1];
      fenceIndent = width;
      loneTagAllowed = false;
      return line;
    }
    if (width > listIndent + 3) {
      loneTagAllowed = blank;
      return line;
    }
    // Một block HTML mở được ngay trên dòng có dấu list: trong "- <div>", nội
    // dung của item bắt đầu sau "- " và chính là dấu mở. Chỉ thử trên phần đã
    // bỏ thụt lề thì dấu list còn nguyên, không dấu mở nào khớp, và nội dung
    // của block bị quét như Markdown sống. Cả dòng bị ẩn kèm dấu list, tức một
    // bullet biến mất khỏi Markdown cấu trúc; đó là hướng fail-closed và đúng
    // với chuẩn, vì nội dung của item đó là HTML thô chứ không phải văn xuôi.
    const content = container.marker
      ? relative.slice(container.marker.length)
      : relative;
    for (const [opener, end] of htmlBlockOpeners) {
      if (!opener.test(content)) continue;
      // Điều kiện đóng có thể được thỏa ngay trên dòng mở, ví dụ "<pre>x</pre>".
      closer = end && end.test(line) ? undefined : end ?? htmlBlank;
      loneTagAllowed = false;
      return hidden(line);
    }
    if (loneTagAllowed && htmlLoneTag.test(content)) {
      closer = htmlBlank;
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
const linkDestination =
  /^(?:<([^<>]*)>|([^\s<>]+))(?:(?:[ \t]+|[ \t]*\r?\n[ \t]*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\)))?$/;
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
// CommonMark giải mã character reference trong destination trước khi phân giải,
// nên "[x](link&amp;target.md)" trỏ tới file "link&target.md". Bảng tên đầy đủ
// của HTML5 có hơn hai nghìn mục, phần lớn trỏ tới ký hiệu toán, chữ Hy Lạp hay
// mũi tên, và nhúng trọn bộ vào đây thì đưa cả ký tự điều khiển lẫn ký tự vô
// hình vào source mà không ai đọc lại được. Giữ đúng phần dùng được trong một
// đường dẫn: mọi tên trỏ tới một ký tự Latin-1, tức toàn bộ dấu câu ASCII và
// bảng chữ có dấu, trừ hai tên trỏ tới tab và xuống dòng vì destination chưa
// escape không chứa khoảng trắng. Tên ngoài bảng giữ nguyên chuỗi thô và link
// vẫn bị kiểm, tức fail-closed.
const namedReferences = new Map([
  ["AElig", "Æ"],
  ["AMP", "&"],
  ["Aacute", "Á"],
  ["Acirc", "Â"],
  ["Agrave", "À"],
  ["Aring", "Å"],
  ["Atilde", "Ã"],
  ["Auml", "Ä"],
  ["COPY", "©"],
  ["Ccedil", "Ç"],
  ["Cedilla", "¸"],
  ["CenterDot", "·"],
  ["DiacriticalAcute", "´"],
  ["DiacriticalGrave", "`"],
  ["Dot", "¨"],
  ["DoubleDot", "¨"],
  ["ETH", "Ð"],
  ["Eacute", "É"],
  ["Ecirc", "Ê"],
  ["Egrave", "È"],
  ["Euml", "Ë"],
  ["GT", ">"],
  ["Hat", "^"],
  ["Iacute", "Í"],
  ["Icirc", "Î"],
  ["Igrave", "Ì"],
  ["Iuml", "Ï"],
  ["LT", "<"],
  ["NonBreakingSpace", "\u00a0"],
  ["Ntilde", "Ñ"],
  ["Oacute", "Ó"],
  ["Ocirc", "Ô"],
  ["Ograve", "Ò"],
  ["Oslash", "Ø"],
  ["Otilde", "Õ"],
  ["Ouml", "Ö"],
  ["PlusMinus", "±"],
  ["QUOT", '"'],
  ["REG", "®"],
  ["THORN", "Þ"],
  ["Uacute", "Ú"],
  ["Ucirc", "Û"],
  ["Ugrave", "Ù"],
  ["UnderBar", "_"],
  ["Uuml", "Ü"],
  ["VerticalLine", "|"],
  ["Yacute", "Ý"],
  ["aacute", "á"],
  ["acirc", "â"],
  ["acute", "´"],
  ["aelig", "æ"],
  ["agrave", "à"],
  ["amp", "&"],
  ["angst", "Å"],
  ["apos", "'"],
  ["aring", "å"],
  ["ast", "*"],
  ["atilde", "ã"],
  ["auml", "ä"],
  ["brvbar", "¦"],
  ["bsol", "\\"],
  ["ccedil", "ç"],
  ["cedil", "¸"],
  ["cent", "¢"],
  ["centerdot", "·"],
  ["circledR", "®"],
  ["colon", ":"],
  ["comma", ","],
  ["commat", "@"],
  ["copy", "©"],
  ["curren", "¤"],
  ["deg", "°"],
  ["die", "¨"],
  ["div", "÷"],
  ["divide", "÷"],
  ["dollar", "$"],
  ["eacute", "é"],
  ["ecirc", "ê"],
  ["egrave", "è"],
  ["equals", "="],
  ["eth", "ð"],
  ["euml", "ë"],
  ["excl", "!"],
  ["frac12", "½"],
  ["frac14", "¼"],
  ["frac34", "¾"],
  ["grave", "`"],
  ["gt", ">"],
  ["half", "½"],
  ["iacute", "í"],
  ["icirc", "î"],
  ["iexcl", "¡"],
  ["igrave", "ì"],
  ["iquest", "¿"],
  ["iuml", "ï"],
  ["laquo", "«"],
  ["lbrace", "{"],
  ["lbrack", "["],
  ["lcub", "{"],
  ["lowbar", "_"],
  ["lpar", "("],
  ["lsqb", "["],
  ["lt", "<"],
  ["macr", "¯"],
  ["micro", "µ"],
  ["midast", "*"],
  ["middot", "·"],
  ["nbsp", "\u00a0"],
  ["not", "¬"],
  ["ntilde", "ñ"],
  ["num", "#"],
  ["oacute", "ó"],
  ["ocirc", "ô"],
  ["ograve", "ò"],
  ["ordf", "ª"],
  ["ordm", "º"],
  ["oslash", "ø"],
  ["otilde", "õ"],
  ["ouml", "ö"],
  ["para", "¶"],
  ["percnt", "%"],
  ["period", "."],
  ["plus", "+"],
  ["plusmn", "±"],
  ["pm", "±"],
  ["pound", "£"],
  ["quest", "?"],
  ["quot", '"'],
  ["raquo", "»"],
  ["rbrace", "}"],
  ["rbrack", "]"],
  ["rcub", "}"],
  ["reg", "®"],
  ["rpar", ")"],
  ["rsqb", "]"],
  ["sect", "§"],
  ["semi", ";"],
  ["shy", "\u00ad"],
  ["sol", "/"],
  ["strns", "¯"],
  ["sup1", "¹"],
  ["sup2", "²"],
  ["sup3", "³"],
  ["szlig", "ß"],
  ["thorn", "þ"],
  ["times", "×"],
  ["uacute", "ú"],
  ["ucirc", "û"],
  ["ugrave", "ù"],
  ["uml", "¨"],
  ["uuml", "ü"],
  ["verbar", "|"],
  ["vert", "|"],
  ["yacute", "ý"],
  ["yen", "¥"],
  ["yuml", "ÿ"],
]);
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
const decodeReferences = (text, marker = "") =>
  text.replace(
    /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, name, offset) => {
      // Một "&" bị escape là ký tự literal, không mở được entity.
      if (markdownEscaped(text, offset)) return whole;
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
    const destination = inside.match(linkDestination);
    // Label của một link vẫn chứa được inline khác, thường gặp nhất là image:
    // "[![alt](a.png)](b.md)" render cả hai đích. Nhảy thẳng tới cuối link
    // ngoài thì đích của image bên trong không ai hỏi tới và một ảnh hỏng lọt
    // qua gate. Quét lại riêng phần label; nó ngắn hơn text nên đệ quy dừng.
    const label = scanInline(text.slice(index + 1, cursor - 1));
    targets.push(...label.targets);
    // Link không lồng trong link: khi label đã chứa một link thật, CommonMark
    // vô hiệu hóa opener bên ngoài và "[outer [inner](a.md)](b.md)" render ra
    // link tới a.md rồi "](b.md)" nguyên văn. Đẩy b.md vào gate là đem một
    // destination không ai viết đi phân giải và báo hỏng một tài liệu đúng.
    // Image không bị luật này: label của nó vẫn nằm trong một image sống, nên
    // "[![alt](a.png)](b.md)" giữ nguyên cả hai đích.
    const image = text[index - 1] === "!" && !markdownEscaped(text, index - 1);
    if (image || !label.link) {
      targets.push(destination ? destination[1] ?? destination[2] : inside);
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
    const blockedPath = resolve(
      planRoot,
      "evidence",
      String(entry.id).padStart(3, "0") + ".md",
    );
    if (!blockedReason(body) || !existsSync(blockedPath)) {
      fail(
        entry.file +
          ": BLOCKED requires one nonempty blocked_reason and an evidence report",
      );
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
const referenceLabel = (raw) => raw.trim().replace(/\s+/g, " ").toLowerCase();
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
const headingText = (raw, definitions) =>
  stripUnderscoreEmphasis(
    raw.split(/(`+[^`]*`+)/).map((part, index) =>
      // Nội dung code span render nguyên văn: gạch dưới trong đó là ký tự thật,
      // không phải delimiter của cặp nhấn bao quanh span.
      index % 2
        ? part.replace(/^`+|`+$/g, "").replaceAll("_", "\0_")
        : decodeReferences(
          part.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(
              /!?\[([^\]]*)\]\[([^\]]*)\]/g,
              (whole, text, label) =>
                !label.trim() || definitions.has(referenceLabel(label))
                  ? text
                  : whole,
            )
            .replace(autolinkText, "$1")
            .replace(/<[^>]*>/g, ""),
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
const indentColumns = (text) => columnsOf(text.match(/^[ \t]*/)[0]);
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
function scanContainers(rawLines) {
  const open = [];
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
    if (!rest.trim()) return { text: "", depth: matched, opened: false };
    open.length = matched;
    let opened = false;
    for (;;) {
      const prefix = rest.match(containerPrefix);
      if (!prefix) break;
      open.push({
        indent: /^ {0,3}>/.test(prefix[0]) ? null : columnsOf(prefix[0]),
      });
      rest = rest.slice(prefix[0].length);
      opened = true;
    }
    return { text: rest, depth: open.length, opened };
  });
}
// Một dòng chỉ góp vào heading setext khi nó là văn bản đoạn thường: heading
// ATX, hàng gạch của đoạn trước và thematic break đều kết thúc đoạn.
const paragraphText = (entry) =>
  entry.text.trim() && !/^ {0,3}#/.test(entry.text) &&
  !/^ {0,3}(?:=+|-+)[ \t]*$/.test(entry.text) &&
  !/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(entry.text);
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
  // heading dùng nó, nên tập định nghĩa phải dựng trước vòng quét heading. Một
  // dòng "[label]: dest" nằm giữa đoạn văn không mở định nghĩa nào; đọc rộng
  // như đây chỉ khiến nhãn đó được coi là sống, tức thu gọn đúng như cách viết
  // phổ biến thay vì ghi nguyên văn dấu ngoặc vào slug.
  const definitions = new Set();
  for (
    const match of structural.matchAll(/^ {0,3}\[((?:[^\[\]\\\n]|\\.)+)\]:/gm)
  ) definitions.add(referenceLabel(match[1]));
  const lines = scanContainers(structural.split("\n"));
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
    else if (
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[index].text) &&
      !lines[index].opened && index > 0 && paragraphText(lines[index - 1]) &&
      lines[index - 1].depth === lines[index].depth
    ) {
      let start = index - 1;
      while (
        start > 0 && !lines[start].opened &&
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
      if (value) anchors.add(decodeReferences(value));
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
    const targets = inlineLinkTargets(markdown);
    // Block HTML thô bị outsideHtmlBlocks xóa khỏi Markdown cấu trúc, đúng ở chỗ
    // Markdown bên trong nó không render; nhưng thuộc tính link của chính HTML
    // đó vẫn render và vẫn hỏng được. Quét lại trước khi block bị xóa, sau khi
    // code và comment đã bị xóa, nên một ví dụ <a href> trong fence không sống.
    const rawHtml = markdownLinkSections(body).map((section) =>
      outsideRawTextAndComments(outsideInlineCode(outsideBlockCode(section)))
    ).join("\n\n");
    for (const tag of renderedTags(rawHtml)) {
      for (const [name, value] of tagAttributes(tag[2])) {
        if ((name === "href" || name === "src") && value) targets.push(value);
      }
    }
    // Kiểm mọi definition, kể cả chưa dùng; không phụ thuộc kiểu full/collapsed/shortcut.
    // Label dừng ở ] không escape, không được ăn sang chuỗi ]: trong title.
    // Marker list ở đầu dòng phải được bỏ qua như đã bỏ qua dấu blockquote: một
    // definition mở đầu list item vẫn định nghĩa reference thật, nên nếu chỉ cho
    // phép khoảng trắng trước "[" thì "- [report]: missing.md" biến mất khỏi gate
    // và link hỏng đi qua. Checklist "- [ ] việc" không lọt vào đây vì sau "]"
    // phải là ":".
    // Destination được phép nằm ở dòng ngay sau "]:" theo CommonMark. Regex chỉ
    // đọc một dòng thì một definition hợp lệ viết tách dòng cho ra chuỗi rỗng và
    // bị báo là không hỗ trợ, dù nó trỏ tới file có thật.
    // "[^label]:" là footnote definition của GFM, không phải reference
    // definition: phần sau dấu hai chấm là văn xuôi chứ không phải destination,
    // nên đem đi khớp linkDestination sẽ bác bỏ một chú thích đúng chuẩn. Link
    // thật nằm trong thân chú thích vẫn được inlineLinkTargets kiểm như mọi
    // inline khác, nên bỏ qua ở đây không mở lỗ nào.
    for (
      const definition of markdown.matchAll(
        /^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)*\[(?!\^)(?:\\[^\r\n]|[^\[\]\\\r\n])+\]:[ \t]*(?:\r?\n[ \t]*)?([^\r\n]*)$/gm,
      )
    ) {
      const destination = definition[1].trim().match(linkDestination);
      if (!destination) {
        fail(
          file + ": unsupported Markdown reference definition " +
            definition[0].trim(),
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
      const indexed = trackedTargets();
      const posix = parts.join("/");
      if (
        indexed && !indexed.files.has(posix) && !indexed.directories.has(posix)
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
      index.split("\n").map((line) => tableCells(line)[1]?.trim()).filter(
        (cell) => cell !== undefined && /^\d{3}$/.test(cell),
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
