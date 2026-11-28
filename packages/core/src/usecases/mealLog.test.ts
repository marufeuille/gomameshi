// 食事記録のユースケース。DB の代わりにアダプタの偽物を渡して、計算と
// 検証だけを確かめる（Muse も SQLite も要らない）。
import { expect, test } from "bun:test";
import { CoreError } from "../errors";
import { emptyMicros } from "../nutrition/micros";
import type {
  FoodRow,
  MealLogDeps,
  MealLogRow,
  NewMealLogRow,
} from "../ports";
import {
  getDailySummaries,
  getDailySummary,
  listDayEntries,
  logMeal,
} from "./mealLog";

function makeFood(over: Partial<FoodRow> = {}): FoodRow {
  return {
    id: 1,
    name: "鶏むね肉（皮なし）",
    basisType: "per100g",
    basisLabel: "100gあたり",
    kcal: 105,
    proteinG: 23.3,
    fatG: 1.9,
    carbsG: 0.1,
    saltG: 0.1,
    ...emptyMicros(),
    source: "table",
    blendJson: null,
    sourceName: null,
    sourceUrl: null,
    tableNo: "11219",
    defaultAmount: 100,
    defaultUnit: "g",
    unitGrams: null,
    useCount: 3,
    lastUsedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function rowFromInsert(id: number, values: NewMealLogRow): MealLogRow {
  return {
    ...emptyMicros(),
    saltG: null,
    assistNote: null,
    foodId: null,
    eatingOut: 0,
    ...values,
    id,
    createdAt: new Date("2026-11-28T03:00:00Z"),
  } as MealLogRow;
}

function makeDeps(foods: FoodRow[], logs: MealLogRow[] = []) {
  const rows = [...logs];
  const inserts: NewMealLogRow[] = [];
  const deps: MealLogDeps = {
    foods: {
      findById: async (id) => foods.find((f) => f.id === id) ?? null,
    },
    mealLogs: {
      listByDate: async (date) => rows.filter((r) => r.date === date),
      listByDateRange: async (from, to) =>
        rows.filter((r) => r.date >= from && r.date <= to),
      insert: async (values) => {
        inserts.push(values);
        const row = rowFromInsert(rows.length + 1, values);
        rows.push(row);
        return row;
      },
    },
  };
  return { deps, rows, inserts };
}

function logEntry(over: Partial<MealLogRow> = {}): MealLogRow {
  return {
    ...emptyMicros(),
    id: 1,
    date: "2026-11-28",
    slot: "lunch",
    foodId: 1,
    foodName: "鶏むね肉（皮なし）",
    quantity: 100,
    unit: "g",
    kcal: 105,
    proteinG: 23.3,
    fatG: 1.9,
    carbsG: 0.1,
    saltG: 0.1,
    eatingOut: 0,
    assistNote: null,
    createdAt: new Date("2026-11-28T03:00:00Z"),
    ...over,
  };
}

test("logMeal はマスタ値 × 量 から栄養値を計算して1行に残す", async () => {
  const { deps, inserts } = makeDeps([makeFood()]);
  const row = await logMeal(deps, {
    date: "2026-11-28",
    slot: "lunch",
    foodId: 1,
    quantity: 150,
    unit: "g",
  });
  expect(row.foodName).toBe("鶏むね肉（皮なし）");
  expect(row.foodId).toBe(1);
  expect(row.kcal).toBe(158);
  expect(row.proteinG).toBe(35);
  expect(row.saltG).toBe(0.15);
  expect(row.eatingOut).toBe(0);
  expect(inserts[0]?.quantity).toBe(150);
});

test("logMeal は食品マスタ側を書き換えない（利用回数はコアの関心ではない）", async () => {
  const food = makeFood();
  const { deps } = makeDeps([food]);
  await logMeal(deps, {
    date: "2026-11-28",
    slot: "dinner",
    foodId: 1,
    quantity: 100,
    unit: "g",
  });
  expect(food.useCount).toBe(3);
  expect(food.lastUsedAt).toBeNull();
});

test("logMeal は外食フラグを 0/1 で持つ", async () => {
  const { deps } = makeDeps([makeFood()]);
  const row = await logMeal(deps, {
    date: "2026-11-28",
    slot: "dinner",
    foodId: 1,
    quantity: 100,
    unit: "g",
    eatingOut: true,
  });
  expect(row.eatingOut).toBe(1);
});

test("logMeal は換算メモを版付きの JSON で保存する", async () => {
  const { deps } = makeDeps([makeFood()]);
  const row = await logMeal(deps, {
    date: "2026-11-28",
    slot: "lunch",
    foodId: 1,
    quantity: 150,
    unit: "g",
    assistNote: {
      originalText: "鶏むね肉を150gくらい",
      baseFoodName: "鶏むね肉（皮なし）",
      factor: 1,
      rationale: "皮なしとして換算",
    },
  });
  expect(JSON.parse(row.assistNote ?? "null")).toMatchObject({
    v: 1,
    data: { baseFoodName: "鶏むね肉（皮なし）" },
  });
});

test("換算メモの基準食品が記録する食品と違えば受け付けない", async () => {
  const { deps, inserts } = makeDeps([makeFood()]);
  const err = await logMeal(deps, {
    date: "2026-11-28",
    slot: "lunch",
    foodId: 1,
    quantity: 150,
    unit: "g",
    assistNote: {
      originalText: "ささみ150g",
      baseFoodName: "鶏ささみ",
      factor: 1,
      rationale: "",
    },
  }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CoreError);
  expect((err as CoreError).code).toBe("schema");
  expect((err as CoreError).message).toBe(
    "換算メモの基準食品が、記録する食品と一致しません",
  );
  expect(inserts).toHaveLength(0);
});

test("知らない食品は記録できない", async () => {
  const { deps } = makeDeps([makeFood()]);
  const err = await logMeal(deps, {
    date: "2026-11-28",
    slot: "lunch",
    foodId: 999,
    quantity: 100,
    unit: "g",
  }).catch((e: unknown) => e);
  expect((err as CoreError).code).toBe("unknown_food");
  expect((err as CoreError).message).toBe("指定された食品が見つかりません");
});

test("その食品に無い単位では記録できない", async () => {
  const { deps } = makeDeps([makeFood()]);
  const err = await logMeal(deps, {
    date: "2026-11-28",
    slot: "lunch",
    foodId: 1,
    quantity: 1,
    unit: "個",
  }).catch((e: unknown) => e);
  expect((err as CoreError).code).toBe("unit_not_defined");
});

test("入力の形が不正なら、DB を触る前に落ちる", async () => {
  const { deps, inserts } = makeDeps([makeFood()]);
  for (const bad of [
    { date: "2026/11/28", slot: "lunch", foodId: 1, quantity: 100, unit: "g" },
    { date: "2026-11-28", slot: "lunch", foodId: 1, quantity: 0, unit: "g" },
    { date: "2026-11-28", slot: "brunch", foodId: 1, quantity: 100, unit: "g" },
    { date: "2026-11-28", slot: "lunch", foodId: 1.5, quantity: 100, unit: "g" },
  ]) {
    const err = await logMeal(deps, bad as never).catch((e: unknown) => e);
    expect((err as CoreError).code).toBe("schema");
  }
  expect(inserts).toHaveLength(0);
});

test("getDailySummary はその日の行だけを足す", async () => {
  const { deps } = makeDeps(
    [makeFood()],
    [
      logEntry({ id: 1, date: "2026-11-28", kcal: 158, proteinG: 35 }),
      logEntry({ id: 2, date: "2026-11-28", kcal: 240, proteinG: 6.1, eatingOut: 1 }),
      logEntry({ id: 3, date: "2026-11-27", kcal: 500 }),
    ],
  );
  const s = await getDailySummary(deps, "2026-11-28");
  expect(s.kcal).toBe(398);
  expect(s.proteinG).toBe(41.1);
  expect(s.entryCount).toBe(2);
  expect(s.hasEatingOut).toBe(true);
});

test("listDayEntries はその日の記録を返す", async () => {
  const { deps } = makeDeps(
    [makeFood()],
    [logEntry({ id: 1 }), logEntry({ id: 2, date: "2026-11-27" })],
  );
  expect((await listDayEntries(deps, "2026-11-28")).map((r) => r.id)).toEqual([1]);
});

test("getDailySummaries は記録の無い日も logged=false で埋める", async () => {
  const { deps } = makeDeps(
    [makeFood()],
    [logEntry({ id: 1, date: "2026-11-28", kcal: 300 })],
  );
  const list = await getDailySummaries(deps, "2026-11-27", "2026-11-29");
  expect(list.map((s) => s.date)).toEqual([
    "2026-11-27",
    "2026-11-28",
    "2026-11-29",
  ]);
  expect(list[0]?.logged).toBe(false);
  expect(list[0]?.kcal).toBe(0);
  expect(list[1]?.kcal).toBe(300);
});

test("期間は最大366日、逆順は不正", async () => {
  const { deps } = makeDeps([makeFood()]);
  const tooLong = await getDailySummaries(deps, "2025-11-28", "2026-11-29").catch(
    (e: unknown) => e,
  );
  expect((tooLong as CoreError).code).toBe("date_out_of_range");
  expect((tooLong as CoreError).message).toBe("期間指定が不正です（最大366日）");

  const reversed = await getDailySummaries(deps, "2026-11-29", "2026-11-28").catch(
    (e: unknown) => e,
  );
  expect((reversed as CoreError).code).toBe("date_out_of_range");

  // ちょうど366日は通る（2025-11-29 〜 2026-11-29）
  const ok = await getDailySummaries(deps, "2025-11-29", "2026-11-29");
  expect(ok).toHaveLength(366);
});
