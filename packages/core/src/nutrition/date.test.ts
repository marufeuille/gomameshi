// カレンダー日は Asia/Tokyo。時刻は持たない。
import { expect, test } from "bun:test";
import { dateToDays, datesInRange, daysToDate, isDateStr, todayJstStr } from "./date";

test("日数との往復で同じ日付に戻る", () => {
  for (const d of ["1970-01-01", "2026-11-28", "2026-03-01", "2024-02-29"]) {
    expect(daysToDate(dateToDays(d))).toBe(d);
  }
});

test("日数の差がそのまま日数になる（月をまたいでも）", () => {
  expect(dateToDays("2026-12-01") - dateToDays("2026-11-28")).toBe(3);
  expect(dateToDays("2027-01-01") - dateToDays("2026-01-01")).toBe(365);
});

test("datesInRange は両端を含む", () => {
  expect(datesInRange("2026-11-28", "2026-12-01")).toEqual([
    "2026-11-28",
    "2026-11-29",
    "2026-11-30",
    "2026-12-01",
  ]);
  expect(datesInRange("2026-11-28", "2026-11-28")).toEqual(["2026-11-28"]);
});

test("todayJstStr は JST のカレンダー日（UTC の日付とずれる）", () => {
  // UTC で 2026-11-28 15:00 は、JST では翌日の 0 時。
  expect(todayJstStr(new Date("2026-11-28T15:00:00Z"))).toBe("2026-11-29");
  expect(todayJstStr(new Date("2026-11-28T14:59:59Z"))).toBe("2026-11-28");
});

test("isDateStr は YYYY-MM-DD だけを通す", () => {
  expect(isDateStr("2026-11-28")).toBe(true);
  expect(isDateStr("2026-11-28T00:00:00Z")).toBe(false);
  expect(isDateStr("2026/11/28")).toBe(false);
});
