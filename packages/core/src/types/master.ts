// The food master: public data, kept in plain text in the cloud.
//
// Everything here comes from public sources (the composition table,
// package labels, maker pages, published recipes), so it needs no
// encryption. What is private is *what you ate* — that is in events.ts.
//
// Entries are immutable revisions. A meal event pins {id, rev}, so a
// later fix to a food never rewrites past days.

import { z } from "zod";
import {
  Amount,
  FoodId,
  Instant,
  Nutrients,
  NutrientsInput,
  RecipeId,
  Rev,
} from "./common";

// ---------- basis ----------

export const Basis = z.discriminatedUnion("type", [
  z.object({ type: z.literal("per100g") }),
  z.object({
    type: z.literal("serving"),
    /** As printed, e.g. "1本（45g）あたり". */
    label: z.string().min(1).max(60),
    /** Grams in one serving, when the label states it. */
    servingGrams: z.number().positive().max(100_000).nullable(),
  }),
]);
export type Basis = z.infer<typeof Basis>;

// ---------- source (a citation, not a method) ----------
//
// There is no "ai" source. An AI is how values were found, not where
// they came from: a researched food cites the maker page it read, and a
// photographed label is a label. A value with nothing to cite is not
// registered at all.

export const FoodSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mext_table"),
    tableNo: z.string().regex(/^\d{5}$/),
    edition: z.string().min(1).max(40), // e.g. "八訂増補2023"
  }),
  z.object({
    kind: z.literal("label"),
    /** When the photo of the package was read. */
    readAt: Instant,
  }),
  z.object({
    kind: z.literal("maker_page"),
    url: z.url({ protocol: /^https?$/ }).max(1000),
    title: z.string().min(1).max(200),
    retrievedAt: Instant,
  }),
  z.object({
    kind: z.literal("blend"),
    /** 配合計算: grams of each part in totalGrams of the blend. */
    totalGrams: z.number().positive().max(100_000),
    parts: z
      .array(z.object({ food: FoodId, rev: Rev, grams: z.number().positive() }))
      .min(1)
      .max(30),
  }),
  z.object({
    kind: z.literal("manual"),
    /** Why there is no better source. Required, so it is never silent. */
    note: z.string().min(1).max(300),
  }),
]);
export type FoodSource = z.infer<typeof FoodSource>;

// ---------- food ----------

/** A countable unit and its grams, e.g. { unit: "個", grams: 50 }. */
export const UnitDef = z.object({
  unit: z.string().min(1).max(10),
  grams: z.number().positive().max(100_000),
});

export const Food = z.object({
  id: FoodId,
  rev: Rev,
  name: z.string().min(1).max(100),
  maker: z.string().max(100).nullable(),
  basis: Basis,
  nutrients: Nutrients,
  units: z.array(UnitDef).max(10),
  /** What a log defaults to when the agent gives no amount. */
  defaultAmount: Amount,
  source: FoodSource,
  createdAt: Instant,
});
export type Food = z.infer<typeof Food>;

/**
 * register_food: what an agent sends. Pass `id` to make a new revision
 * of an existing food; omit it to register a new one. The relay assigns
 * id / rev / createdAt.
 */
export const FoodSubmission = z.object({
  id: FoodId.optional(),
  name: z.string().min(1).max(100),
  maker: z.string().max(100).nullable().default(null),
  basis: Basis,
  nutrients: NutrientsInput,
  units: z.array(UnitDef).max(10).default([]),
  defaultAmount: Amount.optional(),
  source: FoodSource.refine((s) => s.kind !== "mext_table", {
    message: "composition-table foods are imported, not submitted",
  }),
});
export type FoodSubmission = z.input<typeof FoodSubmission>;

// ---------- recipe (a composite food) ----------

export const Ingredient = z.discriminatedUnion("kind", [
  /** Matched to the master: nutrients are computed, never stored here. */
  z.object({
    kind: z.literal("food"),
    name: z.string().min(1).max(100),
    food: FoodId,
    rev: Rev,
    grams: z.number().positive().max(100_000),
  }),
  /** Nutrients typed in from the recipe source. */
  z.object({
    kind: z.literal("manual"),
    name: z.string().min(1).max(100),
    nutrients: Nutrients,
  }),
  /** Could not be matched: kept for the record, left out of the totals. */
  z.object({
    kind: z.literal("unknown"),
    name: z.string().min(1).max(100),
    amountText: z.string().max(60),
  }),
]);
export type Ingredient = z.infer<typeof Ingredient>;

export const Recipe = z.object({
  id: RecipeId,
  rev: Rev,
  title: z.string().min(1).max(100),
  servings: z.number().positive().max(1000),
  servingsLabel: z.string().max(60).nullable(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("url"), url: z.url({ protocol: /^https?$/ }).max(1000) }),
    z.object({ kind: z.literal("photo") }),
    z.object({ kind: z.literal("manual") }),
  ]),
  ingredients: z.array(Ingredient).min(1).max(100),
  createdAt: Instant,
});
export type Recipe = z.infer<typeof Recipe>;
