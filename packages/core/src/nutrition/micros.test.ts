// 微量栄養素の規則: 不明は null のまま、0 で埋めない。
import { expect, test } from "bun:test";
import {
  emptyMicros,
  fillMicros,
  microsFromInput,
  microsFromTuple,
  microsOf,
  MICRO_KEYS,
  sameMicros,
  scaleMicros,
  sumMicros,
} from "./micros";

test("emptyMicros は12項目すべてを null にする", () => {
  const m = emptyMicros();
  expect(Object.keys(m).sort()).toEqual([...MICRO_KEYS].sort());
  expect(Object.values(m).every((v) => v === null)).toBe(true);
});

test("microsOf は12項目だけを抜き出す", () => {
  const row = { ...emptyMicros(), fiberG: 2.5, kcal: 100, name: "x" };
  const m = microsOf(row);
  expect(m.fiberG).toBe(2.5);
  expect("kcal" in m).toBe(false);
});

test("scaleMicros は栄養素ごとの桁で丸め、null は null のまま", () => {
  const base = { ...emptyMicros(), fiberG: 3.33, potassiumMg: 410, ironMg: 1.234 };
  const scaled = scaleMicros(base, 1.5);
  expect(scaled.fiberG).toBe(5); //            小数1桁: 4.995 → 5
  expect(scaled.potassiumMg).toBe(615); //     整数
  expect(scaled.ironMg).toBe(1.85); //         小数2桁: 1.851 → 1.85
  expect(scaled.vitaminCMg).toBeNull(); //     不明は不明のまま
});

test("sumMicros は分かっている値だけを足し、全部不明なら null", () => {
  const a = { ...emptyMicros(), fiberG: 1.2, calciumMg: 30 };
  const b = { ...emptyMicros(), fiberG: 2.4 };
  const total = sumMicros([a, b]);
  expect(total.fiberG).toBe(3.6);
  expect(total.calciumMg).toBe(30); // 片方だけ分かっていれば、その分だけ
  expect(total.folateMcg).toBeNull(); // 誰も知らない栄養素は 0 にしない
});

test("sumMicros は空の集合でも null を返す（0 ではない）", () => {
  const total = sumMicros([]);
  expect(Object.values(total).every((v) => v === null)).toBe(true);
});

test("microsFromInput は省略されたキーを不明として扱う", () => {
  const m = microsFromInput({ fiberG: 5, ironMg: null });
  expect(m.fiberG).toBe(5);
  expect(m.ironMg).toBeNull();
  expect(m.vitaminB1Mg).toBeNull();
});

test("microsFromTuple は成分表タプルの位置 7..18 を読む", () => {
  const row = ["01088", "name", 100, 1, 2, 3, 0.5, 1.1, 200] as unknown as {
    [i: number]: unknown;
  };
  const m = microsFromTuple(row);
  expect(m.fiberG).toBe(1.1); //       位置 7
  expect(m.potassiumMg).toBe(200); //  位置 8
  expect(m.calciumMg).toBeNull(); //   位置 9 以降は無い → 不明
});

test("sameMicros は12項目すべての一致を見る", () => {
  const a = { ...emptyMicros(), fiberG: 1 };
  expect(sameMicros(a, { ...emptyMicros(), fiberG: 1 })).toBe(true);
  expect(sameMicros(a, { ...emptyMicros(), fiberG: 1, ironMg: 0 })).toBe(false);
});

test("fillMicros は無いキーだけを null で補う", () => {
  const filled = fillMicros({ fiberG: 2 }) as Record<string, unknown>;
  expect(filled.fiberG).toBe(2);
  expect(filled.vitaminCMg).toBeNull();
  expect(fillMicros(null)).toBeNull();
});
