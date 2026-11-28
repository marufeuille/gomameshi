// 共通コアの入口。
//
// 型の下書きは `./types`（`@gomameshi/core/types`）に、計算・検証・ユース
// ケースはここから出す。器（Space 版・スマホ版）は `ports.ts` のアダプタを
// 実装して、ユースケースに渡す。

export * from "./errors";
export * from "./ports";
export * from "./nutrition/round";
export * from "./nutrition/micros";
export * from "./nutrition/foods";
export * from "./nutrition/summary";
export * from "./nutrition/date";
export * from "./nutrition/targets";
export * from "./db/storedJson";
export * as schema from "./db/schema";
export * as mealLogUseCases from "./usecases/mealLog";
