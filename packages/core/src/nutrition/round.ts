// 丸めの規則。表示のためではなく、保存する値そのものの桁を決める。
//
// Space 版（`server/src/actions.ts`）が使っていた丸めをそのまま移したもの。
// kcal は整数、PFC は小数1桁、塩分は小数2桁。微量栄養素は栄養素ごとに
// 違うので `micros.ts` の `MICRO_ROUND` を見ること。

export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;
export const round0 = (n: number): number => Math.round(n);

/** 基準の要約用の短い数値表記: 150 は "150"、66.7 は "66.7"。 */
export const fmtNum = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
