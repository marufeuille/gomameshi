// Views: what the phone publishes for agents to read.
//
// The phone computes these from the log and pushes them to the relay;
// the relay only serves the latest copy. Nothing here wakes the phone,
// so nothing here can time out. Every view says how fresh it is.

import { z } from "zod";
import { Amount, EventId, FoodId, Instant, LocalDate, MealSlot, Nutrients, Rev } from "./common";
import { EntryRef } from "./events";

export const ViewMeta = z.object({
  generatedAt: Instant,
  /** receivedAt of the newest event the phone had applied. */
  appliedThrough: Instant.nullable(),
  /** Accepted by the relay but not yet applied by the phone. */
  pendingEventIds: z.array(EventId),
});

const Targets = z.object({
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
});

export const DaySummary = z.object({
  date: LocalDate,
  entryCount: z.number().int(),
  total: Nutrients,
  targets: Targets.nullable(),
  hasEatingOut: z.boolean(),
});

export const DailyView = z.object({
  kind: z.literal("daily"),
  meta: ViewMeta,
  summary: DaySummary,
  entries: z.array(
    z.object({
      ref: EntryRef,
      slot: MealSlot,
      name: z.string(),
      amount: Amount.nullable(),
      nutrients: Nutrients,
      eatingOut: z.boolean(),
    }),
  ),
});

/** Default window: the last 90 days, so most questions need no phone. */
export const RangeView = z.object({
  kind: z.literal("range"),
  meta: ViewMeta,
  from: LocalDate,
  to: LocalDate,
  days: z.array(DaySummary),
  averages: z.object({
    week: Nutrients.nullable(),
    month: Nutrients.nullable(),
  }),
});

/** よく使う組み合わせ, counted from real logs — same for every agent. */
export const FrequentView = z.object({
  kind: z.literal("frequent"),
  meta: ViewMeta,
  foods: z.array(z.object({ id: FoodId, rev: Rev, name: z.string(), count: z.number().int(), usual: Amount })),
  combos: z.array(
    z.object({
      items: z.array(z.object({ id: FoodId, name: z.string(), usual: Amount })).min(2),
      count: z.number().int(),
    }),
  ),
});

export const EventStatusView = z.object({
  kind: z.literal("event_status"),
  meta: ViewMeta,
  events: z.array(
    z.discriminatedUnion("status", [
      z.object({ eventId: EventId, status: z.literal("pending") }),
      z.object({ eventId: EventId, status: z.literal("applied"), appliedAt: Instant }),
      /** The phone's own check failed (e.g. a retracted entry was already gone). */
      z.object({ eventId: EventId, status: z.literal("rejected"), reason: z.string() }),
    ]),
  ),
});

export const View = z.discriminatedUnion("kind", [DailyView, RangeView, FrequentView, EventStatusView]);
export type View = z.infer<typeof View>;
