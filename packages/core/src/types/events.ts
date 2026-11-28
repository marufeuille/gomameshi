// Events: the only way private data changes.
//
// An agent never touches the log. It submits an event; the relay checks
// it against these schemas and the master, seals it, and the phone
// applies it. Corrections are events too (retract, then log again), so
// the log is a plain replay of its events.
//
// Two layers:
// - *Submission: what an agent may send. Lenient where that is safe
//   (rev may be omitted — the relay pins the current one).
// - *Event: what is stored and replayed. Strict: every food reference is
//   pinned to a rev, and envelope fields come from the relay, not the agent.

import { z } from "zod";
import {
  AgentId,
  Amount,
  EventId,
  FoodId,
  Instant,
  LocalDate,
  MealSlot,
  RecipeId,
  Rev,
} from "./common";

const FoodRefIn = z.object({ id: FoodId, rev: Rev.optional() });
const FoodRef = z.object({ id: FoodId, rev: Rev });
const RecipeRefIn = z.object({ id: RecipeId, rev: Rev.optional() });
const RecipeRef = z.object({ id: RecipeId, rev: Rev });

/** One logged entry: an event, plus an item index for multi-item meals. */
export const EntryRef = z.object({
  eventId: EventId,
  item: z.number().int().min(0).max(19).nullable(),
});
export type EntryRef = z.infer<typeof EntryRef>;

// ---------- payloads, as submitted ----------

const MealItemIn = z.object({ food: FoodRefIn, amount: Amount });

export const MealLoggedIn = z.object({
  type: z.literal("meal.logged"),
  date: LocalDate,
  slot: MealSlot,
  eatingOut: z.boolean().default(false),
  /** One meal = one event, so a meal is applied or rejected as a whole. */
  items: z.array(MealItemIn).min(1).max(20),
  note: z.string().max(200).optional(),
});

/** A dish broken into parts (今の logAssistParts). Logged as one entry. */
export const DishLoggedIn = z.object({
  type: z.literal("dish.logged"),
  date: LocalDate,
  slot: MealSlot,
  eatingOut: z.boolean().default(false),
  dishName: z.string().min(1).max(100),
  /** What the user said, kept so a wrong breakdown can be traced. */
  originalText: z.string().min(1).max(200),
  parts: z
    .array(
      z.discriminatedUnion("status", [
        z.object({
          status: z.literal("counted"),
          name: z.string().min(1).max(60),
          food: FoodRefIn,
          grams: z.number().positive().max(100_000),
          rationale: z.string().max(300),
        }),
        /** e.g. だし・水: present in the dish, no nutrients counted. */
        z.object({ status: z.literal("excluded"), name: z.string().min(1).max(60), rationale: z.string().max(300) }),
        /** No master food fits: recorded, not counted, shown to the user. */
        z.object({ status: z.literal("unmatched"), name: z.string().min(1).max(60), rationale: z.string().max(300) }),
      ]),
    )
    .min(1)
    .max(12)
    .refine((ps) => ps.some((p) => p.status === "counted"), {
      message: "at least one part must be counted",
    }),
});

export const RecipeEatenIn = z.object({
  type: z.literal("recipe.eaten"),
  date: LocalDate,
  slot: MealSlot,
  eatingOut: z.boolean().default(false),
  recipe: RecipeRefIn,
  servings: z.number().positive().max(100),
});

export const EntryRetractedIn = z.object({
  type: z.literal("entry.retracted"),
  target: EntryRef,
  reason: z.string().max(200).optional(),
});

export const TargetSetIn = z.object({
  type: z.literal("target.set"),
  effectiveDate: LocalDate,
  kcal: z.number().positive().max(20_000),
  proteinG: z.number().positive().max(2000),
  fatG: z.number().positive().max(2000),
  carbsG: z.number().positive().max(2000),
  /** 根拠: which guideline, which inputs. Required, never silent. */
  rationale: z.string().min(1).max(500),
});

export const Submission = z.discriminatedUnion("type", [
  MealLoggedIn,
  DishLoggedIn,
  RecipeEatenIn,
  EntryRetractedIn,
  TargetSetIn,
]);
export type Submission = z.input<typeof Submission>;
export type ParsedSubmission = z.output<typeof Submission>;

// ---------- payloads, as stored (refs pinned) ----------

export const MealLogged = MealLoggedIn.extend({
  items: z.array(z.object({ food: FoodRef, amount: Amount })).min(1).max(20),
});

export const DishLogged = DishLoggedIn.extend({
  parts: z
    .array(
      z.discriminatedUnion("status", [
        z.object({
          status: z.literal("counted"),
          name: z.string(),
          food: FoodRef,
          grams: z.number().positive(),
          rationale: z.string(),
        }),
        z.object({ status: z.literal("excluded"), name: z.string(), rationale: z.string() }),
        z.object({ status: z.literal("unmatched"), name: z.string(), rationale: z.string() }),
      ]),
    )
    .min(1),
});

export const RecipeEaten = RecipeEatenIn.extend({ recipe: RecipeRef });

export const Payload = z.discriminatedUnion("type", [
  MealLogged,
  DishLogged,
  RecipeEaten,
  EntryRetractedIn,
  TargetSetIn,
]);
export type Payload = z.infer<typeof Payload>;

/** What the phone replays. Envelope fields are set by the relay. */
export const Event = z.object({
  schemaVersion: z.literal(1),
  eventId: EventId,
  agentId: AgentId,
  receivedAt: Instant,
  /** Optional dedupe key from the agent: a retried submit is a no-op. */
  clientRef: z.string().max(64).nullable(),
  payload: Payload,
});
export type Event = z.infer<typeof Event>;
