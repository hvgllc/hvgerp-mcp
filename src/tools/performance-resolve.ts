/**
 * Phân giải "tên nhân sự" người dùng gõ thành đúng một người ERP cho phép xem.
 *
 * Chỉ tìm trong danh sách `people` mà `get_report_context` trả về, tức đúng danh sách người
 * mà trang báo cáo trên SPA cho người xem chọn. Không tra bảng `Employee` hay `User` riêng:
 * tra rộng hơn danh sách đó là để lộ việc một người ngoài tầm xem có tồn tại hay không.
 *
 * Luật chọn được viết theo một nguyên tắc: tự chọn khi chắc chắn, hỏi lại trong mọi trường hợp
 * còn lại. Đánh giá nhầm người là lỗi đắt nhất mà tool này có thể gây ra, vì kết quả trông hoàn
 * toàn hợp lệ.
 *
 * @module lib/erpnext/tools/performance-resolve
 */

import { isSelfReference } from "../api/identity.ts";
import { AmbiguousLinkError, type LinkCandidate } from "../api/resolve.ts";

/** Một người trong danh sách `people` của `get_report_context`. */
export interface ReportPerson {
  user: string;
  full_name?: string | null;
  designation?: string | null;
  department?: string | null;
}

/** Bậc khớp đã chọn ra người, trả kèm để mô hình biết độ chắc của phép chọn. */
export type PersonMatch = "self" | "email" | "exact" | "folded";

export interface ResolvedPerson {
  person: ReportPerson;
  match: PersonMatch;
}

/** Số ứng viên tối đa đưa vào một lỗi mơ hồ. Form MRTR là một danh sách chọn, không phải bảng. */
export const MAX_PERSON_CANDIDATES = 10;

/** Doctype của mã ứng viên: mã là email đăng nhập, tức tên bản ghi `User`. */
const CANDIDATE_DOCTYPE = "User";

const WHITESPACE = /\s+/gu;
const COMBINING_MARKS = /\p{Mn}/gu;

/** NFC, bỏ khoảng trắng hai đầu, gộp mọi khoảng trắng (kể cả NBSP) thành một dấu cách. */
export function normalizePersonInput(value: string): string {
  return value.normalize("NFC").replace(WHITESPACE, " ").trim();
}

/** Năm dấu thanh ở dạng tách rời (NFD): huyền, sắc, ngã, hỏi, nặng. */
const TONE = "[̣̀́̃̉]";
/** "hòa"/"khỏe" ở cuối từ: dấu thanh trên "o", đứng trước "a" hoặc "e". */
const TONE_ON_O = new RegExp(`o(${TONE})([ae])(?=\\s|$)`, "gu");
/** "thủy" ở cuối từ: dấu thanh trên "u", đứng trước "y". */
const TONE_ON_U = new RegExp(`u(${TONE})y(?=\\s|$)`, "gu");

/**
 * Khoá so khớp đúng dấu: chuẩn hoá, hạ chữ thường, giữ nguyên dấu.
 *
 * Vần "oa", "oe", "uy" ở cuối từ có hai cách đặt dấu thanh đều được chấp nhận: "Hòa"/"Hoà",
 * "Khỏe"/"Khoẻ", "Thủy"/"Thuỷ". Cách nào là do bộ gõ chọn chứ không phải người gõ, nên hai
 * chuỗi là CÙNG một tên. Khoá dời dấu về nguyên âm cuối cho cả hai phía; dấu thanh khác nhau
 * ("Thủy" và "Thúy") vẫn cho hai khoá khác nhau.
 */
function exactKey(value: string): string {
  return normalizePersonInput(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(TONE_ON_O, "o$2$1")
    .replace(TONE_ON_U, "uy$1")
    .normalize("NFC");
}

/** Tên không mang dấu nào, tức không cho biết gì về dấu của tên thật. */
function hasNoMarks(value: string): boolean {
  return exactKey(value) === foldPersonName(value);
}

/**
 * Khoá so khớp bỏ dấu: "Đỗ Văn Đức" và "do van duc" cho cùng một khoá.
 *
 * `Đ`/`đ` phải đổi tay trước khi tách dấu: chúng là chữ cái riêng chứ không phải `D` cộng một
 * dấu, nên NFD không tách được và bước bỏ dấu sẽ để nguyên.
 */
export function foldPersonName(value: string): string {
  return normalizePersonInput(value)
    .replace(/Đ/g, "D")
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase();
}

function displayName(person: ReportPerson): string {
  return person.full_name
    ? normalizePersonInput(person.full_name)
    : person.user;
}

/** Nhãn ứng viên: tên, chức danh, phòng ban, bỏ qua phần trống. */
function candidateLabel(person: ReportPerson): string {
  return [displayName(person), person.designation, person.department]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" - ");
}

/** Xếp ổn định theo tên rồi theo mã, để cùng một câu hỏi luôn cho cùng một danh sách. */
function byNameThenUser(a: ReportPerson, b: ReportPerson): number {
  return displayName(a).localeCompare(displayName(b), "vi") ||
    (a.user < b.user ? -1 : a.user > b.user ? 1 : 0);
}

function notFoundError(tool: string, input: string): Error {
  // Một khuôn câu duy nhất cho tên lẫn email, và không nêu tên ai khác: người hỏi không được
  // suy ra rằng mình vừa đoán trúng một người có thật nhưng nằm ngoài tầm xem.
  return new Error(
    `[${tool}] no one matching "${input}" is among the people you can view in the ERP ` +
      "performance report. Check the spelling or use their ERP email; people outside your " +
      "report scope cannot be looked up.",
  );
}

interface AmbiguityOptions {
  tool: string;
  input: string;
  inputPath: string;
  matches: ReportPerson[];
  confirm: boolean;
}

function ambiguityError(options: AmbiguityOptions): AmbiguousLinkError {
  const sorted = [...options.matches].sort(byNameThenUser);
  const truncated = sorted.length > MAX_PERSON_CANDIDATES;
  const candidates: LinkCandidate[] = sorted
    .slice(0, MAX_PERSON_CANDIDATES)
    .map((person) => ({ id: person.user, label: candidateLabel(person) }));
  const listed = candidates
    .map((candidate) => `${candidate.id} (${candidate.label})`)
    .join("; ");
  const lead = options.confirm
    ? `"${options.input}" is not an exact match for anyone you can view; the closest is: ` +
      `${listed}. Do not assume it is the same person: ask the user to confirm,`
    : `"${options.input}" matches more than one person you can view: ${listed}. ` +
      "Do not choose one yourself: ask the user which person they mean,";
  const tail = truncated
    ? ` More than ${MAX_PERSON_CANDIDATES} people match, so ask the user for the full name ` +
      "or ERP email instead of picking from this partial list."
    : "";
  return new AmbiguousLinkError({
    message:
      `[${options.tool}] ${lead} then call again with ${options.inputPath} set to ` +
      `that person's id (the email).${tail}`,
    doctype: CANDIDATE_DOCTYPE,
    identifier: options.input,
    inputPath: options.inputPath,
    candidates,
    truncated,
  });
}

export interface ResolveReportPersonOptions {
  /** Chuỗi người dùng gõ: "me", email, họ tên có hoặc không dấu. */
  input: string;
  /** `viewer` của `get_report_context`, tức email của người đang hỏi. */
  viewer: string;
  /** `people` của `get_report_context`. */
  people: ReportPerson[];
  tool: string;
  /** Tên trường đầu vào chứa `input`, để MRTR biết thay giá trị vào đâu khi hỏi lại. */
  inputPath: string;
}

/**
 * Chọn đúng một người, hoặc ném lỗi.
 *
 * Bậc khớp, dừng ở bậc đầu tiên có người:
 * - 0. "me" và các biến thể: chính người xem.
 * - 1. Có "@": khớp email không phân biệt hoa thường. Không thấy thì là "không thấy", không lùi
 *   xuống so tên, vì một email gõ sai mà lại khớp tên ai đó là chọn nhầm người.
 * - 2. Người dùng gõ CÓ dấu: đúng tên, đúng dấu (không phân biệt hoa thường, không phân biệt
 *   vị trí dấu thanh kiểu cũ và kiểu mới). Người có tên lưu KHÔNG dấu mà khớp sau khi bỏ dấu
 *   cũng tính vào bậc này: tên lưu không dấu không cho biết gì về dấu, nên không loại được ai.
 * - 3. Người dùng gõ KHÔNG dấu: khớp tên sau khi bỏ dấu. Đầu vào không dấu bỏ qua bậc 2, vì nó
 *   không phân biệt được "Nguyen Van Duc" lưu không dấu với "Nguyễn Văn Đức".
 * - 3'. Người dùng gõ CÓ dấu nhưng chỉ khớp sau khi bỏ dấu: luôn hỏi xác nhận. "Hoa" và "Hòa"
 *   là hai tên khác nhau; dấu khác là tín hiệu, không phải lỗi gõ để bỏ qua.
 * - 4. Mọi từ của đầu vào đều là từ trong tên (gõ "Đức" cho "Đỗ Văn Đức"): luôn hỏi xác nhận,
 *   kể cả khi chỉ có một người, vì danh sách người xem được là tập con của công ty.
 *
 * Bậc 2 và 3 chỉ tự chọn khi có đúng một người; từ hai người trở lên là lỗi mơ hồ.
 */
export function resolveReportPerson(
  options: ResolveReportPersonOptions,
): ResolvedPerson {
  const { tool, inputPath } = options;
  const input = normalizePersonInput(options.input);
  if (input === "") {
    throw new Error(`[${tool}] '${inputPath}' must name a person`);
  }

  if (isSelfReference(input)) {
    const own = options.people.find((person) => person.user === options.viewer);
    return { person: own ?? { user: options.viewer }, match: "self" };
  }

  if (input.includes("@")) {
    const wanted = input.toLowerCase();
    const hit = options.people.find((person) =>
      person.user.toLowerCase() === wanted
    );
    if (hit) return { person: hit, match: "email" };
    throw notFoundError(tool, input);
  }

  const pick = (
    matches: ReportPerson[],
    match: PersonMatch,
  ): ResolvedPerson => {
    if (matches.length === 1) return { person: matches[0], match };
    throw ambiguityError({ tool, input, inputPath, matches, confirm: false });
  };

  const wantedExact = exactKey(input);
  const wantedFolded = foldPersonName(input);
  const typedMarks = wantedExact !== wantedFolded;
  const folded = options.people.filter((person) =>
    foldPersonName(displayName(person)) === wantedFolded
  );

  if (typedMarks) {
    const exact = folded.filter((person) =>
      exactKey(displayName(person)) === wantedExact
    );
    if (exact.length > 0) {
      // Người trùng tên nhưng lưu không dấu vẫn có thể là người được hỏi: đưa vào cùng danh
      // sách để `pick` hỏi lại khi có từ hai người trở lên.
      const unmarked = folded.filter((person) =>
        !exact.includes(person) && hasNoMarks(displayName(person))
      );
      return pick([...exact, ...unmarked], "exact");
    }
  }

  if (folded.length > 0) {
    // Đầu vào có dấu mà vẫn tới được đây nghĩa là dấu không khớp ai: hỏi xác nhận.
    if (!typedMarks) return pick(folded, "folded");
    throw ambiguityError({
      tool,
      input,
      inputPath,
      matches: folded,
      confirm: folded.length === 1,
    });
  }

  const tokens = wantedFolded.split(" ");
  const partial = options.people.filter((person) => {
    const nameTokens = new Set(foldPersonName(displayName(person)).split(" "));
    return tokens.every((token) => nameTokens.has(token));
  });
  if (partial.length > 0) {
    throw ambiguityError({
      tool,
      input,
      inputPath,
      matches: partial,
      confirm: partial.length === 1,
    });
  }

  throw notFoundError(tool, input);
}
