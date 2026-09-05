import { assertEquals, assertThrows } from "@std/assert";
import { serializeCsv } from "./csv.ts";

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && char === "\r" && csv[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index++;
    } else {
      cell += char;
    }
  }
  assertEquals(quoted, false, "CSV must not end inside a quoted cell");
  row.push(cell);
  rows.push(row);
  return rows;
}

Deno.test("serializeCsv escapes commas, quotes and line breaks in headers and cells", () => {
  const columns = [
    "a,b",
    'say "hi"',
    "line\nfeed",
    "carriage\rreturn",
    "both\r\nlines",
  ];
  const row = Object.fromEntries(columns.map((column) => [column, column]));
  const expected =
    '"a,b","say ""hi""","line\nfeed","carriage\rreturn","both\r\nlines"';
  const csv = serializeCsv(columns, [row]);
  assertEquals(csv, `${expected}\r\n${expected}`);
  assertEquals(parseCsv(csv), [columns, columns]);
});

Deno.test("serializeCsv protects formula strings and headers without trimming their contents", () => {
  const values = [
    "=1+1",
    "+SUM(1,2)",
    "-12",
    "@SUM(1,2)",
    " =1+1",
    " \t\r\n-12",
  ];
  const csv = serializeCsv(values, [
    Object.fromEntries(values.map((value) => [value, value])),
  ]);
  const expected =
    "'=1+1,\"'+SUM(1,2)\",'-12,\"'@SUM(1,2)\",' =1+1,\"' \t\r\n-12\"";
  assertEquals(csv, `${expected}\r\n${expected}`);
  assertEquals(parseCsv(csv), [
    values.map((value) => `'${value}`),
    values.map((value) => `'${value}`),
  ]);
});

Deno.test("serializeCsv protects leading tab, CR and LF even without a formula", () => {
  for (const value of ["\tplain", "\rplain", "\nplain", "\t", "\r\n"]) {
    const csv = serializeCsv([value], [{ [value]: value }]);
    assertEquals(parseCsv(csv), [[`'${value}`], [`'${value}`]]);
  }
});

Deno.test("serializeCsv preserves ordinary text, Unicode and embedded apostrophes", () => {
  const values = [
    "Công ty Việt",
    "  ordinary",
    "value=1",
    "O'Brien",
    "'=1+1",
    "",
    " \tplain",
  ];
  assertEquals(
    parseCsv(serializeCsv(["text"], values.map((text) => ({ text })))),
    [["text"], ...values.map((value) => [value])],
  );
});

Deno.test("serializeCsv preserves finite number precision without grouping or text prefixes", () => {
  const values = [
    -12,
    0,
    -0,
    1234.56789,
    1e21,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
  ];
  assertEquals(
    serializeCsv(["number"], values.map((number) => ({ number }))),
    `number\r\n${values.map(String).join("\r\n")}`,
  );
  assertEquals(
    serializeCsv(["number", "text"], [{ number: -12, text: "-12" }]),
    "number,text\r\n-12,'-12",
  );
});

Deno.test("serializeCsv rejects non-finite numbers", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assertThrows(
      () => serializeCsv(["value"], [{ value }]),
      TypeError,
      "finite",
    );
  }
});

Deno.test("serializeCsv uses empty nullish cells and lowercase boolean values", () => {
  assertEquals(
    serializeCsv(["null", "undefined", "missing", "yes", "no"], [{
      null: null,
      undefined: undefined,
      yes: true,
      no: false,
    }]),
    "null,undefined,missing,yes,no\r\n,,,true,false",
  );
});

Deno.test("serializeCsv stringifies objects and arrays before escaping", () => {
  assertEquals(
    serializeCsv(["object", "array"], [{
      object: { text: 'Công ty, "Việt"', count: 2 },
      array: [1, true, null],
    }]),
    'object,array\r\n"{""text"":""Công ty, \\""Việt\\"""",""count"":2}","[1,true,null]"',
  );
});

Deno.test("serializeCsv propagates JSON serialization errors", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assertThrows(() => serializeCsv(["value"], [{ value: circular }]), TypeError);
  const error = new Error("Serialization failed");
  const caught = assertThrows(() =>
    serializeCsv(["value"], [{
      value: {
        toJSON() {
          throw error;
        },
      },
    }])
  );
  assertEquals(caught, error);
  assertThrows(
    () => serializeCsv(["value"], [{ value: { number: 1n } }]),
    TypeError,
  );
});

Deno.test("serializeCsv rejects unsupported or unserializable values explicitly", () => {
  for (
    const value of [Symbol("text"), 1n, () => "text", {
      toJSON: () => undefined,
    }]
  ) {
    assertThrows(() => serializeCsv(["value"], [{ value }]), TypeError);
  }
});

Deno.test("serializeCsv keeps column order, row order and selected fields only", () => {
  const rows = [{ second: 2, first: "one", hidden: "secret" }, {
    second: -12,
    first: "two",
  }];
  assertEquals(
    serializeCsv(["first", "second"], rows),
    "first,second\r\none,2\r\ntwo,-12",
  );
  assertEquals(serializeCsv(["first", "second"], []), "first,second");
  assertEquals(rows[0], { second: 2, first: "one", hidden: "secret" });
});

Deno.test("serializeCsv round-trips the three-row local browser fixture", () => {
  const columns = ["name", "customer_name", "amount", "notes"];
  const rows = [
    {
      name: "CUSTOMER-001",
      customer_name: "Alpha, Incorporated",
      notes: 'A "quoted" value',
      amount: 42,
    },
    {
      name: "CUSTOMER-002",
      customer_name: "=1+1",
      notes: "First line\nSecond line",
      amount: 0,
    },
    {
      name: "CUSTOMER-003",
      customer_name: "Công ty Việt",
      notes: "+SUM(1,2)",
      amount: -1,
    },
  ];
  const expected =
    'name,customer_name,amount,notes\r\nCUSTOMER-001,"Alpha, Incorporated",42,"A ""quoted"" value"\r\nCUSTOMER-002,\'=1+1,0,"First line\nSecond line"\r\nCUSTOMER-003,Công ty Việt,-1,"\'+SUM(1,2)"';
  const csv = serializeCsv(columns, rows);
  assertEquals(csv, expected);
  assertEquals(parseCsv(csv), [
    columns,
    ["CUSTOMER-001", "Alpha, Incorporated", "42", 'A "quoted" value'],
    ["CUSTOMER-002", "'=1+1", "0", "First line\nSecond line"],
    ["CUSTOMER-003", "Công ty Việt", "-1", "'+SUM(1,2)"],
  ]);
});
