// マスタ食品 × 量 から栄養値を出す。ここだけが栄養値を作る。
//
// 設計上の決まり: 栄養値を発明しない。記録に入る数値はすべてこの計算を
// 通る（エージェントやクライアントが送ってきた数値は使わない）。
//
// Space 版（`server/src/actions.ts` の `scaleFactor` / `nutrientsFor` /
// `nutrientsForGrams`）をそのまま移したもので、丸めも例外の文言も同じ。
// 引数は Drizzle の行そのものではなく必要な列だけの形にしてあるので、
// マスタを行で持たないリレーやスマホ側からも同じ関数を呼べる。

import { CoreError } from "../errors";
import { microsOf, scaleMicros, type MicroValues } from "./micros";
import { round1, round2 } from "./round";

/** PFC＋塩分＋微量栄養素。食品でも記録でも合計でも同じ形。 */
export interface NutrientValues extends MicroValues {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  saltG: number | null;
}

/**
 * 計算に必要な食品マスタの列。
 * - `basisType` 'per100g' は値が 100g あたり、'serving' は 1単位あたり
 * - `unitGrams` はその食品の1単位が何グラムか（未設定なら null）
 */
export interface FoodBasis extends NutrientValues {
  name: string;
  basisType: "per100g" | "serving";
  unitGrams: number | null;
  defaultUnit: string;
}

/** 食品の基準から、記録された量までの倍率。 */
export function scaleFactor(
  food: FoodBasis,
  quantity: number,
  unit: string,
): number {
  if (food.basisType === "per100g") {
    let grams: number;
    if (unit === "g") {
      grams = quantity;
    } else if (food.unitGrams != null) {
      grams = quantity * food.unitGrams;
    } else {
      throw new CoreError(
        "unit_not_defined",
        `「${food.name}」は${unit}あたりのグラム数が未設定のため、その単位では記録できません`,
        { path: ["unit"], allowedUnits: ["g"] },
      );
    }
    return grams / 100;
  }
  // serving 基準: quantity は単位の数。グラム指定のときだけ換算する。
  if (unit === "g") {
    if (food.unitGrams == null) {
      throw new CoreError(
        "basis_mismatch",
        `「${food.name}」は1単位のグラム数が未設定のため、グラムでは記録できません`,
        { path: ["unit"], allowedUnits: [food.defaultUnit] },
      );
    }
    return quantity / food.unitGrams;
  }
  return quantity;
}

/** 食品 × 量 の栄養値。 */
export function nutrientsFor(
  food: FoodBasis,
  quantity: number,
  unit: string,
): NutrientValues {
  const k = scaleFactor(food, quantity, unit);
  return {
    kcal: Math.round(food.kcal * k),
    proteinG: round1(food.proteinG * k),
    fatG: round1(food.fatG * k),
    carbsG: round1(food.carbsG * k),
    saltG: food.saltG == null ? null : round2(food.saltG * k),
    ...scaleMicros(microsOf(food), k),
  };
}

/** 食品 `grams` グラム分の栄養値。換算できないときは null。 */
export function nutrientsForGrams(
  food: FoodBasis,
  grams: number,
): NutrientValues | null {
  if (food.basisType === "per100g") {
    return nutrientsFor(food, grams, "g");
  }
  if (food.unitGrams == null) return null;
  return nutrientsFor(food, grams / food.unitGrams, food.defaultUnit);
}

/** PFC＋塩分＋微量栄養素だけを抜き出す（余計な列を落とす）。 */
export function nutrientsOf(src: NutrientValues): NutrientValues {
  return {
    kcal: src.kcal,
    proteinG: src.proteinG,
    fatG: src.fatG,
    carbsG: src.carbsG,
    saltG: src.saltG,
    ...microsOf(src),
  };
}
