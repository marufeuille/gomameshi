// Shared primitives for the gomameshi core types.
//
// Design rule for the whole `types/` tree: an LLM agent is an unreliable
// writer. Anything an agent sends is parsed by these schemas first, and
// every number that ends up in the log is computed by the core from the
// master — never taken from the agent.

import { z } from "zod";

// ---------- ids ----------
//
// Ids are strings, not auto-increment integers: the master lives in the
// cloud and the log lives on the phone, so ids must be stable across
// both and never collide.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A food in the master.
 * - `mext:<食品番号>` for 日本食品標準成分表 entries (e.g. `mext:01088`).
 *   The same id on every install, so the shared table lines up.
 * - `food_<ULID>` for foods registered from a label or a maker page.
 */
export const FoodId = z
  .string()
  .regex(/^(mext:\d{5}|food_[0-9A-HJKMNP-TV-Z]{26})$/, {
    message: "foodId must be mext:<5 digits> or food_<ULID>",
  })
  .brand<"FoodId">();
export type FoodId = z.infer<typeof FoodId>;

export const RecipeId = z
  .string()
  .regex(/^recipe_[0-9A-HJKMNP-TV-Z]{26}$/, {
    message: "recipeId must be recipe_<ULID>",
  })
  .brand<"RecipeId">();
export type RecipeId = z.infer<typeof RecipeId>;

/** Assigned by the relay when it accepts an event. Agents never mint it. */
export const EventId = z
  .string()
  .regex(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/)
  .brand<"EventId">();
export type EventId = z.infer<typeof EventId>;

/** Taken from the agent's token by the relay, never from the payload. */
export const AgentId = z
  .string()
  .regex(/^agt_[a-z0-9-]{1,40}$/)
  .brand<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;

/** Master entries are immutable revisions; an edit makes rev + 1. */
export const Rev = z.number().int().positive();
export type Rev = z.infer<typeof Rev>;

export const isUlid = (s: string): boolean => ULID.test(s);

// ---------- dates and slots ----------

/** Calendar date in Asia/Tokyo, YYYY-MM-DD. */
export const LocalDate = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: "date must be YYYY-MM-DD (Asia/Tokyo)",
  });
export type LocalDate = z.infer<typeof LocalDate>;

/** ISO-8601 instant with offset, e.g. 2026-11-28T12:30:00+09:00. */
export const Instant = z.iso.datetime({ offset: true });
export type Instant = z.infer<typeof Instant>;

export const MealSlot = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export type MealSlot = z.infer<typeof MealSlot>;

// ---------- nutrients ----------
//
// PFC and energy are required. Everything else is nullable, and null
// means "unknown" — never 0, never a guess (same rule as today's app).

const g = (max: number) => z.number().min(0).max(max);

export const Micronutrients = z.object({
  saltG: g(1000).nullable(),
  fiberG: g(1000).nullable(),
  potassiumMg: g(1_000_000).nullable(),
  calciumMg: g(1_000_000).nullable(),
  magnesiumMg: g(1_000_000).nullable(),
  ironMg: g(100_000).nullable(),
  vitaminDMcg: g(100_000).nullable(),
  vitaminB1Mg: g(100_000).nullable(),
  vitaminB2Mg: g(100_000).nullable(),
  vitaminB6Mg: g(100_000).nullable(),
  vitaminB12Mcg: g(100_000).nullable(),
  folateMcg: g(1_000_000).nullable(),
  vitaminCMg: g(1_000_000).nullable(),
});

export const Nutrients = z
  .object({
    kcal: g(10_000),
    proteinG: g(1000),
    fatG: g(1000),
    carbsG: g(1000),
  })
  .extend(Micronutrients.shape);
export type Nutrients = z.infer<typeof Nutrients>;

/**
 * Nutrients as an agent submits them (from a label photo). Missing
 * micronutrients become null, so "not printed on the label" and
 * "the agent forgot the key" both end up as unknown, not 0.
 */
export const NutrientsInput = z
  .object({
    kcal: g(10_000),
    proteinG: g(1000),
    fatG: g(1000),
    carbsG: g(1000),
  })
  .extend(
    Object.fromEntries(
      Object.entries(Micronutrients.shape).map(([k, v]) => [k, v.default(null)]),
    ) as { [K in keyof typeof Micronutrients.shape]: z.ZodDefault<(typeof Micronutrients.shape)[K]> },
  );
export type NutrientsInput = z.input<typeof NutrientsInput>;

// ---------- amounts ----------

/**
 * How much was eaten. `unit` is "g", "serving" (for serving-basis foods
 * and recipes), or one of the food's own `units` (e.g. "個", "枚").
 * The core rejects a unit the food does not define — an agent cannot
 * invent a gram conversion.
 */
export const Amount = z.object({
  value: z.number().positive().max(100_000),
  unit: z.string().min(1).max(10),
});
export type Amount = z.infer<typeof Amount>;
