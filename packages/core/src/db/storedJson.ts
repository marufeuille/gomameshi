// 保存 JSON の版付け。
//
// いくつかのテーブルは構造を持つ値を JSON テキストで持っている
// （`assist_proposals.result_json`、`recipe_imports.draft_json`、
// `recipes.ingredients_json`、`foods.blend_json`、
// `meal_logs.assist_note`）。中身をそのまま入れていた頃は、形を変えた
// ときに読み手のスキーマ検査が静かに落ちるだけで、壊れたデータと区別が
// つかなかった。新しい書き込みは { v: STORED_JSON_VERSION, data } で
// 包む。読み手は外す: 版の印が無い値は旧版（版 0）としてそのまま返し、
// 知らない版なら undefined を返す（数えられる明示的な空振りにして、
// 静かな読み違いにしない）。
//
// Space 版（`server/src/actions.ts`）から移したもので、形式は同じ。
// 版が合わなかったときの観測（`ai_metrics`）はホスト側の関心なので、
// コアには持ち込まない。

export const STORED_JSON_VERSION = 1;

export function stringifyStoredJson(value: unknown): string {
  return JSON.stringify({ v: STORED_JSON_VERSION, data: value });
}

export function unwrapStoredJson(raw: unknown): unknown {
  if (
    raw != null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "v" in raw
  ) {
    const rec = raw as { v?: unknown; data?: unknown };
    return rec.v === STORED_JSON_VERSION ? rec.data : undefined;
  }
  return raw;
}
