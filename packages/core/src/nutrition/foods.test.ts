// 栄養値は「マスタ食品 × グラム」からしか作らない、という規則の固定。
import { expect, test } from "bun:test";
import { CoreError } from "../errors";
import { emptyMicros } from "./micros";
import {
  nutrientsFor,
  nutrientsForGrams,
  nutrientsOf,
  scaleFactor,
  type FoodBasis,
} from "./foods";

function food(over: Partial<FoodBasis> = {}): FoodBasis {
  return {
    ...emptyMicros(),
    name: "鶏むね肉（皮なし）",
    basisType: "per100g",
    unitGrams: null,
    defaultUnit: "g",
    kcal: 105,
    proteinG: 23.3,
    fatG: 1.9,
    carbsG: 0.1,
    saltG: 0.1,
    ...over,
  };
}

test("100g 基準 × グラム指定", () => {
  expect(scaleFactor(food(), 150, "g")).toBe(1.5);
  const n = nutrientsFor(food(), 150, "g");
  expect(n.kcal).toBe(158); //      158.5 → 四捨五入で整数
  expect(n.proteinG).toBe(35); //   小数1桁: 34.95 → 35
  expect(n.fatG).toBe(2.8); //      1.9×1.5 = 2.84999… なので 2.8
  expect(n.saltG).toBe(0.15); //    塩分は小数2桁
});

test("100g 基準 × 個数指定は、その単位のグラム数で換算する", () => {
  const egg = food({ name: "鶏卵", unitGrams: 50, defaultUnit: "個" });
  expect(scaleFactor(egg, 2, "個")).toBe(1);
  expect(nutrientsFor(egg, 2, "個").kcal).toBe(105);
});

test("100g 基準で単位のグラム数が未設定なら、その単位では記録できない", () => {
  let thrown: unknown;
  try {
    scaleFactor(food(), 1, "個");
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CoreError);
  const err = thrown as CoreError;
  expect(err.code).toBe("unit_not_defined");
  expect(err.message).toBe(
    "「鶏むね肉（皮なし）」は個あたりのグラム数が未設定のため、その単位では記録できません",
  );
  expect(err.allowedUnits).toEqual(["g"]);
});

test("1食分基準は単位の数をそのまま倍率にする", () => {
  const bar = food({
    name: "プロテインバー",
    basisType: "serving",
    defaultUnit: "本",
    unitGrams: 45,
    kcal: 200,
  });
  expect(scaleFactor(bar, 2, "本")).toBe(2);
  expect(nutrientsFor(bar, 2, "本").kcal).toBe(400);
  // グラムで言われたら、1単位のグラム数で割り戻す
  expect(scaleFactor(bar, 90, "g")).toBe(2);
});

test("1食分基準でグラム数が未設定なら、グラムでは記録できない", () => {
  const soup = food({ name: "みそ汁", basisType: "serving", defaultUnit: "杯" });
  let thrown: unknown;
  try {
    scaleFactor(soup, 100, "g");
  } catch (e) {
    thrown = e;
  }
  expect((thrown as CoreError).code).toBe("basis_mismatch");
  expect((thrown as CoreError).message).toBe(
    "「みそ汁」は1単位のグラム数が未設定のため、グラムでは記録できません",
  );
});

test("塩分と微量栄養素の不明は、計算しても不明のまま", () => {
  const n = nutrientsFor(food({ saltG: null, fiberG: 2 }), 200, "g");
  expect(n.saltG).toBeNull();
  expect(n.fiberG).toBe(4);
  expect(n.vitaminCMg).toBeNull();
});

test("nutrientsForGrams は基準に応じて換算し、できないときは null", () => {
  expect(nutrientsForGrams(food(), 50)?.kcal).toBe(53);
  const bar = food({ basisType: "serving", defaultUnit: "本", unitGrams: 45, kcal: 200 });
  expect(nutrientsForGrams(bar, 90)?.kcal).toBe(400);
  const soup = food({ basisType: "serving", defaultUnit: "杯" });
  expect(nutrientsForGrams(soup, 100)).toBeNull();
});

test("nutrientsOf は栄養値の列だけを残す", () => {
  const n = nutrientsOf({ ...food(), ...emptyMicros() });
  expect("name" in n).toBe(false);
  expect(n.kcal).toBe(105);
});
