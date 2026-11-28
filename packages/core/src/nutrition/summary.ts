// 日次の集計。記録の行を読み取り時に足して出す。
//
// 記録は1行ごとに、記録した時点の栄養値のスナップショットを持っている
// （あとで食品マスタを直しても過去の日が書き換わらないようにするため）。
// 合計は保存せず、必要なときに行を足して作る。
//
// Space 版（`server/src/actions.ts` の `summarize`）をそのまま移したもの。

import { microsOf, sumMicros, type MicroValues } from "./micros";
import { round1, round2 } from "./round";

/** 集計に必要な記録1行分の列。 */
export interface SummarizableEntry extends MicroValues {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  saltG: number | null;
  /** 外食フラグ（SQLite の 0/1 をそのまま使う）。 */
  eatingOut: number;
}

export interface DaySummary extends MicroValues {
  date: string;
  logged: boolean;
  entryCount: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  saltG: number | null;
  /** 外食の記録を含む日か、と何件含むか。 */
  hasEatingOut: boolean;
  eatingOutCount: number;
}

export function summarize(
  date: string,
  rows: readonly SummarizableEntry[],
): DaySummary {
  let kcal = 0,
    p = 0,
    f = 0,
    c = 0,
    salt = 0,
    hasSalt = false,
    eatingOutCount = 0;
  for (const r of rows) {
    kcal += r.kcal;
    p += r.proteinG;
    f += r.fatG;
    c += r.carbsG;
    if (r.saltG != null) {
      salt += r.saltG;
      hasSalt = true;
    }
    if (r.eatingOut === 1) eatingOutCount += 1;
  }
  return {
    date,
    logged: rows.length > 0,
    entryCount: rows.length,
    kcal: Math.round(kcal),
    proteinG: round1(p),
    fatG: round1(f),
    carbsG: round1(c),
    saltG: hasSalt ? round2(salt) : null,
    // 微量栄養素の合計: 分かっている値だけを足し、その栄養素が全部不明な
    // 日は null のまま（「データが無い」が 0 に見えないようにする）。
    ...sumMicros(rows.map((r) => microsOf(r))),
    hasEatingOut: eatingOutCount > 0,
    eatingOutCount,
  };
}

/** 日付ごとに記録をまとめる（期間の集計で使う）。 */
export function groupByDate<T extends { date: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const byDate = new Map<string, T[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  return byDate;
}
