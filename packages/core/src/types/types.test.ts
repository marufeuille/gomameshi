// The mistakes an LLM agent actually makes, and what the types do with them.

import { describe, expect, test } from "bun:test";
import { Event, FoodSubmission, Receipt, Submission, View } from "./index";

const FOOD = "mext:11220"; // 鶏むね肉（皮なし）

describe("Submission", () => {
  test("a normal meal passes; rev may be omitted", () => {
    const r = Submission.safeParse({
      type: "meal.logged",
      date: "2026-11-28",
      slot: "lunch",
      items: [{ food: { id: FOOD }, amount: { value: 150, unit: "g" } }],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "meal.logged") expect(r.data.eatingOut).toBe(false);
  });

  test.each([
    ["amount as a string", { value: "150g", unit: "g" }],
    ["zero amount", { value: 0, unit: "g" }],
  ])("rejects %s", (_, amount) => {
    const r = Submission.safeParse({
      type: "meal.logged",
      date: "2026-11-28",
      slot: "lunch",
      items: [{ food: { id: FOOD }, amount }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects a Japanese slot name and a made-up food id", () => {
    const r = Submission.safeParse({
      type: "meal.logged",
      date: "2026-11-28",
      slot: "昼食",
      items: [{ food: { id: "chicken-breast" }, amount: { value: 150, unit: "g" } }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("slot");
      expect(paths).toContain("items.0.food.id");
    }
  });

  test("rejects agent-supplied nutrients on a meal (extra keys are stripped, never trusted)", () => {
    const r = Submission.safeParse({
      type: "meal.logged",
      date: "2026-11-28",
      slot: "lunch",
      items: [{ food: { id: FOOD }, amount: { value: 150, unit: "g" }, kcal: 9999 }],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "meal.logged") expect("kcal" in r.data.items[0]!).toBe(false);
  });

  test("a dish needs at least one counted part", () => {
    const r = Submission.safeParse({
      type: "dish.logged",
      date: "2026-11-28",
      slot: "dinner",
      dishName: "味噌汁",
      originalText: "味噌汁",
      parts: [{ status: "excluded", name: "だし", rationale: "水分" }],
    });
    expect(r.success).toBe(false);
  });

  test("a target change must say why", () => {
    const r = Submission.safeParse({
      type: "target.set",
      effectiveDate: "2026-12-01",
      kcal: 2200,
      proteinG: 120,
      fatG: 60,
      carbsG: 290,
      rationale: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("Event (stored form)", () => {
  test("requires every food reference pinned to a rev", () => {
    const base = {
      schemaVersion: 1,
      eventId: "evt_01JDX0000000000000000000AA",
      agentId: "agt_muse",
      receivedAt: "2026-11-28T12:30:00+09:00",
      clientRef: null,
    };
    const payload = {
      type: "meal.logged",
      date: "2026-11-28",
      slot: "lunch",
      eatingOut: false,
      items: [{ food: { id: FOOD }, amount: { value: 150, unit: "g" } }],
    };
    expect(Event.safeParse({ ...base, payload }).success).toBe(false);
    payload.items[0]!.food = { id: FOOD, rev: 1 } as never;
    expect(Event.safeParse({ ...base, payload }).success).toBe(true);
  });
});

describe("FoodSubmission", () => {
  test("micronutrients not on the label become null, not 0", () => {
    const r = FoodSubmission.safeParse({
      name: "プロテインバー チョコ",
      maker: "Example",
      basis: { type: "serving", label: "1本（45g）あたり", servingGrams: 45 },
      nutrients: { kcal: 190, proteinG: 15, fatG: 8, carbsG: 16 },
      source: { kind: "label", readAt: "2026-11-28T12:00:00+09:00" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.nutrients.saltG).toBeNull();
      expect(r.data.nutrients.vitaminCMg).toBeNull();
    }
  });

  test("there is no 'ai' source: a researched value must cite its page", () => {
    const r = FoodSubmission.safeParse({
      name: "何かのお菓子",
      basis: { type: "per100g" },
      nutrients: { kcal: 500, proteinG: 5, fatG: 25, carbsG: 60 },
      source: { kind: "ai" },
    });
    expect(r.success).toBe(false);
  });
});

describe("Receipt and View", () => {
  test("a rejection carries a typed error with candidates", () => {
    const r = Receipt.safeParse({
      status: "rejected",
      errors: [
        {
          code: "unit_not_defined",
          path: ["items", 0, "amount", "unit"],
          message: "鶏むね肉 has no unit 個",
          hint: "use g, or one of allowedUnits",
          candidates: null,
          allowedUnits: ["g", "枚"],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  test("an event-status view parses", () => {
    const r = View.safeParse({
      kind: "event_status",
      meta: { generatedAt: "2026-11-28T13:00:00+09:00", appliedThrough: null, pendingEventIds: [] },
      events: [{ eventId: "evt_01JDX0000000000000000000AA", status: "applied", appliedAt: "2026-11-28T12:31:00+09:00" }],
    });
    expect(r.success).toBe(true);
  });
});
