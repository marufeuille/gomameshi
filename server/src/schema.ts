// Drizzle schema for 食事とPFC.
//
// foods: the food master. Nutrient values are stored per basis —
//   basisType 'per100g' → values are per 100 g
//   basisType 'serving' → values are per 1 serving (see basisLabel,
//   e.g. "1食分（200g）あたり")
// meal_logs: one row per logged item (an event). Each row snapshots the
//   computed nutrients at log time, so later food edits never rewrite
//   history; daily totals are derived by summing rows at read time.
// settings: simple key/value store (targets as JSON numbers).

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const foods = sqliteTable("foods", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  basisType: text("basis_type", { enum: ["per100g", "serving"] }).notNull(),
  basisLabel: text("basis_label").notNull(),
  kcal: real("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  fatG: real("fat_g").notNull(),
  carbsG: real("carbs_g").notNull(),
  saltG: real("salt_g"),
  // Micronutrients （微量栄養素）, per the same basis as the PFC values
  // above. All nullable: unknown stays null, never 0 or a guess.
  fiberG: real("fiber_g"),
  potassiumMg: real("potassium_mg"),
  calciumMg: real("calcium_mg"),
  magnesiumMg: real("magnesium_mg"),
  ironMg: real("iron_mg"),
  vitaminDMcg: real("vitamin_d_mcg"),
  vitaminB1Mg: real("vitamin_b1_mg"),
  vitaminB2Mg: real("vitamin_b2_mg"),
  vitaminB6Mg: real("vitamin_b6_mg"),
  vitaminB12Mcg: real("vitamin_b12_mcg"),
  folateMcg: real("folate_mcg"),
  vitaminCMg: real("vitamin_c_mg"),
  source: text("source", {
    enum: ["table", "label", "manual", "ai", "blend"],
  }).notNull(),
  // Calculation basis for source = 'blend' foods （配合計算）: JSON of
  // { note, totalGrams, parts: [{ foodId, foodName, grams, per100:
  // { kcal, proteinG, fatG, carbsG, saltG } }] } — each part's nutrient
  // contribution to 100 g of the blend, snapshotted at save time so the
  // basis stays readable even if a part food is edited later. Null for
  // all other sources.
  blendJson: text("blend_json"),
  // Citation for AI-researched foods (source = 'ai'): the public source the
  // values were taken from. Null for other sources.
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  // Composition-table number （食品番号， e.g. "06153") for foods that come
  // from 日本食品標準成分表 (source = 'table'); null for user-registered
  // foods. Unique when present — the full-table import keys on it.
  tableNo: text("table_no"),
  defaultAmount: real("default_amount").notNull(),
  defaultUnit: text("default_unit").notNull(),
  unitGrams: real("unit_grams"),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const mealLogs = sqliteTable("meal_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD, Asia/Tokyo calendar date
  slot: text("slot", {
    enum: ["breakfast", "lunch", "dinner", "snack"],
  }).notNull(),
  foodId: integer("food_id"),
  foodName: text("food_name").notNull(),
  quantity: real("quantity").notNull(),
  unit: text("unit").notNull(),
  kcal: real("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  fatG: real("fat_g").notNull(),
  carbsG: real("carbs_g").notNull(),
  saltG: real("salt_g"),
  // Micronutrient snapshot, same rule as the PFC snapshot above: copied
  // from the food at log time; null when the food's value was unknown.
  // Existing rows (logged before these columns existed) read as null.
  fiberG: real("fiber_g"),
  potassiumMg: real("potassium_mg"),
  calciumMg: real("calcium_mg"),
  magnesiumMg: real("magnesium_mg"),
  ironMg: real("iron_mg"),
  vitaminDMcg: real("vitamin_d_mcg"),
  vitaminB1Mg: real("vitamin_b1_mg"),
  vitaminB2Mg: real("vitamin_b2_mg"),
  vitaminB6Mg: real("vitamin_b6_mg"),
  vitaminB12Mcg: real("vitamin_b12_mcg"),
  folateMcg: real("folate_mcg"),
  vitaminCMg: real("vitamin_c_mg"),
  // 外食フラグ： 1 when this entry was eaten out. The flag marks the day as
  // containing an estimated meal (public nutrition labels on chains are
  // close, but the record is still an outside meal) so the dashboard can
  // treat such days separately. Existing rows default to 0 = not eating out.
  eatingOut: integer("eating_out").notNull().default(0),
  // AIアシスト換算メモ (JSON): set only when the entry was logged through
  // the AI-assist conversion flow （基準食品 × 実効グラム）. Holds
  // { originalText, baseFoodName, factor, rationale } — what the user
  // typed, which master food served as the basis, the conversion factor
  // (an estimate, editable before logging) and its rationale. The
  // nutrient snapshot above always comes from the base food's master
  // values; the note only explains the conversion. Null for normal logs.
  assistNote: text("assist_note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// target_history: the daily targets as a dated history （目標の履歴）.
// One row = one target set taking effect on `effectiveDate` (YYYY-MM-DD,
// Asia/Tokyo calendar date) until the next row's date. The settings rows
// (target_kcal etc.) remain the "current" cache and always mirror the
// latest history row once history exists: changing the current target
// appends a row dated today, and editing/deleting history rows re-derives
// the settings from the newest remaining row. effectiveDate is unique —
// one target set per start date.
export const targetHistory = sqliteTable("target_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  effectiveDate: text("effective_date").notNull().unique(),
  kcal: real("kcal").notNull(),
  proteinG: real("protein_g").notNull(),
  fatG: real("fat_g").notNull(),
  carbsG: real("carbs_g").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// recipes: dishes saved as a unit (レシピ単位で保存). A recipe's nutrients
// are the sum of its ingredient lines, stored as JSON so each line keeps
// its own basis: lines matched to a food-master entry carry that food's
// id/name and are recomputed server-side from the master at save time;
// 'manual' lines carry user-entered nutrients; 'unknown' lines have null
// nutrients and are excluded from the totals. Per-serving values are
// derived at read time from the totals and `servings` — never stored.
// The totals_* columns are a snapshot of the summed lines at save time,
// kept so list views and the recipe logger don't need to parse JSON.
export const recipes = sqliteTable("recipes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  servings: real("servings"), // 何人分か (e.g. 2); null when unknown
  servingsLabel: text("servings_label").notNull().default(""), // e.g. "2人分"
  sourceType: text("source_type", {
    enum: ["url", "photo", "manual"],
  }).notNull(),
  sourceUrl: text("source_url"), // the recipe page URL for sourceType 'url'
  ingredientsJson: text("ingredients_json").notNull(),
  totalsKcal: real("totals_kcal").notNull().default(0),
  totalsProteinG: real("totals_protein_g").notNull().default(0),
  totalsFatG: real("totals_fat_g").notNull().default(0),
  totalsCarbsG: real("totals_carbs_g").notNull().default(0),
  totalsSaltG: real("totals_salt_g"), // null when no line carries salt
  // Micronutrient totals, same rule as salt: null when no line carries
  // a value for that nutrient, otherwise the sum of the known lines.
  totalsFiberG: real("totals_fiber_g"),
  totalsPotassiumMg: real("totals_potassium_mg"),
  totalsCalciumMg: real("totals_calcium_mg"),
  totalsMagnesiumMg: real("totals_magnesium_mg"),
  totalsIronMg: real("totals_iron_mg"),
  totalsVitaminDMcg: real("totals_vitamin_d_mcg"),
  totalsVitaminB1Mg: real("totals_vitamin_b1_mg"),
  totalsVitaminB2Mg: real("totals_vitamin_b2_mg"),
  totalsVitaminB6Mg: real("totals_vitamin_b6_mg"),
  totalsVitaminB12Mcg: real("totals_vitamin_b12_mcg"),
  totalsFolateMcg: real("totals_folate_mcg"),
  totalsVitaminCMg: real("totals_vitamin_c_mg"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// recipe_imports: one in-flight (or finished) recipe estimation started
// from a URL or a photo. URL imports run as a background agent task (the
// action runtime cannot open pages), which reports back through
// completeRecipeImport; photo imports are filled synchronously by
// importRecipeFromPhoto. The matched draft is stored as JSON until the
// user confirms it in the editor and it becomes a recipe via saveRecipe.
export const recipeImports = sqliteTable("recipe_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["url", "photo"] }).notNull(),
  sourceUrl: text("source_url"),
  status: text("status", {
    enum: ["pending", "ready", "failed"],
  }).notNull(),
  error: text("error"),
  draftJson: text("draft_json"),
  // Progress reported by the background URL-import agent, same shape
  // as food_research_jobs: a short free-text note plus the stage enum
  // ('opening_page' / 'extracting' / 'saving') enforced by the
  // reportRecipeImportProgress request schema. Photo imports are
  // synchronous and never report. Null until the agent's first report.
  progress: text("progress"),
  progressStage: text("progress_stage", {
    enum: ["opening_page", "extracting", "saving"],
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// food_research_jobs: one in-flight (or finished) deep food research
// started when the fast snippet-based lookup (lookupFoodInfo) cannot
// confirm values — search-result snippets often lack the manufacturer's
// full 栄養成分表示 (e.g. BASE BREAD: the official shop page never
// surfaces with its table in the snippets). A background agent task
// opens the manufacturer's pages directly and reports back through
// completeDeepFoodResearch, which upserts the outcome into
// food_research; the client polls getDeepFoodResearch.
export const foodResearchJobs = sqliteTable("food_research_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  queryName: text("query_name").notNull(),
  queryNorm: text("query_norm").notNull(),
  status: text("status", {
    enum: ["pending", "ready", "failed"],
  }).notNull(),
  error: text("error"),
  // Latest progress note reported by the research agent while it works
  // (e.g. 「公式ショップの商品ページを開きました」), so the UI can show
  // what the ~1-2 minute background job is doing instead of a bare
  // spinner. Null until the agent's first report.
  progress: text("progress"),
  // Which stage of the research the latest progress report belongs to
  // (enum enforced by the reportDeepFoodResearchProgress request
  // schema): 'searching' (looking for the official site), 'opening_page'
  // (a page was opened), 'reading_table' (the nutrition table was
  // confirmed), 'saving' (about to report the result). The free-text
  // note alone could not be grouped or checked; the stage makes the
  // agent's position in the flow machine-readable. Null until the
  // agent's first staged report (jobs reported before this column
  // existed stay null).
  progressStage: text("progress_stage", {
    enum: ["searching", "opening_page", "reading_table", "saving"],
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// assist_proposals: durable cache of successful AI-assist proposals
// (「AIアシスト記録」), keyed by the normalized input text — the same
// caching philosophy as food_research for lookups. The assist flow
// stacks up to three model calls (parse → select → decompose), each
// sampled and each slow; before this cache existed, EVERY attempt at
// a dish like 「たまごスープ 1杯」 re-rolled all of them, and a slow
// or unlucky draw ended in a timeout 'none' even though the same
// input had succeeded before. Only successful proposals (status 'ok'
// or 'decomposed') are stored, as the full assistOut JSON; 'none' is
// never cached, so a failed input always gets a fresh attempt. The
// stored food snapshots can go stale if a food is later edited —
// logging always recomputes from the live master, so a stale cache
// entry can only affect the preview, never the recorded values.
export const assistProposals = sqliteTable("assist_proposals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  queryNorm: text("query_norm").notNull().unique(),
  originalText: text("original_text").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// food_research: the durable record of every AI lookup (「AIで調べる」).
// One row per normalized query name, whether a trustworthy source was
// found or not. A repeat lookup for the same name returns the stored
// record instead of searching again; the user can force a fresh search.
// Nutrient columns are null for status 'not_found'.
export const foodResearch = sqliteTable("food_research", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  queryName: text("query_name").notNull(),
  queryNorm: text("query_norm").notNull().unique(),
  // Maker/brand name for this lookup （メーカー名）: the value the user
  // typed in the split maker field, or the maker the research confirmed
  // or inferred from the source. Part of the record's match precision
  // (a record stored for a different maker is not reused for a lookup
  // naming another maker), but never a hard filter. Null for records
  // stored before this column existed — those keep matching any lookup
  // for the same product name, as before.
  maker: text("maker"),
  status: text("status", { enum: ["found", "not_found"] }).notNull(),
  name: text("name"),
  basisType: text("basis_type"),
  basisLabel: text("basis_label"),
  servingGrams: real("serving_grams"),
  kcal: real("kcal"),
  proteinG: real("protein_g"),
  fatG: real("fat_g"),
  carbsG: real("carbs_g"),
  saltG: real("salt_g"),
  // Micronutrients found in the source (null when the source does not
  // state them — never guessed).
  fiberG: real("fiber_g"),
  potassiumMg: real("potassium_mg"),
  calciumMg: real("calcium_mg"),
  magnesiumMg: real("magnesium_mg"),
  ironMg: real("iron_mg"),
  vitaminDMcg: real("vitamin_d_mcg"),
  vitaminB1Mg: real("vitamin_b1_mg"),
  vitaminB2Mg: real("vitamin_b2_mg"),
  vitaminB6Mg: real("vitamin_b6_mg"),
  vitaminB12Mcg: real("vitamin_b12_mcg"),
  folateMcg: real("folate_mcg"),
  vitaminCMg: real("vitamin_c_mg"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// consumption_groups: named sets of foods the user wants to total
// together in the 消費ペース view (e.g. 「ソイ系」 = several soy protein
// products bought in parallel, or a replacement candidate set). Only
// the membership is stored — every number in that view is computed at
// read time from meal_logs, so a group never goes stale. foodIds is a
// JSON array of foods.id values; ids whose food was later deleted are
// dropped at read time.
export const consumptionGroups = sqliteTable("consumption_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  foodIds: text("food_ids").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ai_metrics: durable counters for the AI-call layer, keyed by a dotted
// name (e.g. "assist_pick.attempts", "assist_pick.schema_failures",
// "deep_research.expired"). The flows' failure/ retry/ expiry rates
// were previously invisible — there was no way to tell whether schema
// hardening actually reduced failures — so every inference attempt,
// schema-validation failure, retry, background-job expiry and stored-
// JSON version mismatch increments a counter here. Read via the
// getAiMetrics action. Counts only ever grow; nothing resets them.
export const aiMetrics = sqliteTable("ai_metrics", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
