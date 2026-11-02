/**
 * Performance person resolution tests
 *
 * Kiểm bảng bậc khớp tên: chỉ tìm trong danh sách người mà ERP cho người xem chọn, tự chọn khi
 * chắc chắn, và hỏi lại trong mọi trường hợp còn lại. Hàm thuần nên không cần client giả.
 *
 * @module lib/erpnext/tests/tools/performance-resolve_test
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { AmbiguousLinkError } from "../api/resolve.ts";
import {
  foldPersonName,
  MAX_PERSON_CANDIDATES,
  normalizePersonInput,
  type ReportPerson,
  resolveReportPerson,
} from "./performance-resolve.ts";

const TOOL = "erpnext_employee_performance_get";
const VIEWER = "lead01@havigroup.llc";

const PEOPLE: ReportPerson[] = [
  {
    user: VIEWER,
    full_name: "Trần Văn Lực",
    designation: "Trưởng nhóm thiết kế",
    department: "Design - HVG",
  },
  {
    user: "duc@havigroup.llc",
    full_name: "Đỗ Văn Đức",
    designation: "Chuyên viên thiết kế",
    department: "Design - HVG",
  },
  {
    user: "hoa@havigroup.llc",
    full_name: "Lê Thị Hòa",
    designation: "Nhân viên vận đơn",
    department: "Fulfillment - HVG",
  },
  {
    user: "an1@havigroup.llc",
    full_name: "Nguyễn Văn An",
    designation: "Chuyên viên thiết kế",
    department: "Design - HVG",
  },
  {
    user: "an2@havigroup.llc",
    full_name: "Nguyễn Văn An",
    designation: "Nhân viên bán hàng",
    department: "Team Hòa",
  },
];

function resolve(input: string, people: ReportPerson[] = PEOPLE) {
  return resolveReportPerson({
    input,
    viewer: VIEWER,
    people,
    tool: TOOL,
    inputPath: "employee",
  });
}

/** Lỗi mơ hồ mà một đầu vào sinh ra; hỏng test nếu nó lại tự chọn được người. */
function ambiguity(
  input: string,
  people: ReportPerson[] = PEOPLE,
): AmbiguousLinkError {
  const error = assertThrows(() => resolve(input, people));
  assertInstanceOf(error, AmbiguousLinkError);
  return error;
}

/** Lỗi "không thấy" của một đầu vào; hỏng test nếu nó thành lỗi mơ hồ. */
function notFound(input: string, people: ReportPerson[] = PEOPLE): Error {
  const error = assertThrows(() => resolve(input, people));
  assertInstanceOf(error, Error);
  assert(
    !(error instanceof AmbiguousLinkError),
    `"${input}" should be reported as not found, not as ambiguous`,
  );
  return error;
}

// ── Chuẩn hoá và gấp chữ ─────────────────────────────────────────────────────

Deno.test("foldPersonName - drops marks, folds đ and case, collapses spaces", () => {
  assertEquals(foldPersonName("Đỗ Văn Đức"), "do van duc");
  assertEquals(foldPersonName("  LÊ   THỊ  HÒA "), "le thi hoa");
  // Chuỗi NFD (dấu tách rời, kiểu macOS gõ ra) phải gấp giống hệt chuỗi NFC.
  assertEquals(foldPersonName("Đỗ Văn Đức".normalize("NFD")), "do van duc");
});

Deno.test("normalizePersonInput - NFC, trimmed, single spaces, case kept", () => {
  assertEquals(
    normalizePersonInput("  Đỗ  Văn   Đức ".normalize("NFD")),
    "Đỗ Văn Đức",
  );
});

// ── Bậc 0 và 1: chính mình, email ────────────────────────────────────────────

Deno.test("resolveReportPerson - me and its aliases resolve to the viewer", () => {
  for (const input of ["me", "Me", " myself ", "@me"]) {
    const resolved = resolve(input);
    assertEquals(resolved.person.user, VIEWER, input);
    assertEquals(resolved.match, "self", input);
  }
});

Deno.test("resolveReportPerson - an exact email resolves regardless of case", () => {
  const resolved = resolve("  DUC@havigroup.llc ");
  assertEquals(resolved.person.user, "duc@havigroup.llc");
  assertEquals(resolved.match, "email");
});

Deno.test("resolveReportPerson - an email outside the list is not found, never matched by name", () => {
  const error = notFound("outsider@havigroup.llc");
  assertStringIncludes(error.message, `[${TOOL}]`);
  assertStringIncludes(error.message, '"outsider@havigroup.llc"');
});

// ── Bậc 2 và 3: tên đúng dấu, tên gõ không dấu ───────────────────────────────

Deno.test("resolveReportPerson - the exact name with its marks resolves, case-insensitively", () => {
  assertEquals(resolve("Đỗ Văn Đức").person.user, "duc@havigroup.llc");
  assertEquals(resolve("đỗ văn đức").match, "exact");
  assertEquals(
    resolve("Đỗ Văn Đức".normalize("NFD")).person.user,
    "duc@havigroup.llc",
  );
});

Deno.test("resolveReportPerson - a name typed without marks resolves by folding", () => {
  const resolved = resolve("Do Van Duc");
  assertEquals(resolved.person.user, "duc@havigroup.llc");
  assertEquals(resolved.match, "folded");
  assertEquals(resolve("do van duc").match, "folded");
});

Deno.test("resolveReportPerson - the exact spelling wins over a folded twin", () => {
  const people: ReportPerson[] = [
    ...PEOPLE,
    { user: "hoa2@havigroup.llc", full_name: "Lê Thị Hoa" },
  ];
  assertEquals(resolve("Lê Thị Hoa", people).person.user, "hoa2@havigroup.llc");
  assertEquals(resolve("Lê Thị Hòa", people).person.user, "hoa@havigroup.llc");

  // Gõ không dấu thì cả hai đều khớp sau khi gấp, nên phải hỏi lại.
  const error = ambiguity("Le Thi Hoa", people);
  assertEquals(
    error.candidates.map((candidate) => candidate.id).sort(),
    ["hoa2@havigroup.llc", "hoa@havigroup.llc"],
  );
});

// ── Bậc 3' và 4: không bao giờ tự chọn ────────────────────────────────────────

Deno.test("resolveReportPerson - different marks ask for confirmation even with one match", () => {
  // "Hoa" và "Hòa" là hai tên khác nhau. Người dùng đã gõ dấu, nên dấu khác là tín hiệu, không
  // phải lỗi gõ để bỏ qua.
  const error = ambiguity("Lê Thị Hoa");
  assertEquals(error.candidates.map((candidate) => candidate.id), [
    "hoa@havigroup.llc",
  ]);
  assertStringIncludes(error.message, "confirm");
});

Deno.test("resolveReportPerson - a partial name is never picked on its own", () => {
  const error = ambiguity("Đức");
  assertEquals(error.candidates.map((candidate) => candidate.id), [
    "duc@havigroup.llc",
  ]);
});

Deno.test("resolveReportPerson - a given name shared by several people lists them all", () => {
  const people: ReportPerson[] = [
    ...PEOPLE,
    {
      user: "an3@havigroup.llc",
      full_name: "Lê Văn Ân",
      designation: "Nhân viên vận đơn",
      department: "Fulfillment - HVG",
    },
  ];
  const error = ambiguity("An", people);
  assertEquals(
    error.candidates.map((candidate) => candidate.id).sort(),
    ["an1@havigroup.llc", "an2@havigroup.llc", "an3@havigroup.llc"],
  );
});

// ── Lỗi mơ hồ: hình dạng mà MRTR và mô hình cần ───────────────────────────────

Deno.test("resolveReportPerson - namesakes become an MRTR-ready ambiguity", () => {
  const error = ambiguity("Nguyễn Văn An");
  assertEquals(error.identifier, "Nguyễn Văn An");
  assertEquals(error.inputPath, "employee");
  assertEquals(error.truncated, false);
  assertEquals(error.candidates, [
    {
      id: "an1@havigroup.llc",
      label: "Nguyễn Văn An - Chuyên viên thiết kế - Design - HVG",
    },
    {
      id: "an2@havigroup.llc",
      label: "Nguyễn Văn An - Nhân viên bán hàng - Team Hòa",
    },
  ]);
  // Không có MRTR thì chính câu này đến tay mô hình: nó phải bảo mô hình hỏi người dùng,
  // không được tự chọn.
  assertStringIncludes(error.message, `[${TOOL}]`);
  assertStringIncludes(error.message, "ask the user");
  assertStringIncludes(error.message, "an1@havigroup.llc");
  assertStringIncludes(error.message, "Nhân viên bán hàng");
});

Deno.test("resolveReportPerson - matching stops at the first tier with a hit, ordered by name", () => {
  const people: ReportPerson[] = [
    { user: "z@havigroup.llc", full_name: "Phạm Thị Mai Anh" },
    { user: "y@havigroup.llc", full_name: "Mai Anh" },
    { user: "x@havigroup.llc", full_name: "Mai Anh" },
  ];
  // Bậc khớp đúng tên đã có người thì dừng ở đó: người chỉ khớp một phần không vào danh sách,
  // và hai người trùng tên được xếp ổn định theo mã.
  const error = ambiguity("Mai Anh", people);
  assertEquals(error.candidates.map((candidate) => candidate.id), [
    "x@havigroup.llc",
    "y@havigroup.llc",
  ]);
});

Deno.test("resolveReportPerson - labels skip missing parts and fall back to the user id", () => {
  const people: ReportPerson[] = [
    { user: "a@havigroup.llc", full_name: "Võ An", designation: null },
    { user: "b@havigroup.llc", full_name: "", department: "Design - HVG" },
  ];
  const error = ambiguity("An", [
    ...people,
    { user: "c@havigroup.llc", full_name: "Hồ An" },
  ]);
  assertEquals(error.candidates[0], { id: "c@havigroup.llc", label: "Hồ An" });
  assertEquals(error.candidates[1], { id: "a@havigroup.llc", label: "Võ An" });
  // Người không có họ tên vẫn tìm được bằng email, và nhãn của họ là chính email.
  assertEquals(
    resolve("b@havigroup.llc", people).person.user,
    "b@havigroup.llc",
  );
});

Deno.test("resolveReportPerson - more matches than the cap are truncated and say so", () => {
  const people: ReportPerson[] = Array.from({ length: 13 }, (_, index) => ({
    user: `an${index}@havigroup.llc`,
    full_name: `Nguyễn Văn An`,
    designation: `Vị trí ${index}`,
  }));
  const error = ambiguity("Nguyễn Văn An", people);
  assertEquals(error.candidates.length, MAX_PERSON_CANDIDATES);
  assertEquals(error.truncated, true);
  assertStringIncludes(error.message, "full name or ERP email");
});

// ── Không thấy: một câu cho cả "không có" và "không được xem" ─────────────────

Deno.test("resolveReportPerson - not found reveals nothing about anyone else", () => {
  const error = notFound("Phạm Văn Ngoài");
  assertStringIncludes(error.message, '"Phạm Văn Ngoài"');
  for (const person of PEOPLE) {
    assert(
      !error.message.includes(person.user),
      `not-found message leaks ${person.user}`,
    );
    assert(
      !error.message.includes(person.full_name ?? "\u0000"),
      `not-found message leaks ${person.full_name}`,
    );
  }
  // Cùng một khuôn câu cho tên và cho email: không ai suy ra được mình đã đoán trúng một
  // người có thật nhưng ngoài tầm xem.
  const byEmail = notFound("ghost@havigroup.llc");
  assertEquals(
    error.message.replace('"Phạm Văn Ngoài"', "<input>"),
    byEmail.message.replace('"ghost@havigroup.llc"', "<input>"),
  );
});

Deno.test("resolveReportPerson - an empty input is rejected before matching", () => {
  const error = notFound("   ");
  assertNotEquals(error.message, "");
});
