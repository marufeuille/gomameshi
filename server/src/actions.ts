// Actions for 食事とPFC — a meal log with a food master, label-photo
// registration, and read-time daily PFC aggregation.
//
// Data principles (per the user's design):
// - Meal logs are events: each row snapshots the nutrients computed at
//   log time, so editing a food never rewrites history.
// - Daily totals are always derived by summing log rows at read time.
// - getDailySummary / getDailySummaries are the linkage surface the
//   body-composition dashboard reads every morning.
// - logMeal / listFoods / upsertFood let the user's agent record and
//   register on their behalf (the whole point of replacing Calomeal).

import {
  defineAction,
  InferenceSchemaError,
  z,
  type ActionsModule,
  type Ctx,
  type InferenceCompleteOptions,
} from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import {
FOOD_TABLE,
FOOD_TABLE_SOURCE_NAME,
FOOD_TABLE_SOURCE_URL,
} from "./foodTableData";

type Db = ReturnType<Ctx["db"]>;
type FoodRow = typeof schema.foods.$inferSelect;
type LogRow = typeof schema.mealLogs.$inferSelect;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round0 = (n: number) => Math.round(n);

// Citation URLs are rendered as <a href> in the client, so a bare
// z.string().url() is not enough: it happily accepts javascript: /
// data: URLs. Only http(s) may ever be stored as a source URL.
const httpUrl = (max: number) =>
  z
    .string()
    .url()
    .max(max)
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "出典URLは http:// または https:// のURLだけ使えます",
    });

// ---------------------------------------------------------------------------
// Micronutrients （微量栄養素） — the 12 nullable nutrient fields that ride
// alongside PFC + salt everywhere (food master, meal-log snapshots,
// research records, recipe lines/totals, blend bases). Unknown is always
// null: never 0-filled, never guessed. Daily totals sum the known values
// only and stay null when every entry is unknown for that nutrient.
// ---------------------------------------------------------------------------

const MICRO_KEYS = [
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
type MicroKey = (typeof MICRO_KEYS)[number];
type MicroValues = Record<MicroKey, number | null>;

const MICRO_ROUND: Record<MicroKey, (n: number) => number> = {
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

// Micronutrient fields for MODEL-RESPONSE schemas (label photo read,
// staged lookup extraction). The numeric ranges are enforced HERE, in
// the schema the model must answer to — the same bounds the action
// request schemas use (microInputZod) — so an out-of-range value fails
// validation at the boundary and is retried there, instead of passing
// through and being caught (or missed) by range checks scattered
// through the downstream code. Semantic checks that a schema cannot
// express (grounding against the cited material, candidate-pool
// membership) stay in the handlers.
const microZod = {
  fiberG: z.number().min(0).max(100000).nullable(),
  potassiumMg: z.number().min(0).max(1000000).nullable(),
  calciumMg: z.number().min(0).max(1000000).nullable(),
  magnesiumMg: z.number().min(0).max(1000000).nullable(),
  ironMg: z.number().min(0).max(100000).nullable(),
  vitaminDMcg: z.number().min(0).max(100000).nullable(),
  vitaminB1Mg: z.number().min(0).max(100000).nullable(),
  vitaminB2Mg: z.number().min(0).max(100000).nullable(),
  vitaminB6Mg: z.number().min(0).max(100000).nullable(),
  vitaminB12Mcg: z.number().min(0).max(100000).nullable(),
  folateMcg: z.number().min(0).max(1000000).nullable(),
  vitaminCMg: z.number().min(0).max(1000000).nullable(),
};

const microInputZod = {
  fiberG: z.number().min(0).max(100000).nullable().optional(),
  potassiumMg: z.number().min(0).max(1000000).nullable().optional(),
  calciumMg: z.number().min(0).max(1000000).nullable().optional(),
  magnesiumMg: z.number().min(0).max(1000000).nullable().optional(),
  ironMg: z.number().min(0).max(100000).nullable().optional(),
  vitaminDMcg: z.number().min(0).max(100000).nullable().optional(),
  vitaminB1Mg: z.number().min(0).max(100000).nullable().optional(),
  vitaminB2Mg: z.number().min(0).max(100000).nullable().optional(),
  vitaminB6Mg: z.number().min(0).max(100000).nullable().optional(),
  vitaminB12Mcg: z.number().min(0).max(100000).nullable().optional(),
  folateMcg: z.number().min(0).max(1000000).nullable().optional(),
  vitaminCMg: z.number().min(0).max(1000000).nullable().optional(),
};

function microsOf(src: MicroValues): MicroValues {
  const out = {} as MicroValues;
  for (const k of MICRO_KEYS) out[k] = src[k];
  return out;
}

function emptyMicros(): MicroValues {
  const out = {} as MicroValues;
  for (const k of MICRO_KEYS) out[k] = null;
  return out;
}

/** Scale every known micronutrient by k, rounded per nutrient. */
function scaleMicros(m: MicroValues, k: number): MicroValues {
  const out = {} as MicroValues;
  for (const key of MICRO_KEYS) {
    const v = m[key];
    out[key] = v == null ? null : MICRO_ROUND[key](v * k);
  }
  return out;
}

/** Sum the known values per nutrient; null when nothing is known. */
function sumMicros(list: MicroValues[]): MicroValues {
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
/** Micronutrients from a FOOD_TABLE tuple (positions 7..18, MICRO_KEYS order). */
function microsFromTableRow(row: {
  [i: number]: unknown;
}): MicroValues {
  const out = {} as MicroValues;
  MICRO_KEYS.forEach((k, i) => {
    const v = row[7 + i];
    out[k] = typeof v === "number" ? v : null;
  });
  return out;
}

/** Micronutrients from optional action input (absent = unknown = null). */
function microsFromInput(args: Partial<MicroValues>): MicroValues {
  const out = {} as MicroValues;
  for (const k of MICRO_KEYS) out[k] = args[k] ?? null;
  return out;
}

function sameMicros(a: MicroValues, b: MicroValues): boolean {
  return MICRO_KEYS.every((k) => a[k] === b[k]);
}

/** Compact number for basis summaries: 150 stays "150", 66.7 stays "66.7". */
const fmtNum = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);

// The stored calculation basis of a 配合計算 (source 'blend') food: the
// parts it was computed from and what each part contributes to 100 g of
// the blend. Snapshotted at save time; see saveBlendFood.
const blendPartOut = z.object({
  foodId: z.number().nullable(),
  foodName: z.string(),
  grams: z.number(),
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
  saltG: z.number().nullable(),
  ...microZod,
});

const blendOut = z.object({
  note: z.string(),
  totalGrams: z.number(),
  parts: z.array(blendPartOut),
});

type BlendBasis = z.infer<typeof blendOut>;

const foodOut = z.object({
  id: z.number(),
  name: z.string(),
  basisType: z.enum(["per100g", "serving"]),
  basisLabel: z.string(),
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
  saltG: z.number().nullable(),
  ...microZod,
  source: z.enum(["table", "label", "manual", "ai", "blend"]),
  blend: blendOut.nullable(),
  sourceName: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  tableNo: z.string().nullable(),
  defaultAmount: z.number(),
  defaultUnit: z.string(),
  unitGrams: z.number().nullable(),
  useCount: z.number(),
  lastUsedAt: z.string().nullable(),
});

function toFoodOut(row: FoodRow): z.infer<typeof foodOut> {
  return {
    id: row.id,
    name: row.name,
    basisType: row.basisType,
    basisLabel: row.basisLabel,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
    saltG: row.saltG,
    ...microsOf(row),
    source: row.source,
    blend: parseBlendJson(row.blendJson),
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    tableNo: row.tableNo,
    defaultAmount: row.defaultAmount,
    defaultUnit: row.defaultUnit,
    unitGrams: row.unitGrams,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/**
 * Fill missing micronutrient keys with null on a stored JSON object
 * (blend parts, recipe ingredient lines). Rows written before the
 * micronutrient fields existed carry no such keys; filling them at
 * parse time keeps the strict schemas (and every reader) working with
 * "unknown" semantics instead of failing the whole payload.
 */
function fillMicros(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  return { ...emptyMicros(), ...(obj as Record<string, unknown>) };
}

/**
 * Stored-JSON schema versioning. Several tables keep structured
 * payloads as JSON text (assist_proposals.result_json,
 * recipe_imports.draft_json, recipes.ingredients_json,
 * foods.blend_json, meal_logs.assist_note). Until now the payload was
 * the bare object, so a future format change would have failed the
 * reader's schema parse silently — indistinguishable from corruption.
 * New writes wrap the payload as { v: STORED_JSON_VERSION, data }.
 * Readers unwrap: a payload WITHOUT a version marker is a legacy
 * (version 0) payload and is returned as-is; a payload WITH an unknown
 * version returns undefined — an explicit miss the caller can count
 * (see bumpMetric) and fall back from, never a silent mis-parse.
 */
const STORED_JSON_VERSION = 1;

function stringifyStoredJson(value: unknown): string {
  return JSON.stringify({ v: STORED_JSON_VERSION, data: value });
}

function unwrapStoredJson(raw: unknown): unknown {
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

/**
 * Increment a durable AI-layer counter (ai_metrics). Keys are dotted:
 * "<flow>.attempts" / ".failures" / ".schema_failures" / ".retries"
 * for inference calls (flows: label_photo, lookup_extract,
 * recipe_photo, blend_parse, assist_parse, assist_pick,
 * assist_decompose), "deep_research.expired" / "recipe_import.expired"
 * for background jobs that died without a callback, and
 * "assist_cache.version_mismatch" for stored proposals whose JSON
 * version this build does not understand. Metrics are observability
 * only: a failed increment must never fail the request being counted.
 */
async function bumpMetric(ctx: Ctx, key: string, by = 1): Promise<void> {
  try {
    const db = ctx.db<typeof schema>();
    await db
      .insert(schema.aiMetrics)
      .values({ key, count: by, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.aiMetrics.key,
        set: {
          count: sql`${schema.aiMetrics.count} + ${by}`,
          updatedAt: new Date(),
        },
      });
  } catch {
    // Counting is never a failure mode.
  }
}

/** Parse a stored blend basis; a corrupt payload reads as no basis. */
function parseBlendJson(json: string | null): BlendBasis | null {
  if (json == null) return null;
  try {
    const raw = unwrapStoredJson(JSON.parse(json)) as
      | { parts?: unknown }
      | undefined;
    if (raw == null) return null;
    if (Array.isArray(raw.parts)) {
      raw.parts = raw.parts.map(fillMicros);
    }
    const parsed = blendOut.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * ctx.inference.complete with automatic retries (up to 3 attempts). The
 * inference service occasionally fails transiently (an opaque "inference
 * failed" on the action), and a single hiccup must not make food
 * registration — label photo, AI lookup, recipe photo — look broken to
 * the user. Schema-validation failures are retried too: the model is
 * sampled, so a format slip on one attempt (a number returned as a
 * string, a missing field) routinely conforms on the next; only the
 * final attempt's error propagates.
 */
async function completeWithRetry<T extends z.ZodType>(
  ctx: Ctx,
  prompt: string,
  options: InferenceCompleteOptions<T>,
  // Interactive (user-is-staring-at-a-spinner) callers pass 2: with the
  // default 3 attempts, one hung attempt at a 60–120 s timeout silently
  // stacks into minutes of dead air before anything surfaces. Two
  // attempts still absorb a transient failure while bounding the wait.
  maxAttempts = 3,
  // Flow label for the ai_metrics counters ("assist_pick", …): every
  // attempt, failure, schema-validation failure and retry is counted
  // under it, so the effect of schema hardening is measurable after
  // the fact instead of anecdotal.
  metricLabel?: string,
): Promise<z.infer<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (metricLabel) {
      await bumpMetric(ctx, `${metricLabel}.attempts`);
      if (attempt > 0) await bumpMetric(ctx, `${metricLabel}.retries`);
    }
    try {
      return await ctx.inference.complete(prompt, options);
    } catch (e) {
      lastError = e;
      if (metricLabel) {
        await bumpMetric(ctx, `${metricLabel}.failures`);
        if (InferenceSchemaError.is(e)) {
          await bumpMetric(ctx, `${metricLabel}.schema_failures`);
        }
      }
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 4000));
      }
    }
  }
  throw lastError;
}

/**
 * A single inference attempt, no retries. The staged food lookup uses
 * this on purpose: re-running an extraction over the SAME material
 * that just timed out or failed only doubles the wait without changing
 * the answer — the lookup escalates to the next stage (page bodies,
 * then the background deep research) instead. Transient failures are
 * absorbed by the stage structure itself (parallel searches, a second
 * material source), not by repeating an identical call.
 */
async function completeOnce<T extends z.ZodType>(
  ctx: Ctx,
  prompt: string,
  options: InferenceCompleteOptions<T>,
  // Flow label for the ai_metrics counters, as in completeWithRetry.
  metricLabel?: string,
): Promise<z.infer<T>> {
  if (metricLabel) await bumpMetric(ctx, `${metricLabel}.attempts`);
  try {
    return await ctx.inference.complete(prompt, options);
  } catch (e) {
    if (metricLabel) {
      await bumpMetric(ctx, `${metricLabel}.failures`);
      if (InferenceSchemaError.is(e)) {
        await bumpMetric(ctx, `${metricLabel}.schema_failures`);
      }
    }
    throw e;
  }
}

/** Thrown when a hard, locally-enforced deadline expires. */
class SyncBudgetExceeded extends Error {
  constructor(label: string) {
    super(`sync budget exceeded: ${label}`);
    this.name = "SyncBudgetExceeded";
  }
}

/**
 * Races a promise against a hard deadline enforced HERE, in the action
 * — not by the callee. The inference service's `timeout_secs` and the
 * privileged host's timeout are requests, not guarantees: in
 * production a label-photo read ran past 150 s (a 120 s timeout,
 * retried) and a staged lookup ran past 80 s without ever reaching
 * its not_found exit, so no research record was saved and the
 * background handoff never fired. Synchronous user-facing flows
 * therefore wrap every await in this race against a total budget; the
 * abandoned underlying call may still finish in the background, but
 * the ACTION returns on time and reaches its terminal state (a clear
 * failure, or a saved record plus a background handoff).
 */
function raceDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(
      () => reject(new SyncBudgetExceeded(label)),
      Math.max(0, ms),
    );
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Name normalization shared by the duplicate guard and the research cache. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "");
}

/**
 * The match key for ingredient↔master matching: the food's identity with
 * all classification noise removed. Composition-table names look like
 * "にわとり ［若どり・主品目］ むね 皮なし 生" or "だいず ［豆腐・油揚げ類］
 * 木綿豆腐" — the ＜群＞・（〜類）tokens and the ［分類］brackets say which
 * shelf the food sits on, not what it is, and they broke naive substring
 * matching (an ingredient "鶏もも肉" never appears verbatim inside them).
 * What remains ("にわとりむね皮なし生", "だいず木綿豆腐") is what recipes
 * actually name.
 */
/** Fold katakana to hiragana (recipes and the table mix the two freely). */
function foldKana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60),
  );
}

/**
 * Bracket contents in table names are classification noise when they say
 * which shelf/grade the food sits on （［若どり・主品目］, ［豆腐・油揚げ
 * 類］, ［大型種肉］, ［水稲めし］) — but sometimes the bracket IS the
 * food （［ひき肉］, ［小麦粉］). Only the classification forms are
 * dropped; everything else stays as part of the name.
 */
function isClassificationBracket(content: string): boolean {
  return /品目|種肉|種・|水稲めし|陸稲めし/.test(content) || content.endsWith("類");
}

function coreMatchKey(s: string): string {
  return foldKana(
    s
      .replace(/＜[^＞]*＞/g, "")
      .replace(/［([^］]*)］/g, (_m, c: string) =>
        isClassificationBracket(c) ? "" : c,
      )
      .replace(/\[([^\]]*)\]/g, (_m, c: string) =>
        isClassificationBracket(c) ? "" : c,
      )
      .replace(/（[^）]*類）/g, "")
      .replace(/\([^)]*\)/g, "")
      .toLowerCase(),
  )
    .replace(/[\s　・,、]+/g, "")
    .replace(/[（）()]/g, "");
}

/**
 * Preparation words that make a table entry a different food from the raw
 * ingredient a recipe names. When the ingredient doesn't mention them, a
 * candidate carrying them is probably a cooked/processed variant and is
 * penalized, so 玉ねぎ lands on たまねぎ（生）rather than たまねぎ（ゆで）.
 */
const PREP_MARKERS = [
  "ゆで",
  "焼き",
  "蒸し",
  "揚げ",
  "油いため",
  "素揚げ",
  "水煮",
  "缶詰",
  "塩蔵",
  "干し",
  "乾燥",
  "味付け",
  "加工品",
  "フライ",
  "ロースト",
  "燻製",
  "水さらし",
  "電子レンジ調理",
  "おろし",
  "粉",
  "ソース",
  "ジュース",
  "ペースト",
  "ジャム",
  "ピューレー",
  "漬",
  "ケチャップ",
  "スプレッド",
  "ケーキ",
  "ドレッシング",
  "ドライ",
  "塩ざけ",
  "いくら",
  "すじこ",
];

/**
 * State/part words that may follow the head noun in a table name without
 * changing which food it is: たまねぎ りん茎 生, にわとり もも 皮つき 生.
 * A prefix match only counts as tier 1 when the remainder is built from
 * these; when another noun follows （しろさけ イクラ, トマトケチャップ,
 * バターケーキ) the candidate is a different product and drops to the
 * plain containment tier.
 */
const STATE_SUFFIXES = [
  "皮下脂肪なし",
  "淡色辛みそ",
  "脂身つき",
  "脂身なし",
  "赤色辛みそ",
  "皮つき",
  "皮なし",
  "甘みそ",
  "普通酒",
  "根茎",
  "りん茎",
  "塊茎",
  "結球葉",
  "まさば",
  "軟白",
  "果実",
  "全卵",
  "ゆで",
  "焼き",
  "蒸し",
  "生",
  "乾",
  "根",
  "葉",
  "茎",
  "皮",
];

function isStateRemainder(rest: string): boolean {
  // Strip one suffix at a time, always scanning from the top of the
  // list (longest first): "根茎皮なし生" must consume 根茎, then 皮なし,
  // then 生 — never let the shorter 皮 eat the head of 皮なし.
  let r = rest;
  while (r.length > 0) {
    const w = STATE_SUFFIXES.find((s) => r.startsWith(s));
    if (!w) return false;
    r = r.slice(w.length);
  }
  return true;
}

/**
 * Part words that signal a secondary part of the plant/animal. Only a
 * soft penalty: 大根 should land on the root, not だいこん葉 — but when
 * every candidate carries the part （ねぎ 葉）, the penalty is uniform
 * and changes nothing.
 */
const PART_MARKERS = ["葉"];

/**
 * How recipes write ingredients vs how the composition table names them.
 * Each entry maps a common written form to the table's form; both the
 * original and the rewritten query are tried, so an alias can only add
 * matches, never remove them.
 */
const INGREDIENT_ALIASES: Array<[string, string]> = [
  ["玉ねぎ", "たまねぎ"],
  ["玉葱", "たまねぎ"],
  ["人参", "にんじん"],
  ["生姜", "しょうが"],
  ["大根", "だいこん"],
  ["白菜", "はくさい"],
  ["茄子", "なす"],
  ["胡瓜", "きゅうり"],
  ["牛蒡", "ごぼう"],
  ["蓮根", "れんこん"],
  ["筍", "たけのこ"],
  ["椎茸", "しいたけ"],
  ["鶏", "にわとり"],
  ["豚", "ぶた"],
  ["牛", "うし"],
  ["卵", "鶏卵"],
  ["醤油", "しょうゆ"],
  ["醤油", "こいくちしょうゆ"],
  ["味噌", "みそ"],
  ["味噌", "米みそ"],
  ["鮭", "さけ"],
  ["鮭", "しろさけ"],
  ["鮭", "しろざけ"],
  ["ねぎ", "根深ねぎ"],
  ["酒", "清酒"],
  ["小麦粉", "薄力粉"],
  ["砂糖", "上白糖"],
  ["塩", "食塩"],
  ["油", "調合油"],
  ["ごはん", "ご飯"],
  ["米", "こめ"],
  ["片栗粉", "じゃがいもでん粉"],
];

/**
 * Query variants for matching: alias rewrites first, then the raw query.
 * A deliberate rewrite （醤油 → しょうゆ, 塩 → 食塩） should outrank the
 * raw form, whose characters can coincidentally appear inside an
 * unrelated food （醤油 inside 魚醤油）. The raw form still gets its
 * chance — an alias can only add matches, never remove them. Each
 * variant is flagged: a hit through an alias rewrite earns a bonus in
 * scoring, because the rewrite states what the recipe actually means.
 */
function queryVariants(
  rawName: string,
): Array<{ text: string; alias: boolean }> {
  const base = coreMatchKey(rawName);
  const pool = new Set<string>();
  if (base) pool.add(base);
  for (const [from, to] of INGREDIENT_ALIASES) {
    for (const v of [...pool]) {
      if (v.includes(from)) pool.add(v.replaceAll(from, to));
    }
  }
  const rewritten = [...pool].filter((v) => v !== base);
  const ordered: Array<{ text: string; alias: boolean }> = [
    ...rewritten.map((text) => ({ text, alias: true })),
    ...(base ? [{ text: base, alias: false }] : []),
  ];
  // Recipe style "鶏もも肉" vs table style "にわとり もも": a trailing
  // 肉 is packaging, not identity.
  for (const v of [...ordered]) {
    if (v.text.length > 2 && v.text.endsWith("肉")) {
      ordered.push({ text: v.text.slice(0, -1), alias: v.alias });
    }
  }
  const seen = new Set<string>();
  return ordered.filter((v) => {
    if (seen.has(v.text)) return false;
    seen.add(v.text);
    return true;
  });
}

const researchOut = z.object({
  id: z.number(),
  queryName: z.string(),
  maker: z.string().nullable(),
  status: z.enum(["found", "not_found"]),
  name: z.string().nullable(),
  basisType: z.enum(["per100g", "serving", "unknown"]).nullable(),
  basisLabel: z.string().nullable(),
  servingGrams: z.number().nullable(),
  kcal: z.number().nullable(),
  proteinG: z.number().nullable(),
  fatG: z.number().nullable(),
  carbsG: z.number().nullable(),
  saltG: z.number().nullable(),
  ...microZod,
  sourceName: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type ResearchRow = typeof schema.foodResearch.$inferSelect;

function toResearchOut(row: ResearchRow): z.infer<typeof researchOut> {
  return {
    id: row.id,
    queryName: row.queryName,
    maker: row.maker,
    status: row.status,
    name: row.name,
    basisType:
      row.basisType === "per100g" ||
      row.basisType === "serving" ||
      row.basisType === "unknown"
        ? row.basisType
        : null,
    basisLabel: row.basisLabel,
    servingGrams: row.servingGrams,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
    saltG: row.saltG,
    ...microsOf(row),
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const draftOut = z.object({
  name: z.string(),
  // Maker/brand for this draft: user-supplied, confirmed from the
  // source, or inferred by the research from the product name / source
  // pages. Shown in the form's maker field, where the user can correct
  // it. Null when nothing could be determined.
  maker: z.string().nullable(),
  basisType: z.enum(["per100g", "serving", "unknown"]),
  basisLabel: z.string(),
  servingGrams: z.number().nullable(),
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
  saltG: z.number().nullable(),
  ...microZod,
  sourceName: z.string(),
  sourceUrl: z.string(),
});

function researchDraft(row: ResearchRow): z.infer<typeof draftOut> | null {
  if (
    row.status !== "found" ||
    row.kcal == null ||
    row.proteinG == null ||
    row.fatG == null ||
    row.carbsG == null
  ) {
    return null;
  }
  return {
    name: row.name ?? row.queryName,
    maker: row.maker,
    basisType:
      row.basisType === "per100g"
        ? "per100g"
        : row.basisType === "serving"
          ? "serving"
          : "unknown",
    basisLabel: row.basisLabel ?? "",
    servingGrams: row.servingGrams,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
    saltG: row.saltG,
    ...microsOf(row),
    sourceName: row.sourceName ?? "",
    sourceUrl: row.sourceUrl ?? "",
  };
}

type DeepJobRow = typeof schema.foodResearchJobs.$inferSelect;

const deepJobOut = z.object({
  id: z.number(),
  queryName: z.string(),
  status: z.enum(["pending", "ready", "failed"]),
  error: z.string().nullable(),
  // Latest progress note from the research agent (what it is doing
  // right now); null until its first report.
  progress: z.string().nullable(),
  // The stage that note belongs to (enum, see schema.ts): makes the
  // agent's position in the flow machine-readable instead of leaving
  // it buried in free text. Null until the first staged report.
  progressStage: z
    .enum(["searching", "opening_page", "reading_table", "saving"])
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: draftOut.nullable(),
});

// A healthy deep research finishes in ~1–2 minutes, and its agent
// reports progress at every milestone (each report refreshes
// updatedAt). A pending job with no callback at all for this long is
// dead — its agent never started, died silently, or its return was
// lost — and leaving it "pending" makes the app claim forever that
// research is still running (the banner polls it, restarts reuse it,
// and it suppresses the same name's finished draft card). Expire such
// jobs to failed wherever jobs are read or started, so the user sees
// an honest outcome and can retry.
const DEEP_JOB_STALE_MS = 6 * 60 * 1000;
const DEEP_JOB_TIMEOUT_ERROR =
  "調査エージェントから時間内に応答がありませんでした";

async function expireStaleDeepJobs(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const cutoff = Date.now() - DEEP_JOB_STALE_MS;
  const pending = await db
    .select()
    .from(schema.foodResearchJobs)
    .where(eq(schema.foodResearchJobs.status, "pending"));
  const stale = pending.filter((j) => j.updatedAt.getTime() < cutoff);
  for (const j of stale) {
    await db
      .update(schema.foodResearchJobs)
      .set({
        status: "failed",
        error: DEEP_JOB_TIMEOUT_ERROR,
        updatedAt: new Date(),
      })
      .where(eq(schema.foodResearchJobs.id, j.id));
  }
  if (stale.length > 0) {
    await bumpMetric(ctx, "deep_research.expired", stale.length);
    ctx.invalidateQueries();
  }
}

/**
 * Starts (or reuses) a deep-research job for a name and returns its
 * job id. Shared by the startDeepFoodResearch action and by
 * lookupFoodInfo's handoff: when the synchronous lookup burns its
 * budget without confirming values, the SERVER starts the job itself
 * before returning, so the research continues — and stays visible in
 * listDeepFoodResearchJobs / the app banner — even if the client has
 * already given up waiting or the form was closed. Callers run the
 * master duplicate guard first; this helper only handles job reuse,
 * insertion, and the agent spawn.
 */
async function spawnDeepResearchJob(
  ctx: Ctx,
  q: string,
  maker: string,
): Promise<number | null> {
  const db = ctx.db<typeof schema>();
  const nq = normName(q);
  if (nq) {
    // Reuse a still-running job for the same name instead of spawning
    // a second agent for the same question.
    const pending = await db
      .select()
      .from(schema.foodResearchJobs)
      .where(
        and(
          eq(schema.foodResearchJobs.queryNorm, nq),
          eq(schema.foodResearchJobs.status, "pending"),
        ),
      )
      .orderBy(desc(schema.foodResearchJobs.id))
      .limit(1);
    const running = pending[0];
    if (running && Date.now() - running.createdAt.getTime() < 15 * 60 * 1000) {
      return running.id;
    }
  }
  const inserted = await db
    .insert(schema.foodResearchJobs)
    .values({ queryName: q, queryNorm: nq, status: "pending" })
    .returning({ id: schema.foodResearchJobs.id });
  const row = inserted[0];
  if (!row) return null;
  const jobId = row.id;
  const task = await ctx.agent.spawnTask(
    [
      `食品「${q}」の栄養成分をメーカー公式情報から調べ、このSpaceの深掘り調査ジョブ（jobId: ${jobId}）に結果を保存するタスクです。`,
      ...(maker
        ? [
            `メーカー名（ユーザー指定）: 「${maker}」。このメーカーの公式ストア/公式サイトを最優先で当てること。同名の別メーカー商品と取り違えないこと。`,
          ]
        : []),
      "",
      "背景: このアプリの通常のAI調査はWeb検索結果のスニペットしか見られないため、メーカー公式ページの栄養成分表示がスニペットに完全な形で現れない食品（例: ベースブレッド こしあん）では「見つからない」になってしまいます。あなたはページを実際に開けるので、公式ページ本文から確認してください。",
      "",
      "手順:",
      `進捗報告: 作業の節目ごとに reportDeepFoodResearchProgress アクションを jobId=${jobId}, message=「いま何をしているか」の短い日本語（60字以内）, stage=現在の段階 で呼ぶこと。stage は次の4値のいずれか（それ以外は使わない）: "searching"=メーカー公式サイトを探している, "opening_page"=公式ページを開いた, "reading_table"=栄養成分表示を確認した, "saving"=結果を保存するところ。ユーザーには1〜2分待ってもらうので、待ち時間の表示に使う。最低限、開始時（stage="searching", 例: 「メーカー公式サイトを探しています」）、公式ページを開いた時（stage="opening_page", 例: 「○○公式ショップの商品ページを開きました」）、栄養成分表示を確認した時（stage="reading_table", 例: 「栄養成分表示を確認しました」）の3回は呼ぶこと。completeDeepFoodResearch を呼ぶ直前にも stage="saving" で1回呼ぶこと。`,
      `1. Web検索で「${q}」のメーカー公式サイトの商品ページ・栄養成分ページを探し、実際に開いて本文を読む。優先順位: メーカー公式の商品ページ（公式オンラインショップ含む）の栄養成分表示 ＞ メーカー公式の栄養成分一覧・ヘルプページ ＞ 文部科学省 日本食品標準成分表（fooddb）＞ その他の公的データベース。個人ブログ・まとめサイト・通販サイトの値で済ませないこと（公式ページがどうしても見つからない場合の最後の手段としてのみ使い、その旨を sourceName に明記すること）。`,
      "2. ページに栄養成分表示（熱量・たんぱく質・脂質・炭水化物・食塩相当量）とその基準（1袋あたり・1個あたり・100gあたり等）が書かれていることを確認する。リニューアル等で複数の値が存在する場合は、公式商品ページに現在載っている値を採用する。",
      "2b. 食塩相当量は特に見落とすな。包装食品の栄養成分表示には食塩相当量が必ず載っているが、表の後半（糖質・食物繊維・ナトリウム等の後）に配置されることが多く、メーカーのヘルプページ等では複数商品の表が並ぶため、対象商品の表の食塩相当量の行まで必ずたどること。別の味・別の商品の表の値を流用しないこと。",
      `3. 値が確認できたら completeDeepFoodResearch アクションを jobId=${jobId}, status="ready", found=true, name（公式での商品名）, maker（公式でのメーカー/ブランド名）${maker ? `, ※ユーザー指定のメーカー名は「${maker}」` : ""}, basisType（"per100g" または "serving"）, basisLabel（例: "1袋あたり"）, servingGrams（1単位のグラム数がページにあればその数値、なければ null）, kcal, proteinG, fatG, carbsG, saltG（表を最後まで確認しても記載がなければ null）, および微量栄養素 fiberG（食物繊維g）・potassiumMg（カリウムmg）・calciumMg（カルシウムmg）・magnesiumMg（マグネシウムmg）・ironMg（鉄mg）・vitaminDMcg（ビタミンDµg）・vitaminB1Mg（B1 mg）・vitaminB2Mg（B2 mg）・vitaminB6Mg（B6 mg）・vitaminB12Mcg（B12 µg）・folateMcg（葉酸µg）・vitaminCMg（ビタミンC mg）— ページの表に明記されている項目だけを入れ、明記されていない項目は null（推測で埋めない）, sourceName（出典の名称）, sourceUrl（実際に開いて確認したページのURLをそのまま）で呼ぶ。`,
      `4. 公式情報で値が確認できない場合は、同じアクションを jobId=${jobId}, status="ready", found=false で呼ぶ。推測や概算で値を埋めないこと。`,
      `5. ページが開けない等の技術的な失敗の場合は、同じアクションを jobId=${jobId}, status="failed", error（短い理由）で呼ぶ。`,
      "報告の形式: completeDeepFoodResearch に渡すフィールド名・型・取りうる値は、この手順3〜5に書かれたものがそのアクションの引数スキーマそのものである。ここに無いフィールドを足したり、フィールド名を変えたり、数値を文字列で渡したりしないこと（スキーマに合わない報告は保存されず、ジョブは失敗扱いになる）。",
    ].join("\n"),
    {
      expectsAction: "completeDeepFoodResearch",
      dedupeKey: `food-research-${jobId}`,
    },
  );
  if (!task.ok) {
    await db
      .update(schema.foodResearchJobs)
      .set({
        status: "failed",
        error: "調査タスクを開始できませんでした",
        updatedAt: new Date(),
      })
      .where(eq(schema.foodResearchJobs.id, jobId));
  }
  ctx.invalidateQueries();
  return jobId;
}

async function toDeepJobOut(
  ctx: Ctx,
  job: DeepJobRow,
): Promise<z.infer<typeof deepJobOut>> {
  const db = ctx.db<typeof schema>();
  let draft: z.infer<typeof draftOut> | null = null;
  if (job.status === "ready") {
    const records = await db
      .select()
      .from(schema.foodResearch)
      .where(eq(schema.foodResearch.queryNorm, job.queryNorm))
      .limit(1);
    const record = records[0];
    if (record) draft = researchDraft(record);
  }
  return {
    id: job.id,
    queryName: job.queryName,
    status: job.status,
    error: job.error,
    progress: job.progress,
    progressStage: job.progressStage,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    draft,
  };
}

// AIアシスト換算メモ： what an assist-logged entry was converted from.
// originalText is what the user typed （例：「焼き芋 皮つき 200g」),
// baseFoodName the master food whose values the snapshot was computed
// from, factor the （推定） conversion applied to the input grams, and
// rationale its stated basis. Stored as JSON in meal_logs.assist_note.
//
// Decomposed entries （分解モード, mode 'decomposed') carry `parts`
// instead of a single base: baseFoodName then holds the dish name and
// factor is null. Each part records what the user confirmed — the
// ingredient name, the master food it was computed from (null when
// none), the grams, its rationale, and its status: 'counted' parts
// fed the snapshot; 'excluded' parts （水・だし汁など） were listed
// but deliberately left out; 'unmatched' parts had no master match
// and are NOT in the totals — the note keeps them visible so a
// partial sum never masquerades as a complete one. mode/parts are
// optional so every pre-decomposition note still parses.
const assistNotePartOut = z.object({
  partName: z.string(),
  foodName: z.string().nullable(),
  grams: z.number().nullable(),
  rationale: z.string(),
  status: z.enum(["counted", "excluded", "unmatched"]),
});

const assistNoteOut = z.object({
  originalText: z.string(),
  baseFoodName: z.string(),
  factor: z.number().nullable(),
  rationale: z.string(),
  mode: z.enum(["single", "decomposed"]).optional(),
  parts: z.array(assistNotePartOut).optional(),
});

type AssistNote = z.infer<typeof assistNoteOut>;

/** Parse a stored assist note; a corrupt payload reads as no note. */
function parseAssistNote(json: string | null): AssistNote | null {
  if (json == null) return null;
  try {
    const parsed = assistNoteOut.safeParse(unwrapStoredJson(JSON.parse(json)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const logOut = z.object({
  id: z.number(),
  date: z.string(),
  slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
  foodId: z.number().nullable(),
  foodName: z.string(),
  quantity: z.number(),
  unit: z.string(),
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
  saltG: z.number().nullable(),
  ...microZod,
  eatingOut: z.boolean(),
  assist: assistNoteOut.nullable(),
  createdAt: z.string(),
});

function toLogOut(row: LogRow): z.infer<typeof logOut> {
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    foodId: row.foodId,
    foodName: row.foodName,
    quantity: row.quantity,
    unit: row.unit,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
    saltG: row.saltG,
    ...microsOf(row),
    eatingOut: row.eatingOut === 1,
    assist: parseAssistNote(row.assistNote),
    createdAt: row.createdAt.toISOString(),
  };
}

const daySummaryOut = z.object({
  date: z.string(),
  logged: z.boolean(),
  entryCount: z.number(),
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
  saltG: z.number().nullable(),
  ...microZod,
  // 外食フラグ情報： whether the day contains any eating-out entry, and how
  // many. The dashboard syncs these to mark days whose record includes an
  // estimated outside meal.
  hasEatingOut: z.boolean(),
  eatingOutCount: z.number(),
});

type DaySummary = z.infer<typeof daySummaryOut>;

function summarize(date: string, rows: LogRow[]): DaySummary {
  let kcal = 0,
    p = 0,
    f = 0,
    c = 0,
    salt = 0,
    hasSalt = false,
    eatingOutCount = 0;
  for (const r of rows) {
    kcal += r.kcal;
    p += r.proteinG;
    f += r.fatG;
    c += r.carbsG;
    if (r.saltG != null) {
      salt += r.saltG;
      hasSalt = true;
    }
    if (r.eatingOut === 1) eatingOutCount += 1;
  }
  return {
    date,
    logged: rows.length > 0,
    entryCount: rows.length,
    kcal: Math.round(kcal),
    proteinG: round1(p),
    fatG: round1(f),
    carbsG: round1(c),
    saltG: hasSalt ? round2(salt) : null,
    // Micronutrient totals: known values summed, null when every entry
    // is unknown for that nutrient (so "no data" never reads as 0).
    ...sumMicros(rows.map((r) => microsOf(r))),
    hasEatingOut: eatingOutCount > 0,
    eatingOutCount,
  };
}

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

function dateToDays(s: string): number {
  const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function daysToDate(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/** Today's calendar date in Asia/Tokyo (YYYY-MM-DD). */
function todayJstStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    new Date(),
  );
}

// ---------- consumption pace （消費ペース） ----------
//
// How fast a food (or a named set of foods) is actually used up,
// derived at read time from the meal-log events — the shopping view:
// "over the last N days I went through about X g, so about Y g/week".
// Three log shapes contribute, all converted to grams of a master food:
//   1. direct entries (meal_logs.food_id set): quantity × the food's
//      unit grams; unit 'g' is taken as-is. An entry whose unit has no
//      gram equivalent (unit_grams unset) counts as an entry but adds
//      no grams — the UI falls back to counts for it, never a guess.
//   2. AI-assist decomposition entries: the counted parts in the
//      assist note carry master food names + grams; a part counts
//      toward the food whose name matches exactly.
//   3. recipe entries (unit 人前， food_id null): matched to a recipe
//      by title and expanded into its 'food' ingredient lines, scaled
//      by 人前 ÷ 何人分. Manual/unknown lines carry no master food and
//      never contribute.
// Everything is a reference figure （参考値）: day-to-day intake swings
// (eating out, hard training days) are exactly why the pace is averaged
// over a long window instead of projected from a daily rate.

type ConsumptionAcc = {
  grams: number;
  hasGrams: boolean;
  unconverted: number;
  entries: number;
  days: Set<string>;
  weekly: Map<string, number>;
};

function newConsumptionAcc(): ConsumptionAcc {
  return {
    grams: 0,
    hasGrams: false,
    unconverted: 0,
    entries: 0,
    days: new Set(),
    weekly: new Map(),
  };
}

/** Monday (YYYY-MM-DD) of the week containing `date`. */
function weekStartOf(date: string): string {
  const days = dateToDays(date);
  const dow = new Date(days * 86400000).getUTCDay(); // 0 = Sunday
  return daysToDate(days - ((dow + 6) % 7));
}

function addConsumption(
  acc: ConsumptionAcc,
  date: string,
  grams: number | null,
): void {
  acc.entries += 1;
  acc.days.add(date);
  if (grams == null) {
    acc.unconverted += 1;
    return;
  }
  acc.grams += grams;
  acc.hasGrams = true;
  const wk = weekStartOf(date);
  acc.weekly.set(wk, (acc.weekly.get(wk) ?? 0) + grams);
}

/** Grams of one direct log entry, or null when its unit can't convert. */
function logEntryGrams(
  food: FoodRow,
  quantity: number,
  unit: string,
): number | null {
  if (unit === "g") return quantity;
  if (food.unitGrams != null) return quantity * food.unitGrams;
  return null;
}

const consumptionFoodOut = z.object({
  foodId: z.number(),
  name: z.string(),
  grams: z.number().nullable(),
  perWeek: z.number().nullable(),
  perMonth: z.number().nullable(),
  perYear: z.number().nullable(),
  entries: z.number(),
  daysUsed: z.number(),
  unconverted: z.number(),
});

const consumptionOut = z.object({
  from: z.string(),
  to: z.string(),
  windowDays: z.number(),
  observationDays: z.number(),
  total: z.object({
    grams: z.number().nullable(),
    perWeek: z.number().nullable(),
    perMonth: z.number().nullable(),
    perYear: z.number().nullable(),
    entries: z.number(),
    daysUsed: z.number(),
    unconverted: z.number(),
  }),
  foods: z.array(consumptionFoodOut),
  weekly: z.array(z.object({ weekStart: z.string(), grams: z.number() })),
});

type ConsumptionResult = z.infer<typeof consumptionOut>;

function paceOf(
  acc: ConsumptionAcc,
  observationDays: number,
): {
  grams: number | null;
  perWeek: number | null;
  perMonth: number | null;
  perYear: number | null;
  entries: number;
  daysUsed: number;
  unconverted: number;
} {
  const grams = acc.hasGrams ? round1(acc.grams) : null;
  const rate = (days: number): number | null =>
    grams != null && observationDays > 0
      ? round1((acc.grams / observationDays) * days)
      : null;
  return {
    grams,
    perWeek: rate(7),
    perMonth: rate(365.25 / 12),
    perYear: rate(365.25),
    entries: acc.entries,
    daysUsed: acc.days.size,
    unconverted: acc.unconverted,
  };
}

async function computeConsumption(
  db: Db,
  foodIds: number[],
  days: number,
): Promise<ConsumptionResult> {
  const to = todayJstStr();
  const selected = new Set(foodIds);
  const foodRows = await db
    .select()
    .from(schema.foods)
    .where(inArray(schema.foods.id, foodIds));
  const foodById = new Map(foodRows.map((f) => [f.id, f]));

  // The observation window: the requested last N days, or everything
  // when days = 0. The pace denominator never exceeds the span the log
  // actually covers — with only a few days of history, dividing by 90
  // would understate the pace by an order of magnitude.
  const earliestRows = await db
    .select({ date: schema.mealLogs.date })
    .from(schema.mealLogs)
    .orderBy(asc(schema.mealLogs.date))
    .limit(1);
  const earliest = earliestRows[0]?.date ?? null;
  let from: string;
  let windowDays: number;
  if (days > 0) {
    from = daysToDate(dateToDays(to) - days + 1);
    windowDays = days;
  } else {
    from = earliest ?? to;
    windowDays = dateToDays(to) - dateToDays(from) + 1;
  }
  const obsFrom = earliest != null && earliest > from ? earliest : from;
  const observationDays = Math.max(
    0,
    dateToDays(to) - dateToDays(obsFrom) + 1,
  );

  const logs = await db
    .select()
    .from(schema.mealLogs)
    .where(and(gte(schema.mealLogs.date, from), lte(schema.mealLogs.date, to)))
    .orderBy(asc(schema.mealLogs.id));

  // Recipe title → recipe, for expanding 人前 entries into ingredients.
  const recipeRows = await db.select().from(schema.recipes);
  const recipeByTitle = new Map<string, (typeof recipeRows)[number]>();
  for (const r of recipeRows) {
    if (!recipeByTitle.has(r.title)) recipeByTitle.set(r.title, r);
  }
  // Exact food name → id, for resolving decomposition parts (the note
  // stores names, not ids). On a name collision the most-used food
  // wins — it is the one logging actually referenced in practice.
  const allFoods = await db
    .select()
    .from(schema.foods)
    .orderBy(desc(schema.foods.useCount));
  const foodIdByName = new Map<string, number>();
  for (const f of allFoods) {
    if (!foodIdByName.has(f.name)) foodIdByName.set(f.name, f.id);
  }

  const perFood = new Map<number, ConsumptionAcc>();
  const accFor = (id: number): ConsumptionAcc => {
    let acc = perFood.get(id);
    if (!acc) {
      acc = newConsumptionAcc();
      perFood.set(id, acc);
    }
    return acc;
  };
  const total = newConsumptionAcc();
  const addBoth = (id: number, date: string, grams: number | null): void => {
    addConsumption(accFor(id), date, grams);
    addConsumption(total, date, grams);
  };

  for (const row of logs) {
    if (row.foodId != null) {
      if (!selected.has(row.foodId)) continue;
      const food = foodById.get(row.foodId);
      addBoth(
        row.foodId,
        row.date,
        food ? logEntryGrams(food, row.quantity, row.unit) : null,
      );
      continue;
    }
    const note = parseAssistNote(row.assistNote);
    if (note?.mode === "decomposed" && note.parts) {
      const touched = new Set<number>();
      for (const part of note.parts) {
        if (part.status !== "counted" || part.foodName == null) continue;
        if (part.grams == null) continue;
        const fid = foodIdByName.get(part.foodName);
        if (fid == null || !selected.has(fid)) continue;
        const acc = accFor(fid);
        acc.grams += part.grams;
        acc.hasGrams = true;
        const wk = weekStartOf(row.date);
        acc.weekly.set(wk, (acc.weekly.get(wk) ?? 0) + part.grams);
        total.grams += part.grams;
        total.hasGrams = true;
        total.weekly.set(wk, (total.weekly.get(wk) ?? 0) + part.grams);
        touched.add(fid);
      }
      for (const fid of touched) {
        accFor(fid).entries += 1;
        accFor(fid).days.add(row.date);
        total.entries += 1;
        total.days.add(row.date);
      }
      continue;
    }
    if (row.unit === "人前") {
      const recipe = recipeByTitle.get(row.foodName);
      if (!recipe || recipe.servings == null || recipe.servings <= 0) {
        continue;
      }
      let lines: Ingredient[];
      try {
        const parsed = z.array(ingredientSchema).safeParse(
          unwrapStoredJson(JSON.parse(recipe.ingredientsJson)),
        );
        if (!parsed.success) continue;
        lines = parsed.data;
      } catch {
        continue;
      }
      const scale = row.quantity / recipe.servings;
      const touched = new Set<number>();
      for (const line of lines) {
        if (line.basisMode !== "food") continue;
        if (line.matchedFoodId == null || line.grams == null) continue;
        if (!selected.has(line.matchedFoodId)) continue;
        const g = line.grams * scale;
        const acc = accFor(line.matchedFoodId);
        acc.grams += g;
        acc.hasGrams = true;
        const wk = weekStartOf(row.date);
        acc.weekly.set(wk, (acc.weekly.get(wk) ?? 0) + g);
        total.grams += g;
        total.hasGrams = true;
        total.weekly.set(wk, (total.weekly.get(wk) ?? 0) + g);
        touched.add(line.matchedFoodId);
      }
      for (const fid of touched) {
        accFor(fid).entries += 1;
        accFor(fid).days.add(row.date);
        total.entries += 1;
        total.days.add(row.date);
      }
    }
  }

  // Continuous weekly series over the window (empty weeks read as 0).
  const weekly: Array<{ weekStart: string; grams: number }> = [];
  const firstWeek = weekStartOf(from);
  const lastWeek = weekStartOf(to);
  for (
    let wk = firstWeek;
    wk <= lastWeek;
    wk = daysToDate(dateToDays(wk) + 7)
  ) {
    weekly.push({ weekStart: wk, grams: round1(total.weekly.get(wk) ?? 0) });
  }

  return {
    from,
    to,
    windowDays,
    observationDays,
    total: paceOf(total, observationDays),
    foods: foodIds
      .filter((id) => foodById.has(id))
      .map((id) => ({
        foodId: id,
        name: foodById.get(id)?.name ?? "",
        ...paceOf(perFood.get(id) ?? newConsumptionAcc(), observationDays),
      })),
    weekly,
  };
}

/** Per-100 g nutrient vector for similarity; null when not derivable. */
function nutrientVector(food: FoodRow): number[] | null {
  let k = 1;
  if (food.basisType === "serving") {
    if (food.unitGrams == null || food.unitGrams <= 0) return null;
    k = 100 / food.unitGrams;
  }
  return [
    food.proteinG * k,
    food.fatG * k,
    food.carbsG * k,
    (food.kcal * k) / 10,
    (food.saltG ?? 0) * k * 10,
    (food.fiberG ?? 0) * k,
  ];
}

/** Character bigrams of the folded core name, for name similarity. */
function nameBigrams(name: string): Set<string> {
  const core = coreMatchKey(name);
  const out = new Set<string>();
  for (let i = 0; i + 1 < core.length; i += 1) out.add(core.slice(i, i + 2));
  if (core.length === 1) out.add(core);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const consumptionGroupOut = z.object({
  id: z.number(),
  name: z.string(),
  foods: z.array(z.object({ id: z.number(), name: z.string() })),
});

type ConsumptionGroupRow = typeof schema.consumptionGroups.$inferSelect;

async function toConsumptionGroupOut(
  db: Db,
  row: ConsumptionGroupRow,
): Promise<z.infer<typeof consumptionGroupOut>> {
  let ids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(row.foodIds);
    if (Array.isArray(parsed)) {
      ids = parsed.filter(
        (x): x is number => typeof x === "number" && Number.isInteger(x),
      );
    }
  } catch {
    ids = [];
  }
  const foods =
    ids.length > 0
      ? await db
          .select()
          .from(schema.foods)
          .where(inArray(schema.foods.id, ids))
      : [];
  const nameById = new Map(foods.map((f) => [f.id, f.name]));
  return {
    id: row.id,
    name: row.name,
    foods: ids
      .filter((id) => nameById.has(id))
      .map((id) => ({ id, name: nameById.get(id) ?? "" })),
  };
}

// ---------- target history （目標の履歴） ----------
//
// The settings rows (target_kcal / target_protein_g / target_fat_g /
// target_carbs_g) stay the "current target" cache every existing surface
// reads. target_history is the durable log behind them: once history
// exists, settings mirror its newest row. Changing the current target
// appends a row dated today; adding/editing/deleting history rows
// re-derives settings from the newest remaining row. Rows are never
// overwritten by a later change except a same-day re-save of the
// current target (one row per start date).

type TargetHistoryRow = typeof schema.targetHistory.$inferSelect;

const targetHistoryOut = z.object({
  id: z.number(),
  effectiveDate: z.string(),
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
});

function toTargetHistoryOut(
  row: TargetHistoryRow,
): z.infer<typeof targetHistoryOut> {
  return {
    id: row.id,
    effectiveDate: row.effectiveDate,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbsG: row.carbsG,
  };
}

interface TargetValues {
  kcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
}

async function readTargetValues(db: Db): Promise<TargetValues> {
  const rows = await db.select().from(schema.settings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (key: string): number | null => {
    const v = map.get(key);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    kcal: num("target_kcal"),
    proteinG: num("target_protein_g"),
    fatG: num("target_fat_g"),
    carbsG: num("target_carbs_g"),
  };
}

async function writeTargetKey(
  db: Db,
  key: string,
  value: number | null,
): Promise<void> {
  if (value === null) {
    await db.delete(schema.settings).where(eq(schema.settings.key, key));
  } else {
    await db
      .insert(schema.settings)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: String(value) },
      });
  }
}

/** Mirror the newest history row into the settings cache. */
async function syncSettingsFromHistory(db: Db): Promise<void> {
  const rows = await db
    .select()
    .from(schema.targetHistory)
    .orderBy(desc(schema.targetHistory.effectiveDate))
    .limit(1);
  const latest = rows[0];
  if (!latest) return;
  await writeTargetKey(db, "target_kcal", latest.kcal);
  await writeTargetKey(db, "target_protein_g", latest.proteinG);
  await writeTargetKey(db, "target_fat_g", latest.fatG);
  await writeTargetKey(db, "target_carbs_g", latest.carbsG);
}

function sameTargetValues(
  row: TargetHistoryRow,
  v: { kcal: number; proteinG: number; fatG: number; carbsG: number },
): boolean {
  return (
    row.kcal === v.kcal &&
    row.proteinG === v.proteinG &&
    row.fatG === v.fatG &&
    row.carbsG === v.carbsG
  );
}

/**
 * After a current-target (settings) change, record it in the history:
 * a row dated today is created or — when the user re-saves on the same
 * day — updated in place. Skipped when the target set is incomplete
 * (any value cleared) or identical to the newest history row.
 */
async function appendSettingsChangeToHistory(db: Db): Promise<void> {
  const t = await readTargetValues(db);
  if (
    t.kcal == null ||
    t.proteinG == null ||
    t.fatG == null ||
    t.carbsG == null
  ) {
    return;
  }
  const values = {
    kcal: t.kcal,
    proteinG: t.proteinG,
    fatG: t.fatG,
    carbsG: t.carbsG,
  };
  const today = todayJstStr();
  const todayRows = await db
    .select()
    .from(schema.targetHistory)
    .where(eq(schema.targetHistory.effectiveDate, today));
  const todayRow = todayRows[0];
  if (todayRow) {
    if (!sameTargetValues(todayRow, values)) {
      await db
        .update(schema.targetHistory)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.targetHistory.id, todayRow.id));
    }
    return;
  }
  const latestRows = await db
    .select()
    .from(schema.targetHistory)
    .orderBy(desc(schema.targetHistory.effectiveDate))
    .limit(1);
  const latest = latestRows[0];
  if (latest && sameTargetValues(latest, values)) return;
  await db.insert(schema.targetHistory).values({
    effectiveDate: today,
    ...values,
  });
}

/** Scale factor from a food's basis to the logged quantity. */
function scaleFactor(food: FoodRow, quantity: number, unit: string): number {
  if (food.basisType === "per100g") {
    let grams: number;
    if (unit === "g") {
      grams = quantity;
    } else if (food.unitGrams != null) {
      grams = quantity * food.unitGrams;
    } else {
      throw new Error(
        `「${food.name}」は${unit}あたりのグラム数が未設定のため、その単位では記録できません`,
      );
    }
    return grams / 100;
  }
  // serving basis: quantity counts servings, unless given in grams.
  if (unit === "g") {
    if (food.unitGrams == null) {
      throw new Error(
        `「${food.name}」は1単位のグラム数が未設定のため、グラムでは記録できません`,
      );
    }
    return quantity / food.unitGrams;
  }
  return quantity;
}

function nutrientsFor(food: FoodRow, quantity: number, unit: string) {
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

async function loadDay(db: Db, date: string): Promise<LogRow[]> {
  return db
    .select()
    .from(schema.mealLogs)
    .where(eq(schema.mealLogs.date, date))
    .orderBy(asc(schema.mealLogs.id));
}

// ---------------------------------------------------------------------------
// Recipes — saved as a unit, estimated from a URL or a photo, with every
// ingredient line keeping its own editable basis.
//
// An ingredient line is one of:
// - basisMode 'food': matched to a food-master entry. Its nutrients are
//   ALWAYS recomputed from the master entry and the line's gram amount
//   (at import-match time and again at save time), so correcting the
//   match or the grams corrects the numbers — the client never gets to
//   invent them.
// - basisMode 'manual': nutrients typed by the user (or left from an
//   unmatched estimate the user then filled in).
// - basisMode 'unknown': no trustworthy basis yet; nutrients are null
//   and the line is excluded from the recipe totals.
// ---------------------------------------------------------------------------

const ingredientSchema = z.object({
  name: z.string().min(1).max(100),
  amount: z.number().min(0).max(100000).nullable(),
  unit: z.string().max(10),
  amountText: z.string().max(60),
  grams: z.number().min(0).max(100000).nullable(),
  matchedFoodId: z.number().int().positive().nullable(),
  matchedFoodName: z.string().max(100).nullable(),
  basisMode: z.enum(["food", "manual", "unknown"]),
  kcal: z.number().min(0).max(100000).nullable(),
  proteinG: z.number().min(0).max(100000).nullable(),
  fatG: z.number().min(0).max(100000).nullable(),
  carbsG: z.number().min(0).max(100000).nullable(),
  saltG: z.number().min(0).max(100000).nullable(),
  fiberG: z.number().min(0).max(100000).nullable(),
  potassiumMg: z.number().min(0).max(1000000).nullable(),
  calciumMg: z.number().min(0).max(1000000).nullable(),
  magnesiumMg: z.number().min(0).max(1000000).nullable(),
  ironMg: z.number().min(0).max(100000).nullable(),
  vitaminDMcg: z.number().min(0).max(100000).nullable(),
  vitaminB1Mg: z.number().min(0).max(100000).nullable(),
  vitaminB2Mg: z.number().min(0).max(100000).nullable(),
  vitaminB6Mg: z.number().min(0).max(100000).nullable(),
  vitaminB12Mcg: z.number().min(0).max(100000).nullable(),
  folateMcg: z.number().min(0).max(1000000).nullable(),
  vitaminCMg: z.number().min(0).max(1000000).nullable(),
});

type Ingredient = z.infer<typeof ingredientSchema>;

const recipeTotalsSchema = z.object({
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
  saltG: z.number().nullable(),
  ...microZod,
  complete: z.boolean(),
});

type RecipeTotals = z.infer<typeof recipeTotalsSchema>;

function sumIngredients(lines: Ingredient[]): RecipeTotals {
  let kcal = 0,
    p = 0,
    f = 0,
    c = 0,
    salt = 0,
    hasSalt = false,
    complete = true;
  const knownLines: Ingredient[] = [];
  for (const l of lines) {
    if (l.kcal == null || l.proteinG == null || l.fatG == null || l.carbsG == null) {
      complete = false;
      continue;
    }
    knownLines.push(l);
    kcal += l.kcal;
    p += l.proteinG;
    f += l.fatG;
    c += l.carbsG;
    if (l.saltG != null) {
      salt += l.saltG;
      hasSalt = true;
    }
  }
  return {
    kcal: Math.round(kcal),
    proteinG: round1(p),
    fatG: round1(f),
    carbsG: round1(c),
    saltG: hasSalt ? round2(salt) : null,
    // Like salt: sum the lines that carry a value, null when none do.
    ...sumMicros(knownLines.map((l) => microsOf(l))),
    complete,
  };
}

function perServingOf(
  totals: RecipeTotals,
  servings: number | null,
): RecipeTotals | null {
  if (servings == null || servings <= 0) return null;
  return {
    kcal: Math.round(totals.kcal / servings),
    proteinG: round1(totals.proteinG / servings),
    fatG: round1(totals.fatG / servings),
    carbsG: round1(totals.carbsG / servings),
    saltG: totals.saltG == null ? null : round2(totals.saltG / servings),
    ...scaleMicros(microsOf(totals), 1 / servings),
    complete: totals.complete,
  };
}

/** Nutrients of `grams` of a master food, or null when not convertible. */
function nutrientsForGrams(food: FoodRow, grams: number) {
  if (food.basisType === "per100g") {
    return nutrientsFor(food, grams, "g");
  }
  if (food.unitGrams == null) return null;
  return nutrientsFor(food, grams / food.unitGrams, food.defaultUnit);
}

/**
 * Recompute one line from its matched master food. A 'food' line whose
 * food vanished or whose grams are unknown degrades to 'unknown' rather
 * than keeping numbers nobody can stand behind.
 */
function recomputeLine(line: Ingredient, foodById: Map<number, FoodRow>): Ingredient {
  if (line.basisMode !== "food") return line;
  const food = line.matchedFoodId != null ? foodById.get(line.matchedFoodId) : undefined;
  if (!food || line.grams == null) {
    return {
      ...line,
      basisMode: "unknown",
      kcal: null,
      proteinG: null,
      fatG: null,
      carbsG: null,
      saltG: null,
      ...emptyMicros(),
    };
  }
  const n = nutrientsForGrams(food, line.grams);
  if (!n) {
    return {
      ...line,
      basisMode: "unknown",
      kcal: null,
      proteinG: null,
      fatG: null,
      carbsG: null,
      saltG: null,
      ...emptyMicros(),
    };
  }
  return { ...line, matchedFoodName: food.name, ...n };
}

function recomputeLines(
  lines: Ingredient[],
  foodById: Map<number, FoodRow>,
): Ingredient[] {
  return lines.map((l) => recomputeLine(l, foodById));
}

/**
 * All match cores for a food name: the full core plus each bracketed
 * alias spelled out in the name — 鮭（しろざけ・生）must be findable as
 * しろざけ, not only as 鮭しろざけ生.
 */
function foodCores(name: string): string[] {
  const cores = [coreMatchKey(name)];
  for (const m of name.matchAll(/[（(]([^）)]+)[）)]/g)) {
    const alt = coreMatchKey(m[1] ?? "");
    if (alt.length >= 2 && !cores.includes(alt)) cores.push(alt);
  }
  return cores;
}

/**
 * Score one master food against an ingredient's query variants; lower is
 * better, null is no match. Tiers: exact core equality; a prefix hit
 * whose remainder is only state words （しょうが → しょうが 根茎 皮なし
 * 生, but not しろさけ イクラ）; plain containment either way. A
 * cooked/processed variant the recipe didn't ask for （ゆで・缶詰・粉・
 * ソース…) costs half a tier, so 玉ねぎ lands on たまねぎ（生）rather
 * than たまねぎ（ゆで）without ever outweighing a tier difference.
 * Alias hits earn a small bonus — an exact alias hit （油 → 調合油）
 * must beat a loose substring hit on the raw query （ごま油）.
 * One-character queries match only on exact equality: 水 must not land
 * on 水あめ. When cores tie exactly （にわとり もも 皮つき 生 exists for
 * both 若どり and 親）, the everyday 若どり wins over the specialty 親.
 */
function scoreForCore(
  variants: Array<{ text: string; alias: boolean }>,
  rawQuery: string,
  foodName: string,
  foodCore: string,
  tableNo: string | null,
  isPrimaryCore: boolean,
): number | null {
  let best: number | null = null;
  for (const { text: v, alias } of variants) {
    if (!v || !foodCore) continue;
    let tier: number | null = null;
    if (foodCore === v) tier = 0;
    else if (
      v.length >= 2 &&
      foodCore.startsWith(v) &&
      isStateRemainder(foodCore.slice(v.length))
    )
      tier = 1;
    else if (v.length >= 2 && foodCore.includes(v)) tier = 2;
    else if (v.length >= 2 && v.includes(foodCore) && foodCore.length >= 2)
      tier = 3;
    if (tier == null) continue;
    // The prep penalty separates raw from cooked forms of the same food
    // （たまねぎ 生 vs ゆで — both tier 1), so it must stay smaller than
    // a whole tier: a tier-1 hit with a prep word （うどん ゆで, the
    // canonical form) still beats a tier-2 hit without one.
    const prepPenalty = PREP_MARKERS.some((m) => {
      const fm = foldKana(m);
      return foodCore.includes(fm) && !foldKana(rawQuery).includes(fm);
    })
      ? 500
      : 0;
    const partPenalty = PART_MARKERS.some((m) => {
      const fm = foldKana(m);
      return foodCore.includes(fm) && !foldKana(rawQuery).includes(fm);
    })
      ? 50
      : 0;
    // Sweets （菓子類， group 15) are almost never what a recipe means by
    // a staple name: バター must not land on バタースコッチ and 小麦粉
    // must not land on 小麦粉あられ. A query that itself names a sweet
    // is exempt.
    const sweetsPenalty =
      tableNo != null &&
      tableNo.startsWith("15") &&
      !/ケーキ|クッキー|チョコ|あめ|飴|菓子|せんべい|あられ|ビスケット|プリン|ゼリー|アイス/.test(
        rawQuery,
      )
        ? 1500
        : 0;
    const specialtyPenalty = foodName.includes("［親") ? 50 : 0;
    // A hit through an alias rewrite （塩 → 食塩） states the recipe's
    // intent; a raw-form hit can be a coincidence inside a longer name
    // （砂糖 inside 黒砂糖, さけ inside しろさけ めふん's rivals). The
    // bonus is small — it only breaks near-ties.
    const aliasBonus = alias ? -30 : 0;
    // A food whose name literally starts with the ingredient as written
    // is the canonical entry for it （鮭（しろざけ・生）for 鮭, the user's
    // own 鶏むね肉（皮なし）for 鶏むね肉）. When that form carries no
    // preparation word the bonus is large — it must outrank a cooked
    // table form （しろさけ 焼き）; when it does carry one （うどん ゆで)
    // the bonus stays small, and products like トマトケチャップ (which
    // carry a marker) never earn the large form.
    const rawCore = coreMatchKey(rawQuery);
    let rawPrefixBonus = 0;
    if (
      isPrimaryCore &&
      rawCore.length >= 2 &&
      foodCore.startsWith(rawCore)
    ) {
      rawPrefixBonus = prepPenalty > 0 ? -50 : -600;
    }
    const score =
      tier * 1000 +
      prepPenalty +
      partPenalty +
      sweetsPenalty +
      specialtyPenalty +
      aliasBonus +
      rawPrefixBonus +
      foodCore.length;
    if (best == null || score < best) best = score;
  }
  return best;
}

/** Best score across all of a food's cores (full name + bracket aliases).
 * Bracket aliases cost a little: （しろざけ・生）must make 鮭 findable,
 * but （砂糖入り）on きな粉 must not outrank the real 砂糖. */
function matchScore(
  variants: Array<{ text: string; alias: boolean }>,
  rawQuery: string,
  foodName: string,
  cores: string[],
  tableNo: string | null,
): number | null {
  let best: number | null = null;
  for (let i = 0; i < cores.length; i++) {
    const core = cores[i];
    if (core == null) continue;
    const s = scoreForCore(variants, rawQuery, foodName, core, tableNo, i === 0);
    if (s == null) continue;
    const total = s + (i === 0 ? 0 : 100);
    if (best == null || total < best) best = total;
  }
  return best;
}

/**
 * Match raw extracted ingredients (name + printed amount + gram estimate)
 * against the food master. A name match with a known gram amount becomes
 * a 'food' line with real master nutrients; anything else stays
 * 'unknown' for the user to resolve in the editor — values are never
 * guessed. The master is the full composition table (~2,500 foods), so
 * matching runs on core names with recipe/table alias rewrites (see
 * coreMatchKey / INGREDIENT_ALIASES) instead of raw substring equality.
 */
/** The single best master food for a free-text ingredient name, or
 * undefined when nothing scores. `cores` is foodCores per food, aligned
 * with `foods`. */
function bestFoodMatch(
  name: string,
  foods: FoodRow[],
  cores: string[][],
): FoodRow | undefined {
  const variants = queryVariants(name);
  let best: FoodRow | undefined;
  let bestScore = Infinity;
  for (let i = 0; i < foods.length; i++) {
    const food = foods[i];
    const foodCoreList = cores[i];
    if (!food || foodCoreList == null) continue;
    const score = matchScore(variants, name, food.name, foodCoreList, food.tableNo);
    if (score != null && score < bestScore) {
      bestScore = score;
      best = food;
    }
  }
  return best;
}

/** The best-scoring master foods for a free-text name, best first (at
 * most `n`). Used to build the candidate pool for AI-assist logging,
 * where the model — not the score — makes the final pick. */
function topFoodMatches(
  name: string,
  foods: FoodRow[],
  cores: string[][],
  n: number,
): FoodRow[] {
  const variants = queryVariants(name);
  const scored: Array<{ food: FoodRow; score: number }> = [];
  for (let i = 0; i < foods.length; i++) {
    const food = foods[i];
    const foodCoreList = cores[i];
    if (!food || foodCoreList == null) continue;
    const score = matchScore(variants, name, food.name, foodCoreList, food.tableNo);
    if (score != null) scored.push({ food, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, n).map((s) => s.food);
}

function matchIngredients(
  raw: Array<{ name: string; amountText?: string; grams?: number | null }>,
  foods: FoodRow[],
): Ingredient[] {
  const cores = foods.map((f) => foodCores(f.name));
  return raw.map((r) => {
    const name = r.name.trim();
    const grams = r.grams != null && r.grams > 0 ? r.grams : null;
    const best = bestFoodMatch(name, foods, cores);
    const base: Ingredient = {
      name,
      amount: grams,
      unit: grams != null ? "g" : "",
      amountText: (r.amountText ?? "").slice(0, 60),
      grams,
      matchedFoodId: best?.id ?? null,
      matchedFoodName: best?.name ?? null,
      basisMode: "unknown",
      kcal: null,
      proteinG: null,
      fatG: null,
      carbsG: null,
      saltG: null,
      ...emptyMicros(),
    };
    if (best && grams != null) {
      return recomputeLine({ ...base, basisMode: "food" }, new Map([[best.id, best]]));
    }
    return base;
  });
}

const recipeDraftSchema = z.object({
  title: z.string(),
  servings: z.number().nullable(),
  servingsLabel: z.string(),
  sourceType: z.enum(["url", "photo", "manual"]),
  sourceUrl: z.string().nullable(),
  ingredients: z.array(ingredientSchema),
});

type RecipeDraft = z.infer<typeof recipeDraftSchema>;

const recipeBasisEntry = z.object({
  label: z.string(),
  sourceName: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});

const recipeOut = z.object({
  id: z.number(),
  title: z.string(),
  servings: z.number().nullable(),
  servingsLabel: z.string(),
  sourceType: z.enum(["url", "photo", "manual"]),
  sourceUrl: z.string().nullable(),
  ingredients: z.array(ingredientSchema),
  basis: z.array(recipeBasisEntry),
  totals: recipeTotalsSchema,
  perServing: recipeTotalsSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type RecipeRow = typeof schema.recipes.$inferSelect;

/** The distinct estimation bases behind a recipe, for display. */
function recipeBasis(
  lines: Ingredient[],
  foodById: Map<number, FoodRow>,
): Array<z.infer<typeof recipeBasisEntry>> {
  const seen = new Map<string, z.infer<typeof recipeBasisEntry>>();
  for (const l of lines) {
    if (l.basisMode !== "food" || l.matchedFoodId == null) continue;
    const food = foodById.get(l.matchedFoodId);
    if (!food) continue;
    const label =
      food.source === "table"
        ? "日本食品標準成分表"
        : food.source === "ai"
          ? "AI調査（食品マスタ）"
          : food.source === "label"
            ? "栄養成分表示の写真（食品マスタ）"
            : "食品マスタ（手入力）";
    const key = `${label}:${food.sourceUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      label,
      sourceName: food.sourceName,
      sourceUrl: food.sourceUrl,
    });
  }
  return [...seen.values()];
}

function toRecipeOut(row: RecipeRow, foodById: Map<number, FoodRow>): z.infer<typeof recipeOut> {
  let lines: Ingredient[] = [];
  try {
    const rawLines: unknown = unwrapStoredJson(JSON.parse(row.ingredientsJson));
    const parsed = z
      .array(ingredientSchema)
      .safeParse(
        Array.isArray(rawLines) ? rawLines.map(fillMicros) : rawLines,
      );
    if (parsed.success) lines = parsed.data;
  } catch {
    lines = [];
  }
  const totals = sumIngredients(lines);
  return {
    id: row.id,
    title: row.title,
    servings: row.servings,
    servingsLabel: row.servingsLabel,
    sourceType: row.sourceType,
    sourceUrl: row.sourceUrl,
    ingredients: lines,
    basis: recipeBasis(lines, foodById),
    totals,
    perServing: perServingOf(totals, row.servings),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadFoodMap(db: Db): Promise<Map<number, FoodRow>> {
  const rows = await db.select().from(schema.foods);
  return new Map(rows.map((r) => [r.id, r]));
}

const recipeImportOut = z.object({
  id: z.number(),
  kind: z.enum(["url", "photo"]),
  sourceUrl: z.string().nullable(),
  status: z.enum(["pending", "ready", "failed"]),
  error: z.string().nullable(),
  // Background agent's latest progress (URL imports only): the note
  // and its stage enum, same shape as the deep-research jobs.
  progress: z.string().nullable(),
  progressStage: z
    .enum(["opening_page", "extracting", "saving"])
    .nullable(),
  draft: recipeDraftSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type RecipeImportRow = typeof schema.recipeImports.$inferSelect;

function toRecipeImportOut(row: RecipeImportRow): z.infer<typeof recipeImportOut> {
  let draft: RecipeDraft | null = null;
  if (row.draftJson) {
    try {
      const rawDraft = unwrapStoredJson(JSON.parse(row.draftJson)) as
        | { ingredients?: unknown }
        | undefined;
      if (rawDraft && Array.isArray(rawDraft.ingredients)) {
        rawDraft.ingredients = rawDraft.ingredients.map(fillMicros);
      }
      const parsed = recipeDraftSchema.safeParse(rawDraft);
      if (parsed.success) draft = parsed.data;
    } catch {
      draft = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    sourceUrl: row.sourceUrl,
    status: row.status,
    error: row.error,
    progress: row.progress,
    progressStage: row.progressStage,
    draft,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// A pending URL recipe import whose agent has sent no callback
// (progress or completion — both refresh updatedAt) for this long is
// dead, exactly like a stale deep-research job: without an expiry the
// recipes tab would poll it forever and the user could never tell a
// lost import from a slow one. The agent normally finishes in ~1
// minute. A late completion callback still lands (completeRecipeImport
// does not require pending status), so a merely slow agent's draft is
// not lost.
const RECIPE_IMPORT_STALE_MS = 6 * 60 * 1000;
const RECIPE_IMPORT_TIMEOUT_ERROR =
  "読み取りエージェントから時間内に応答がありませんでした";

async function expireStaleRecipeImport(
  ctx: Ctx,
  row: RecipeImportRow,
): Promise<RecipeImportRow> {
  if (
    row.status !== "pending" ||
    Date.now() - row.updatedAt.getTime() < RECIPE_IMPORT_STALE_MS
  ) {
    return row;
  }
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.recipeImports)
    .set({
      status: "failed",
      error: RECIPE_IMPORT_TIMEOUT_ERROR,
      updatedAt: new Date(),
    })
    .where(eq(schema.recipeImports.id, row.id));
  await bumpMetric(ctx, "recipe_import.expired");
  ctx.invalidateQueries();
  return {
    ...row,
    status: "failed" as const,
    error: RECIPE_IMPORT_TIMEOUT_ERROR,
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Staple seed foods — 日本食品標準成分表（八訂）増補2023, per 100 g.
// Values verified against 文部科学省 食品成分データベース (fooddb.mext.go.jp).
// No branded products: the user registers those from label photos.
// ---------------------------------------------------------------------------
const SEED_FOODS: Array<{
  no: string;
  name: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  saltG: number | null;
  defaultAmount: number;
  defaultUnit: string;
  unitGrams: number | null;
}> = [
  { no: "01088", name: "ご飯（精白米）", kcal: 156, proteinG: 2.5, fatG: 0.3, carbsG: 37.1, saltG: 0, defaultAmount: 150, defaultUnit: "g", unitGrams: null },
  { no: "01026", name: "食パン", kcal: 248, proteinG: 8.9, fatG: 4.1, carbsG: 46.4, saltG: null, defaultAmount: 1, defaultUnit: "枚", unitGrams: 60 },
  { no: "12004", name: "鶏卵（全卵）", kcal: 142, proteinG: 12.2, fatG: 10.2, carbsG: 0.4, saltG: null, defaultAmount: 1, defaultUnit: "個", unitGrams: 50 },
  { no: "11220", name: "鶏むね肉（皮なし）", kcal: 105, proteinG: 23.3, fatG: 1.9, carbsG: 0.1, saltG: null, defaultAmount: 100, defaultUnit: "g", unitGrams: null },
  { no: "11227", name: "鶏ささみ", kcal: 98, proteinG: 23.9, fatG: 0.8, carbsG: 0.1, saltG: null, defaultAmount: 1, defaultUnit: "本", unitGrams: 50 },
  { no: "13003", name: "牛乳", kcal: 61, proteinG: 3.3, fatG: 3.8, carbsG: 4.8, saltG: null, defaultAmount: 200, defaultUnit: "g", unitGrams: null },
  { no: "04046", name: "納豆（糸引き）", kcal: 184, proteinG: 16.5, fatG: 10.0, carbsG: 12.1, saltG: null, defaultAmount: 1, defaultUnit: "パック", unitGrams: 40 },
  { no: "04032", name: "木綿豆腐", kcal: 73, proteinG: 7.0, fatG: 4.9, carbsG: 1.5, saltG: 0.1, defaultAmount: 150, defaultUnit: "g", unitGrams: null },
  { no: "07107", name: "バナナ", kcal: 93, proteinG: 1.1, fatG: 0.2, carbsG: 22.5, saltG: null, defaultAmount: 1, defaultUnit: "本", unitGrams: 100 },
  { no: "13025", name: "ヨーグルト（全脂無糖）", kcal: 56, proteinG: 3.6, fatG: 3.0, carbsG: 4.9, saltG: 0.1, defaultAmount: 100, defaultUnit: "g", unitGrams: null },
  { no: "13040", name: "プロセスチーズ", kcal: 313, proteinG: 22.7, fatG: 26.0, carbsG: 1.3, saltG: 2.8, defaultAmount: 1, defaultUnit: "枚", unitGrams: 20 },
  { no: "10154", name: "さば（まさば・生）", kcal: 211, proteinG: 20.6, fatG: 16.8, carbsG: 0.3, saltG: null, defaultAmount: 1, defaultUnit: "切れ", unitGrams: 80 },
  { no: "10134", name: "鮭（しろざけ・生）", kcal: 124, proteinG: 22.3, fatG: 4.1, carbsG: 0.1, saltG: null, defaultAmount: 1, defaultUnit: "切れ", unitGrams: 80 },
  { no: "07176", name: "りんご（皮つき）", kcal: 56, proteinG: 0.2, fatG: 0.3, carbsG: 16.2, saltG: null, defaultAmount: 150, defaultUnit: "g", unitGrams: null },
  { no: "01039", name: "うどん（ゆで）", kcal: 95, proteinG: 2.6, fatG: 0.4, carbsG: 21.6, saltG: null, defaultAmount: 1, defaultUnit: "玉", unitGrams: 250 },
];

const foodInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1).max(100),
  basisType: z.enum(["per100g", "serving"]),
  basisLabel: z.string().min(1).max(60),
  kcal: z.number().min(0).max(10000),
  proteinG: z.number().min(0).max(1000),
  fatG: z.number().min(0).max(1000),
  carbsG: z.number().min(0).max(1000),
  saltG: z.number().min(0).max(1000).nullable().optional(),
  ...microInputZod,
  source: z.enum(["table", "label", "manual", "ai", "blend"]),
  sourceName: z.string().min(1).max(200).nullable().optional(),
  sourceUrl: httpUrl(1000).nullable().optional(),
  defaultAmount: z.number().positive().max(100000),
  defaultUnit: z.string().min(1).max(10),
  unitGrams: z.number().positive().max(100000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// AIアシスト記録 (AI-assist logging): log a variation that has no exact
// master entry （例：焼き芋の皮つき — the table only carries 皮なし 焼き）
// WITHOUT registering anything. assistMealInput is read-only: it parses
// the natural-language input, gathers master candidates server-side,
// and lets the model pick the closest base food plus a conversion
// （係数＋根拠）. Nutrient values ALWAYS come from the base food's master
// row — the model never returns a nutrient number, only a food id, a
// factor and a rationale. Logging itself goes through logMeal with the
// effective grams and an assistNote, so the snapshot path is unchanged.
// ---------------------------------------------------------------------------

// One ingredient part of a decomposition proposal （分解モード）. The
// model proposes the part name, grams and rationale; the server
// matches the part against the master (food + swap alternatives) —
// nutrient values are never part of this payload. status is the
// proposal's initial state: 'counted' (a matched food the totals will
// include once grams are set), 'excluded' （水・だし汁など、栄養的に
// 無視できるため計算対象外として明示する部品）, 'unmatched' (no
// master food found — shown to the user, never silently dropped, and
// never part of the totals).
const assistPartOut = z.object({
  partName: z.string(),
  rationale: z.string(),
  grams: z.number().nullable(),
  food: foodOut.nullable(),
  alternatives: z.array(foodOut),
  status: z.enum(["counted", "excluded", "unmatched"]),
});

const assistOut = z.object({
  status: z.enum(["ok", "none", "decomposed"]),
  originalText: z.string(),
  base: foodOut.nullable(),
  alternatives: z.array(foodOut),
  // The amount as typed, converted to grams. inputGrams is null when no
  // amount could be read; amountAssumption states the premise of a
  // count/cup → gram conversion （例：「茶碗1杯を約150gとして換算」),
  // empty when the amount was given in grams directly.
  inputGrams: z.number().nullable(),
  amountText: z.string(),
  amountAssumption: z.string(),
  // Conversion factor （推定）: effectiveGrams = inputGrams × factor.
  factor: z.number().nullable(),
  effectiveGrams: z.number().nullable(),
  rationale: z.string(),
  // Decomposition proposal （分解モード）: only for status
  // 'decomposed' — the dish name (the logged entry's name) and the
  // ingredient parts. Empty / [] otherwise.
  dishName: z.string(),
  parts: z.array(assistPartOut),
});

// Step (1) of the assist: language-only parse of the input. Numeric
// ranges live in the schema (inputGrams is a gram amount: 0–100000),
// so an implausible answer fails validation at the boundary and is
// retried there instead of being filtered downstream.
const assistParseSchema = z.object({
  foodPhrase: z.string(),
  keywords: z.array(z.string()).max(10),
  amountText: z.string(),
  inputGrams: z.number().min(0).max(100000).nullable(),
  amountAssumption: z.string(),
});

// Step (3) of the assist: the base-food pick from the candidate pool.
// Ids must be positive integers (pool membership itself is a semantic
// check and stays server-side); the factor is bounded to the same
// 0–5 plausibility window the handler used to enforce after the fact.
const assistPickSchema = z.object({
  baseFoodId: z.number().int().positive().nullable(),
  alternativeFoodIds: z.array(z.number().int().positive()).max(10),
  factor: z.number().min(0).max(5).nullable(),
  rationale: z.string(),
});

// What the decomposition step may return: ingredient names, gram
// estimates and rationales ONLY — matching and all nutrient math stay
// server-side, exactly as in the single-base flow.
const decomposeSchema = z.object({
  decomposable: z.boolean(),
  dishName: z.string(),
  rationale: z.string(),
  parts: z.array(
    z.object({
      partName: z.string(),
      grams: z.number().min(0).max(100000).nullable(),
      rationale: z.string(),
      excluded: z.boolean(),
    }),
  ).max(12),
});

export const Actions = {
  seedFoods: defineAction({
    description:
      "Seeds the staple foods from the Japanese food composition table (八訂増補2023) when the food master is empty; otherwise does nothing.",
    request: z.object({}),
    response: z.object({ seeded: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.foods.id })
        .from(schema.foods)
        .limit(1);
      if (existing.length > 0) return { seeded: 0 };
      for (const f of SEED_FOODS) {
        const tableRow = FOOD_TABLE.find((r) => r[0] === f.no);
        await db.insert(schema.foods).values({
          name: f.name,
          basisType: "per100g",
          basisLabel: "100gあたり",
          kcal: f.kcal,
          proteinG: f.proteinG,
          fatG: f.fatG,
          carbsG: f.carbsG,
          saltG: f.saltG,
          ...(tableRow ? microsFromTableRow(tableRow) : emptyMicros()),
          source: "table",
          sourceName: FOOD_TABLE_SOURCE_NAME,
          sourceUrl: FOOD_TABLE_SOURCE_URL,
          tableNo: f.no,
          defaultAmount: f.defaultAmount,
          defaultUnit: f.defaultUnit,
          unitGrams: f.unitGrams,
        });
      }
      ctx.invalidateQueries();
      return { seeded: SEED_FOODS.length };
    },
  }),

  listFoods: defineAction({
    description:
      "Lists foods in the master (the full composition table plus user-registered foods), most frequently used first. The master holds ~2,500 foods, so this is a search interface: pass query to filter by name (normalized substring — hiragana/kanji variants in brackets are ignored), and limit (default 80) caps the page; total always reports the full match count.",
    request: z.object({
      query: z.string().max(100).optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    response: z.object({ foods: z.array(foodOut), total: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.foods)
        .orderBy(
          desc(schema.foods.useCount),
          desc(schema.foods.lastUsedAt),
          asc(schema.foods.name),
        );
      const q = args.query?.trim();
      if (!q) {
        return {
          foods: rows.slice(0, args.limit ?? 80).map(toFoodOut),
          total: rows.length,
        };
      }
      const nq = normName(q);
      const matched = rows.filter((r) => normName(r.name).includes(nq));
      // Relevance first (name starts with the query), then the usual
      // most-used ordering rows already carry.
      const starts = matched.filter((r) => normName(r.name).startsWith(nq));
      const rest = matched.filter((r) => !normName(r.name).startsWith(nq));
      const ordered = [...starts, ...rest];
      return {
        foods: ordered.slice(0, args.limit ?? 80).map(toFoodOut),
        total: matched.length,
      };
    },
  }),

  getFoodsByIds: defineAction({
    description:
      "Returns the master foods for the given ids (missing ids are omitted). Used to resolve foods already referenced from elsewhere, e.g. a recipe line's matched food, without paging the whole master.",
    request: z.object({
      ids: z.array(z.number().int().positive()).min(1).max(100),
    }),
    response: z.object({ foods: z.array(foodOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.foods)
        .where(inArray(schema.foods.id, args.ids));
      return { foods: rows.map(toFoodOut) };
    },
  }),

  importFoodTable: defineAction({
    description:
      "Imports the full 日本食品標準成分表（八訂）増補2023 (all ~2,500 foods, per 100 g, source 'table' with the MEXT citation) into the food master, including the micronutrients （食物繊維・カリウム・カルシウム・マグネシウム・鉄・ビタミンD・B1・B2・B6・B12・葉酸・ビタミンC). Idempotent: rows are keyed by composition-table number （食品番号） — for numbers already present on a source='table' food, only the micronutrient columns are refreshed (existing PFC / salt values are never overwritten); the original 15 seed staples (seeded before table numbers existed) are recognized by their exact nutrient values and tagged with their number instead of being duplicated. Foods the user registered by label photo, AI research or hand are never touched. A row whose name collides with an existing master food is skipped (the existing food wins) and reported in the result as `skipped` with up to 5 example names in `skippedNames`. For micronutrients, notations that cannot be confirmed as a plain number — '(…)' estimates, 'Tr' (trace) and '-' (unmeasured) — stay null; only plain printed numbers are stored (PFC/salt keep their existing parsing policy).",
    request: z.object({}),
    response: z.object({
      inserted: z.number(),
      tagged: z.number(),
      updated: z.number(),
      // Rows skipped because a food with the same name already exists
      // in the master (e.g. a user-registered food sharing a table
      // food's name). Previously these vanished silently, so the
      // inserted count did not reflect what actually happened.
      skipped: z.number(),
      skippedNames: z.array(z.string()),
      total: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.foods);
      const byNo = new Map(
        existing
          .filter((r): r is FoodRow & { tableNo: string } => r.tableNo != null)
          .map((r) => [r.tableNo, r]),
      );
      const haveName = new Set(existing.map((r) => r.name));
      // Seed staples from before table numbers were tracked: recognize
      // them by their exact nutrient tuple (verified unique per staple)
      // and tag them with their number rather than inserting a twin.
      const untagged = existing.filter(
        (r) => r.source === "table" && r.tableNo == null,
      );
      let tagged = 0;
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const skippedNames: string[] = [];
      const statements: BatchItem<"sqlite">[] = [];
      const claimed = new Set<number>();
      for (const row of FOOD_TABLE) {
        const [no, name, kcal, p, f, c, salt] = row;
        const micros = microsFromTableRow(row);
        const present = byNo.get(no);
        if (present) {
          // Already imported: refresh ONLY the micronutrients on table
          // foods whose values differ. PFC, salt and user-registered
          // (non-table) foods are never overwritten.
          if (
            present.source === "table" &&
            !sameMicros(microsOf(present), micros)
          ) {
            updated++;
            statements.push(
              db
                .update(schema.foods)
                .set({ ...micros })
                .where(eq(schema.foods.id, present.id)),
            );
          }
          continue;
        }
        const seed = untagged.find(
          (r, i) =>
            !claimed.has(i) &&
            r.kcal === kcal &&
            r.proteinG === p &&
            r.fatG === f &&
            r.carbsG === c,
        );
        if (seed) {
          claimed.add(untagged.indexOf(seed));
          tagged++;
          statements.push(
            db
              .update(schema.foods)
              .set({
                tableNo: no,
                sourceName: FOOD_TABLE_SOURCE_NAME,
                sourceUrl: FOOD_TABLE_SOURCE_URL,
                ...micros,
              })
              .where(eq(schema.foods.id, seed.id)),
          );
          continue;
        }
        if (haveName.has(name)) {
          // Same-name collision with an existing master food: skip
          // the row (the existing food wins) but COUNT it and keep a
          // few example names, so the import result tells the truth
          // about what was not imported.
          skipped++;
          if (skippedNames.length < 5) skippedNames.push(name);
          continue;
        }
        inserted++;
        statements.push(
          db.insert(schema.foods).values({
            name,
            basisType: "per100g",
            basisLabel: "100gあたり",
            kcal,
            proteinG: p,
            fatG: f,
            carbsG: c,
            saltG: salt,
            ...micros,
            source: "table",
            sourceName: FOOD_TABLE_SOURCE_NAME,
            sourceUrl: FOOD_TABLE_SOURCE_URL,
            tableNo: no,
            defaultAmount: 100,
            defaultUnit: "g",
            unitGrams: null,
          }),
        );
      }
      // Apply in chunks: one batch per 200 statements keeps each call
      // small while the whole import stays a handful of round trips.
      for (let i = 0; i < statements.length; i += 200) {
        const chunk = statements.slice(i, i + 200);
        const [first, ...rest] = chunk;
        if (first) await db.batch([first, ...rest]);
      }
      if (statements.length > 0) ctx.invalidateQueries();
      const totalRows = await db
        .select({ id: schema.foods.id })
        .from(schema.foods);
      return { inserted, tagged, updated, skipped, skippedNames, total: totalRows.length };
    },
  }),

  upsertFood: defineAction({
    description:
      "Creates a food in the master, or updates it when id is given. Values are per the stated basis (100 g or 1 serving).",
    request: foodInput,
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const values = {
        name: args.name,
        basisType: args.basisType,
        basisLabel: args.basisLabel,
        kcal: args.kcal,
        proteinG: args.proteinG,
        fatG: args.fatG,
        carbsG: args.carbsG,
        saltG: args.saltG ?? null,
        ...microsFromInput(args),
        source: args.source,
        sourceName:
          args.source === "ai" || args.source === "table" || args.source === "blend"
            ? (args.sourceName ?? null)
            : null,
        sourceUrl:
          args.source === "ai" || args.source === "table"
            ? (args.sourceUrl ?? null)
            : null,
        // A manual edit through this generic form detaches the food from
        // its stored blend basis (the numbers may no longer be the
        // computed ones); saveBlendFood is the path that keeps it.
        blendJson: null,
        defaultAmount: args.defaultAmount,
        defaultUnit: args.defaultUnit,
        unitGrams: args.unitGrams ?? null,
      };
      if (args.id != null) {
        const updated = await db
          .update(schema.foods)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.foods.id, args.id))
          .returning({ id: schema.foods.id });
        if (!updated[0]) {
          throw new Error("指定された食品が見つかりません");
        }
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const inserted = await db
        .insert(schema.foods)
        .values(values)
        .returning({ id: schema.foods.id });
      const row = inserted[0];
      if (!row) throw new Error("upsertFood: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteFood: defineAction({
    description:
      "Deletes a food from the master. Past meal logs keep their snapshots and are unaffected.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.foods)
        .where(eq(schema.foods.id, args.id))
        .returning({ id: schema.foods.id });
      if (!deleted[0]) {
        throw new Error("指定された食品が見つかりません");
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  parseBlendText: defineAction({
    description:
      "Parses a free-text description of a home blend （配合食品， e.g. 「もち麦50%ご飯：ご飯ともち麦を半々で炊いた」) into a blend draft: a suggested name, the parts with their gram amounts or percentage shares as stated, and a note of the assumptions made. Each part is matched against the food master with the recipe matcher; unmatched parts come back with food=null for the user to resolve. Nothing is registered — the draft goes to the blend editor, where the user checks the basis and saves via saveBlendFood.",
    request: z.object({ text: z.string().min(1).max(500) }),
    response: z.object({
      name: z.string(),
      note: z.string(),
      parts: z.array(
        z.object({
          text: z.string(),
          grams: z.number().nullable(),
          sharePercent: z.number().nullable(),
          food: foodOut.nullable(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const extracted = await completeWithRetry(
        ctx,
        `次の文章は、自宅で作る配合食品（複数の食品を混ぜたもの）の説明です。食品名の候補、各部品（材料）の名前と分量を読み取ってください。\n\n文章：${args.text.trim()}\n\nルール：\n- 部品の分量がグラム数で書かれていれば grams に入れる。割合（％・「半々」・「2:1」のような比）で書かれていれば sharePercent にパーセント数値で入れる（半々なら各50、2:1なら約66.7と33.3）。どちらも書かれていなければ両方 null。\n- 割合から勝手にグラム数を計算しない。グラム数が読み取れない部品は grams を null のままにする。\n- 食品名の候補が文章にあれば name に入れる（なければ部品から自然な名前を作る）。\n- 解釈で仮定したこと・曖昧な点があれば note に日本語で簡潔に書く（例：「炊き上がり重量での割合と解釈しました」）。仮定がなければ空文字。\n- 部品は文章に登場する食品だけ。調味料など書かれていないものは足さない。`,
        {
          schema: z.object({
            name: z.string(),
            note: z.string(),
            parts: z.array(
              z.object({
                name: z.string(),
                grams: z.number().min(0).max(100000).nullable(),
                sharePercent: z.number().min(0).max(100).nullable(),
              }),
            ).max(20),
          }),
          timeout_secs: 30,
        },
        2,
        "blend_parse",
      );
      const db = ctx.db<typeof schema>();
      const allFoods = await db.select().from(schema.foods);
      const cores = allFoods.map((f) => foodCores(f.name));
      return {
        name: extracted.name.trim(),
        note: extracted.note.trim(),
        parts: extracted.parts
          .filter((p) => p.name.trim() !== "")
          .map((p) => {
            const matched = bestFoodMatch(p.name.trim(), allFoods, cores);
            return {
              text: p.name.trim(),
              grams: p.grams != null && p.grams > 0 ? p.grams : null,
              sharePercent:
                p.sharePercent != null && p.sharePercent > 0
                  ? Math.round(p.sharePercent * 10) / 10
                  : null,
              food: matched ? toFoodOut(matched) : null,
            };
          }),
      };
    },
  }),

  saveBlendFood: defineAction({
    description:
      "Registers a blend food （配合食品） computed from food-master parts: each part's nutrients are recomputed server-side from the master entry × its grams, summed, and normalized to per-100 g of the finished blend (totalGrams, which may differ from the parts sum when cooking changes the weight). The food is stored with source 'blend', the calculation basis (parts, each part's per-100 g contribution, total, note) in blend_json, and a one-line basis summary as sourceName. Salt and each micronutrient are only set when every part carries a value for them. Updates the food in place when id is given. This is the ONLY write in the blend flow — parseBlendText never registers anything.",
    request: z.object({
      id: z.number().int().positive().optional(),
      name: z.string().min(1).max(100),
      note: z.string().max(500).optional(),
      totalGrams: z.number().positive().max(100000),
      defaultAmount: z.number().positive().max(100000),
      parts: z
        .array(
          z.object({
            foodId: z.number().int().positive(),
            grams: z.number().positive().max(100000),
          }),
        )
        .min(2)
        .max(20),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const foodById = await loadFoodMap(db);
      const total = args.totalGrams;
      let kcal = 0,
        p = 0,
        f = 0,
        c = 0,
        salt = 0,
        saltComplete = true;
      // Micronutrients follow the salt rule, per nutrient: a value is
      // only stored when EVERY part carries it — a partial sum would
      // read as a confirmed (too small) total, so any gap makes that
      // nutrient null (unknown) for the blend.
      const microSums = {} as Record<MicroKey, number>;
      const microComplete = {} as Record<MicroKey, boolean>;
      for (const key of MICRO_KEYS) {
        microSums[key] = 0;
        microComplete[key] = true;
      }
      const basisParts: BlendBasis["parts"] = [];
      for (const part of args.parts) {
        const food = foodById.get(part.foodId);
        if (!food) {
          throw new Error("部品の食品がマスタに見つかりませんでした");
        }
        const n = nutrientsForGrams(food, part.grams);
        if (!n) {
          throw new Error(
            `「${food.name}」はグラム換算できない食品のため部品にできません`,
          );
        }
        kcal += n.kcal;
        p += n.proteinG;
        f += n.fatG;
        c += n.carbsG;
        if (n.saltG == null) saltComplete = false;
        else salt += n.saltG;
        for (const key of MICRO_KEYS) {
          const v = n[key];
          if (v == null) microComplete[key] = false;
          else microSums[key] += v;
        }
        const k = 100 / total;
        basisParts.push({
          foodId: food.id,
          foodName: food.name,
          grams: part.grams,
          kcal: Math.round(n.kcal * k),
          proteinG: round1(n.proteinG * k),
          fatG: round1(n.fatG * k),
          carbsG: round1(n.carbsG * k),
          saltG: n.saltG == null ? null : round2(n.saltG * k),
          ...scaleMicros(microsOf(n), k),
        });
      }
      const k = 100 / total;
      const note = (args.note ?? "").trim();
      const basisLine =
        "配合計算：" +
        basisParts
          .map((bp) => `${bp.foodName} ${fmtNum(bp.grams)}g`)
          .join(" ＋ ") +
        `（全${fmtNum(total)}g）` +
        (note ? `／${note}` : "");
      const values = {
        name: args.name.trim(),
        basisType: "per100g" as const,
        basisLabel: "100gあたり",
        kcal: Math.round(kcal * k),
        proteinG: round1(p * k),
        fatG: round1(f * k),
        carbsG: round1(c * k),
        saltG: saltComplete ? round2(salt * k) : null,
        ...(() => {
          const out = {} as MicroValues;
          for (const key of MICRO_KEYS) {
            out[key] = microComplete[key]
              ? MICRO_ROUND[key](microSums[key] * k)
              : null;
          }
          return out;
        })(),
        source: "blend" as const,
        sourceName: basisLine.slice(0, 200),
        sourceUrl: null,
        blendJson: stringifyStoredJson({
          note,
          totalGrams: total,
          parts: basisParts,
        } satisfies BlendBasis),
        tableNo: null,
        defaultAmount: args.defaultAmount,
        defaultUnit: "g",
        unitGrams: null,
      };
      if (args.id != null) {
        const updated = await db
          .update(schema.foods)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.foods.id, args.id))
          .returning({ id: schema.foods.id });
        if (!updated[0]) {
          throw new Error("指定された食品が見つかりません");
        }
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const inserted = await db
        .insert(schema.foods)
        .values(values)
        .returning({ id: schema.foods.id });
      const row = inserted[0];
      if (!row) throw new Error("saveBlendFood: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  parseLabelImage: defineAction({
    description:
      "Reads a photo of a packaged food's nutrition label (栄養成分表示) and returns a draft food registration: name, basis (per 100 g or per serving), energy, protein, fat, carbs, salt, and any micronutrients the label actually prints （食物繊維・カルシウム・鉄など — most labels print few beyond salt; unprinted nutrients stay null). The photo is not stored.",
    request: z.object({
      imageBase64: z.string().min(100).max(10_000_000),
      mimeType: z.enum(["image/jpeg", "image/png"]),
    }),
    response: z.object({
      readable: z.boolean(),
      name: z.string(),
      basisType: z.enum(["per100g", "serving", "unknown"]),
      basisLabel: z.string(),
      servingGrams: z.number().nullable(),
      kcal: z.number(),
      proteinG: z.number(),
      fatG: z.number(),
      carbsG: z.number(),
      saltG: z.number().nullable(),
      ...microZod,
    }),
    async handler(ctx, args) {
      // Hard total budget, enforced locally via raceDeadline: the old
      // shape (timeout_secs 120 × 2 retried attempts) let one photo
      // read hold the form for 150 s+ with no way out. Now the whole
      // read — retries included — must finish within ~55 s; a retry
      // only happens when an attempt failed FAST (a transient error),
      // never after a long hang, and budget exhaustion returns a clear
      // failure instead of spinning.
      const LABEL_BUDGET_MS = 55_000;
      const startedAt = Date.now();
      const remainingMs = () => LABEL_BUDGET_MS - (Date.now() - startedAt);
      const prompt =
        "添付の写真は食品パッケージの栄養成分表示です。食品名（パッケージに商品名が見えればそれ、なければ空文字）、基準（100gあたり／100mlあたりか、1食分・1個・1袋など1単位あたりか）、熱量（エネルギー）、たんぱく質、脂質、炭水化物、食塩相当量を読み取ってください。基準が1単位あたりの場合は、その単位の表記（例: 1食分（200g））を basisLabel に、1単位のグラム数が分かれば servingGrams に入れてください。100gあたりの場合は basisLabel に「100gあたり」と入れてください。食塩相当量の記載がなければ saltG は null にしてください。さらに、表示に印字されている場合のみ、微量栄養素も読み取ってください：食物繊維 fiberG（g）、カリウム potassiumMg（mg）、カルシウム calciumMg（mg）、マグネシウム magnesiumMg（mg）、鉄 ironMg（mg）、ビタミンD vitaminDMcg（µg）、ビタミンB1 vitaminB1Mg（mg）、ビタミンB2 vitaminB2Mg（mg）、ビタミンB6 vitaminB6Mg（mg）、ビタミンB12 vitaminB12Mcg（µg）、葉酸 folateMcg（µg）、ビタミンC vitaminCMg（mg）。印字されていない項目は推測せず null にしてください（炭水化物から食物繊維を差し引いて糖質を出すような計算もしないでください）。表示が読み取れない場合は readable を false にしてください。";
      const labelSchema = z.object({
        readable: z.boolean(),
        name: z.string(),
        basisType: z.enum(["per100g", "serving", "unknown"]),
        basisLabel: z.string(),
        servingGrams: z.number().min(0).max(100000).nullable(),
        kcal: z.number().min(0).max(10000),
        proteinG: z.number().min(0).max(1000),
        fatG: z.number().min(0).max(1000),
        carbsG: z.number().min(0).max(1000),
        saltG: z.number().min(0).max(1000).nullable(),
        ...microZod,
      });
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const remaining = remainingMs();
        if (remaining <= 0) break;
        await bumpMetric(ctx, "label_photo.attempts");
        if (attempt > 0) await bumpMetric(ctx, "label_photo.retries");
        try {
          return await raceDeadline(
            ctx.inference.complete(prompt, {
              schema: labelSchema,
              images: [
                {
                  dataBase64: args.imageBase64,
                  mimeType: args.mimeType,
                  filename: "label",
                },
              ],
              timeout_secs: Math.max(
                10,
                Math.floor(remaining / 1000) - 5,
              ),
            }),
            remaining,
            "label photo read",
          );
        } catch (e) {
          lastError = e;
          await bumpMetric(ctx, "label_photo.failures");
          if (InferenceSchemaError.is(e)) {
            await bumpMetric(ctx, "label_photo.schema_failures");
          }
          if (e instanceof SyncBudgetExceeded) break;
          // Retry only a fast transient failure, and only with budget
          // to spare — a slow attempt is never repeated.
          if (attempt === 0 && remainingMs() > 20_000) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          break;
        }
      }
      if (lastError instanceof SyncBudgetExceeded) {
        throw new Error(
          "読み取りが制限時間（約1分）内に終わりませんでした。写真を撮り直すか、手入力してください。",
        );
      }
      throw lastError instanceof Error
        ? lastError
        : new Error("読み取りに失敗しました");
    },
  }),

  lookupFoodInfo: defineAction({
    description:
      "AI research for registering a food that is not in the master yet, as a staged escalation with a bounded synchronous wait (~60 s at most). Resolution order: (1) foods already in the master with a similar name (status 'existing'); (2) the stored research record for this name from a previous lookup (status 'found'/'not_found' with fromRecord=true, no web search — a maker mismatch re-searches, a maker-less legacy record always matches); (3) stage 1: a fresh parallel web search whose result snippets are distilled into a draft (via 'snippet'); (4) stage 2: the bodies of the top candidate pages (maker's official store/site first, then public databases) are fetched and the nutrition table is read from the page text itself (via 'page') — this is what confirms branded products whose table never reaches the snippets. Extraction is single-attempt per stage: a timeout or failure escalates to the next stage instead of retrying the same material. The ~55 s synchronous budget is enforced locally (every stage is raced against the remaining budget), so the action ALWAYS reaches a terminal state: when no stage confirms values it saves a 'not_found' record, starts the background deep research itself, and returns 'not_found' with deepJobId set — the handoff no longer depends on the client still waiting. Every completed lookup, found or not, is saved as a research record (see listResearch) so it is kept and reused. Pass force=true to skip steps 1–2 and search again, overwriting the record. `maker` is an optional maker/brand name: it steers query building and SKU identification and is stored on the record, but it is never a hard filter — product-name-only queries always run too. When no trustworthy source is found it returns status 'not_found' and never guesses values. The draft is NOT saved as a food; registration happens through upsertFood with source 'ai' plus sourceName/sourceUrl after the user confirms.",
    request: z.object({
      name: z.string().min(1).max(100),
      maker: z.string().max(60).optional(),
      force: z.boolean().optional(),
    }),
    response: z.object({
      status: z.enum(["existing", "found", "not_found"]),
      fromRecord: z.boolean(),
      // Which stage produced the answer: 'existing' (master duplicate),
      // 'record' (stored research record), 'snippet' (stage 1), 'page'
      // (stage 2, page body), 'none' (nothing confirmed — the client
      // escalates to the background deep research).
      via: z.enum(["existing", "record", "snippet", "page", "none"]),
      candidates: z.array(foodOut),
      draft: draftOut.nullable(),
      // On a fresh 'not_found' the server has ALREADY handed off to
      // the background deep research before returning (the sync phase
      // is hard-budgeted, so this exit is always reached): this is
      // the started (or reused) job's id, so the client can attach to
      // it directly. Null when no job was started (found / existing /
      // record outcomes, or the spawn itself failed).
      deepJobId: z.number().nullable(),
    }),
    privileged: [privileged.fetchPageText],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const startedAt = Date.now();
      const elapsedMs = () => Date.now() - startedAt;
      // Hard synchronous budget (~55 s), enforced locally with
      // raceDeadline at every stage — NOT delegated to the inference
      // service's timeout_secs or to stage-boundary elapsed checks.
      // The previous shape checked the clock only between stages, and
      // a single slow call could hold the action past 80 s: it never
      // reached the not_found exit below, so no research record was
      // saved and the deep-research handoff never fired — the lookup
      // vanished without a trace. Now every stage is raced against
      // the remaining budget, and the exit path (record + server-side
      // handoff) is always reached.
      const SYNC_BUDGET_MS = 55_000;
      const remainingMs = () => SYNC_BUDGET_MS - elapsedMs();
      const q = args.name.trim();
      const nq = normName(q);
      const maker = (args.maker ?? "").trim();
      const nMaker = normName(maker);
      // The name the searches target: maker + product when a maker was
      // given. Product-only variants always run alongside, so a wrong
      // or oddly-spelled maker can never zero the results out.
      const fullName = maker ? `${maker} ${q}` : q;

      if (!args.force) {
        // 1) Duplicate guard: surface similar foods already in the master
        //    before spending a web search.
        if (nq) {
          const rows = await db.select().from(schema.foods);
          const candidates = rows
            .filter((r) => {
              const nr = normName(r.name);
              return nr.includes(nq) || nq.includes(nr);
            })
            .slice(0, 5);
          if (candidates.length > 0) {
            return {
              status: "existing" as const,
              fromRecord: false,
              via: "existing" as const,
              candidates: candidates.map(toFoodOut),
              draft: null,
              deepJobId: null,
            };
          }
        }

        // 2) Research record: a previous lookup for this name is kept and
        //    returned as-is instead of searching again. Maker rule: a
        //    record with no maker (everything stored before the maker
        //    field existed, or a lookup where the maker stayed unknown)
        //    matches any lookup, as before; a record stored for a
        //    DIFFERENT maker does not — the same product name can be a
        //    different product under another brand, so search fresh.
        if (nq) {
          const records = await db
            .select()
            .from(schema.foodResearch)
            .where(eq(schema.foodResearch.queryNorm, nq))
            .limit(1);
          const record = records[0];
          if (record) {
            const recordMaker = normName(record.maker ?? "");
            if (!nMaker || !recordMaker || recordMaker === nMaker) {
              const draft = researchDraft(record);
              return {
                status: draft ? ("found" as const) : ("not_found" as const),
                fromRecord: true,
                via: "record" as const,
                candidates: [],
                draft,
                deepJobId: null,
              };
            }
          }
        }
      }

      // 3) Search public sources. All queries run in parallel and each is
      //    time-boxed: a slow source must not hang the whole lookup. The
      //    query set pairs maker-qualified variants (they hit the maker's
      //    official store/product pages) with product-only variants
      //    (the fallback when the maker is missing or misspelled). The
      //    merged pool is re-ranked by nutrient signal: generic queries
      //    return a flood of unrelated pages (foreign product PDFs,
      //    index pages) that used to crowd out the one manufacturer page
      //    carrying the values, so results whose snippet actually
      //    mentions nutrient terms — and results from fooddb or an
      //    official-looking store — are fed to the extractor first.
      const queries = [
        `${fullName} fooddb.mext.go.jp 食品成分`,
        `${fullName} 栄養成分 メーカー 公式`,
        `${fullName} 栄養成分表示`,
        `${fullName} 公式 栄養成分表示`,
        `${q} 栄養成分表示 成分表`,
        ...(maker ? [`${maker} 公式ストア ${q}`, `${maker} 公式 ${q}`] : []),
      ];
      const SEARCH_TIMEOUT_MS = 10000;
      const searchOrEmpty = (query: string) =>
        Promise.race([
          ctx.tool.web_search(query),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), SEARCH_TIMEOUT_MS),
          ),
        ]).catch(() => null);
      const searchResults = await Promise.all(queries.map(searchOrEmpty));
      type PoolItem = { title: string; url: string; snippet: string };
      const seen = new Set<string>();
      const pool: PoolItem[] = [];
      for (const res of searchResults) {
        if (!res) continue;
        for (const r of res.content.results) {
          if (!r.url || seen.has(r.url)) continue;
          seen.add(r.url);
          pool.push({
            title: r.title,
            url: r.url,
            snippet: (r.snippet ?? "").slice(0, 1500),
          });
        }
      }
      const nameTokens = fullName
        .toLowerCase()
        .split(/[\s　]+/)
        .filter(Boolean);
      const signalScore = (r: PoolItem) => {
        let s = 0;
        if (/kcal|エネルギー/.test(r.snippet)) s += 2;
        if (r.snippet.includes("たんぱく質")) s += 1;
        if (r.snippet.includes("脂質")) s += 1;
        if (r.snippet.includes("炭水化物")) s += 1;
        if (r.snippet.includes("食塩相当量")) s += 1;
        if (r.snippet.includes("食物繊維")) s += 1;
        if (r.url.includes("fooddb.mext.go.jp")) s += 3;
        // Official stores/sites are where the full table lives; keep
        // them visible both to the snippet extractor and to stage 2.
        if (r.title.includes("公式") || /store\.|shop\.|official/.test(r.url))
          s += 2;
        const text = `${r.title}\n${r.snippet}`.toLowerCase();
        if (nameTokens.some((t) => text.includes(t))) s += 2;
        return s;
      };
      const ranked = pool
        .map((r, i) => ({ r, i, s: signalScore(r) }))
        .sort((a, b) => b.s - a.s || a.i - b.i);
      const results = ranked.filter((x) => x.s > 0).slice(0, 14).map((x) => x.r);

      // Every completed lookup is kept as a research record, found or
      // not, so the work is never lost and a repeat lookup is instant.
      const saveRecord = async (
        values: Omit<
          typeof schema.foodResearch.$inferInsert,
          "id" | "queryName" | "queryNorm"
        >,
      ): Promise<void> => {
        if (!nq) return;
        await db
          .insert(schema.foodResearch)
          .values({ queryName: q, queryNorm: nq, ...values })
          .onConflictDoUpdate({
            target: schema.foodResearch.queryNorm,
            set: { queryName: q, ...values, updatedAt: new Date() },
          });
        ctx.invalidateQueries();
      };
      const notFoundValues = {
        status: "not_found" as const,
        maker: maker || null,
        name: null,
        basisType: null,
        basisLabel: null,
        servingGrams: null,
        kcal: null,
        proteinG: null,
        fatG: null,
        carbsG: null,
        saltG: null,
        ...emptyMicros(),
        sourceName: null,
        sourceUrl: null,
      };

      if (results.length === 0) {
        // No source could be reached at all: record nothing (a later
        // retry deserves a fresh attempt) and report the failure
        // honestly instead of spinning forever.
        throw new Error(
          "公開情報の検索に接続できませんでした。時間をおいて再試行してください。",
        );
      }

      const extractSchema = z.object({
        found: z.boolean(),
        name: z.string(),
        maker: z.string(),
        basisType: z.enum(["per100g", "serving", "unknown"]),
        basisLabel: z.string(),
        servingGrams: z.number().min(0).max(100000).nullable(),
        kcal: z.number().min(0).max(10000),
        proteinG: z.number().min(0).max(1000),
        fatG: z.number().min(0).max(1000),
        carbsG: z.number().min(0).max(1000),
        saltG: z.number().min(0).max(1000).nullable(),
        ...microZod,
        sourceName: z.string(),
        sourceUrl: z.string(),
      });
      type Extracted = z.infer<typeof extractSchema>;
      const rulesText = [
        "ルール:",
        "- 値は与えられた材料に明記されているものだけを使い、推測や概算で埋めないこと。エネルギー・たんぱく質・脂質・炭水化物が揃わない場合は found を false にすること。",
        "- 食塩相当量の記載がなければ saltG は null。",
        "- 微量栄養素（食物繊維 fiberG・カリウム potassiumMg・カルシウム calciumMg・マグネシウム magnesiumMg・鉄 ironMg・ビタミンD vitaminDMcg・ビタミンB1 vitaminB1Mg・ビタミンB2 vitaminB2Mg・ビタミンB6 vitaminB6Mg・ビタミンB12 vitaminB12Mcg・葉酸 folateMcg・ビタミンC vitaminCMg）は、材料に出典の値として明記されている項目だけを入れ、明記されていない項目は null にすること。類似食品からの推測や一般値で埋めないこと。",
        "- 基準が100gあたりなら basisType は per100g、basisLabel は「100gあたり」。1食分・1個など1単位あたりなら basisType は serving、basisLabel に単位表記（例: 1食分（30g）あたり）、分かる場合は servingGrams に1単位のグラム数。",
        "- 同じ商品でも容量・版違い（旧版・別容量・スプーン有無など）で値が異なるものが複数見つかることがある。その場合は値を混ぜたり平均したりせず、必ず次の優先順位で1つの版だけを選んで一式そのまま採用すること（複数の版があること自体は found を false にする理由にならない）: 1) メーカー公式ストア/公式サイトに現在載っているもの 2) お試し・トライアル・数量限定などの付帯表記がない通常商品（レギュラーサイズ） 3) 検索名（とメーカー名）に最も一致するもの。採用した版の基準（1食○gあたり等）を basisLabel に明示すること。",
        "- maker には、この食品のメーカー/ブランド名を入れること（材料や出典から分かる場合。ユーザーがメーカー名を指定している場合はそれを優先する。分からなければ空文字）。",
        "- sourceUrl は、値を採用した材料のURLを一字一句そのままコピーすること。sourceName は出典の名称（例: 日本食品標準成分表（八訂）増補2023、ビーレジェンド公式オンラインショップ）。",
        "- name は出典での食品名（例: オートミール）。",
      ].join("\n");
      // Grounding check: the headline numbers of a draft must appear
      // verbatim in the material of the page they are cited to. A
      // model that cannot find the table in the given material
      // sometimes completes it from its own knowledge instead (values
      // roughly right, cited to a plausible URL) — such a draft must
      // never stand: the numbers were not read from the source. Text
      // is normalized (full-width digits, thousands separators) before
      // comparing, and a number's plain or integer form both count.
      const normalizeNums = (s: string) =>
        s
          .replace(/[０-９]/g, (c) =>
            String.fromCharCode(c.charCodeAt(0) - 0xfee0),
          )
          .replace(/,/g, "");
      const numAppears = (text: string, n: number): boolean => {
        const t = normalizeNums(text);
        const plain = String(n);
        if (t.includes(plain)) return true;
        if (Number.isInteger(n)) return false;
        return t.includes(plain.replace(/0+$/, "").replace(/\.$/, ""));
      };
      // Validate an extraction the same way for both stages: the
      // citation must be a page the stage actually used, and kcal +
      // protein must be grounded in that page's material; otherwise
      // the draft cannot be stood behind and the lookup moves on
      // (next stage / not_found). Pure numeric ranges (kcal ≤ 10000,
      // PFC within 0–1000, non-negative values) are NOT re-checked
      // here anymore: they live in extractSchema itself, so an
      // out-of-range answer already failed validation at the model
      // boundary. What remains below are the semantic checks a schema
      // cannot express: a "found" draft needs positive energy, and an
      // unknown basis still needs its label stated.
      const toDraft = (
        extracted: Extracted,
        materialByUrl: Map<string, string>,
      ): z.infer<typeof draftOut> | null => {
        const citedText = materialByUrl.get(extracted.sourceUrl);
        const urlOk = citedText != null;
        const sane =
          extracted.kcal > 0 &&
          (extracted.basisType !== "unknown" ||
            extracted.basisLabel.trim() !== "");
        const grounded =
          citedText != null &&
          numAppears(citedText, extracted.kcal) &&
          numAppears(citedText, extracted.proteinG);
        if (!urlOk || !sane || !grounded) return null;
        return {
          name: extracted.name || q,
          maker:
            maker ||
            (extracted.maker.trim() !== "" ? extracted.maker.trim() : null),
          basisType: extracted.basisType,
          basisLabel: extracted.basisLabel,
          servingGrams: extracted.servingGrams,
          kcal: extracted.kcal,
          proteinG: extracted.proteinG,
          fatG: extracted.fatG,
          carbsG: extracted.carbsG,
          saltG: extracted.saltG,
          ...microsOf(extracted),
          sourceName: extracted.sourceName,
          sourceUrl: extracted.sourceUrl,
        };
      };
      const saveFound = async (draft: z.infer<typeof draftOut>) => {
        await saveRecord({
          status: "found",
          maker: draft.maker,
          name: draft.name,
          basisType: draft.basisType,
          basisLabel: draft.basisLabel,
          servingGrams: draft.servingGrams,
          kcal: draft.kcal,
          proteinG: draft.proteinG,
          fatG: draft.fatG,
          carbsG: draft.carbsG,
          saltG: draft.saltG,
          ...microsOf(draft),
          sourceName: draft.sourceName,
          sourceUrl: draft.sourceUrl,
        });
      };

      // ---- Stage 1: distill a draft from the search-result snippets.
      // Single attempt, short timeout: when the snippets carry the
      // table this lands in ~15 s; when they don't (the branded-product
      // case), failing fast and moving to the page bodies beats the old
      // behavior of a 60 s timeout retried on identical material, which
      // is what held the form past 100 s.
      try {
        const extracted = await raceDeadline(
          completeOnce(
            ctx,
            `次のWeb検索結果は、食品「${fullName}」の栄養成分に関するものです。信頼できる出典から、この食品の栄養成分値（可食部100gあたり、またはその製品として一般的な1食分・1個あたり）を抽出してください。\n\n出典の優先順位: 1) 文部科学省 日本食品標準成分表（fooddb.mext.go.jp の食品詳細ページ。MODE=0 の一般成分の値を優先） 2) メーカー公式サイト・公式ストアの栄養成分ページ 3) その他の公的データベース（USDA FoodData Central、厚生労働省など）。個人ブログ・まとめサイト・通販サイトの値は採用しないでください（ただし公的出典の値をそのまま引用している場合も、その引用元のURLではなく出典本体のURLが検索結果にあればそちらを優先してください）。\n\n${rulesText}\n\n検索結果:\n${results
              .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
              .join("\n\n")}`,
            { schema: extractSchema, timeout_secs: 20 },
            "lookup_extract",
          ),
          Math.min(20_000, remainingMs()),
          "stage 1 extraction",
        );
        if (extracted.found) {
          const draft = toDraft(
            extracted,
            new Map(results.map((r) => [r.url, r.snippet])),
          );
          if (draft) {
            await saveFound(draft);
            return {
              status: "found" as const,
              fromRecord: false,
              via: "snippet" as const,
              candidates: [],
              draft,
              deepJobId: null,
            };
          }
        }
      } catch {
        // Timed out or failed: escalate to stage 2 on different
        // material instead of retrying the same snippets.
      }

      // ---- Stage 2: read the candidate pages' bodies, following the
      // maker's own site structure when the product page itself is not
      // in the search pool. Makers publish the full 栄養成分表示 in the
      // product page's HTML text, but the table sits deep in the page —
      // past where search snippets cut off (BASE BREAD, be LEGEND) —
      // and the product page is often only reachable by following a
      // category/search link from a page the search DID surface. So:
      // round A fetches the top candidates (plus the best
      // official-looking one); rounds B/C follow, from the fetched
      // pages, the store's own keyword-search form, nutrient-info
      // links （原材料・栄養成分表示はこちら類）, and links whose anchor
      // names this product — all on or from official pages. Only
      // official pages (maker's store/site, fooddb) become extraction
      // material; retailer/blog pages serve as link sources only, so a
      // value can never be cited to them. Rounds are skipped as the
      // synchronous budget runs out: the client then hands off to the
      // background deep research instead of extending the user's wait.
      type FetchedPage = {
        url: string;
        title: string;
        text: string;
        links: Array<{ url: string; text: string }>;
        searchForms: Array<{ action: string; param: string }>;
        official: boolean;
      };
      const productTokens = q
        .toLowerCase()
        .split(/[\s　]+/)
        .filter((t) => t.length >= 2);
      const namesProduct = (s: string) =>
        productTokens.some((t) => s.toLowerCase().includes(t));
      const looksOfficial = (url: string, title: string) =>
        title.includes("公式") ||
        url.includes("fooddb.mext.go.jp") ||
        /store\.|shop\.|official/.test(url);
      // A page "has the table" only when an actual numeric nutrition
      // table is present near the product's name — listing/search
      // pages mention 栄養成分表示 in navigation text (「商品概要・
      // 栄養成分表示等は単品ページをご覧ください」) without carrying
      // any values, and treating them as done would stop the link
      // following before the product page is ever fetched.
      const pageHasTable = (p: FetchedPage) => {
        const re = /栄養成分表示/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(p.text)) !== null) {
          const win = p.text.slice(
            Math.max(0, m.index - 500),
            m.index + 1700,
          );
          if (
            /エネルギー/.test(win) &&
            /\d/.test(win) &&
            /たんぱく質/.test(win) &&
            (namesProduct(win) || namesProduct(p.title))
          ) {
            return true;
          }
        }
        return false;
      };
      const fetchedUrls = new Set<string>();
      const pages: FetchedPage[] = [];
      const fetchPages = async (
        urls: string[],
        officialHosts: Set<string>,
      ): Promise<void> => {
        const fresh = urls.filter((u) => u && !fetchedUrls.has(u));
        for (const u of fresh) fetchedUrls.add(u);
        if (fresh.length === 0) return;
        const results = await Promise.all(
          fresh.map((u) =>
            ctx
              .executePrivileged(privileged.fetchPageText, { url: u })
              .catch(() => null),
          ),
        );
        for (const f of results) {
          if (!f || !f.ok || !f.finalUrl) continue;
          let host = "";
          try {
            host = new URL(f.finalUrl).host;
          } catch {
            host = "";
          }
          pages.push({
            url: f.finalUrl,
            title: f.title,
            text: f.text,
            links: f.links,
            searchForms: f.searchForms,
            official:
              looksOfficial(f.finalUrl, f.title) ||
              (host !== "" && officialHosts.has(host)),
          });
        }
      };
      if (remainingMs() > 12000) {
        const skipHost = (url: string) =>
          /openfoodfacts\.org|youtube\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|tiktok\.com/.test(
            url,
          );
        const roundA: string[] = [];
        for (const x of ranked) {
          if (roundA.length >= 2) break;
          if (x.s >= 2 && !skipHost(x.r.url)) roundA.push(x.r.url);
        }
        const officialCand = ranked.find(
          (x) =>
            !roundA.includes(x.r.url) &&
            !skipHost(x.r.url) &&
            looksOfficial(x.r.url, x.r.title),
        );
        if (officialCand) roundA.push(officialCand.r.url);
        await raceDeadline(
          fetchPages(roundA, new Set()),
          remainingMs(),
          "stage 2 round A fetch",
        ).catch(() => undefined);
        const officialHosts = new Set<string>();
        for (const p of pages) {
          if (!p.official) continue;
          try {
            officialHosts.add(new URL(p.url).host);
          } catch {
            // ignore unparseable URL
          }
        }
        const hasMaterial = () =>
          pages.some((p) => p.official && pageHasTable(p));
        // Rounds B/C: follow the maker's own structure one or two hops.
        for (let round = 0; round < 2 && !hasMaterial(); round++) {
          if (remainingMs() < (round === 0 ? 18000 : 14000)) break;
          const targets: string[] = [];
          // The store's own keyword search, when a fetched official
          // page exposed one — how a human finds the product page.
          if (round === 0) {
            for (const p of pages) {
              if (!p.official) continue;
              for (const form of p.searchForms) {
                const sep = form.action.includes("?") ? "&" : "?";
                targets.push(
                  `${form.action}${sep}${encodeURIComponent(form.param)}=${encodeURIComponent(q)}`,
                );
              }
            }
          }
          for (const p of pages) {
            for (const link of p.links) {
              let linkHost = "";
              try {
                linkHost = new URL(link.url).host;
              } catch {
                continue;
              }
              const onOfficialHost = officialHosts.has(linkHost);
              if (
                /栄養成分|原材料/.test(link.text) &&
                (onOfficialHost || p.official)
              ) {
                targets.push(link.url);
              } else if (namesProduct(link.text) && onOfficialHost) {
                targets.push(link.url);
              }
            }
          }
          const next = [...new Set(targets)]
            .filter((u) => !fetchedUrls.has(u))
            .slice(0, 3);
          if (next.length === 0) break;
          await raceDeadline(
            fetchPages(next, officialHosts),
            remainingMs(),
            "stage 2 link-follow fetch",
          ).catch(() => undefined);
          for (const p of pages) {
            if (!p.official) continue;
            try {
              officialHosts.add(new URL(p.url).host);
            } catch {
              // ignore unparseable URL
            }
          }
        }
        // Extraction material: when any fetched official page carries
        // an actual numeric table for this product, use ONLY those
        // pages. Listing/search/set pages that merely mention
        // 栄養成分表示 in navigation text add noise that invites the
        // extractor to complete values from its own knowledge instead
        // of reading the table in front of it (the grounding check
        // then rejects the draft and the whole lookup is wasted).
        const withTable = pages.filter(
          (p) => p.official && pageHasTable(p),
        );
        const material = (withTable.length > 0
          ? withTable
          : pages.filter((p) => p.official && p.text.includes("栄養成分"))
        ).slice(0, 4);
        if (material.length > 0 && remainingMs() > 5000) {
          // Slice each page down to the nutrient-table region(s): the
          // extractor needs the table for THIS product, not 100 KB of
          // navigation and reviews. Keep windows around every
          // 栄養成分表示 hit near the product name when identifiable,
          // else the first hits, capped per page.
          const slicePage = (text: string): string => {
            const hits: number[] = [];
            const re = /栄養成分表示/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) hits.push(m.index);
            if (hits.length === 0) {
              const idx = text.indexOf("栄養成分");
              return text.slice(Math.max(0, idx - 400), idx + 5600);
            }
            const win = (idx: number) =>
              text.slice(Math.max(0, idx - 500), idx + 1700);
            // A page may carry many products' tables (an all-products
            // nutrition page): prefer the windows that name this
            // product (its name typically heads its own table). Fall
            // back to the first tables when no window names it (a
            // single-product page's own table).
            const named = hits.filter((idx) =>
              productTokens.some((t) =>
                win(idx).toLowerCase().includes(t),
              ),
            );
            const chosen = (named.length > 0 ? named : hits).slice(0, 3);
            return chosen.map(win).join("\n…\n");
          };
          const pageBlocks = material.map(
            (p, i) =>
              `[ページ${i}] ${p.title}\nURL: ${p.url}\n${slicePage(p.text)}`,
          );
          try {
            const extracted = await raceDeadline(
              completeOnce(
                ctx,
                `次のページ本文は、食品「${fullName}」の候補ページ（メーカー公式ストア/公式サイト等）を実際に開いて取得したテキストです。栄養成分表示の表が本文の途中にあるため、検索結果の断片では届かなかった値もここには載っています。この中から、この食品の栄養成分値を抽出してください。\n\n出典の優先順位: 1) メーカー公式ストア/公式サイトの商品ページに現在載っている値 2) 文部科学省 日本食品標準成分表（fooddb） 3) その他の公的データベース。個人ブログ・まとめサイト・通販サイトの値は採用しないでください。\n\n注意: 採用できるのは、ここに渡したページ本文に実際に書かれている値だけです。本文に載っていない版・容量の値を、記憶や推測から補ってはいけません。本文中の公式ページにこの商品の表が1種類だけ含まれている場合は、それを現在の公式ストアで販売中のSKUの値としてそのまま採用してください（その際、商品名はページの表記どおりにし、容量が分かれば name に含めてください）。\n\n${rulesText}\n\nページ本文:\n${pageBlocks.join("\n\n")}`,
                { schema: extractSchema, timeout_secs: 20 },
                "lookup_extract",
              ),
              Math.min(20_000, remainingMs()),
              "stage 2 extraction",
            );
            if (extracted.found) {
              const draft = toDraft(
                extracted,
                new Map(material.map((p) => [p.url, p.text])),
              );
              if (draft) {
                await saveFound(draft);
                return {
                  status: "found" as const,
                  fromRecord: false,
                  via: "page" as const,
                  candidates: [],
                  draft,
                  deepJobId: null,
                };
              }
            }
          } catch {
            // Fall through to not_found; the deep research takes over
            // in the background rather than extending the user's wait.
          }
        }
      }
      await saveRecord(notFoundValues);
      // Server-side handoff: start the background deep research HERE,
      // before returning — not in the client after it receives this
      // response. The job (and the not_found record above) therefore
      // exist even when the sync phase burned the whole budget or the
      // client stopped waiting; the app-level banner picks the job up
      // either way. A spawn failure leaves deepJobId null and the
      // client falls back to starting the research itself.
      let deepJobId: number | null = null;
      try {
        deepJobId = await spawnDeepResearchJob(ctx, q, maker);
      } catch {
        deepJobId = null;
      }
      return {
        status: "not_found" as const,
        fromRecord: false,
        via: "none" as const,
        candidates: [],
        draft: null,
        deepJobId,
      };
    },
  }),


  listResearch: defineAction({
    description:
      "Lists the stored AI food-research records, most recently updated first — every name ever looked up with 「AIで調べる」, including ones where no trustworthy source was found.",
    request: z.object({}),
    response: z.object({ records: z.array(researchOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.foodResearch)
        .orderBy(desc(schema.foodResearch.updatedAt))
        .limit(200);
      return { records: rows.map(toResearchOut) };
    },
  }),

  deleteResearch: defineAction({
    description:
      "Deletes one AI food-research record. The next lookup for that name will search the web again.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.foodResearch)
        .where(eq(schema.foodResearch.id, args.id))
        .returning({ id: schema.foodResearch.id });
      if (!deleted[0]) {
        throw new Error("指定された調査記録が見つかりません");
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  startDeepFoodResearch: defineAction({
    description:
      "Starts an asynchronous deep food research for a name the fast snippet-based lookup (lookupFoodInfo) could not confirm, or confirmed only partially (PFC found but 食塩相当量 missing — packaged foods print salt on the label, but the salt row sits deep in the manufacturer's table, past where search snippets cut off; BASE BREAD is the recurring example). A background agent opens the manufacturer's official product/nutrition pages directly, reads the printed 栄養成分表示 through to the salt row, and reports back through completeDeepFoodResearch; the outcome is upserted into the food_research records. Poll getDeepFoodResearch for the result. If similar foods already exist in the master, returns them as candidates with jobId null and starts nothing.",
    request: z.object({
      name: z.string().min(1).max(100),
      maker: z.string().max(60).optional(),
    }),
    response: z.object({
      jobId: z.number().nullable(),
      candidates: z.array(foodOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Fail dead jobs first, so the reuse check below never hands
      // back a zombie the user would wait on forever.
      await expireStaleDeepJobs(ctx);
      const q = args.name.trim();
      const nq = normName(q);
      const maker = (args.maker ?? "").trim();

      // Duplicate guard, same as lookupFoodInfo: don't research what the
      // master already holds.
      if (nq) {
        const rows = await db.select().from(schema.foods);
        const candidates = rows
          .filter((r) => {
            const nr = normName(r.name);
            return nr.includes(nq) || nq.includes(nr);
          })
          .slice(0, 5);
        if (candidates.length > 0) {
          return { jobId: null, candidates: candidates.map(toFoodOut) };
        }
      }

      const jobId = await spawnDeepResearchJob(ctx, q, maker);
      if (jobId == null) {
        throw new Error("startDeepFoodResearch: insert returned no rows");
      }
      return { jobId, candidates: [] };
    },
  }),

  getDeepFoodResearch: defineAction({
    description:
      "Returns one deep food-research job with its status, the agent's latest progress note, and start/update timestamps; when the job is ready and values were found, draft carries the nutrient draft (also stored as a food_research record). Poll this after startDeepFoodResearch.",
    request: z.object({ jobId: z.number().int().positive() }),
    response: z.object({ job: deepJobOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await expireStaleDeepJobs(ctx);
      const rows = await db
        .select()
        .from(schema.foodResearchJobs)
        .where(eq(schema.foodResearchJobs.id, args.jobId))
        .limit(1);
      const job = rows[0];
      if (!job) throw new Error("調査ジョブが見つかりません");
      return { job: await toDeepJobOut(ctx, job) };
    },
  }),

  listDeepFoodResearchJobs: defineAction({
    description:
      "Lists the deep food-research jobs the UI should keep in view: jobs still pending (started within the last hour) and jobs that finished within the last 24 hours, newest first (max 5). The research runs in the background, so this lets the app show live progress and surface a finished draft even after the registration form was closed or the app was reopened. Pending jobs whose agent has sent no callback for over 6 minutes are first expired to failed (a healthy research reports progress throughout and finishes in ~1–2 minutes), so a dead job never masquerades as still-researching.",
    request: z.object({}),
    response: z.object({ jobs: z.array(deepJobOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await expireStaleDeepJobs(ctx);
      const now = Date.now();
      const rows = await db
        .select()
        .from(schema.foodResearchJobs)
        .orderBy(desc(schema.foodResearchJobs.id))
        .limit(20);
      const visible = rows
        .filter(
          (j) =>
            (j.status === "pending" &&
              now - j.createdAt.getTime() < 60 * 60 * 1000) ||
            (j.status !== "pending" &&
              now - j.updatedAt.getTime() < 24 * 60 * 60 * 1000),
        )
        .slice(0, 5);
      const jobs: Array<z.infer<typeof deepJobOut>> = [];
      for (const j of visible) jobs.push(await toDeepJobOut(ctx, j));
      return { jobs };
    },
  }),

  listUnregisteredResearchDrafts: defineAction({
    description:
      "Lists recent AI research results (from the fast lookupFoodInfo or a finished deep research) that found values but were never registered as foods, newest first (max 5, updated within the last 24 hours). The fast lookup's draft is only shown inside the registration form, so a lookup that finishes after the form was closed leaves no visible trace except the research-records list at the bottom of the foods tab — this surfaces those drafts at app level so the user can still register them. Records already covered by a recent deep-research job are excluded (the job's own status card shows them), as are records whose name matches a food already in the master.",
    request: z.object({}),
    response: z.object({
      drafts: z.array(
        z.object({
          id: z.number(),
          queryName: z.string(),
          updatedAt: z.string(),
          draft: draftOut,
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await expireStaleDeepJobs(ctx);
      const now = Date.now();
      const DAY_MS = 24 * 60 * 60 * 1000;
      const rows = await db
        .select()
        .from(schema.foodResearch)
        .where(eq(schema.foodResearch.status, "found"))
        .orderBy(desc(schema.foodResearch.updatedAt))
        .limit(50);
      const fresh = rows.filter((r) => now - r.updatedAt.getTime() < DAY_MS);
      if (fresh.length === 0) return { drafts: [] };
      // Names the deep-research status cards already surface.
      const jobs = await db
        .select()
        .from(schema.foodResearchJobs)
        .orderBy(desc(schema.foodResearchJobs.id))
        .limit(20);
      // Only jobs whose own status card represents the draft (pending,
      // or ready and carrying it) suppress the standalone draft card.
      // A failed job's card carries no draft, so it must not hide the
      // fast lookup's finished result for a day.
      const jobNorms = new Set(
        jobs
          .filter(
            (j) =>
              (j.status === "pending" || j.status === "ready") &&
              now - j.updatedAt.getTime() < DAY_MS,
          )
          .map((j) => j.queryNorm),
      );
      // Names already registered as foods (by draft name or query name).
      const foodRows = await db
        .select({ name: schema.foods.name })
        .from(schema.foods);
      const foodNorms = new Set(
        foodRows.map((f) => normName(f.name)).filter((n) => n !== ""),
      );
      const drafts: Array<{
        id: number;
        queryName: string;
        updatedAt: string;
        draft: z.infer<typeof draftOut>;
      }> = [];
      for (const r of fresh) {
        if (jobNorms.has(r.queryNorm)) continue;
        const draft = researchDraft(r);
        if (!draft) continue;
        if (foodNorms.has(normName(draft.name)) || foodNorms.has(r.queryNorm))
          continue;
        drafts.push({
          id: r.id,
          queryName: r.queryName,
          updatedAt: r.updatedAt.toISOString(),
          draft,
        });
        if (drafts.length >= 5) break;
      }
      return { drafts };
    },
  }),

  reportDeepFoodResearchProgress: defineAction({
    description:
      "Progress callback for the background deep-research task: records what the agent is currently doing on a pending job — a short Japanese note plus the stage enum it belongs to (searching / opening_page / reading_table / saving) — so the UI can show live, structured progress during the ~1-2 minute research instead of a bare spinner. Ignored once the job has finished.",
    request: z.object({
      jobId: z.number().int().positive(),
      message: z.string().min(1).max(200),
      stage: z
        .enum(["searching", "opening_page", "reading_table", "saving"])
        .optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.foodResearchJobs)
        .where(eq(schema.foodResearchJobs.id, args.jobId))
        .limit(1);
      const job = rows[0];
      if (!job) throw new Error("reportDeepFoodResearchProgress: job not found");
      if (job.status === "pending") {
        await db
          .update(schema.foodResearchJobs)
          .set({
            progress: args.message.trim(),
            // A report without a stage keeps the previous stage: the
            // note moved on, the position in the flow did not rewind.
            ...(args.stage ? { progressStage: args.stage } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.foodResearchJobs.id, job.id));
        ctx.invalidateQueries();
      }
      return { ok: true as const };
    },
  }),

  completeDeepFoodResearch: defineAction({
    description:
      "Callback for the background deep-research task: stores the outcome of a deep food research job. With status 'ready' and found=true it validates the reported values and upserts them as a 'found' food_research record (the draft the user then confirms into a food); found=false upserts a 'not_found' record. Status 'failed' records the reason on the job only.",
    request: z.object({
      jobId: z.number().int().positive(),
      status: z.enum(["ready", "failed"]),
      found: z.boolean().optional(),
      name: z.string().max(200).optional(),
      maker: z.string().max(100).nullable().optional(),
      basisType: z.enum(["per100g", "serving", "unknown"]).optional(),
      basisLabel: z.string().max(100).optional(),
      servingGrams: z.number().positive().max(100000).nullable().optional(),
      kcal: z.number().min(0).max(10000).optional(),
      proteinG: z.number().min(0).max(1000).optional(),
      fatG: z.number().min(0).max(1000).optional(),
      carbsG: z.number().min(0).max(1000).optional(),
      saltG: z.number().min(0).max(1000).nullable().optional(),
      ...microInputZod,
      sourceName: z.string().max(200).optional(),
      sourceUrl: httpUrl(2000).optional(),
      error: z.string().max(500).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.foodResearchJobs)
        .where(eq(schema.foodResearchJobs.id, args.jobId))
        .limit(1);
      const job = rows[0];
      if (!job) throw new Error("completeDeepFoodResearch: job not found");

      if (args.status === "failed") {
        await db
          .update(schema.foodResearchJobs)
          .set({
            status: "failed",
            error: args.error ?? "調査に失敗しました",
            updatedAt: new Date(),
          })
          .where(eq(schema.foodResearchJobs.id, job.id));
        ctx.invalidateQueries();
        return { ok: true as const };
      }

      const upsertRecord = async (
        values: Omit<
          typeof schema.foodResearch.$inferInsert,
          "id" | "queryName" | "queryNorm"
        >,
      ): Promise<void> => {
        await db
          .insert(schema.foodResearch)
          .values({ queryName: job.queryName, queryNorm: job.queryNorm, ...values })
          .onConflictDoUpdate({
            target: schema.foodResearch.queryNorm,
            set: { queryName: job.queryName, ...values, updatedAt: new Date() },
          });
      };
      const notFoundValues = {
        status: "not_found" as const,
        name: null,
        basisType: null,
        basisLabel: null,
        servingGrams: null,
        kcal: null,
        proteinG: null,
        fatG: null,
        carbsG: null,
        saltG: null,
        ...emptyMicros(),
        sourceName: null,
        sourceUrl: null,
      };

      if (!args.found) {
        // Never downgrade an existing 'found' record: a deep research
        // also runs as a refill pass (e.g. hunting the 食塩相当量 the
        // fast lookup's snippets missed), and a refill that comes back
        // empty must not erase values already confirmed.
        const existing = await db
          .select({ status: schema.foodResearch.status })
          .from(schema.foodResearch)
          .where(eq(schema.foodResearch.queryNorm, job.queryNorm))
          .limit(1);
        if (existing[0]?.status !== "found") {
          await upsertRecord(notFoundValues);
        }
        await db
          .update(schema.foodResearchJobs)
          .set({ status: "ready", error: null, updatedAt: new Date() })
          .where(eq(schema.foodResearchJobs.id, job.id));
        ctx.invalidateQueries();
        return { ok: true as const };
      }

      // The reported values must be complete and sane before they may
      // become a citable record; a glitched report fails the job (the
      // user can retry) instead of poisoning the research cache.
      const sane =
        args.kcal != null &&
        args.kcal > 0 &&
        args.proteinG != null &&
        args.fatG != null &&
        args.carbsG != null &&
        args.sourceUrl != null &&
        args.sourceUrl !== "" &&
        (args.basisType === "per100g" || args.basisType === "serving"
          ? (args.basisLabel ?? "").trim() !== "" || args.basisType === "per100g"
          : (args.basisLabel ?? "").trim() !== "");
      if (!sane) {
        await db
          .update(schema.foodResearchJobs)
          .set({
            status: "failed",
            error: "報告された値を確認できませんでした",
            updatedAt: new Date(),
          })
          .where(eq(schema.foodResearchJobs.id, job.id));
        ctx.invalidateQueries();
        return { ok: true as const };
      }
      // Maker: prefer what the agent confirmed on the official pages;
      // fall back to the maker already on the record (e.g. the one the
      // user typed for the fast lookup) instead of erasing it.
      const existingRecord = await db
        .select({ maker: schema.foodResearch.maker })
        .from(schema.foodResearch)
        .where(eq(schema.foodResearch.queryNorm, job.queryNorm))
        .limit(1);
      await upsertRecord({
        status: "found",
        maker: args.maker ?? existingRecord[0]?.maker ?? null,
        name: args.name ?? job.queryName,
        basisType: args.basisType ?? "unknown",
        basisLabel:
          args.basisType === "per100g"
            ? "100gあたり"
            : (args.basisLabel ?? ""),
        servingGrams: args.servingGrams ?? null,
        kcal: args.kcal ?? null,
        proteinG: args.proteinG ?? null,
        fatG: args.fatG ?? null,
        carbsG: args.carbsG ?? null,
        saltG: args.saltG ?? null,
        ...microsFromInput(args),
        sourceName: args.sourceName ?? "",
        sourceUrl: args.sourceUrl ?? null,
      });
      await db
        .update(schema.foodResearchJobs)
        .set({ status: "ready", error: null, updatedAt: new Date() })
        .where(eq(schema.foodResearchJobs.id, job.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listRecipes: defineAction({
    description:
      "Lists all saved recipes, most recently updated first, each with its ingredient lines (with their estimation bases), whole-recipe totals and per-serving totals.",
    request: z.object({}),
    response: z.object({ recipes: z.array(recipeOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipes)
        .orderBy(desc(schema.recipes.updatedAt));
      const foodById = await loadFoodMap(db);
      return { recipes: rows.map((r) => toRecipeOut(r, foodById)) };
    },
  }),

  saveRecipe: defineAction({
    description:
      "Creates a recipe, or replaces it wholesale when id is given. Ingredient lines matched to a food-master entry (basisMode 'food') are recomputed from the master and the line's grams, so the stored numbers always follow the stated basis; 'manual' lines keep the given nutrients; 'unknown' lines store none.",
    request: z.object({
      id: z.number().int().positive().optional(),
      title: z.string().min(1).max(100),
      servings: z.number().positive().max(1000).nullable().optional(),
      servingsLabel: z.string().max(60).optional(),
      sourceType: z.enum(["url", "photo", "manual"]),
      sourceUrl: z.string().url().max(1000).nullable().optional(),
      ingredients: z.array(ingredientSchema).min(1).max(100),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const foodById = await loadFoodMap(db);
      const lines = recomputeLines(args.ingredients, foodById);
      const totals = sumIngredients(lines);
      const values = {
        title: args.title.trim(),
        servings: args.servings ?? null,
        servingsLabel: args.servingsLabel ?? "",
        sourceType: args.sourceType,
        sourceUrl: args.sourceType === "url" ? (args.sourceUrl ?? null) : null,
        ingredientsJson: stringifyStoredJson(lines),
        totalsKcal: totals.kcal,
        totalsProteinG: totals.proteinG,
        totalsFatG: totals.fatG,
        totalsCarbsG: totals.carbsG,
        totalsSaltG: totals.saltG,
        totalsFiberG: totals.fiberG,
        totalsPotassiumMg: totals.potassiumMg,
        totalsCalciumMg: totals.calciumMg,
        totalsMagnesiumMg: totals.magnesiumMg,
        totalsIronMg: totals.ironMg,
        totalsVitaminDMcg: totals.vitaminDMcg,
        totalsVitaminB1Mg: totals.vitaminB1Mg,
        totalsVitaminB2Mg: totals.vitaminB2Mg,
        totalsVitaminB6Mg: totals.vitaminB6Mg,
        totalsVitaminB12Mcg: totals.vitaminB12Mcg,
        totalsFolateMcg: totals.folateMcg,
        totalsVitaminCMg: totals.vitaminCMg,
      };
      if (args.id != null) {
        const updated = await db
          .update(schema.recipes)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.recipes.id, args.id))
          .returning({ id: schema.recipes.id });
        if (!updated[0]) {
          throw new Error("指定されたレシピが見つかりません");
        }
        ctx.invalidateQueries();
        return { id: args.id };
      }
      const inserted = await db
        .insert(schema.recipes)
        .values(values)
        .returning({ id: schema.recipes.id });
      const row = inserted[0];
      if (!row) throw new Error("saveRecipe: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteRecipe: defineAction({
    description:
      "Deletes a saved recipe. Meal logs already recorded from it keep their nutrient snapshots and are unaffected.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.recipes)
        .where(eq(schema.recipes.id, args.id))
        .returning({ id: schema.recipes.id });
      if (!deleted[0]) {
        throw new Error("指定されたレシピが見つかりません");
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  logRecipe: defineAction({
    description:
      "Logs servings of a saved recipe as one meal entry for a date and slot, snapshotting the per-serving nutrients (recipe totals ÷ servings) times the amount eaten. Throws when the recipe has no servings set.",
    request: z.object({
      date: dateStr,
      slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
      recipeId: z.number().int().positive(),
      amount: z.number().positive().max(100),
      eatingOut: z.boolean().optional(),
    }),
    response: z.object({ entry: logOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipes)
        .where(eq(schema.recipes.id, args.recipeId))
        .limit(1);
      const recipe = rows[0];
      if (!recipe) throw new Error("指定されたレシピが見つかりません");
      if (recipe.servings == null || recipe.servings <= 0) {
        throw new Error(
          "このレシピは人数（何人分）が未設定のため記録できません。レシピを編集して人数を設定してください",
        );
      }
      const k = args.amount / recipe.servings;
      const inserted = await db
        .insert(schema.mealLogs)
        .values({
          date: args.date,
          slot: args.slot,
          foodId: null,
          foodName: recipe.title,
          quantity: args.amount,
          unit: "人前",
          eatingOut: args.eatingOut ? 1 : 0,
          kcal: Math.round(recipe.totalsKcal * k),
          proteinG: round1(recipe.totalsProteinG * k),
          fatG: round1(recipe.totalsFatG * k),
          carbsG: round1(recipe.totalsCarbsG * k),
          saltG:
            recipe.totalsSaltG == null ? null : round2(recipe.totalsSaltG * k),
          fiberG:
            recipe.totalsFiberG == null
              ? null
              : round1(recipe.totalsFiberG * k),
          potassiumMg:
            recipe.totalsPotassiumMg == null
              ? null
              : round0(recipe.totalsPotassiumMg * k),
          calciumMg:
            recipe.totalsCalciumMg == null
              ? null
              : round0(recipe.totalsCalciumMg * k),
          magnesiumMg:
            recipe.totalsMagnesiumMg == null
              ? null
              : round0(recipe.totalsMagnesiumMg * k),
          ironMg:
            recipe.totalsIronMg == null ? null : round2(recipe.totalsIronMg * k),
          vitaminDMcg:
            recipe.totalsVitaminDMcg == null
              ? null
              : round1(recipe.totalsVitaminDMcg * k),
          vitaminB1Mg:
            recipe.totalsVitaminB1Mg == null
              ? null
              : round2(recipe.totalsVitaminB1Mg * k),
          vitaminB2Mg:
            recipe.totalsVitaminB2Mg == null
              ? null
              : round2(recipe.totalsVitaminB2Mg * k),
          vitaminB6Mg:
            recipe.totalsVitaminB6Mg == null
              ? null
              : round2(recipe.totalsVitaminB6Mg * k),
          vitaminB12Mcg:
            recipe.totalsVitaminB12Mcg == null
              ? null
              : round1(recipe.totalsVitaminB12Mcg * k),
          folateMcg:
            recipe.totalsFolateMcg == null
              ? null
              : round0(recipe.totalsFolateMcg * k),
          vitaminCMg:
            recipe.totalsVitaminCMg == null
              ? null
              : round0(recipe.totalsVitaminCMg * k),
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("logRecipe: insert returned no rows");
      ctx.invalidateQueries();
      return { entry: toLogOut(row) };
    },
  }),

  startRecipeImportFromUrl: defineAction({
    description:
      "Starts an asynchronous recipe estimation from a recipe page URL. A background agent opens the page, extracts the title, servings and ingredients as printed, and reports back through completeRecipeImport; poll getRecipeImport for the matched draft (status 'ready') or the failure reason ('failed'). The draft is not a recipe until the user confirms it via saveRecipe.",
    request: z.object({ url: z.string().url().max(2000) }),
    response: z.object({ importId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.recipeImports)
        .values({ kind: "url", sourceUrl: args.url, status: "pending" })
        .returning({ id: schema.recipeImports.id });
      const row = inserted[0];
      if (!row) throw new Error("startRecipeImportFromUrl: insert returned no rows");
      const importId = row.id;
      const task = await ctx.agent.spawnTask(
        [
          `レシピページを読み取り、このSpaceのレシピ取り込みレコード（importId: ${importId}）に結果を保存するタスクです。`,
          "",
          `対象URL: ${args.url}`,
          "",
          "手順:",
          `進捗報告: 作業の節目ごとに reportRecipeImportProgress アクションを importId=${importId}, message=「いま何をしているか」の短い日本語（60字以内）, stage=現在の段階 で呼ぶこと。stage は次の3値のいずれか（それ以外は使わない）: "opening_page"=ページを開いている, "extracting"=レシピを抽出した, "saving"=結果を保存するところ。最低限、開始時（stage="opening_page", 例: 「レシピページを開いています」）と、材料を抽出できた時（stage="extracting", 例: 「材料を抽出しました」）の2回は呼ぶこと。completeRecipeImport を呼ぶ直前にも stage="saving" で1回呼ぶこと。`,
          "1. 対象URLのページを開いて本文を読み、レシピ（料理名・何人分・材料と分量）を抽出する。材料は1品目ずつ、材料名 name、ページに書かれた分量表記そのままの amountText（例: 200g、大さじ1、1/2個、少々）、グラム換算できる場合の grams（大さじ1=約15g・小さじ1=約5gなど一般的な換算でよい。換算が難しいものや「少々」「適量」は null）を用意する。",
          `2. 読み取れたら completeRecipeImport アクションを importId=${importId}, status="ready", title（料理名）, servings（何人分の数値。不明なら null）, servingsLabel（例: 2人分）, ingredients（{name, amountText, grams} の配列）で呼ぶ。`,
          `3. ページが開けない・レシピが載っていない等で読み取れない場合は、同じアクションを importId=${importId}, status="failed", error（短い理由）で呼ぶ。`,
          "材料や数値をページに無いものまで創作しないこと。ページに書かれた材料だけを渡すこと。",
          "報告の形式: completeRecipeImport に渡すフィールド名・型は、この手順2〜3に書かれたものがそのアクションの引数スキーマそのものである。ここに無いフィールドを足したり、フィールド名を変えたり、数値を文字列で渡したりしないこと（スキーマに合わない報告は保存されない）。",
        ].join("\n"),
        {
          expectsAction: "completeRecipeImport",
          dedupeKey: `recipe-import-${importId}`,
        },
      );
      if (!task.ok) {
        await db
          .update(schema.recipeImports)
          .set({
            status: "failed",
            error: "読み取りタスクを開始できませんでした",
            updatedAt: new Date(),
          })
          .where(eq(schema.recipeImports.id, importId));
      }
      ctx.invalidateQueries();
      return { importId };
    },
  }),

  importRecipeFromPhoto: defineAction({
    description:
      "Reads a photo of a recipe (cookbook page, recipe card, handwritten memo, or the finished dish) and stores a matched estimation draft as a completed recipe import; returns its importId — read the draft with getRecipeImport. Ingredients are matched against the food master exactly like URL imports. The photo is not stored.",
    request: z.object({
      imageBase64: z.string().min(100).max(10_000_000),
      mimeType: z.enum(["image/jpeg", "image/png"]),
    }),
    response: z.object({ importId: z.number() }),
    async handler(ctx, args) {
      // Same defect class as the label-photo read: timeout_secs 120 ×
      // retried attempts could hold the form for minutes. The whole
      // read is raced against a hard ~55 s budget enforced locally;
      // exhaustion is a clear failure the user can retry from.
      let extracted: {
        readable: boolean;
        title: string;
        servings: number | null;
        servingsLabel: string;
        ingredients: Array<{
          name: string;
          amountText: string;
          grams: number | null;
        }>;
      };
      try {
        extracted = await raceDeadline(
          completeWithRetry(
            ctx,
            "添付の写真は料理のレシピ（料理本のページ、レシピカード、手書きメモなど）か、料理の完成品の写真です。料理名が読み取れれば title に入れてください。何人分か分かれば servings に数値を、servingsLabel に表記（例: 2人分）を入れてください。材料は1品目ずつ、材料名 name、写真に書かれた分量表記そのままの amountText（例: 200g、大さじ1、1/2個、少々）、グラム換算できる場合の grams（大さじ1=約15g・小さじ1=約5gなど一般的な換算でよい。換算が難しいものや「少々」「適量」は null）を入れてください。完成品の写真だけの場合は、写っている料理の一般的な材料と分量を推定して入れてください（推定の下書きとして後でユーザーが1品目ずつ修正します）。レシピとしても料理としても読み取れない場合は readable を false にしてください。",
            {
              schema: z.object({
                readable: z.boolean(),
                title: z.string(),
                servings: z.number().min(0).max(1000).nullable(),
                servingsLabel: z.string(),
                ingredients: z.array(
                  z.object({
                    name: z.string(),
                    amountText: z.string(),
                    grams: z.number().min(0).max(100000).nullable(),
                  }),
                ).max(100),
              }),
              images: [
                {
                  dataBase64: args.imageBase64,
                  mimeType: args.mimeType,
                  filename: "recipe",
                },
              ],
              timeout_secs: 45,
            },
            2,
            "recipe_photo",
          ),
          55_000,
          "recipe photo read",
        );
      } catch (e) {
        if (e instanceof SyncBudgetExceeded) {
          throw new Error(
            "読み取りが制限時間（約1分）内に終わりませんでした。写真を撮り直して再試行してください。",
          );
        }
        throw e;
      }
      if (!extracted.readable || extracted.ingredients.length === 0) {
        throw new Error(
          "写真からレシピを読み取れませんでした。レシピが写るように撮り直してください。",
        );
      }
      const db = ctx.db<typeof schema>();
      const foods = await db.select().from(schema.foods);
      const draft: RecipeDraft = {
        title: extracted.title.trim() || "レシピ",
        servings: extracted.servings,
        servingsLabel: extracted.servingsLabel,
        sourceType: "photo",
        sourceUrl: null,
        ingredients: matchIngredients(extracted.ingredients, foods),
      };
      const inserted = await db
        .insert(schema.recipeImports)
        .values({
          kind: "photo",
          sourceUrl: null,
          status: "ready",
          draftJson: stringifyStoredJson(draft),
        })
        .returning({ id: schema.recipeImports.id });
      const row = inserted[0];
      if (!row) throw new Error("importRecipeFromPhoto: insert returned no rows");
      ctx.invalidateQueries();
      return { importId: row.id };
    },
  }),

  completeRecipeImport: defineAction({
    description:
      "Callback for the background recipe-reading task: stores the outcome of a URL recipe import. With status 'ready' it takes the extracted title/servings/raw ingredients, matches each ingredient against the food master (real nutrient values where matched) and stores the draft for the user to review; with status 'failed' it records the reason.",
    request: z.object({
      importId: z.number().int().positive(),
      status: z.enum(["ready", "failed"]),
      title: z.string().max(100).optional(),
      servings: z.number().positive().max(1000).nullable().optional(),
      servingsLabel: z.string().max(60).optional(),
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            amountText: z.string().max(60).optional(),
            grams: z.number().min(0).max(100000).nullable().optional(),
          }),
        )
        .max(100)
        .optional(),
      error: z.string().max(300).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeImports)
        .where(eq(schema.recipeImports.id, args.importId))
        .limit(1);
      const imp = rows[0];
      if (!imp) throw new Error("指定された取り込みが見つかりません");
      if (args.status === "failed") {
        await db
          .update(schema.recipeImports)
          .set({
            status: "failed",
            error: args.error ?? "レシピを読み取れませんでした",
            updatedAt: new Date(),
          })
          .where(eq(schema.recipeImports.id, args.importId));
        ctx.invalidateQueries();
        return { ok: true as const };
      }
      const foods = await db.select().from(schema.foods);
      const draft: RecipeDraft = {
        title: (args.title ?? "").trim() || "レシピ",
        servings: args.servings ?? null,
        servingsLabel: args.servingsLabel ?? "",
        sourceType: "url",
        sourceUrl: imp.sourceUrl,
        ingredients: matchIngredients(args.ingredients ?? [], foods),
      };
      await db
        .update(schema.recipeImports)
        .set({
          status: "ready",
          error: null,
          draftJson: stringifyStoredJson(draft),
          updatedAt: new Date(),
        })
        .where(eq(schema.recipeImports.id, args.importId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  reportRecipeImportProgress: defineAction({
    description:
      "Progress callback for the background recipe-URL import task: records what the agent is currently doing on a pending import — a short Japanese note plus the stage enum it belongs to (opening_page / extracting / saving) — mirroring reportDeepFoodResearchProgress, so the recipes tab can show structured progress while the page is being read. Ignored once the import has finished.",
    request: z.object({
      importId: z.number().int().positive(),
      message: z.string().min(1).max(200),
      stage: z.enum(["opening_page", "extracting", "saving"]).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeImports)
        .where(eq(schema.recipeImports.id, args.importId))
        .limit(1);
      const imp = rows[0];
      if (!imp) throw new Error("reportRecipeImportProgress: import not found");
      if (imp.status === "pending") {
        await db
          .update(schema.recipeImports)
          .set({
            progress: args.message.trim(),
            ...(args.stage ? { progressStage: args.stage } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.recipeImports.id, imp.id));
        ctx.invalidateQueries();
      }
      return { ok: true as const };
    },
  }),

  getRecipeImport: defineAction({
    description:
      "Returns one recipe import by id: status (pending/ready/failed), the agent's latest progress note and stage while pending, the failure reason when failed, and the matched ingredient draft when ready. A pending import whose agent has sent no callback for over 6 minutes is first expired to failed, so a dead import never masquerades as still-reading.",
    request: z.object({ importId: z.number().int().positive() }),
    response: z.object({ import: recipeImportOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeImports)
        .where(eq(schema.recipeImports.id, args.importId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("指定された取り込みが見つかりません");
      return { import: toRecipeImportOut(await expireStaleRecipeImport(ctx, row)) };
    },
  }),

  assistMealInput: defineAction({
    description:
      "AIアシスト記録の換算案を作る（読み取り専用・マスタは変更しない）。自然文（食品の説明＋量、例：「焼き芋 皮つき 200g」「ご飯 茶碗1杯」）を受け取り、(1) AIが食品の説明・検索キーワード・量のグラム換算を読み取り、(2) サーバがマスタ内をキーワード検索＋マッチングして候補を集め、(3) AIが候補から最も近い基準食品を1つ選び、換算係数（推定）と根拠、代替候補を返す。栄養値は一切返さない — 記録時は基準食品のマスタ値 × 実効グラムで計算される。(4) 単一の基準が定まらない複合料理（例：「たまごスープ 1杯」）は分解モードに回る：AIが材料部品（部品名・グラム・根拠）への分解案を返し、サーバが各部品をマスタに照合して status 'decomposed' で返す（水・だし等の計算対象外部品と、未マッチ部品は明示される）。分解も妥当でない場合は status 'none' を返し、UIは既存のAI調査→登録フローへ案内する。選定と分解は並行して走る（分解待ちで予算を使い切らないため）。成功した換算案（ok / decomposed）は入力テキストをキーに assist_proposals へ保存され、同じ入力の再試行ではAIを呼ばずに即座に同じ案を返す（'none' は保存しない）。",
    request: z.object({ text: z.string().min(1).max(200) }),
    response: assistOut,
    async handler(ctx, args): Promise<z.infer<typeof assistOut>> {
      const text = args.text.trim();
      // Total sync budget for the whole assist, enforced locally via
      // raceDeadline (the inference service's own timeout is a
      // request, not a guarantee — see raceDeadline's comment; a slow
      // day otherwise stacks parse+select+decompose retries into a
      // raw inference-timeout 500 with no terminal state). Select
      // and decompose run in parallel (see below), so a healthy
      // single-base answer takes ~15 s and a decomposition ~20–40 s;
      // past the budget the action still answers 'none' with the
      // reason instead of dying. Successful proposals are cached in
      // assist_proposals, so a repeat of the same text skips all of
      // this entirely.
      const ASSIST_BUDGET_MS = 90_000;
      const startedAt = Date.now();
      const remaining = () =>
        Math.max(0, ASSIST_BUDGET_MS - (Date.now() - startedAt));
      const TIMEOUT_RATIONALE =
        "AIの処理が時間内に終わりませんでした。時間をおいてもう一度お試しください。";
      // The inference service can also surface its OWN timeout as an
      // error from complete() — and with one retry stacked, that can
      // land before the local budget race fires. Both shapes mean the
      // same thing to the user (the AI did not answer in time), so
      // both reach the same terminal 'none'.
      const isTimeoutError = (e: unknown): boolean =>
        e instanceof SyncBudgetExceeded ||
        (e instanceof Error && /timed out|timeout/i.test(e.message));
      // Durable proposal cache (assist_proposals): a text that once
      // produced a usable proposal returns that same proposal
      // instantly, without re-rolling the model calls below. Only
      // 'ok'/'decomposed' outcomes are cached — never 'none', so a
      // failed input always gets a fresh attempt.
      const db = ctx.db<typeof schema>();
      const queryNorm = normName(text);
      if (queryNorm !== "") {
        const cachedRows = await db
          .select()
          .from(schema.assistProposals)
          .where(eq(schema.assistProposals.queryNorm, queryNorm))
          .limit(1);
        const cachedRow = cachedRows[0];
        if (cachedRow) {
          try {
            const unwrapped = unwrapStoredJson(
              JSON.parse(cachedRow.resultJson),
            );
            if (unwrapped === undefined) {
              // Stored under a JSON version this build does not
              // understand: an explicit, counted cache miss — never a
              // silent mis-parse of a future format as today's.
              await bumpMetric(ctx, "assist_cache.version_mismatch");
            } else {
              const parsedCache = assistOut.safeParse(unwrapped);
              if (
                parsedCache.success &&
                parsedCache.data.status !== "none" &&
                parsedCache.data.originalText === text
              ) {
                return parsedCache.data;
              }
            }
          } catch {
            // A corrupt cache entry reads as no cache.
          }
        }
      }
      // Persist a successful proposal for next time. A cache-write
      // failure must never fail the request itself.
      const withCache = async (
        out: z.infer<typeof assistOut>,
      ): Promise<z.infer<typeof assistOut>> => {
        if (out.status !== "none" && queryNorm !== "") {
          try {
            const existing = await db
              .select({ id: schema.assistProposals.id })
              .from(schema.assistProposals)
              .where(eq(schema.assistProposals.queryNorm, queryNorm))
              .limit(1);
            const existingRow = existing[0];
            if (existingRow) {
              await db
                .update(schema.assistProposals)
                .set({
                  originalText: text,
                  resultJson: stringifyStoredJson(out),
                  updatedAt: new Date(),
                })
                .where(eq(schema.assistProposals.id, existingRow.id));
            } else {
              await db.insert(schema.assistProposals).values({
                queryNorm,
                originalText: text,
                resultJson: stringifyStoredJson(out),
              });
            }
          } catch {
            // The cache is an optimization, never a failure mode.
          }
        }
        return out;
      };
      // (1) Parse: food description, master-search keywords, and the
      // amount converted to grams. The model handles language only —
      // no nutrient values anywhere in this step.
      let parsed: z.infer<typeof assistParseSchema>;
      try {
        parsed = await raceDeadline(
          completeWithRetry(
            ctx,
            `次の文章は、食べた食品の説明と量を書いたものです。食品マスタを検索するための情報と、量の読み取り結果を返してください。\n\n文章：${text}\n\nルール：\n- foodPhrase：量の表現を取り除いた、食品の説明そのもの（例：「焼き芋 皮つき」）。\n- keywords：食品マスタ（日本食品標準成分表の食品名が中心）を検索するキーワードを最大5つ。一般的な呼び名と成分表での呼び名が違う場合は両方入れる（例：焼き芋 → 「焼き芋」「さつまいも 焼き」「さつまいも」）。量や単位の語は入れない。\n- amountText：量の表現をそのまま抜き出す（例：「200g」「茶碗1杯」「2個」）。量が書かれていなければ空文字。\n- inputGrams：量をグラムに直した値。グラムで書かれていればその数値。個数・杯・枚などの個数表現なら、一般的な1単位の重量で換算する（例：ご飯 茶碗1杯≈150g、卵1個≈50g）。判断できなければ null。\n- amountAssumption：グラム換算で仮定したことがあれば日本語で簡潔に書く（例：「茶碗1杯を約150gとして換算」）。グラムで直接書かれていた場合は空文字。\n- 栄養素の値は一切扱わない（この段階では量と検索語だけ）。`,
            {
              schema: assistParseSchema,
              // Interactive call: a healthy parse answers in seconds,
              // so a 30 s cap with one retry bounds this step's wait.
              timeout_secs: 30,
            },
            2,
            "assist_parse",
          ),
          remaining(),
          "assist parse",
        );
      } catch (e) {
        if (isTimeoutError(e)) {
          return {
            status: "none",
            originalText: text,
            base: null,
            alternatives: [],
            inputGrams: null,
            amountText: "",
            amountAssumption: "",
            factor: null,
            effectiveGrams: null,
            rationale: TIMEOUT_RATIONALE,
            dishName: "",
            parts: [],
          };
        }
        throw e;
      }
      const amount = {
        inputGrams:
          parsed.inputGrams != null && parsed.inputGrams > 0
            ? round1(parsed.inputGrams)
            : null,
        amountText: parsed.amountText.trim().slice(0, 60),
        amountAssumption: parsed.amountAssumption.trim().slice(0, 200),
      };
      const none = (
        rationale: string,
      ): z.infer<typeof assistOut> => ({
        status: "none",
        originalText: text,
        base: null,
        alternatives: [],
        ...amount,
        factor: null,
        effectiveGrams: null,
        rationale,
        dishName: "",
        parts: [],
      });

      // (2) Gather candidates from the master (read-only): normalized
      // substring search (same rule as listFoods) plus the recipe
      // matcher, per keyword, deduped. The pool is deliberately wide —
      // the model makes the final pick, and a missing candidate can
      // never be picked.
      const allFoods = await db
        .select()
        .from(schema.foods)
        .orderBy(
          desc(schema.foods.useCount),
          desc(schema.foods.lastUsedAt),
          asc(schema.foods.name),
        );
      const cores = allFoods.map((f) => foodCores(f.name));
      const pool: FoodRow[] = [];
      const seen = new Set<number>();
      const push = (f: FoodRow) => {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          pool.push(f);
        }
      };
      const keywords = [
        ...new Set(
          [parsed.foodPhrase, ...parsed.keywords]
            .map((s) => s.trim())
            .filter((s) => s !== ""),
        ),
      ].slice(0, 6);
      for (const kw of keywords) {
        const nk = normName(kw);
        if (nk.length >= 2) {
          const hits = allFoods.filter((f) => normName(f.name).includes(nk));
          const starts = hits.filter((f) => normName(f.name).startsWith(nk));
          const rest = hits.filter((f) => !starts.includes(f));
          for (const f of [...starts, ...rest].slice(0, 10)) push(f);
        }
        for (const f of topFoodMatches(kw, allFoods, cores, 6)) push(f);
        if (pool.length >= 16) break;
      }
      const candidates = pool.slice(0, 16);

      // (4) Decompose （分解モード）: when no single master food can
      // stand in for the input — a composite home dish like たまご
      // スープ or 味噌汁, whose parts exist in the table but which has
      // no entry of its own — the model breaks the dish into
      // ingredient parts (names, gram estimates, rationales only),
      // and the server matches each part against the master with the
      // recipe matcher. Parts the model flags as nutritionally
      // negligible （水・だし汁） stay in the list as 'excluded' —
      // visible, never silently zero-filled; parts with no master
      // match stay as 'unmatched' and never enter the totals, so a
      // partial sum is never presented as a complete one. Returns
      // { out } on success, or { failRationale } describing why no
      // honest decomposition exists (the caller then answers 'none').
      const decompose = async (): Promise<{
        out: z.infer<typeof assistOut> | null;
        failRationale: string;
      }> => {
        let dec: z.infer<typeof decomposeSchema>;
        try {
          dec = await raceDeadline(
            completeWithRetry(
              ctx,
            `ユーザーが記録したい料理です。単一の食品では表せない複合料理として、材料（部品）に分解してください。栄養素の値は部品を食品マスタに照合してサーバが計算するので、あなたが値を推測することはありません（してはいけません）。返すのは料理名・材料名・グラム数・根拠だけです。\n\nユーザーの入力：${text}\n量：${amount.amountText || "不明"}（グラム換算 ${amount.inputGrams != null ? `${amount.inputGrams}g` : "不明"}${amount.amountAssumption ? `／前提：${amount.amountAssumption}` : ""}）\n\nルール：\n- decomposable：材料に分解できる料理かどうか。食品でないもの、材料が特定できないものは false にする。\n- dishName：料理名（量の表現を除いたもの。例：「たまごスープ」）。\n- parts：材料の配列（最大8つ）。入力された量全体（例：1杯分）についての分解にする。\n  - partName：材料名。食品マスタ（日本食品標準成分表）にありそうな一般名で書く（例：「卵」「たまねぎ」「食塩」「だし汁」）。\n  - grams：その材料のグラム数（食べた量全体に含まれる量）。個数表現は一般的な1単位の重量で換算する（例：卵1/2個≈25g）。\n  - rationale：その量にした根拠を日本語で簡潔に書く（例：「卵は1人前で約1/2個」）。\n  - excluded：水・だし汁のように栄養的に無視でき、計算に入れるべきでない材料は true。その場合も部品として挙げ、rationale に計算対象外の理由を書く。だしに溶けた塩分など無視できないものは excluded にせず、食塩などの部品として分ける。\n- rationale：分解全体の根拠・前提を日本語で簡潔に書く（例：「一般的な家庭のたまごスープ1杯（約200ml）を想定」）。decomposable が false の場合は、なぜ分解できないかを書く。`,
              { schema: decomposeSchema, timeout_secs: 30 },
              2,
              "assist_decompose",
            ),
            remaining(),
            "assist decompose",
          );
        } catch (e) {
          if (isTimeoutError(e)) {
            return { out: null, failRationale: TIMEOUT_RATIONALE };
          }
          return { out: null, failRationale: "" };
        }
        if (!dec.decomposable) {
          return {
            out: null,
            failRationale: dec.rationale.trim().slice(0, 500),
          };
        }
        const parts: z.infer<typeof assistPartOut>[] = [];
        for (const p of dec.parts.slice(0, 8)) {
          const partName = p.partName.trim().slice(0, 60);
          if (partName === "") continue;
          const rationale = p.rationale.trim().slice(0, 300);
          const grams =
            p.grams != null && p.grams > 0 ? round1(p.grams) : null;
          if (p.excluded) {
            parts.push({
              partName,
              rationale,
              grams,
              food: null,
              alternatives: [],
              status: "excluded",
            });
            continue;
          }
          const matches = topFoodMatches(partName, allFoods, cores, 4);
          const food = matches[0];
          if (!food) {
            parts.push({
              partName,
              rationale,
              grams,
              food: null,
              alternatives: [],
              status: "unmatched",
            });
            continue;
          }
          parts.push({
            partName,
            rationale,
            grams,
            food: toFoodOut(food),
            alternatives: matches.slice(1).map(toFoodOut),
            status: "counted",
          });
        }
        // A decomposition with no part that can actually be computed
        // (matched food + grams) is not a proposal — fall back to
        // 'none' rather than showing an empty shell.
        const computable = parts.some(
          (p) =>
            p.status === "counted" &&
            p.grams != null &&
            p.food != null &&
            (p.food.basisType === "per100g" || p.food.unitGrams != null),
        );
        if (!computable) {
          return {
            out: null,
            failRationale:
              dec.rationale.trim().slice(0, 500) ||
              "材料をマスタの食品に照合できませんでした",
          };
        }
        return {
          out: {
            status: "decomposed",
            originalText: text,
            base: null,
            alternatives: [],
            ...amount,
            factor: null,
            effectiveGrams: null,
            rationale: dec.rationale.trim().slice(0, 500),
            dishName:
              dec.dishName.trim().slice(0, 100) ||
              parsed.foodPhrase.trim().slice(0, 100) ||
              text,
            parts,
          },
          failRationale: "",
        };
      };

      // Start the decomposition NOW, in parallel with the select
      // step below. Run sequentially, a composite dish paid the
      // select step's full latency (plus its retries) before the
      // decomposition even started, and that stack ate the whole
      // budget on slow days — in production 「たまごスープ」 kept
      // ending in a timeout 'none' or an error even though the
      // same input succeeded in tests. The decomposed path now
      // costs parse + max(select, decompose). When the select step
      // does find a base, the decomposition result is simply
      // discarded; the catch guard keeps an abandoned
      // decomposition from surfacing as an unhandled rejection.
      const decomposePromise = decompose();
      decomposePromise.catch(() => undefined);

      if (candidates.length === 0) {
        const dec = await decomposePromise;
        if (dec.out) return withCache(dec.out);
        return none(dec.failRationale);
      }

      // (3) Select: the model picks the base food and proposes the
      // conversion. It sees ids, names and bases only — never nutrient
      // values — and may only reference ids from the candidate list.
      let picked: z.infer<typeof assistPickSchema> | null = null;
      let selectTimedOut = false;
      try {
        picked = await raceDeadline(
          completeWithRetry(
            ctx,
        `ユーザーが記録したい食品と、食品マスタの候補一覧です。候補の中から「基準食品」として最も近いものを1つ選び、換算案を作ってください。栄養素の値は基準食品のマスタ値がそのまま使われるので、あなたが値を推測することはありません（してはいけません）。選ぶのは食品と換算係数だけです。\n\nユーザーの入力：${text}\n量：${amount.amountText || "不明"}（グラム換算 ${amount.inputGrams != null ? `${amount.inputGrams}g` : "不明"}${amount.amountAssumption ? `／前提：${amount.amountAssumption}` : ""}）\n\n候補（id・食品名・基準）：\n${candidates.map((c) => `${c.id}: ${c.name}（${c.basisLabel}）`).join("\n")}\n\nルール：\n- baseFoodId：最も近い候補の id。妥当な基準が候補に無い場合は null。\n- factor：入力グラムを「基準食品として記録すべきグラム（実効グラム）」に直す係数（実効グラム ＝ 入力グラム × factor）。皮・骨など食べない部分が入力重量に含まれ、基準食品が可食部だけの値なら、その分を差し引く（例：皮つきで量った焼き芋を皮なし基準で記録し皮は食べない → 可食部は約9割 → 0.9）。そのまま記録できるなら 1。個数→グラムの換算はすでに inputGrams に反映済みなので、factor に二重に入れないこと。\n- rationale：係数の根拠を日本語で簡潔に書く（例：「皮は通常食べないため、皮なし基準では可食部を約9割としました」）。factor が 1 の場合はその理由。baseFoodId が null の場合は、なぜ基準にできないかを書く。\n- alternativeFoodIds：基準の候補になり得る他の候補の id を最大3つ（baseFoodId 以外、候補一覧にあるものだけ）。`,
            {
              schema: assistPickSchema,
              timeout_secs: 30,
            },
            2,
            "assist_pick",
          ),
          remaining(),
          "assist select",
        );
      } catch (e) {
        // A select failure no longer kills the request — timeout
        // or not (two schema slips in a row used to surface as a
        // raw 500). The decomposition is already running in
        // parallel; only if it also fails does the request answer
        // 'none'.
        selectTimedOut = isTimeoutError(e);
        picked = null;
      }
      const byId = new Map(candidates.map((f) => [f.id, f]));
      const base =
        picked?.baseFoodId != null ? byId.get(picked.baseFoodId) : undefined;
      if (!base) {
        // No single base food: use the decomposition already in
        // flight — composite dishes （汁物など） live exactly in
        // this gap.
        const dec = await decomposePromise;
        if (dec.out) return withCache(dec.out);
        const pickRationale =
          picked != null ? picked.rationale.trim().slice(0, 500) : "";
        return none(
          dec.failRationale ||
            (selectTimedOut ? TIMEOUT_RATIONALE : pickRationale),
        );
      }
      // Reaching here means `base` was resolved from `picked`, so
      // `picked` is set; the guard only satisfies the type checker.
      if (!picked) return none(TIMEOUT_RATIONALE);
      // A missing or implausible factor falls back to 1 (no conversion)
      // — the conservative choice, and the user can still edit it in
      // the proposal card before anything is logged.
      const factor =
        picked.factor != null && picked.factor > 0 && picked.factor <= 5
          ? round2(picked.factor)
          : 1;
      const alternatives: FoodRow[] = [];
      for (const id of picked.alternativeFoodIds) {
        const f = byId.get(id);
        if (f && f.id !== base.id && !alternatives.some((a) => a.id === f.id)) {
          alternatives.push(f);
        }
        if (alternatives.length >= 3) break;
      }
      return withCache({
        status: "ok",
        originalText: text,
        base: toFoodOut(base),
        alternatives: alternatives.map(toFoodOut),
        ...amount,
        factor,
        effectiveGrams:
          amount.inputGrams != null
            ? round1(amount.inputGrams * factor)
            : null,
        rationale: picked.rationale.trim().slice(0, 500),
        dishName: "",
        parts: [],
      });
    },
  }),

  logMeal: defineAction({
    description:
      "Logs one meal item (food + quantity) for a date and meal slot, snapshotting its nutrients. Pass eatingOut=true when the meal was eaten out. For AIアシスト記録， pass assistNote (original input text, base food name — must equal the logged food's name, conversion factor, rationale); the snapshot is computed from the food's master values exactly as usual, and the note is stored on the entry. Also bumps the food's use count so frequent foods surface first.",
    request: z.object({
      date: dateStr,
      slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
      foodId: z.number().int().positive(),
      quantity: z.number().positive().max(100000),
      unit: z.string().min(1).max(10),
      eatingOut: z.boolean().optional(),
      assistNote: z
        .object({
          originalText: z.string().min(1).max(200),
          baseFoodName: z.string().min(1).max(200),
          factor: z.number().positive().max(10).nullable(),
          rationale: z.string().max(500),
        })
        .optional(),
    }),
    response: z.object({ entry: logOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const foods = await db
        .select()
        .from(schema.foods)
        .where(eq(schema.foods.id, args.foodId))
        .limit(1);
      const food = foods[0];
      if (!food) throw new Error("指定された食品が見つかりません");
      // The assist note claims a base food; it must be the food actually
      // being logged, so a note can never describe a different basis
      // than the snapshot was computed from.
      if (args.assistNote && args.assistNote.baseFoodName !== food.name) {
        throw new Error("換算メモの基準食品が、記録する食品と一致しません");
      }
      const n = nutrientsFor(food, args.quantity, args.unit);
      const inserted = await db
        .insert(schema.mealLogs)
        .values({
          date: args.date,
          slot: args.slot,
          foodId: food.id,
          foodName: food.name,
          quantity: args.quantity,
          unit: args.unit,
          eatingOut: args.eatingOut ? 1 : 0,
          assistNote: args.assistNote
            ? stringifyStoredJson(args.assistNote)
            : null,
          ...n,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("logMeal: insert returned no rows");
      await db
        .update(schema.foods)
        .set({ useCount: food.useCount + 1, lastUsedAt: new Date() })
        .where(eq(schema.foods.id, food.id));
      ctx.invalidateQueries();
      return { entry: toLogOut(row) };
    },
  }),

  logAssistParts: defineAction({
    description:
      "AIアシストの分解モードで確認された部品リストを、1件の食事記録として保存する。各部品の栄養値はサーバがマスタ値×グラムで再計算し（クライアントの数値は信用しない）、合計をスナップショットとして meal_logs に1行で残す。食品マスタには一切追加しない。分解の内容（元の入力・料理名・部品一覧と各グラム・根拠・計算対象外/未マッチの別）は換算メモ（assist_note）に mode 'decomposed' で保存される。計算できる部品が1つも無い場合はエラー。",
    request: z.object({
      date: dateStr,
      slot: z.enum(["breakfast", "lunch", "dinner", "snack"]),
      eatingOut: z.boolean().optional(),
      dishName: z.string().min(1).max(100),
      originalText: z.string().min(1).max(200),
      rationale: z.string().max(500),
      parts: z
        .array(
          z.object({
            partName: z.string().min(1).max(60),
            foodId: z.number().int().positive().nullable(),
            grams: z.number().positive().max(100000).nullable(),
            rationale: z.string().max(300),
            status: z.enum(["counted", "excluded", "unmatched"]),
          }),
        )
        .min(1)
        .max(12),
    }),
    response: z.object({ entry: logOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const ids = [
        ...new Set(
          args.parts
            .map((p) => p.foodId)
            .filter((id): id is number => id != null),
        ),
      ];
      const foodRows =
        ids.length > 0
          ? await db
              .select()
              .from(schema.foods)
              .where(inArray(schema.foods.id, ids))
          : [];
      const foodById = new Map(foodRows.map((f) => [f.id, f]));

      // Recompute every part from the master: a part counts only when
      // its food resolves AND grams are set AND the food converts to
      // grams. Everything else stays in the note as not-counted, with
      // its status — never silently dropped, never zero-filled.
      let kcal = 0,
        protein = 0,
        fat = 0,
        carbs = 0,
        salt = 0,
        hasSalt = false,
        totalGrams = 0,
        countedCount = 0;
      const microList: MicroValues[] = [];
      const noteParts: z.infer<typeof assistNotePartOut>[] = [];
      const usedFoods = new Map<number, FoodRow>();
      for (const part of args.parts) {
        const food =
          part.foodId != null ? foodById.get(part.foodId) : undefined;
        const n =
          food && part.grams != null
            ? nutrientsForGrams(food, part.grams)
            : null;
        if (food && part.grams != null && n) {
          countedCount += 1;
          kcal += n.kcal;
          protein += n.proteinG;
          fat += n.fatG;
          carbs += n.carbsG;
          if (n.saltG != null) {
            salt += n.saltG;
            hasSalt = true;
          }
          microList.push(microsOf(n));
          totalGrams += part.grams;
          usedFoods.set(food.id, food);
          noteParts.push({
            partName: part.partName,
            foodName: food.name,
            grams: round1(part.grams),
            rationale: part.rationale,
            status: "counted",
          });
        } else {
          noteParts.push({
            partName: part.partName,
            foodName: food ? food.name : null,
            grams: part.grams != null ? round1(part.grams) : null,
            rationale: part.rationale,
            status: part.status === "excluded" ? "excluded" : "unmatched",
          });
        }
      }
      if (countedCount === 0) {
        throw new Error(
          "計算できる部品がありません。マスタに一致する部品とグラム数を確認してください",
        );
      }

      const note: AssistNote = {
        originalText: args.originalText,
        baseFoodName: args.dishName,
        factor: null,
        rationale: args.rationale,
        mode: "decomposed",
        parts: noteParts,
      };
      const inserted = await db
        .insert(schema.mealLogs)
        .values({
          date: args.date,
          slot: args.slot,
          foodId: null,
          foodName: args.dishName,
          quantity: round1(totalGrams),
          unit: "g",
          eatingOut: args.eatingOut ? 1 : 0,
          assistNote: stringifyStoredJson(note),
          kcal: Math.round(kcal),
          proteinG: round1(protein),
          fatG: round1(fat),
          carbsG: round1(carbs),
          saltG: hasSalt ? round2(salt) : null,
          ...sumMicros(microList),
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("logAssistParts: insert returned no rows");
      for (const food of usedFoods.values()) {
        await db
          .update(schema.foods)
          .set({ useCount: food.useCount + 1, lastUsedAt: new Date() })
          .where(eq(schema.foods.id, food.id));
      }
      ctx.invalidateQueries();
      return { entry: toLogOut(row) };
    },
  }),

  deleteMealLog: defineAction({
    description: "Deletes one meal log entry, undoing that record.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.mealLogs)
        .where(eq(schema.mealLogs.id, args.id))
        .returning({ id: schema.mealLogs.id });
      if (!deleted[0]) {
        throw new Error("指定された記録が見つかりません");
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setMealLogEatingOut: defineAction({
    description:
      "Sets or clears the eating-out flag （外食） on an existing meal log entry. The entry's nutrient snapshot is untouched; only the flag changes.",
    request: z.object({
      id: z.number().int().positive(),
      eatingOut: z.boolean(),
    }),
    response: z.object({ entry: logOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const updated = await db
        .update(schema.mealLogs)
        .set({ eatingOut: args.eatingOut ? 1 : 0 })
        .where(eq(schema.mealLogs.id, args.id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error("指定された記録が見つかりません");
      ctx.invalidateQueries();
      return { entry: toLogOut(row) };
    },
  }),

  listMealLogs: defineAction({
    description: "Lists all meal log entries for one date (YYYY-MM-DD).",
    request: z.object({ date: dateStr }),
    response: z.object({ entries: z.array(logOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await loadDay(db, args.date);
      return { entries: rows.map(toLogOut) };
    },
  }),

  getDailySummary: defineAction({
    description:
      "Returns one day's total energy and PFC (protein/fat/carbs in grams), computed from the meal logs at read time. This is the linkage action the body-composition dashboard uses.",
    request: z.object({ date: dateStr }),
    response: z.object({ summary: daySummaryOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await loadDay(db, args.date);
      return { summary: summarize(args.date, rows) };
    },
  }),

  getDailySummaries: defineAction({
    description:
      "Returns daily energy/PFC totals for every date in the inclusive range [startDate, endDate] (max 366 days), computed from the meal logs at read time. Each summary also carries hasEatingOut / eatingOutCount for the day's 外食 flag. Days without logs return zeros with logged=false.",
    request: z.object({ startDate: dateStr, endDate: dateStr }),
    response: z.object({ summaries: z.array(daySummaryOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const start = dateToDays(args.startDate);
      const end = dateToDays(args.endDate);
      if (end < start || end - start > 365) {
        throw new Error("期間指定が不正です（最大366日）");
      }
      const rows = await db
        .select()
        .from(schema.mealLogs)
        .where(
          and(
            gte(schema.mealLogs.date, args.startDate),
            lte(schema.mealLogs.date, args.endDate),
          ),
        )
        .orderBy(asc(schema.mealLogs.id));
      const byDate = new Map<string, LogRow[]>();
      for (const r of rows) {
        const list = byDate.get(r.date) ?? [];
        list.push(r);
        byDate.set(r.date, list);
      }
      const summaries: DaySummary[] = [];
      for (let d = start; d <= end; d++) {
        const date = daysToDate(d);
        summaries.push(summarize(date, byDate.get(date) ?? []));
      }
      return { summaries };
    },
  }),

  getSettings: defineAction({
    description:
      "Returns the daily targets (energy kcal, protein/fat/carbs grams); each is null when unset.",
    request: z.object({}),
    response: z.object({
      targetKcal: z.number().nullable(),
      targetProteinG: z.number().nullable(),
      targetFatG: z.number().nullable(),
      targetCarbsG: z.number().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      const map = new Map(rows.map((r) => [r.key, r.value]));
      const num = (key: string): number | null => {
        const v = map.get(key);
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return {
        targetKcal: num("target_kcal"),
        targetProteinG: num("target_protein_g"),
        targetFatG: num("target_fat_g"),
        targetCarbsG: num("target_carbs_g"),
      };
    },
  }),

  updateSettings: defineAction({
    description:
      "Updates daily targets. Omit a field to leave it unchanged, pass null to clear it, or a number to set it.",
    request: z.object({
      targetKcal: z.number().positive().max(20000).nullable().optional(),
      targetProteinG: z.number().positive().max(2000).nullable().optional(),
      targetFatG: z.number().positive().max(2000).nullable().optional(),
      targetCarbsG: z.number().positive().max(2000).nullable().optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const pairs: Array<[string, number | null | undefined]> = [
        ["target_kcal", args.targetKcal],
        ["target_protein_g", args.targetProteinG],
        ["target_fat_g", args.targetFatG],
        ["target_carbs_g", args.targetCarbsG],
      ];
      for (const [key, value] of pairs) {
        if (value === undefined) continue;
        if (value === null) {
          await db.delete(schema.settings).where(eq(schema.settings.key, key));
        } else {
          await db
            .insert(schema.settings)
            .values({ key, value: String(value) })
            .onConflictDoUpdate({
              target: schema.settings.key,
              set: { value: String(value) },
            });
        }
      }
      // A target change is also a history event: it appends (or, on a
      // same-day re-save, updates) today's target_history row so past
      // targets are never lost to an overwrite.
      await appendSettingsChangeToHistory(db);
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listTargetHistory: defineAction({
    description:
      "Returns the full target history （目標の履歴）: every dated target set (effectiveDate YYYY-MM-DD, kcal, protein/fat/carbs grams), oldest first. This is the sync surface the body-composition dashboard reads to learn when targets changed; the last entry is the current target.",
    request: z.object({}),
    response: z.object({ entries: z.array(targetHistoryOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.targetHistory)
        .orderBy(asc(schema.targetHistory.effectiveDate));
      return { entries: rows.map(toTargetHistoryOut) };
    },
  }),

  upsertTargetHistory: defineAction({
    description:
      "Adds or edits one target-history entry (effectiveDate + kcal / protein / fat / carbs grams). Pass id to edit an existing entry, omit it to add one; effectiveDate must not duplicate another entry's date. Afterwards the current targets are re-derived from the newest history entry.",
    request: z.object({
      id: z.number().int().positive().optional(),
      effectiveDate: dateStr,
      kcal: z.number().positive().max(20000),
      proteinG: z.number().positive().max(2000),
      fatG: z.number().positive().max(2000),
      carbsG: z.number().positive().max(2000),
    }),
    response: z.object({ ok: z.literal(true), id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const clash = await db
        .select()
        .from(schema.targetHistory)
        .where(eq(schema.targetHistory.effectiveDate, args.effectiveDate));
      const clashRow = clash[0];
      if (clashRow && clashRow.id !== args.id) {
        throw new Error(
          `${args.effectiveDate} の目標はすでに登録されています`,
        );
      }
      const values = {
        effectiveDate: args.effectiveDate,
        kcal: args.kcal,
        proteinG: args.proteinG,
        fatG: args.fatG,
        carbsG: args.carbsG,
      };
      let id: number;
      if (args.id != null) {
        const existing = await db
          .select()
          .from(schema.targetHistory)
          .where(eq(schema.targetHistory.id, args.id));
        if (!existing[0]) {
          throw new Error("指定された目標履歴が見つかりません");
        }
        await db
          .update(schema.targetHistory)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(schema.targetHistory.id, args.id));
        id = args.id;
      } else {
        const inserted = await db
          .insert(schema.targetHistory)
          .values(values)
          .returning({ id: schema.targetHistory.id });
        const row = inserted[0];
        if (!row) throw new Error("upsertTargetHistory: insert returned no rows");
        id = row.id;
      }
      await syncSettingsFromHistory(db);
      ctx.invalidateQueries();
      return { ok: true as const, id };
    },
  }),

  deleteTargetHistory: defineAction({
    description:
      "Deletes one target-history entry by id. Afterwards the current targets are re-derived from the newest remaining entry (settings are left as-is when no entries remain).",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const deleted = await db
        .delete(schema.targetHistory)
        .where(eq(schema.targetHistory.id, args.id))
        .returning({ id: schema.targetHistory.id });
      if (!deleted[0]) {
        throw new Error("指定された目標履歴が見つかりません");
      }
      await syncSettingsFromHistory(db);
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  seedTargetHistory: defineAction({
    description:
      "Seeds one sample target-history entry when the target history is empty; otherwise does nothing. The newest seeded entry is mirrored into the current targets.",
    request: z.object({}),
    response: z.object({ seeded: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({ id: schema.targetHistory.id })
        .from(schema.targetHistory)
        .limit(1);
      if (existing.length > 0) return { seeded: 0 };
      const seed: Array<{
        effectiveDate: string;
        kcal: number;
        proteinG: number;
        fatG: number;
        carbsG: number;
      }> = [
        { effectiveDate: "2026-01-01", kcal: 2000, proteinG: 100, fatG: 50, carbsG: 250 },
      ];
      for (const row of seed) {
        await db.insert(schema.targetHistory).values(row);
      }
      await syncSettingsFromHistory(db);
      ctx.invalidateQueries();
      return { seeded: seed.length };
    },
  }),

  getAiMetrics: defineAction({
    description:
      "Returns the durable AI-layer counters (ai_metrics), key-sorted: per inference flow (label_photo / lookup_extract / recipe_photo / blend_parse / assist_parse / assist_pick / assist_decompose) the attempts, failures, schema_failures (responses rejected by the response schema) and retries; plus deep_research.expired and recipe_import.expired (background jobs that died without a callback) and assist_cache.version_mismatch (stored proposals in an unknown JSON version). Lets the effect of schema hardening be measured instead of guessed.",
    request: z.object({}),
    response: z.object({
      metrics: z.array(
        z.object({
          key: z.string(),
          count: z.number(),
          updatedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.aiMetrics)
        .orderBy(asc(schema.aiMetrics.key));
      return {
        metrics: rows.map((r) => ({
          key: r.key,
          count: r.count,
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  }),

  getConsumptionStats: defineAction({
    description:
      "消費ペース： selected foods' consumption over the last `days` days (0 = all history), computed at read time from the meal logs — direct entries, AI-assist decomposition parts, and recipe entries expanded into their master-food ingredient lines, all in grams. Returns the window total, per-week / per-month / per-year pace (averaged over the days the log actually covers, so a young log is not diluted by the requested window), entry counts, days used, a per-food breakdown, and a continuous weekly series for charting. Entries whose unit has no gram equivalent count as entries only (unconverted) — grams are never guessed.",
    request: z.object({
      foodIds: z.array(z.number().int().positive()).min(1).max(30),
      days: z.number().int().min(0).max(3650),
    }),
    response: consumptionOut,
    async handler(ctx, args): Promise<ConsumptionResult> {
      const db = ctx.db<typeof schema>();
      return computeConsumption(db, [...new Set(args.foodIds)], args.days);
    },
  }),

  listUsedFoods: defineAction({
    description:
      "Lists foods that have actually been logged (use_count > 0), most-used first — the short candidate list the consumption view's picker leads with, so picking from the ~2,500-entry master is never the starting point.",
    request: z.object({
      limit: z.number().int().positive().max(300).optional(),
    }),
    response: z.object({ foods: z.array(foodOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.foods)
        .where(sql`${schema.foods.useCount} > 0`)
        .orderBy(
          desc(schema.foods.useCount),
          desc(schema.foods.lastUsedAt),
          asc(schema.foods.name),
        )
        .limit(args.limit ?? 200);
      return { foods: rows.map(toFoodOut) };
    },
  }),

  suggestRelatedFoods: defineAction({
    description:
      "Suggests foods worth adding to a consumption selection: candidates ranked by nutrient-profile cosine similarity (per-100 g P/F/C/kcal/salt/fiber vectors) blended with name similarity (character bigrams of the folded core name), each tagged with the selected food it most resembles. Foods already selected are excluded; foods whose per-100 g vector cannot be derived (serving basis without unit grams) are skipped. Suggestions only — nothing is grouped automatically.",
    request: z.object({
      foodIds: z.array(z.number().int().positive()).min(1).max(30),
    }),
    response: z.object({
      suggestions: z.array(
        z.object({
          food: foodOut,
          score: z.number(),
          similarTo: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const selected = new Set(args.foodIds);
      const rows = await db.select().from(schema.foods);
      const byId = new Map(rows.map((f) => [f.id, f]));
      const bases = args.foodIds
        .map((id) => byId.get(id))
        .filter((f): f is FoodRow => f != null)
        .map((f) => ({
          name: f.name,
          vec: nutrientVector(f),
          grams: nameBigrams(f.name),
        }))
        .filter(
          (b): b is { name: string; vec: number[]; grams: Set<string> } =>
            b.vec != null,
        );
      if (bases.length === 0) return { suggestions: [] };
      const scored: Array<{
        food: FoodRow;
        score: number;
        similarTo: string;
      }> = [];
      for (const cand of rows) {
        if (selected.has(cand.id)) continue;
        const vec = nutrientVector(cand);
        if (vec == null) continue;
        const candGrams = nameBigrams(cand.name);
        let best = 0;
        let bestName = "";
        for (const base of bases) {
          let dot = 0,
            na = 0,
            nb = 0;
          for (let i = 0; i < vec.length; i += 1) {
            const a = vec[i] ?? 0;
            const b = base.vec[i] ?? 0;
            dot += a * b;
            na += a * a;
            nb += b * b;
          }
          const cos = na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
          const score = cos * 0.7 + jaccard(candGrams, base.grams) * 0.3;
          if (score > best) {
            best = score;
            bestName = base.name;
          }
        }
        if (best >= 0.35) {
          scored.push({ food: cand, score: best, similarTo: bestName });
        }
      }
      scored.sort(
        (a, b) => b.score - a.score || b.food.useCount - a.food.useCount,
      );
      return {
        suggestions: scored.slice(0, 10).map((s) => ({
          food: toFoodOut(s.food),
          score: Math.round(s.score * 100) / 100,
          similarTo: s.similarTo,
        })),
      };
    },
  }),

  listConsumptionGroups: defineAction({
    description:
      "Lists the saved consumption groups (named food sets for the 消費ペース view), oldest first, with member foods resolved to names; ids whose food was deleted are dropped from the output.",
    request: z.object({}),
    response: z.object({ groups: z.array(consumptionGroupOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.consumptionGroups)
        .orderBy(asc(schema.consumptionGroups.id));
      const groups: Array<z.infer<typeof consumptionGroupOut>> = [];
      for (const row of rows) groups.push(await toConsumptionGroupOut(db, row));
      return { groups };
    },
  }),

  saveConsumptionGroup: defineAction({
    description:
      "Creates or updates a named consumption group (a set of food ids totalled together in the 消費ペース view). Pass id to update an existing group. Only membership is stored; all figures are computed from the meal logs at read time.",
    request: z.object({
      id: z.number().int().positive().optional(),
      name: z.string().trim().min(1).max(50),
      foodIds: z.array(z.number().int().positive()).min(1).max(30),
    }),
    response: z.object({ group: consumptionGroupOut }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const ids = [...new Set(args.foodIds)];
      const existingFoods = await db
        .select({ id: schema.foods.id })
        .from(schema.foods)
        .where(inArray(schema.foods.id, ids));
      const valid = new Set(existingFoods.map((f) => f.id));
      const kept = ids.filter((id) => valid.has(id));
      if (kept.length === 0) {
        throw new Error("選択された食品がマスタに見つかりません");
      }
      let row: ConsumptionGroupRow | undefined;
      if (args.id != null) {
        const updated = await db
          .update(schema.consumptionGroups)
          .set({
            name: args.name,
            foodIds: JSON.stringify(kept),
            updatedAt: new Date(),
          })
          .where(eq(schema.consumptionGroups.id, args.id))
          .returning();
        row = updated[0];
        if (!row) throw new Error("指定されたまとめが見つかりません");
      } else {
        const inserted = await db
          .insert(schema.consumptionGroups)
          .values({ name: args.name, foodIds: JSON.stringify(kept) })
          .returning();
        row = inserted[0];
        if (!row) throw new Error("saveConsumptionGroup: insert returned no rows");
      }
      ctx.invalidateQueries();
      return { group: await toConsumptionGroupOut(db, row) };
    },
  }),

  deleteConsumptionGroup: defineAction({
    description:
      "Deletes a saved consumption group. The foods and meal logs are untouched — only the named membership is removed.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.consumptionGroups)
        .where(eq(schema.consumptionGroups.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
