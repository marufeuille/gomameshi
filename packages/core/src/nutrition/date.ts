// 日付。カレンダー日は Asia/Tokyo の YYYY-MM-DD で、時刻は持たない。
//
// Space 版（`server/src/actions.ts`）の `dateToDays` / `daysToDate` /
// `todayJstStr` をそのまま移したもの。

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(s: string): boolean {
  return DATE_PATTERN.test(s);
}

/** YYYY-MM-DD を 1970-01-01 からの日数にする。 */
export function dateToDays(s: string): number {
  const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** 日数を YYYY-MM-DD に戻す。 */
export function daysToDate(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** 今日のカレンダー日（Asia/Tokyo、YYYY-MM-DD）。 */
export function todayJstStr(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    now,
  );
}

/** [startDate, endDate] に含まれる日付を順に並べる。 */
export function datesInRange(startDate: string, endDate: string): string[] {
  const start = dateToDays(startDate);
  const end = dateToDays(endDate);
  const out: string[] = [];
  for (let d = start; d <= end; d++) out.push(daysToDate(d));
  return out;
}
