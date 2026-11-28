// 微量栄養素（12項目）。PFC＋塩分と一緒に、食品マスタ・記録のスナップ
// ショット・調査記録・レシピの各行と合計・配合の基準を回る。
//
// 不明は必ず null。0 で埋めず、推測もしない。日次の合計は分かっている値
// だけを足し、その栄養素が全部不明なら null のままにする（「データが無い」
// が 0 に見えないようにする）。
//
// Space 版（`server/src/actions.ts`）の実装をそのまま移したもので、
// 丸めも含めて値は変わらない。

import { round0, round1, round2 } from "./round";

export const MICRO_KEYS = [
  "fiberG",
  "potassiumMg",
  "calciumMg",
  "magnesiumMg",
  "ironMg",
  "vitaminDMcg",
  "vitaminB1Mg",
  "vitaminB2Mg",
  "vitaminB6Mg",
  "vitaminB12Mcg",
  "folateMcg",
  "vitaminCMg",
] as const;

export type MicroKey = (typeof MICRO_KEYS)[number];
export type MicroValues = Record<MicroKey, number | null>;

export const MICRO_ROUND: Record<MicroKey, (n: number) => number> = {
  fiberG: round1,
  potassiumMg: round0,
  calciumMg: round0,
  magnesiumMg: round0,
  ironMg: round2,
  vitaminDMcg: round1,
  vitaminB1Mg: round2,
  vitaminB2Mg: round2,
  vitaminB6Mg: round2,
  vitaminB12Mcg: round1,
  folateMcg: round0,
  vitaminCMg: round0,
};

/** 12項目だけを抜き出す（余計な列を持つ行からでも使える）。 */
export function microsOf(src: MicroValues): MicroValues {
  const out = {} as MicroValues;
  for (const k of MICRO_KEYS) out[k] = src[k];
  return out;
}

export function emptyMicros(): MicroValues {
  const out = {} as MicroValues;
  for (const k of MICRO_KEYS) out[k] = null;
  return out;
}

/** 分かっている微量栄養素を k 倍する（栄養素ごとの桁で丸める）。 */
export function scaleMicros(m: MicroValues, k: number): MicroValues {
  const out = {} as MicroValues;
  for (const key of MICRO_KEYS) {
    const v = m[key];
    out[key] = v == null ? null : MICRO_ROUND[key](v * k);
  }
  return out;
}

/** 栄養素ごとに分かっている値を足す。1件も分からなければ null。 */
export function sumMicros(list: MicroValues[]): MicroValues {
  const out = {} as MicroValues;
  for (const key of MICRO_KEYS) {
    let sum = 0;
    let known = false;
    for (const m of list) {
      const v = m[key];
      if (v != null) {
        sum += v;
        known = true;
      }
    }
    out[key] = known ? MICRO_ROUND[key](sum) : null;
  }
  return out;
}

/** 省略可能な入力から（キーが無ければ不明＝null）。 */
export function microsFromInput(args: Partial<MicroValues>): MicroValues {
  const out = {} as MicroValues;
  for (const k of MICRO_KEYS) out[k] = args[k] ?? null;
  return out;
}

/** 成分表のタプル（位置 7..18 が MICRO_KEYS の順）から。 */
export function microsFromTuple(row: { [i: number]: unknown }): MicroValues {
  const out = {} as MicroValues;
  MICRO_KEYS.forEach((k, i) => {
    const v = row[7 + i];
    out[k] = typeof v === "number" ? v : null;
  });
  return out;
}

export function sameMicros(a: MicroValues, b: MicroValues): boolean {
  return MICRO_KEYS.every((k) => a[k] === b[k]);
}

/**
 * 微量栄養素の列が無い古い保存 JSON を読むための補完。キーが無いものを
 * null で埋めるだけで、既にある値は触らない。
 */
export function fillMicros(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  return { ...emptyMicros(), ...(obj as Record<string, unknown>) };
}
