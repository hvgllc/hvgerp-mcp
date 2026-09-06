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
  let output = "", cursor = 0, match;
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
  "<[A-Za-z][A-Za-z0-9-]*(" + htmlAttributes + ")" + htmlOptionalSpace + "/?>",
  "g",
);
const htmlLinkAttribute = new RegExp(
  "\\b(?:href|src)" + htmlOptionalSpace + "=" + htmlOptionalSpace +
    "(?:\"([^\"]*)\"|'([^']*)'|([^ \\t\\r\\n\"'=<>`]+))",
  "gi",
);
// Nội dung của script, style và textarea là văn bản thô: CommonMark không đọc
// markup bên trong, nên một chuỗi JS trông như thẻ không phải link sống và đem
// href của nó đi phân giải sẽ báo hỏng một tài liệu đúng. Giữ nguyên thẻ mở để
// src của chính nó vẫn bị kiểm, chỉ xóa phần thân và thay bằng khoảng trắng để
// các đường quét theo dòng không lệch. Thiếu thẻ đóng thì thân chạy tới hết tài
// liệu, đúng như chuẩn mô tả.
const rawTextElement = new RegExp(
  "(<(script|style|textarea)" + htmlAttributes + htmlOptionalSpace + ">)" +
    "([\\s\\S]*?)(</\\2" + htmlOptionalSpace + ">|$)",
  "gi",
);
const outsideRawText = (body) =>
  body.replace(
    rawTextElement,
    (_whole, open, _name, content, close) =>
      open + content.replace(/[^\n]/g, " ") + close,
  );
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
// trị nằm trong backtick; hệ quả là một backtick chứa "<!--" vẫn mở được comment
// giả, nhưng hướng lệch đó là fail-closed (trường biến mất, gate báo thiếu).
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
    // Rời container cũng kết thúc fence chưa đóng và inline span của container.
    if (nextDepth !== depth) {
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
function outsideInlineCode(body) {
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
  return paragraphs.map((paragraph) => {
    const runs = [...paragraph.matchAll(/`+/g)];
    let output = "", start = 0;
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
      const end = close.index + close[0].length;
      output += paragraph.slice(start, open.index) +
        paragraph.slice(open.index, end).replace(/[^\n]/g, " ");
      start = end;
      index = closeIndex;
    }
    return output + paragraph.slice(start);
  }).join("");
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
const linkDestination =
  /^(?:<([^<>]*)>|([^\s<>]+))(?:(?:[ \t]+|[ \t]*\r?\n[ \t]*)(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/;
// Ký tự ở vị trí position chỉ bị escape khi số backslash liền ngay trước nó là
// số lẻ. Chuỗi chẵn như \\[ là một backslash literal rồi mới tới [ còn hiệu
// lực, nên kiểm một ký tự đơn text[position - 1] === "\\" sẽ bỏ sót link thật.
function markdownEscaped(text, position) {
  let run = 0;
  while (position - run > 0 && text[position - 1 - run] === "\\") run++;
  return run % 2 === 1;
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
const decodeReferences = (text) =>
  text.replace(
    /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, name, offset) => {
      // Một "&" bị escape là ký tự literal, không mở được entity.
      if (markdownEscaped(text, offset)) return whole;
      if (name[0] !== "#") return namedReferences.get(name) ?? whole;
      const code = name[1] === "x" || name[1] === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      // Chuẩn thay code point không hợp lệ bằng U+FFFD. Ký tự đó không nằm trong
      // đường dẫn nào của repo nên link vẫn bị báo hỏng, đúng hướng.
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    },
  );
function inlineLinkTargets(text) {
  // Regex phẳng \[[^\]]+\]\(...\) không parse được label lồng ngoặc vuông
  // như "[outer [inner]](x)": nó dừng ở ] đầu tiên rồi không khớp tiếp, nên
  // bỏ sót cả link, khiến destination hỏng lọt qua gate. Quét đếm độ sâu để
  // tìm đúng ] đóng label, có tính escape \[ \], rồi mới đọc (destination).
  const targets = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "[" || markdownEscaped(text, index)) continue;
    let depth = 1;
    let cursor = index + 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
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
    targets.push(destination ? destination[1] ?? destination[2] : inside);
    // Label của một link vẫn chứa được inline khác, thường gặp nhất là image:
    // "[![alt](a.png)](b.md)" render cả hai đích. Nhảy thẳng tới cuối link
    // ngoài thì đích của image bên trong không ai hỏi tới và một ảnh hỏng lọt
    // qua gate. Quét lại riêng phần label; nó ngắn hơn text nên đệ quy dừng.
    targets.push(...inlineLinkTargets(text.slice(index + 1, cursor - 1)));
    index = scan - 1;
  }
  return targets;
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
function staleReason(body) {
  const fields = structuralMarkdown(body).split("\n").filter((line) =>
    /^\s*-\s*stale_reason\s*:/.test(line)
  );
  if (
    fields.length !== 1 ||
    !metadataSection(body).split("\n").includes(fields[0])
  ) return false;
  const value = fields[0].match(/^- stale_reason: (.+)$/)?.[1];
  try {
    const reason = JSON.parse(value ?? "null");
    return typeof reason === "string" && reason.trim().length > 0;
  } catch {
    return false;
  }
}
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
  const scopeSection =
    structuralSection(structuralBody, "Phạm vi và Git").split(
      "Ngoài phạm vi:",
    )[0];
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
// span, nhãn link, thẻ HTML và backslash escape trước khi tính.
const headingText = (raw) =>
  raw.replace(/`+([^`]*)`+/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1");
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
  const lines = structuralMarkdown(body).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const atx = lines[index].match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*\r?$/);
    let text;
    if (atx) text = (atx[2] ?? "").replace(/[ \t]#+[ \t]*$/, "");
    // Setext: một dòng văn bản không rỗng theo sau bởi hàng chỉ có "=" hoặc
    // "-". Hàng toàn dấu gạch sau một đoạn văn là heading chứ không phải
    // thematic break, đúng thứ tự ưu tiên của CommonMark.
    else if (
      /^ {0,3}(?:=+|-+)[ \t]*\r?$/.test(lines[index]) && index > 0 &&
      lines[index - 1].trim() && !/^ {0,3}#/.test(lines[index - 1])
    ) text = lines[index - 1].trim();
    else continue;
    const slug = headingSlug(headingText(text));
    if (!slug) continue;
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count ? slug + "-" + count : slug);
  }
  // id và name viết tay cũng là anchor thật, và chúng nằm trong chính những
  // block HTML mà structuralMarkdown đã bỏ, nên quét trên body gốc.
  const attribute = new RegExp(
    "\\b(?:id|name)[ \\t]*=[ \\t]*" +
      "(?:\"([^\"]*)\"|'([^']*)'|([^ \\t\\r\\n\"'=<>`]+))",
    "g",
  );
  for (const match of body.matchAll(attribute)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) anchors.add(value);
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
    const rawHtml = outsideRawText(
      markdownLinkSections(body).map((section) =>
        outsideHtmlComments(outsideInlineCode(outsideBlockCode(section)))
      ).join("\n\n"),
    );
    for (const tag of rawHtml.matchAll(htmlTagAttributes)) {
      for (const attribute of tag[1].matchAll(htmlLinkAttribute)) {
        const value = attribute[1] ?? attribute[2] ?? attribute[3];
        if (value) targets.push(value);
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
      // Bất kỳ URI scheme nào cũng là địa chỉ ngoài cây làm việc, không riêng
      // http(s): ghim hai scheme đó thì "mailto:" hay "ftp:" bị đem đi phân giải
      // như đường dẫn tương đối và một link đúng chuẩn bị báo hỏng. Đòi scheme
      // dài từ hai ký tự theo RFC 3986 để "c:\..." vẫn rơi xuống nhánh unsafe
      // bên dưới thay vì được bỏ qua.
      // "//host/path" là network-path reference của RFC 3986: nó mượn scheme của
      // trang đang render và trỏ ra ngoài cây làm việc y như một URL đủ scheme.
      // Không nhận dạng thì isAbsolute() coi nó là đường dẫn tuyệt đối POSIX và
      // một link đúng chuẩn bị báo unsafe. Đòi authority không rỗng, nên
      // "///etc/passwd" vẫn rơi xuống nhánh unsafe bên dưới.
      // Character reference được giải mã trước mọi câu hỏi khác về destination,
      // vì chuẩn giải mã nó khi dựng URL: ranh giới fragment, ranh giới query và
      // cả scheme đều đọc trên chuỗi đã giải mã. Tìm ranh giới trên chuỗi thô
      // thì "README.md&num;overview" không có dấu # nào và cả chuỗi bị đem đi mở
      // như một tên file, còn "&#35;" lại bị cắt ngay giữa chính reference của
      // nó; cả hai đều báo hỏng một link đúng chuẩn.
      const decoded = decodeReferences(target);
      // Bất kỳ URI scheme nào cũng là địa chỉ ngoài cây làm việc, không riêng
      // http(s): ghim hai scheme đó thì "mailto:" hay "ftp:" bị đem đi phân giải
      // như đường dẫn tương đối và một link đúng chuẩn bị báo hỏng. Đòi scheme
      // dài từ hai ký tự theo RFC 3986 để "c:\..." vẫn rơi xuống nhánh unsafe
      // bên dưới thay vì được bỏ qua.
      // "//host/path" là network-path reference của RFC 3986: nó mượn scheme của
      // trang đang render và trỏ ra ngoài cây làm việc y như một URL đủ scheme.
      // Không nhận dạng thì isAbsolute() coi nó là đường dẫn tuyệt đối POSIX và
      // một link đúng chuẩn bị báo unsafe. Đòi authority không rỗng, nên
      // "///etc/passwd" vẫn rơi xuống nhánh unsafe bên dưới.
      if (/^(?:[a-z][a-z0-9+.-]+:|\/\/[^\/])/i.test(decoded)) continue;
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
