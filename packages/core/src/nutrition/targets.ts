// 目標値。正本は履歴（`target_history`）で、「現在の目標」はその最新行から
// 導出する。
//
// Space 版は `settings` に4キーのキャッシュを持っているが、ちゃんと版では
// 持たずイベント列から導出すると決めた（`docs/plan.md`）。そのためコアは
// 「履歴から現在値を出す」純関数として持つ。Space 版の
// `syncSettingsFromHistory` はこの関数の結果を書き戻すだけになる。

export interface TargetValues {
  kcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
}

export interface TargetHistoryEntry {
  effectiveDate: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

export const EMPTY_TARGETS: TargetValues = {
  kcal: null,
  proteinG: null,
  fatG: null,
  carbsG: null,
};

/** 履歴の中で最も新しい `effectiveDate` の行。無ければ null。 */
export function latestTargetEntry<T extends TargetHistoryEntry>(
  history: readonly T[],
): T | null {
  let latest: T | null = null;
  for (const row of history) {
    if (latest == null || row.effectiveDate > latest.effectiveDate) latest = row;
  }
  return latest;
}

/** 履歴から現在の目標値を導出する。履歴が空なら全部 null。 */
export function currentTargets(
  history: readonly TargetHistoryEntry[],
): TargetValues {
  const latest = latestTargetEntry(history);
  if (!latest) return { ...EMPTY_TARGETS };
  return {
    kcal: latest.kcal,
    proteinG: latest.proteinG,
    fatG: latest.fatG,
    carbsG: latest.carbsG,
  };
}

/** `date` の時点で有効だった目標値（その日以前で最も新しい行）。 */
export function targetsAsOf(
  history: readonly TargetHistoryEntry[],
  date: string,
): TargetValues {
  return currentTargets(history.filter((row) => row.effectiveDate <= date));
}

/** 4値がすべて揃っているか（履歴に積めるか）。 */
export function isCompleteTargets(
  t: TargetValues,
): t is { kcal: number; proteinG: number; fatG: number; carbsG: number } {
  return (
    t.kcal != null && t.proteinG != null && t.fatG != null && t.carbsG != null
  );
}

/** 目標値4つが同じか。 */
export function sameTargets(
  a: { kcal: number; proteinG: number; fatG: number; carbsG: number },
  b: { kcal: number; proteinG: number; fatG: number; carbsG: number },
): boolean {
  return (
    a.kcal === b.kcal &&
    a.proteinG === b.proteinG &&
    a.fatG === b.fatG &&
    a.carbsG === b.carbsG
  );
}
