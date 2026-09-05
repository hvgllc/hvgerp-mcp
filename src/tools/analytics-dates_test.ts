import { assertEquals } from "@std/assert";
import { analyticsDateWindow, analyticsMonthIndex } from "./analytics-dates.ts";

for (
  const [today, previousStart, previousEnd, nextDay, quarterStart] of [
    ["2026-09-05", "2026-08-01", "2026-08-31", "2026-09-06", "2026-07-01"],
    ["2026-01-01", "2025-12-01", "2025-12-31", "2026-01-02", "2026-01-01"],
    ["2026-12-31", "2026-11-01", "2026-11-30", "2027-01-01", "2026-10-01"],
    ["2024-02-29", "2024-01-01", "2024-01-31", "2024-03-01", "2024-01-01"],
    ["2024-03-01", "2024-02-01", "2024-02-29", "2024-03-02", "2024-01-01"],
    ["2026-03-31", "2026-02-01", "2026-02-28", "2026-04-01", "2026-01-01"],
    ["2026-05-01", "2026-04-01", "2026-04-30", "2026-05-02", "2026-04-01"],
  ] as const
) {
  Deno.test(`analytics date window uses UTC calendar arithmetic for ${today}`, () => {
    const window = analyticsDateWindow(today);
    assertEquals(window.start, `${today.slice(0, 7)}-01`);
    assertEquals(window.end, today);
    assertEquals(window.previousStart, previousStart);
    assertEquals(window.previousEnd, previousEnd);
    assertEquals(window.nextDay, nextDay);
    assertEquals(window.quarterStart, quarterStart);
    assertEquals(window.yearStart, `${today.slice(0, 4)}-01-01`);
    assertEquals(window.monthKeys, [today.slice(0, 7)]);
  });
}

Deno.test("analytics month buckets preserve dates at year and leap boundaries", () => {
  const window = analyticsDateWindow("2024-03-01", 6);
  assertEquals(window.start, "2023-10-01");
  assertEquals(window.monthKeys, [
    "2023-10",
    "2023-11",
    "2023-12",
    "2024-01",
    "2024-02",
    "2024-03",
  ]);
  assertEquals(window.labels, [
    "Oct 23",
    "Nov 23",
    "Dec 23",
    "Jan 24",
    "Feb 24",
    "Mar 24",
  ]);
  for (
    const [date, index] of [
      ["2023-09-30", -1],
      ["2023-10-01", 0],
      ["2023-12-31", 2],
      ["2024-01-01", 3],
      ["2024-02-29", 4],
      ["2024-03-01", 5],
      ["2024-04-01", -1],
    ] as const
  ) {
    assertEquals(analyticsMonthIndex(date, window.monthKeys), index);
  }
});
