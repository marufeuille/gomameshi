// Space 版のアダプタ（共通コアのポートの実装）。
//
// コアのユースケースは DB を直接触らず、`packages/core/src/ports.ts` の
// インターフェース越しに読み書きする。ここはそれを Muse の `ctx.db` で
// 実装するだけの薄い層で、問い合わせの形は今まで `actions.ts` が書いて
// いたものと同じ（その日の記録は id の昇順、期間は両端を含む）。
//
// ちゃんと版（スマホ）では、同じインターフェースを expo-sqlite の Drizzle
// で実装する。コアの計算と検証はどちらでもそのまま動く。

import type { Ctx } from "@hatch/space-sdk";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import * as schema from "./schema";
import type {
  FoodStore,
  MealLogDeps,
  MealLogStore,
} from "../../packages/core/src/ports";

type Db = ReturnType<Ctx["db"]>;

export function foodStore(db: Db): FoodStore {
  return {
    async findById(id) {
      const rows = await db
        .select()
        .from(schema.foods)
        .where(eq(schema.foods.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

export function mealLogStore(db: Db): MealLogStore {
  return {
    async listByDate(date) {
      return db
        .select()
        .from(schema.mealLogs)
        .where(eq(schema.mealLogs.date, date))
        .orderBy(asc(schema.mealLogs.id));
    },
    async listByDateRange(startDate, endDate) {
      return db
        .select()
        .from(schema.mealLogs)
        .where(
          and(
            gte(schema.mealLogs.date, startDate),
            lte(schema.mealLogs.date, endDate),
          ),
        )
        .orderBy(asc(schema.mealLogs.id));
    },
    async insert(values) {
      const inserted = await db.insert(schema.mealLogs).values(values).returning();
      const row = inserted[0];
      if (!row) throw new Error("logMeal: insert returned no rows");
      return row;
    },
  };
}

/** 食事記録のユースケースに渡すアダプタ一式。 */
export function mealLogDeps(db: Db): MealLogDeps {
  return { foods: foodStore(db), mealLogs: mealLogStore(db) };
}
