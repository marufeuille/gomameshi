// What a submit returns, synchronously, from the relay.
//
// The relay can resolve every food against the public master and run the
// same core calculation the phone will run, so the agent hears back at
// once — no waiting on the phone. Two outcomes:
// - accepted: the event is sealed and queued. `echo` restates what will be
//   recorded in resolved names and numbers; the agent must show it to the
//   user so a misheard food (レタッチ → ロレッタ) is caught by a person.
// - rejected: nothing was queued. Each error is typed, points at the field,
//   and where useful carries candidates the agent can retry with.

import { z } from "zod";
import { EventId, FoodId, MealSlot, LocalDate, Nutrients, Rev } from "./common";

export const PreviewLine = z.object({
  name: z.string(),
  food: z.object({ id: FoodId, rev: Rev }).nullable(),
  grams: z.number().nullable(),
  nutrients: Nutrients.nullable(), // null for excluded / unmatched parts
});

export const Accepted = z.object({
  status: z.literal("accepted"),
  eventId: EventId,
  /** The phone applies it later; check event_status in the views. */
  appliedBy: z.literal("phone"),
  preview: z
    .object({
      date: LocalDate,
      slot: MealSlot,
      lines: z.array(PreviewLine),
      total: Nutrients,
    })
    .nullable(), // null for retractions and target changes
  /** One sentence for the user, e.g. "昼食に 鶏むね肉（皮なし）150g ほか2品、計 412 kcal を記録します". */
  echo: z.string(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});

export const ErrorCode = z.enum([
  "schema", //            shape or range is wrong; see path
  "unknown_food", //      no such food id; candidates suggested by name
  "unknown_rev", //       that revision does not exist
  "unit_not_defined", //  the food has no such unit; allowed units listed
  "basis_mismatch", //    e.g. "serving" on a per100g food without servingGrams
  "date_out_of_range", // more than one day ahead, or implausibly old
  "unknown_entry", //     retraction target not found
  "duplicate", //         clientRef already used; the original eventId is returned
  "unauthorized", //      this agent's token may not submit this type
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const SubmitError = z.object({
  code: ErrorCode,
  /** JSON path into the submission, e.g. ["items", 1, "amount", "unit"]. */
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  /** Concrete next step for the agent. */
  hint: z.string().nullable(),
  candidates: z
    .array(z.object({ id: FoodId, rev: Rev, name: z.string() }))
    .max(5)
    .nullable(),
  allowedUnits: z.array(z.string()).nullable(),
});
export type SubmitError = z.infer<typeof SubmitError>;

export const Rejected = z.object({
  status: z.literal("rejected"),
  errors: z.array(SubmitError).min(1),
});

export const Receipt = z.discriminatedUnion("status", [Accepted, Rejected]);
export type Receipt = z.infer<typeof Receipt>;
