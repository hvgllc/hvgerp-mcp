const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Nhận ngày nghiệp vụ đã chốt; mọi phép lịch đều độc lập timezone của host. */
export function analyticsDateWindow(today: string, monthsBack = 1) {
  const [year, month, day] = today.split("-").map(Number);
  const date = (monthIndex: number, dayOfMonth = 1) =>
    new Date(Date.UTC(year, monthIndex, dayOfMonth)).toISOString().slice(0, 10);
  const monthKeys: string[] = [];
  const labels: string[] = [];
  for (let offset = 0; offset < monthsBack; offset++) {
    const start = date(month - monthsBack + offset);
    monthKeys.push(start.slice(0, 7));
    labels.push(
      `${MONTH_NAMES[Number(start.slice(5, 7)) - 1]} ${start.slice(2, 4)}`,
    );
  }
  return {
    start: date(month - monthsBack),
    end: today,
    nextDay: date(month - 1, day + 1),
    previousStart: date(month - 2),
    previousEnd: date(month - 1, 0),
    quarterStart: date(Math.floor((month - 1) / 3) * 3),
    yearStart: date(0),
    monthKeys,
    labels,
  };
}

/** Date của Frappe là ngày lịch, không phải instant để đổi sang giờ local. */
export function analyticsMonthIndex(date: string, monthKeys: string[]): number {
  return monthKeys.indexOf(date.slice(0, 7));
}
