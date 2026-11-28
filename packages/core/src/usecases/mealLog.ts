// 食事記録の読み書き。P1 の縦一本（`logMeal` と日次サマリ）。
//
// ここに入れたもの:
// - 入力の検証（形と範囲、使える単位、換算メモの整合）
// - マスタ食品 × 量 からの栄養値の計算（`nutrition/foods.ts`）
// - 読み取り時の集計（`nutrition/summary.ts`）
//
// ここに入れないもの（器の側の関心）:
// - 利用回数（`foods.use_count` / `last_used_at`）の加算。公開マスタから
//   外してログから導出すると決めたので、計算には混ぜない（`docs/plan.md`）
// - 画面の更新通知（`ctx.invalidateQueries`）や観測（`ai_metrics`）

import { z } from "zod";
import { CoreError } from "../errors";
import { stringifyStoredJson } from "../db/storedJson";
import { dateToDays, DATE_PATTERN, daysToDate } from "../nutrition/date";
import { nutrientsFor } from "../nutrition/foods";
import {
  groupByDate,
  summarize,
  type DaySummary,
} from "../nutrition/summary";
import type { MealLogDeps, MealLogRow } from "../ports";

export const MealSlotInput = z.enum([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
]);

export const DateInput = z
  .string()
  .regex(DATE_PATTERN, "date must be YYYY-MM-DD");

/**
 * AIアシスト換算メモ。何を言われて、どのマスタ食品を基準に、どんな係数で
 * 換算したか。栄養値そのものは常に基準食品のマスタ値から計算するので、
 * メモは経緯の説明しか持たない。
 */
export const AssistNoteInput = z.object({
  originalText: z.string().min(1).max(200),
  baseFoodName: z.string().min(1).max(200),
  factor: z.number().positive().max(10).nullable(),
  rationale: z.string().max(500),
});

/**
 * `logMeal` の入力。Space 版のアクションの request スキーマと同じ範囲を
 * 持つ（境界はホストの SDK の zod が先に見るため、同じ内容が
 * `server/src/actions.ts` 側にもある。P3 でイベント型に寄せて一本化する）。
 */
export const LogMealInput = z.object({
  date: DateInput,
  slot: MealSlotInput,
  foodId: z.number().int().positive(),
  quantity: z.number().positive().max(100000),
  unit: z.string().min(1).max(10),
  eatingOut: z.boolean().optional(),
  assistNote: AssistNoteInput.optional(),
});
export type LogMealInput = z.input<typeof LogMealInput>;

/** 期間集計の上限。Space 版と同じ 366 日。 */
export const MAX_SUMMARY_DAYS = 366;

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CoreError("schema", issue?.message ?? "入力の形が不正です", {
      path: issue?.path as ReadonlyArray<string | number> | undefined,
    });
  }
  return parsed.data;
}

/**
 * 1件の食事を記録する。栄養値はマスタ食品 × 量 から計算し、記録した時点
 * のスナップショットとして1行に残す（あとでマスタを直しても過去の日は
 * 変わらない）。
 */
export async function logMeal(
  deps: MealLogDeps,
  input: LogMealInput,
): Promise<MealLogRow> {
  const args = parseOrThrow(LogMealInput, input);
  const food = await deps.foods.findById(args.foodId);
  if (!food) {
    throw new CoreError("unknown_food", "指定された食品が見つかりません", {
      path: ["foodId"],
    });
  }
  // 換算メモは基準食品を名乗る。記録する食品と一致していなければ、
  // メモがスナップショットと別の基準を語れてしまうので受け付けない。
  if (args.assistNote && args.assistNote.baseFoodName !== food.name) {
    throw new CoreError(
      "schema",
      "換算メモの基準食品が、記録する食品と一致しません",
      { path: ["assistNote", "baseFoodName"] },
    );
  }
  const nutrients = nutrientsFor(food, args.quantity, args.unit);
  const row = await deps.mealLogs.insert({
    date: args.date,
    slot: args.slot,
    foodId: food.id,
    foodName: food.name,
    quantity: args.quantity,
    unit: args.unit,
    eatingOut: args.eatingOut ? 1 : 0,
    assistNote: args.assistNote ? stringifyStoredJson(args.assistNote) : null,
    ...nutrients,
  });
  return row;
}

/** その日の記録（記録した順）。 */
export async function listDayEntries(
  deps: MealLogDeps,
  date: string,
): Promise<MealLogRow[]> {
  const day = parseOrThrow(DateInput, date);
  return deps.mealLogs.listByDate(day);
}

/** その日の合計。記録が無い日は 0 と logged=false を返す。 */
export async function getDailySummary(
  deps: MealLogDeps,
  date: string,
): Promise<DaySummary> {
  const day = parseOrThrow(DateInput, date);
  const rows = await deps.mealLogs.listByDate(day);
  return summarize(day, rows);
}

/** [startDate, endDate]（両端を含む、最大366日）の日ごとの合計。 */
export async function getDailySummaries(
  deps: MealLogDeps,
  startDate: string,
  endDate: string,
): Promise<DaySummary[]> {
  const from = parseOrThrow(DateInput, startDate);
  const to = parseOrThrow(DateInput, endDate);
  const start = dateToDays(from);
  const end = dateToDays(to);
  if (end < start || end - start > MAX_SUMMARY_DAYS - 1) {
    throw new CoreError(
      "date_out_of_range",
      `期間指定が不正です（最大${MAX_SUMMARY_DAYS}日）`,
      { path: ["startDate"] },
    );
  }
  const rows = await deps.mealLogs.listByDateRange(from, to);
  const byDate = groupByDate(rows);
  const summaries: DaySummary[] = [];
  for (let d = start; d <= end; d++) {
    const date = daysToDate(d);
    summaries.push(summarize(date, byDate.get(date) ?? []));
  }
  return summaries;
}
