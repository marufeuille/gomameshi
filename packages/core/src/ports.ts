// データの読み書きのアダプタ（ポート）。
//
// コアの処理は DB を直接触らない。必要な読み書きだけをこのインター
// フェースで受け取り、器の側が実装する。
//
// - 簡易版（Space）: `server/src/store.ts` が `ctx.db` で実装する
// - ちゃんと版（スマホ）: expo-sqlite の Drizzle で同じ形を実装する
//
// 行の形は共通コアの Drizzle スキーマ（`db/schema.ts`）そのもの。方言は
// sqlite-core のままどちらの器でも使えるので、行を別の型に詰め替えずに
// 共有する。

import type { foods, mealLogs } from "./db/schema";

export type FoodRow = typeof foods.$inferSelect;
export type MealLogRow = typeof mealLogs.$inferSelect;
export type NewMealLogRow = typeof mealLogs.$inferInsert;

export interface FoodStore {
  /** id の食品。無ければ null。 */
  findById(id: number): Promise<FoodRow | null>;
}

export interface MealLogStore {
  /** その日の記録を、記録した順（id の昇順）に。 */
  listByDate(date: string): Promise<MealLogRow[]>;
  /** [startDate, endDate] の記録を、記録した順に。 */
  listByDateRange(startDate: string, endDate: string): Promise<MealLogRow[]>;
  /** 1件追加して、入った行を返す。 */
  insert(values: NewMealLogRow): Promise<MealLogRow>;
}

/** 食事記録のユースケースが必要とするものの束。 */
export interface MealLogDeps {
  foods: FoodStore;
  mealLogs: MealLogStore;
}
