// 目標値の正本は履歴。「現在の目標」は最新行から導出する。
import { expect, test } from "bun:test";
import {
  currentTargets,
  isCompleteTargets,
  latestTargetEntry,
  sameTargets,
  targetsAsOf,
  type TargetHistoryEntry,
} from "./targets";

const history: TargetHistoryEntry[] = [
  { effectiveDate: "2026-04-01", kcal: 2300, proteinG: 150, fatG: 60, carbsG: 260 },
  { effectiveDate: "2026-11-01", kcal: 2500, proteinG: 160, fatG: 70, carbsG: 280 },
  { effectiveDate: "2026-07-01", kcal: 2400, proteinG: 155, fatG: 65, carbsG: 270 },
];

test("並び順に関係なく、最も新しい effectiveDate の行が現在値になる", () => {
  expect(latestTargetEntry(history)?.effectiveDate).toBe("2026-11-01");
  expect(currentTargets(history)).toEqual({
    kcal: 2500,
    proteinG: 160,
    fatG: 70,
    carbsG: 280,
  });
});

test("履歴が空なら、目標値は全部不明（null）", () => {
  expect(currentTargets([])).toEqual({
    kcal: null,
    proteinG: null,
    fatG: null,
    carbsG: null,
  });
  expect(latestTargetEntry([])).toBeNull();
});

test("targetsAsOf はその日に有効だった値を返す", () => {
  expect(targetsAsOf(history, "2026-10-31").kcal).toBe(2400);
  expect(targetsAsOf(history, "2026-11-01").kcal).toBe(2500); // 当日から有効
  expect(targetsAsOf(history, "2026-03-31").kcal).toBeNull(); // 最初の行より前
});

test("isCompleteTargets は4値が揃っているかを見る", () => {
  expect(isCompleteTargets({ kcal: 2500, proteinG: 160, fatG: 70, carbsG: 280 })).toBe(true);
  expect(isCompleteTargets({ kcal: 2500, proteinG: null, fatG: 70, carbsG: 280 })).toBe(false);
});

test("sameTargets は4値すべての一致を見る", () => {
  const a = { kcal: 2500, proteinG: 160, fatG: 70, carbsG: 280 };
  expect(sameTargets(a, { ...a })).toBe(true);
  expect(sameTargets(a, { ...a, fatG: 71 })).toBe(false);
});
