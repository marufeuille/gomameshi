// 日次の合計は、記録の行を読み取り時に足して作る（保存しない）。
import { expect, test } from "bun:test";
import { emptyMicros } from "./micros";
import { groupByDate, summarize, type SummarizableEntry } from "./summary";

function entry(over: Partial<SummarizableEntry> = {}): SummarizableEntry {
  return {
    ...emptyMicros(),
    kcal: 0,
    proteinG: 0,
    fatG: 0,
    carbsG: 0,
    saltG: null,
    eatingOut: 0,
    ...over,
  };
}

test("記録が無い日は 0 と logged=false", () => {
  const s = summarize("2026-11-28", []);
  expect(s.logged).toBe(false);
  expect(s.entryCount).toBe(0);
  expect(s.kcal).toBe(0);
  expect(s.saltG).toBeNull(); // 塩分は「不明」で、0 ではない
  expect(s.hasEatingOut).toBe(false);
});

test("PFC は小数1桁、kcal は整数、塩分は小数2桁で合計する", () => {
  const s = summarize("2026-11-28", [
    entry({ kcal: 158.5, proteinG: 34.95, fatG: 2.85, carbsG: 0.15, saltG: 0.15 }),
    entry({ kcal: 240.4, proteinG: 6.1, fatG: 0.9, carbsG: 51.2, saltG: 0.004 }),
  ]);
  expect(s.kcal).toBe(399);
  expect(s.proteinG).toBe(41.1);
  expect(s.fatG).toBe(3.8);
  expect(s.carbsG).toBe(51.4);
  expect(s.saltG).toBe(0.15);
  expect(s.entryCount).toBe(2);
  expect(s.logged).toBe(true);
});

test("塩分は1件でも分かっていればその分だけ合計する", () => {
  const s = summarize("2026-11-28", [entry({ saltG: 1.2 }), entry({ saltG: null })]);
  expect(s.saltG).toBe(1.2);
});

test("外食フラグは件数と有無の両方を返す", () => {
  const s = summarize("2026-11-28", [
    entry({ eatingOut: 1 }),
    entry({ eatingOut: 0 }),
    entry({ eatingOut: 1 }),
  ]);
  expect(s.eatingOutCount).toBe(2);
  expect(s.hasEatingOut).toBe(true);
});

test("微量栄養素は分かっている値だけを足し、全部不明なら null", () => {
  const s = summarize("2026-11-28", [
    entry({ fiberG: 1.2 }),
    entry({ fiberG: 2.4, potassiumMg: 300 }),
  ]);
  expect(s.fiberG).toBe(3.6);
  expect(s.potassiumMg).toBe(300);
  expect(s.vitaminCMg).toBeNull();
});

test("groupByDate は日付ごとに、順序を保って分ける", () => {
  const rows = [
    { date: "2026-11-27", id: 1 },
    { date: "2026-11-28", id: 2 },
    { date: "2026-11-27", id: 3 },
  ];
  const byDate = groupByDate(rows);
  expect(byDate.get("2026-11-27")?.map((r) => r.id)).toEqual([1, 3]);
  expect(byDate.get("2026-11-29")).toBeUndefined();
});
