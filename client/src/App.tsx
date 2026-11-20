// 食事とPFC — meal log with a food master.
// Views: 記録 (a day's label-style summary + logs + quick add),
// 履歴 (last 14 days), 消費 (consumption pace of selected foods,
// in grams, for shopping), 食品 (food master, label-photo
// registration), 設定 (daily targets). All nutrient numbers render
// from server data.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Food = ApiResponse<typeof api, "listFoods">["foods"][number];
type Research = ApiResponse<typeof api, "listResearch">["records"][number];
type DeepJob =
  ApiResponse<typeof api, "listDeepFoodResearchJobs">["jobs"][number];
type ResearchDraft = NonNullable<DeepJob["draft"]>;
type ResearchDraftNotice =
  ApiResponse<typeof api, "listUnregisteredResearchDrafts">["drafts"][number];
type Recipe = ApiResponse<typeof api, "listRecipes">["recipes"][number];
type Ingredient = Recipe["ingredients"][number];
type Settings = ApiResponse<typeof api, "getSettings">;
type Slot = "breakfast" | "lunch" | "dinner" | "snack";
type Tab = "today" | "history" | "pace" | "recipes" | "foods" | "settings";

const SLOTS: Array<{ key: Slot; label: string }> = [
  { key: "breakfast", label: "朝食" },
  { key: "lunch", label: "昼食" },
  { key: "dinner", label: "夕食" },
  { key: "snack", label: "間食" },
];

// ---------- date helpers (Asia/Tokyo calendar dates) ----------

function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, n: number): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function formatDateJa(date: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const dow = ["日", "月", "火", "水", "木", "金", "土"][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  return `${m}月${d}日（${dow}）`;
}

function defaultSlot(): Slot {
  const h = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date()),
  );
  if (h < 10) return "breakfast";
  if (h < 14) return "lunch";
  if (h < 17) return "snack";
  return "dinner";
}

// ---------- number helpers ----------

const fmt = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);

/** Elapsed time for long background work: 45秒 / 1分15秒. */
function fmtElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

// ---------- micronutrients （微量栄養素） ----------
// The 12 nullable fields that ride alongside PFC + salt. Unknown is
// null everywhere; totals sum only the known values and the UI labels
// them as such （判明分のみの合計）.

const MICRO_FIELDS = [
  { key: "fiberG", label: "食物繊維", unit: "g" },
  { key: "potassiumMg", label: "カリウム", unit: "mg" },
  { key: "calciumMg", label: "カルシウム", unit: "mg" },
  { key: "magnesiumMg", label: "マグネシウム", unit: "mg" },
  { key: "ironMg", label: "鉄", unit: "mg" },
  { key: "vitaminDMcg", label: "ビタミンD", unit: "µg" },
  { key: "vitaminB1Mg", label: "ビタミンB1", unit: "mg" },
  { key: "vitaminB2Mg", label: "ビタミンB2", unit: "mg" },
  { key: "vitaminB6Mg", label: "ビタミンB6", unit: "mg" },
  { key: "vitaminB12Mcg", label: "ビタミンB12", unit: "µg" },
  { key: "folateMcg", label: "葉酸", unit: "µg" },
  { key: "vitaminCMg", label: "ビタミンC", unit: "mg" },
] as const;
type MicroKey = (typeof MICRO_FIELDS)[number]["key"];
type MicroMap = Record<MicroKey, number | null>;

const emptyMicros = (): MicroMap => ({
  fiberG: null,
  potassiumMg: null,
  calciumMg: null,
  magnesiumMg: null,
  ironMg: null,
  vitaminDMcg: null,
  vitaminB1Mg: null,
  vitaminB2Mg: null,
  vitaminB6Mg: null,
  vitaminB12Mcg: null,
  folateMcg: null,
  vitaminCMg: null,
});

/** Display rounding per nutrient (mirrors the server). */
function roundMicro(key: MicroKey, v: number): number {
  if (key === "fiberG" || key === "vitaminDMcg" || key === "vitaminB12Mcg")
    return Math.round(v * 10) / 10;
  if (
    key === "potassiumMg" ||
    key === "calciumMg" ||
    key === "magnesiumMg" ||
    key === "folateMcg" ||
    key === "vitaminCMg"
  )
    return Math.round(v);
  return Math.round(v * 100) / 100;
}

const fmtMicro = (v: number): string => String(Math.round(v * 100) / 100);

/** "食物繊維 2.8g · 葉酸 210µg" for the known values only; "" when none. */
function microText(src: MicroMap): string {
  return MICRO_FIELDS.filter((f) => src[f.key] != null)
    .map((f) => `${f.label} ${fmtMicro(src[f.key] as number)}${f.unit}`)
    .join(" · ");
}

function hasMicros(src: MicroMap): boolean {
  return MICRO_FIELDS.some((f) => src[f.key] != null);
}

/** Sum known values per nutrient across rows; null when none known. */
function sumMicros(rows: MicroMap[]): MicroMap {
  const out = emptyMicros();
  for (const f of MICRO_FIELDS) {
    let sum = 0;
    let known = false;
    for (const r of rows) {
      const v = r[f.key];
      if (v != null) {
        sum += v;
        known = true;
      }
    }
    out[f.key] = known ? roundMicro(f.key, sum) : null;
  }
  return out;
}

function scaleMicros(src: MicroMap, k: number): MicroMap {
  const out = emptyMicros();
  for (const f of MICRO_FIELDS) {
    const v = src[f.key];
    out[f.key] = v == null ? null : roundMicro(f.key, v * k);
  }
  return out;
}

type Nutrients = {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  saltG: number | null;
} & MicroMap;

/** Mirror of the server-side scaling, for the picker's live preview. */
function previewNutrients(food: Food, quantity: number, unit: string): Nutrients | null {
  let k: number;
  if (food.basisType === "per100g") {
    if (unit === "g") k = quantity / 100;
    else if (food.unitGrams != null) k = (quantity * food.unitGrams) / 100;
    else return null;
  } else {
    if (unit === "g") {
      if (food.unitGrams == null) return null;
      k = quantity / food.unitGrams;
    } else k = quantity;
  }
  return {
    kcal: Math.round(food.kcal * k),
    proteinG: Math.round(food.proteinG * k * 10) / 10,
    fatG: Math.round(food.fatG * k * 10) / 10,
    carbsG: Math.round(food.carbsG * k * 10) / 10,
    saltG: food.saltG == null ? null : Math.round(food.saltG * k * 100) / 100,
    ...scaleMicros(food, k),
  };
}

function unitOptions(food: Food): string[] {
  const opts = [food.defaultUnit];
  if (food.unitGrams != null && food.defaultUnit !== "g") opts.push("g");
  return opts;
}

// ---------- small pieces ----------

function PfcRow({
  label,
  value,
  target,
  color,
}: {
  label: string;
  value: number;
  target: number | null;
  color: string;
}) {
  const pct = target != null && target > 0 ? Math.min(100, (value / target) * 100) : null;
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm text-[var(--text)]">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: color }}
          />
          {label}
        </span>
        <span className="num text-base text-[var(--text)]">
          {fmt(value)}
          <span className="ml-0.5 text-xs text-[var(--dim)]">g</span>
          {target != null && (
            <span className="ml-2 text-xs text-[var(--dim)]">目標 {fmt(target)}g</span>
          )}
        </span>
      </div>
      {pct != null && (
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} 目標進捗`}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, backgroundColor: color }}
          />
        </div>
      )}
    </div>
  );
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center">
      <button
        aria-label="閉じる"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-2xl bg-[var(--surface)] shadow-xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
          <button
            aria-label="閉じる"
            onClick={onClose}
            className="px-2 text-xl leading-none text-[var(--dim)]"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-3 pb-safe">{children}</div>
      </div>
    </div>
  );
}

/**
 * One-tap 外食 toggle. In the recording flow it reads as a setting for the
 * entry being logged; on a logged entry it flips the stored flag. On
 * means the entry was eaten out — the day then counts as containing an
 * estimated meal.
 */
function EatingOutToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        on
          ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
          : "border-[var(--border)] text-[var(--dim)]"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-2 w-2 rounded-full ${
          on ? "bg-white" : "bg-[var(--border)]"
        }`}
      />
      外食
    </button>
  );
}

// ---------- food picker (quick add) ----------

function FoodPicker({
  date,
  initialSlot,
  onClose,
  onAddFood,
  onAddBlend,
  pickFoodId,
  onPickHandled,
}: {
  date: string;
  initialSlot: Slot;
  onClose: () => void;
  onAddFood: (prefillName: string) => void;
  onAddBlend: (prefillName: string) => void;
  // A food just registered from this picker (or chosen via the form's
  // "use existing" path): select it straight away so registration flows
  // into recording without hunting through the master again.
  pickFoodId: number | null;
  onPickHandled: () => void;
}) {
  const queryClient = useQueryClient();
  const [slot, setSlot] = useState<Slot>(initialSlot);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Food | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [recipeAmount, setRecipeAmount] = useState("1");
  const [eatingOut, setEatingOut] = useState(false);
  const search = useFoodSearch(query, 50);

  // Saved recipes are recordable from here too — the picker is where
  // meals get logged, so a recipe that only exists in the レシピ tab
  // reads as "registered but unusable" at recording time.
  const recipesQuery = useQuery({
    queryKey: ["recipes"],
    queryFn: () => api.listRecipes({}),
  });
  const allRecipes = recipesQuery.data?.recipes ?? [];
  const nq = query.replace(/[\s　]+/g, "").toLowerCase();
  const visibleRecipes =
    nq === ""
      ? allRecipes
      : allRecipes.filter((r) =>
          r.title.replace(/[\s　]+/g, "").toLowerCase().includes(nq),
        );

  const logMutation = useMutation({
    mutationFn: (args: { foodId: number; quantity: number; unit: string }) =>
      api.logMeal({ date, slot, eatingOut, ...args }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      onClose();
    },
  });

  const recipeLogMutation = useMutation({
    mutationFn: (args: { recipeId: number; amount: number }) =>
      api.logRecipe({ date, slot, eatingOut, ...args }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      onClose();
    },
  });

  // ---------- AIアシスト記録 ----------
  // For variations with no exact master entry: the AI proposes a base
  // food + conversion from the master (nothing is registered), the user
  // edits the effective grams / factor, and only the explicit record
  // button logs it — via logMeal with an assist note.
  type AssistResult = ApiResponse<typeof api, "assistMealInput">;
  // Decomposition （分解モード） part, as editable local state: grams
  // stay a string while typed; the matched food can be swapped with
  // one of its alternatives or the part removed entirely.
  type AssistPartState = {
    partName: string;
    rationale: string;
    grams: string;
    food: Food | null;
    alternatives: Food[];
    status: "counted" | "excluded" | "unmatched";
  };
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistText, setAssistText] = useState("");
  const [assistResult, setAssistResult] = useState<AssistResult | null>(null);
  const [assistBase, setAssistBase] = useState<Food | null>(null);
  const [assistAlts, setAssistAlts] = useState<Food[]>([]);
  const [assistFactor, setAssistFactor] = useState("");
  const [assistEffective, setAssistEffective] = useState("");
  const [assistDish, setAssistDish] = useState("");
  const [assistParts, setAssistParts] = useState<AssistPartState[]>([]);
  // Failure of the latest assist run, kept as local state (not the
  // mutation's) so a cancelled run's late failure cannot surface it —
  // see the generation guard on assistMutation below.
  const [assistError, setAssistError] = useState<string | null>(null);

  // Run generation for the assist request, same guard as the food
  // form's parseRunRef / lookupRunRef: mutation.reset() alone does NOT
  // cancel — the in-flight request still settles later and its
  // onSuccess would resurrect the proposal card the user already
  // cancelled. Each start bumps the generation; キャンセル bumps it
  // again and resets the mutation, so a late result whose generation
  // no longer matches touches neither the draft nor the card.
  const assistRunRef = useRef(0);

  const assistMutation = useMutation({
    mutationFn: async (text: string) => {
      const run = ++assistRunRef.current;
      try {
        const res = await api.assistMealInput({ text });
        return { run, res, error: null as string | null };
      } catch (e) {
        return {
          run,
          res: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
    onSuccess: (out) => {
      // Cancelled or superseded while in flight: drop the late result.
      if (out.run !== assistRunRef.current) return;
      if (out.error || !out.res) {
        setAssistError(out.error ?? "換算案を作れませんでした");
        return;
      }
      const res = out.res;
      setAssistResult(res);
      setAssistBase(res.base);
      setAssistAlts(res.alternatives);
      setAssistFactor(res.factor != null ? String(res.factor) : "");
      setAssistEffective(
        res.effectiveGrams != null ? String(res.effectiveGrams) : "",
      );
      setAssistDish(res.dishName);
      setAssistParts(
        res.parts.map((p) => ({
          partName: p.partName,
          rationale: p.rationale,
          grams: p.grams != null ? String(p.grams) : "",
          food: p.food,
          alternatives: p.alternatives,
          status: p.status,
        })),
      );
    },
  });

  const startAssist = () => {
    setAssistError(null);
    assistMutation.mutate(assistText.trim());
  };

  const cancelAssist = () => {
    // Invalidate the in-flight run, then reset the mutation: the UI
    // frees immediately and the late result is dropped by the
    // generation check in onSuccess.
    assistRunRef.current += 1;
    assistMutation.reset();
    setAssistError(null);
  };

  const assistPartsLogMutation = useMutation({
    mutationFn: (args: {
      dishName: string;
      originalText: string;
      rationale: string;
      parts: Array<{
        partName: string;
        foodId: number | null;
        grams: number | null;
        rationale: string;
        status: "counted" | "excluded" | "unmatched";
      }>;
    }) => api.logAssistParts({ date, slot, eatingOut, ...args }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      onClose();
    },
  });

  const assistLogMutation = useMutation({
    mutationFn: (args: {
      foodId: number;
      quantity: number;
      unit: string;
      assistNote: {
        originalText: string;
        baseFoodName: string;
        factor: number | null;
        rationale: string;
      };
    }) => api.logMeal({ date, slot, eatingOut, ...args }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      onClose();
    },
  });

  const openAssist = () => {
    setAssistText(query.trim());
    setAssistResult(null);
    setAssistError(null);
    setAssistBase(null);
    setAssistAlts([]);
    setAssistFactor("");
    setAssistEffective("");
    setAssistDish("");
    setAssistParts([]);
    setAssistOpen(true);
  };

  const assistInputGrams = assistResult?.inputGrams ?? null;
  const assistElapsed = useElapsed(assistMutation.isPending);
  const assistEffNum = Number(assistEffective);
  const assistEffValid =
    assistEffective.trim() !== "" &&
    Number.isFinite(assistEffNum) &&
    assistEffNum > 0;
  const assistPreview =
    assistBase && assistEffValid
      ? previewNutrients(assistBase, assistEffNum, "g")
      : null;
  const assistFactorNum = (() => {
    const v = Number(assistFactor);
    return assistFactor.trim() !== "" && Number.isFinite(v) && v > 0
      ? v
      : null;
  })();

  const onAssistEffectiveChange = (v: string) => {
    setAssistEffective(v);
    const eff = Number(v);
    if (assistInputGrams != null && Number.isFinite(eff) && eff > 0) {
      setAssistFactor(
        String(Math.round((eff / assistInputGrams) * 1000) / 1000),
      );
    }
  };
  const onAssistFactorChange = (v: string) => {
    setAssistFactor(v);
    const f = Number(v);
    if (assistInputGrams != null && Number.isFinite(f) && f > 0) {
      setAssistEffective(String(Math.round(assistInputGrams * f * 10) / 10));
    }
  };
  const swapAssistBase = (alt: Food) => {
    if (!assistBase) return;
    setAssistAlts([
      assistBase,
      ...assistAlts.filter((a) => a.id !== alt.id),
    ]);
    setAssistBase(alt);
  };

  // ---------- 分解モードの部品編集 ----------
  // A part counts toward the totals only when it has a matched food,
  // a valid gram amount, and that food converts to grams — the same
  // rule the server applies in logAssistParts (the preview mirrors
  // it; the server recomputes authoritatively at log time).
  const partPreview = (p: AssistPartState): Nutrients | null => {
    if (!p.food) return null;
    const g = Number(p.grams);
    if (p.grams.trim() === "" || !Number.isFinite(g) || g <= 0) return null;
    return previewNutrients(p.food, g, "g");
  };
  const partIsCounted = (p: AssistPartState): boolean =>
    partPreview(p) != null;
  const assistPartPreviews = assistParts.map(partPreview);
  const assistCountedPreviews = assistPartPreviews.filter(
    (n): n is Nutrients => n != null,
  );
  const assistTotals: Nutrients | null =
    assistCountedPreviews.length > 0
      ? {
          kcal: assistCountedPreviews.reduce((s, n) => s + n.kcal, 0),
          proteinG:
            Math.round(
              assistCountedPreviews.reduce((s, n) => s + n.proteinG, 0) * 10,
            ) / 10,
          fatG:
            Math.round(
              assistCountedPreviews.reduce((s, n) => s + n.fatG, 0) * 10,
            ) / 10,
          carbsG:
            Math.round(
              assistCountedPreviews.reduce((s, n) => s + n.carbsG, 0) * 10,
            ) / 10,
          saltG: assistCountedPreviews.some((n) => n.saltG != null)
            ? Math.round(
                assistCountedPreviews.reduce(
                  (s, n) => s + (n.saltG ?? 0),
                  0,
                ) * 100,
              ) / 100
            : null,
          ...sumMicros(assistCountedPreviews),
        }
      : null;
  const assistUncounted = assistParts.filter((p) => !partIsCounted(p));

  const setPartGrams = (i: number, v: string) =>
    setAssistParts((prev) =>
      prev.map((p, j) => (j === i ? { ...p, grams: v } : p)),
    );
  const removePart = (i: number) =>
    setAssistParts((prev) => prev.filter((_, j) => j !== i));
  const swapPartFood = (i: number, alt: Food) =>
    setAssistParts((prev) =>
      prev.map((p, j) => {
        if (j !== i || !p.food) return p;
        return {
          ...p,
          food: alt,
          alternatives: [
            p.food,
            ...p.alternatives.filter((a) => a.id !== alt.id),
          ],
        };
      }),
    );

  const logAssistParts = () => {
    if (!assistResult || assistDish.trim() === "") return;
    assistPartsLogMutation.mutate({
      dishName: assistDish.trim(),
      originalText: assistResult.originalText,
      rationale: assistResult.rationale,
      parts: assistParts.map((p) => {
        const g = Number(p.grams);
        const gramsValid =
          p.grams.trim() !== "" && Number.isFinite(g) && g > 0;
        const counted = partIsCounted(p);
        return {
          partName: p.partName,
          foodId: p.food?.id ?? null,
          grams: gramsValid ? g : null,
          rationale: p.rationale,
          status: counted
            ? ("counted" as const)
            : p.food == null && p.status === "excluded"
              ? ("excluded" as const)
              : p.food != null
                ? ("excluded" as const)
                : ("unmatched" as const),
        };
      }),
    });
  };

  const pick = (food: Food) => {
    setSelected(food);
    setSelectedRecipe(null);
    setQuantity(String(food.defaultAmount));
    setUnit(food.defaultUnit);
    setEatingOut(false);
  };

  const pickRecipe = (recipe: Recipe) => {
    setSelectedRecipe(recipe);
    setSelected(null);
    setRecipeAmount("1");
    setEatingOut(false);
  };

  useEffect(() => {
    if (pickFoodId == null) return;
    let cancelled = false;
    api
      .getFoodsByIds({ ids: [pickFoodId] })
      .then((res) => {
        const f = res.foods[0];
        if (!cancelled && f) pick(f);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) onPickHandled();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickFoodId]);

  const qtyNum = Number(quantity);
  const preview =
    selected && Number.isFinite(qtyNum) && qtyNum > 0
      ? previewNutrients(selected, qtyNum, unit)
      : null;

  const recipeAmountNum = Number(recipeAmount);
  const recipePer = selectedRecipe?.perServing ?? null;
  const recipeCanLog =
    selectedRecipe != null &&
    recipePer != null &&
    Number.isFinite(recipeAmountNum) &&
    recipeAmountNum > 0;

  const visible = search.data?.foods ?? [];
  const searchTotal = search.data?.total ?? 0;
  // The AI-assist entry only appears when the search has no exact match
  // — when the food itself is right there, plain logging is the path.
  const nqFull = query.replace(/[\s　（）()]/g, "").toLowerCase();
  const hasExactMatch =
    nqFull !== "" &&
    visible.some(
      (f) => f.name.replace(/[\s　（）()]/g, "").toLowerCase() === nqFull,
    );

  return (
    <Sheet title="食事を記録" onClose={onClose}>
      <div className="mb-3 flex gap-1" role="group" aria-label="食事の区分">
        {SLOTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSlot(s.key)}
            aria-pressed={slot === s.key}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
              slot === s.key
                ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
                : "border-[var(--border)] text-[var(--text)]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {assistOpen ? (
        <div>
          <button
            onClick={() => setAssistOpen(false)}
            className="mb-2 text-sm text-[var(--accent)]"
          >
            ← 検索に戻る
          </button>
          <p className="mb-3 text-sm text-[var(--dim)]">
            マスタに無いバリエーションを、近い食品を基準にAIが換算して記録します。単一の基準が無い料理は、材料に分解した案を出します。マスタには追加されません。
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--dim)]">
              食べたものの説明と量
            </span>
            <textarea
              aria-label="食べたものの説明と量"
              value={assistText}
              onChange={(e) => setAssistText(e.target.value)}
              rows={2}
              placeholder="例：焼き芋 皮つき 200g"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              disabled={assistText.trim() === "" || assistMutation.isPending}
              onClick={startAssist}
              className="flex-1 rounded-lg bg-[var(--accent)] py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {assistMutation.isPending
                ? `AIが換算案を考え中… ${assistElapsed}秒`
                : "AIに換算案を作ってもらう"}
            </button>
            {assistMutation.isPending && (
              <button
                onClick={cancelAssist}
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--dim)]"
              >
                キャンセル
              </button>
            )}
          </div>
          {assistMutation.isPending && (
            <AiWait
              elapsed={assistElapsed}
              stages={[
                { fromSec: 0, text: "入力を読み取っています" },
                { fromSec: 6, text: "マスタから近い食品を探しています" },
                {
                  fromSec: 12,
                  text: "基準食品の選定と、材料への分解を並行して試しています",
                },
              ]}
              typical="読み取りのあと選定と分解を並行して進めるため、通常は15〜30秒前後かかります。一度うまくいった入力は保存され、次回からはすぐ表示されます"
              longText="通常より時間がかかっています。そのまま待つか、キャンセルして入力を変えてやり直せます。"
            />
          )}
          {assistError && (
            <div className="mt-2">
              <p className="text-sm text-[var(--accent)]">
                換算案を作れませんでした：{assistError}
              </p>
              <button
                onClick={startAssist}
                className="mt-2 w-full rounded-lg border border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
              >
                もう一度試す
              </button>
            </div>
          )}

          {assistResult?.status === "none" && (
            <div className="mt-3 rounded-lg border border-[var(--border)] p-3">
              <p className="text-sm font-semibold text-[var(--text)]">
                記録案を作れませんでした
              </p>
              {assistResult.rationale !== "" && (
                <p className="mt-1 text-xs text-[var(--dim)]">
                  {assistResult.rationale}
                </p>
              )}
              <p className="mt-2 text-xs text-[var(--dim)]">
                換算の基準にできる食品も、材料への分解もできなかったため、このままでは記録できません。食品そのものを登録すると記録できるようになります。
              </p>
              <button
                onClick={startAssist}
                className="mt-3 w-full rounded-lg border border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
              >
                もう一度試す
              </button>
              <button
                onClick={() => onAddFood(assistText.trim())}
                className="mt-3 w-full rounded-lg border border-dashed border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
              >
                AIで調べて食品を登録する
              </button>
              <button
                onClick={() => onAddBlend(assistText.trim())}
                className="mt-2 w-full rounded-lg border border-dashed border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
              >
                部品を組み合わせて配合食品を作る（成分表から計算）
              </button>
            </div>
          )}

          {assistResult?.status === "ok" && assistBase && (
            <div className="mt-3 rounded-lg border border-[var(--border)] p-3">
              <p className="text-xs text-[var(--dim)]">元の入力</p>
              <p className="text-base text-[var(--text)]">
                {assistResult.originalText}
              </p>

              <p className="mt-3 text-xs text-[var(--dim)]">
                基準食品（この食品のマスタ値で計算します）
              </p>
              <p className="text-base font-semibold text-[var(--text)]">
                {assistBase.name}
              </p>
              <p className="num text-xs text-[var(--dim)]">
                {SOURCE_LABEL[assistBase.source]} · {assistBase.basisLabel} ·{" "}
                {fmt(assistBase.kcal)} kcal · P{fmt(assistBase.proteinG)} F
                {fmt(assistBase.fatG)} C{fmt(assistBase.carbsG)}
                {assistBase.saltG != null &&
                  ` · 食塩 ${fmt(assistBase.saltG)}g`}
              </p>
              {assistAlts.length > 0 && (
                <div className="mt-2">
                  <p className="mb-1 text-xs text-[var(--dim)]">
                    他の候補に切り替え
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {assistAlts.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => swapAssistBase(a)}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)]"
                      >
                        {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-3 text-xs text-[var(--dim)]">量の読み取り</p>
              <p className="num text-sm text-[var(--text)]">
                {assistResult.amountText !== ""
                  ? assistResult.amountText
                  : "量の指定なし"}
                {assistResult.inputGrams != null &&
                  ` → ${fmt(assistResult.inputGrams)}g`}
              </p>
              {assistResult.amountAssumption !== "" && (
                <p className="text-xs text-[var(--dim)]">
                  前提：{assistResult.amountAssumption}
                </p>
              )}
              {assistResult.inputGrams == null && (
                <p className="text-xs text-[var(--accent)]">
                  量が読み取れませんでした。実効グラムを直接入力してください。
                </p>
              )}

              <div className="mt-3 flex items-end gap-1.5">
                <div className="flex-1">
                  <span className="mb-1 block text-center text-xs text-[var(--dim)]">
                    入力
                  </span>
                  <p className="num rounded-lg bg-[var(--bg)] px-2 py-2 text-center text-base text-[var(--text)]">
                    {assistResult.inputGrams != null
                      ? `${fmt(assistResult.inputGrams)}g`
                      : "—"}
                  </p>
                </div>
                <span className="pb-2 text-[var(--dim)]">×</span>
                <label className="flex-1">
                  <span className="mb-1 block text-center text-xs text-[var(--dim)]">
                    係数（推定）
                  </span>
                  <input
                    aria-label="換算係数"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={assistFactor}
                    disabled={assistResult.inputGrams == null}
                    onChange={(e) => onAssistFactorChange(e.target.value)}
                    className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-center text-base text-[var(--text)] disabled:opacity-40"
                  />
                </label>
                <span className="pb-2 text-[var(--dim)]">＝</span>
                <label className="flex-1">
                  <span className="mb-1 block text-center text-xs text-[var(--dim)]">
                    実効グラム
                  </span>
                  <input
                    aria-label="実効グラム"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={assistEffective}
                    onChange={(e) => onAssistEffectiveChange(e.target.value)}
                    className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-2 text-center text-base text-[var(--text)]"
                  />
                </label>
              </div>
              {assistResult.rationale !== "" && (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  根拠：{assistResult.rationale}
                </p>
              )}
              <p className="text-xs text-[var(--dim)]">
                係数はAIの推定です。実物に合わせて直せます。
              </p>

              {assistPreview ? (
                <p className="num mt-3 text-sm text-[var(--dim)]">
                  記録される値：{assistPreview.kcal} kcal · P
                  {fmt(assistPreview.proteinG)} F{fmt(assistPreview.fatG)} C
                  {fmt(assistPreview.carbsG)}
                  {assistPreview.saltG != null &&
                    ` · 食塩 ${fmt(assistPreview.saltG)}g`}
                </p>
              ) : assistEffValid ? (
                <p className="mt-3 text-sm text-[var(--accent)]">
                  この基準食品はグラム換算できないため記録できません（1単位のグラム数が未設定です）。他の候補に切り替えてください。
                </p>
              ) : (
                <p className="mt-3 text-sm text-[var(--dim)]">
                  実効グラムを入力すると、記録される値が表示されます。
                </p>
              )}
              {assistPreview && hasMicros(assistPreview) && (
                <p className="num mt-1 text-xs text-[var(--dim)]">
                  {microText(assistPreview)}
                </p>
              )}
              <div className="mt-3 flex items-center gap-2">
                <EatingOutToggle
                  on={eatingOut}
                  onChange={setEatingOut}
                  label={`${assistResult.originalText}を外食として記録する`}
                />
                <span className="text-xs text-[var(--dim)]">
                  外食のときはオン（推定の目印になります）
                </span>
              </div>
              {assistLogMutation.error && (
                <p className="mt-2 text-sm text-[var(--accent)]">
                  記録できませんでした：{String(assistLogMutation.error)}
                </p>
              )}
              <button
                disabled={!assistPreview || assistLogMutation.isPending}
                onClick={() =>
                  assistLogMutation.mutate({
                    foodId: assistBase.id,
                    quantity: assistEffNum,
                    unit: "g",
                    assistNote: {
                      originalText: assistResult.originalText,
                      baseFoodName: assistBase.name,
                      factor:
                        assistResult.inputGrams != null
                          ? assistFactorNum
                          : null,
                      rationale: assistResult.rationale,
                    },
                  })
                }
                className="mt-4 w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
              >
                {assistLogMutation.isPending
                  ? "記録中…"
                  : "この内容で記録する"}
              </button>
            </div>
          )}

          {assistResult?.status === "decomposed" && (
            <div className="mt-3 rounded-lg border border-[var(--border)] p-3">
              <p className="text-xs text-[var(--dim)]">元の入力</p>
              <p className="text-base text-[var(--text)]">
                {assistResult.originalText}
              </p>
              <p className="mt-1 text-xs text-[var(--dim)]">
                単一の基準食品が無いため、材料への分解案です。各部品の栄養値はマスタ値×グラムで計算します。グラムはAIの推定で、直せます。
              </p>

              <label className="mt-3 block">
                <span className="mb-1 block text-xs text-[var(--dim)]">
                  料理名（記録に残る名前）
                </span>
                <input
                  aria-label="料理名"
                  value={assistDish}
                  onChange={(e) => setAssistDish(e.target.value)}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
                />
              </label>

              <p className="mt-3 text-xs text-[var(--dim)]">部品</p>
              <ul className="mt-1 divide-y divide-[var(--border)]">
                {assistParts.map((p, i) => {
                  const preview = assistPartPreviews[i] ?? null;
                  return (
                    <li key={i} className="py-2">
                      <div className="flex items-baseline gap-2">
                        <p className="min-w-0 flex-1 text-sm font-semibold text-[var(--text)]">
                          {p.partName}
                          {p.status === "excluded" && !p.food && (
                            <span className="ml-1.5 rounded border border-[var(--border)] px-1 align-middle text-[10px] font-normal text-[var(--dim)]">
                              計算対象外
                            </span>
                          )}
                          {p.status === "unmatched" && !p.food && (
                            <span className="ml-1.5 rounded border border-[var(--accent)] px-1 align-middle text-[10px] font-normal text-[var(--accent)]">
                              未マッチ・計算に含まれない
                            </span>
                          )}
                        </p>
                        {preview && (
                          <span className="num shrink-0 text-xs text-[var(--dim)]">
                            {preview.kcal} kcal
                          </span>
                        )}
                        <button
                          aria-label={`${p.partName}を部品から削除`}
                          onClick={() => removePart(i)}
                          className="shrink-0 px-1.5 text-lg leading-none text-[var(--dim)]"
                        >
                          ×
                        </button>
                      </div>
                      {p.food ? (
                        <>
                          <p className="num mt-0.5 text-xs text-[var(--dim)]">
                            {p.food.name} · {p.food.basisLabel} ·{" "}
                            {fmt(p.food.kcal)} kcal
                          </p>
                          {p.alternatives.length > 0 && (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              <span className="text-[11px] text-[var(--dim)]">
                                差し替え：
                              </span>
                              {p.alternatives.map((a) => (
                                <button
                                  key={a.id}
                                  onClick={() => swapPartFood(i, a)}
                                  className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)]"
                                >
                                  {a.name}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-2">
                            <label className="flex items-center gap-1">
                              <span className="text-xs text-[var(--dim)]">
                                グラム（推定）
                              </span>
                              <input
                                aria-label={`${p.partName}のグラム数`}
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={p.grams}
                                onChange={(e) =>
                                  setPartGrams(i, e.target.value)
                                }
                                className="num w-24 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-right text-sm text-[var(--text)]"
                              />
                              <span className="text-xs text-[var(--dim)]">
                                g
                              </span>
                            </label>
                            {!preview && (
                              <span className="text-xs text-[var(--accent)]">
                                グラムを入れると計算に入ります
                              </span>
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="mt-0.5 text-xs text-[var(--dim)]">
                          {p.status === "excluded"
                            ? "計算には含めません"
                            : "マスタに一致する食品がありませんでした"}
                          {p.grams !== "" && ` · 目安 ${p.grams}g`}
                        </p>
                      )}
                      {p.rationale !== "" && (
                        <p className="mt-0.5 text-xs text-[var(--dim)]">
                          根拠：{p.rationale}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
              {assistParts.length === 0 && (
                <p className="mt-2 text-sm text-[var(--accent)]">
                  部品が全て削除されました。このままでは記録できません。
                </p>
              )}

              {assistResult.rationale !== "" && (
                <p className="mt-2 text-xs text-[var(--dim)]">
                  分解の前提：{assistResult.rationale}
                </p>
              )}

              {assistTotals ? (
                <>
                  <p className="num mt-3 text-sm text-[var(--text)]">
                    合計（推定）：{assistTotals.kcal} kcal · P
                    {fmt(assistTotals.proteinG)} F{fmt(assistTotals.fatG)} C
                    {fmt(assistTotals.carbsG)}
                    {assistTotals.saltG != null &&
                      ` · 食塩 ${fmt(assistTotals.saltG)}g`}
                  </p>
                  {hasMicros(assistTotals) && (
                    <p className="num mt-1 text-xs text-[var(--dim)]">
                      {microText(assistTotals)}
                    </p>
                  )}
                  {assistUncounted.length > 0 && (
                    <p className="mt-1 text-xs text-[var(--accent)]">
                      {assistUncounted.map((p) => p.partName).join("、")}{" "}
                      は計算に含まれていません。合計はその分だけ実際より小さくなります。
                    </p>
                  )}
                </>
              ) : (
                assistParts.length > 0 && (
                  <p className="mt-3 text-sm text-[var(--dim)]">
                    計算できる部品がありません。部品のグラムを入力してください。
                  </p>
                )
              )}

              <div className="mt-3 flex items-center gap-2">
                <EatingOutToggle
                  on={eatingOut}
                  onChange={setEatingOut}
                  label={`${assistResult.originalText}を外食として記録する`}
                />
                <span className="text-xs text-[var(--dim)]">
                  外食のときはオン（推定の目印になります）
                </span>
              </div>
              {assistPartsLogMutation.error && (
                <p className="mt-2 text-sm text-[var(--accent)]">
                  記録できませんでした：
                  {String(assistPartsLogMutation.error)}
                </p>
              )}
              <button
                disabled={
                  !assistTotals ||
                  assistDish.trim() === "" ||
                  assistPartsLogMutation.isPending
                }
                onClick={logAssistParts}
                className="mt-4 w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
              >
                {assistPartsLogMutation.isPending
                  ? "記録中…"
                  : "この内容で記録する"}
              </button>
            </div>
          )}
        </div>
      ) : !selected && !selectedRecipe ? (
        <>
          <input
            aria-label="食品を検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="食品・レシピを検索"
            className="mb-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
          <ul className="divide-y divide-[var(--border)]">
            {visible.map((food) => (
              <li key={food.id}>
                <button
                  onClick={() => pick(food)}
                  className="flex w-full items-baseline justify-between gap-2 py-2.5 text-left"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-base text-[var(--text)]">
                      {food.name}
                    </span>
                    <span className="block text-xs text-[var(--dim)]">
                      {food.basisLabel} · P{fmt(food.proteinG)} F{fmt(food.fatG)} C
                      {fmt(food.carbsG)}
                    </span>
                  </span>
                  <span className="num shrink-0 text-sm text-[var(--text)]">
                    {fmt(food.kcal)}
                    <span className="ml-0.5 text-xs text-[var(--dim)]">kcal</span>
                  </span>
                </button>
              </li>
            ))}
            {visible.length === 0 && visibleRecipes.length === 0 && !search.isPending && (
              <li className="py-4 text-center text-sm text-[var(--dim)]">
                見つかりませんでした
              </li>
            )}
            {visible.length === 0 && search.isPending && (
              <li className="py-4 text-center text-sm text-[var(--dim)]">
                検索中…
              </li>
            )}
          </ul>
          {searchTotal > visible.length && (
            <p className="mt-2 text-center text-xs text-[var(--dim)]">
              他 {searchTotal - visible.length} 件あります。検索で絞り込んでください
            </p>
          )}
          {visibleRecipes.length > 0 && (
            <>
              <p className="mt-3 mb-1 text-xs font-semibold text-[var(--dim)]">
                レシピ
              </p>
              <ul className="divide-y divide-[var(--border)]">
                {visibleRecipes.map((r) => (
                  <li key={r.id}>
                    <button
                      onClick={() => pickRecipe(r)}
                      className="flex w-full items-baseline justify-between gap-2 py-2.5 text-left"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-base text-[var(--text)]">
                          {r.title}
                          <span className="ml-1.5 rounded border border-[var(--accent)] px-1 align-middle text-[10px] text-[var(--accent)]">
                            レシピ
                          </span>
                        </span>
                        <span className="block text-xs text-[var(--dim)]">
                          {r.servingsLabel !== ""
                            ? r.servingsLabel
                            : r.servings != null
                              ? `${fmt(r.servings)}人分`
                              : "人数未設定"}
                          {r.perServing &&
                            ` · 1人分 P${fmt(r.perServing.proteinG)} F${fmt(r.perServing.fatG)} C${fmt(r.perServing.carbsG)}`}
                        </span>
                      </span>
                      {r.perServing && (
                        <span className="num shrink-0 text-sm text-[var(--text)]">
                          {fmt(r.perServing.kcal)}
                          <span className="ml-0.5 text-xs text-[var(--dim)]">
                            kcal
                          </span>
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {query.trim() !== "" && !hasExactMatch && (
            <button
              onClick={openAssist}
              className="mt-3 w-full rounded-lg border border-dashed border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
            >
              AIアシストで記録（マスタに無いバリエーションを換算）
            </button>
          )}
          <button
            onClick={() => onAddFood(query.trim())}
            className="mt-3 w-full rounded-lg border border-dashed border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
          >
            ＋ 新しい食品を登録
          </button>
          <button
            onClick={() => onAddBlend(query.trim())}
            className="mt-2 w-full rounded-lg border border-dashed border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
          >
            部品を組み合わせて配合食品を作る（成分表から計算）
          </button>
        </>
      ) : selected ? (
        <div>
          <button
            onClick={() => setSelected(null)}
            className="mb-2 text-sm text-[var(--accent)]"
          >
            ← 食品を選び直す
          </button>
          <p className="text-lg font-semibold text-[var(--text)]">{selected.name}</p>
          <p className="mb-3 text-xs text-[var(--dim)]">
            {selected.basisLabel} · {fmt(selected.kcal)} kcal · P{fmt(selected.proteinG)} F
            {fmt(selected.fatG)} C{fmt(selected.carbsG)}
            {selected.saltG != null && ` · 食塩 ${fmt(selected.saltG)}g`}
          </p>
          {hasMicros(selected) && (
            <p className="num mb-3 -mt-2 text-xs text-[var(--dim)]">
              {microText(selected)}
            </p>
          )}
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-[var(--dim)]">量</span>
              <input
                aria-label="量"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-lg text-[var(--text)]"
              />
            </label>
            <label>
              <span className="mb-1 block text-xs text-[var(--dim)]">単位</span>
              <select
                aria-label="単位"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-lg text-[var(--text)]"
              >
                {unitOptions(selected).map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-2 flex gap-1">
            {[0.5, 1, 1.5, 2].map((m) => (
              <button
                key={m}
                onClick={() => setQuantity(String(selected.defaultAmount * m))}
                className="flex-1 rounded-lg border border-[var(--border)] py-1 text-sm text-[var(--text)]"
              >
                ×{m}
              </button>
            ))}
          </div>
          {preview ? (
            <p className="num mt-3 text-sm text-[var(--dim)]">
              {preview.kcal} kcal · P{fmt(preview.proteinG)} F{fmt(preview.fatG)} C
              {fmt(preview.carbsG)}
              {preview.saltG != null && ` · 食塩 ${fmt(preview.saltG)}g`}
            </p>
          ) : (
            <p className="mt-3 text-sm text-[var(--dim)]">
              この単位では計算できません（1単位のグラム数が未設定です）
            </p>
          )}
          {preview && hasMicros(preview) && (
            <p className="num mt-1 text-xs text-[var(--dim)]">
              {microText(preview)}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <EatingOutToggle
              on={eatingOut}
              onChange={setEatingOut}
              label={`${selected.name}を外食として記録する`}
            />
            <span className="text-xs text-[var(--dim)]">
              外食のときはオン（推定の目印になります）
            </span>
          </div>
          {logMutation.error && (
            <p className="mt-2 text-sm text-[var(--accent)]">
              記録できませんでした：{String(logMutation.error)}
            </p>
          )}
          <button
            disabled={!preview || logMutation.isPending}
            onClick={() =>
              logMutation.mutate({ foodId: selected.id, quantity: qtyNum, unit })
            }
            className="mt-4 w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
          >
            {logMutation.isPending ? "記録中…" : `${SLOTS.find((s) => s.key === slot)?.label}に記録`}
          </button>
        </div>
      ) : selectedRecipe ? (
        <div>
          <button
            onClick={() => setSelectedRecipe(null)}
            className="mb-2 text-sm text-[var(--accent)]"
          >
            ← レシピを選び直す
          </button>
          <p className="text-lg font-semibold text-[var(--text)]">
            {selectedRecipe.title}
            <span className="ml-1.5 rounded border border-[var(--accent)] px-1 align-middle text-[10px] text-[var(--accent)]">
              レシピ
            </span>
          </p>
          {recipePer ? (
            <p className="num mb-3 text-xs text-[var(--dim)]">
              1人分 {fmt(recipePer.kcal)} kcal · P{fmt(recipePer.proteinG)} F
              {fmt(recipePer.fatG)} C{fmt(recipePer.carbsG)}
              {recipePer.saltG != null && ` · 食塩 ${fmt(recipePer.saltG)}g`}
              {!recipePer.complete && "（一部の材料が未確定の概算）"}
              {hasMicros(recipePer) && (
                <span className="block">微量栄養素：{microText(recipePer)}</span>
              )}
            </p>
          ) : (
            <p className="mb-3 text-sm text-[var(--accent)]">
              このレシピは人数（何人分）が未設定のため記録できません。レシピタブで編集して人数を設定してください。
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-xs text-[var(--dim)]">
              食べた量（人前）
            </span>
            <input
              aria-label="食べた量（人前）"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={recipeAmount}
              onChange={(e) => setRecipeAmount(e.target.value)}
              className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-lg text-[var(--text)]"
            />
          </label>
          <div className="mt-2 flex gap-1">
            {[0.5, 1, 1.5, 2].map((m) => (
              <button
                key={m}
                onClick={() => setRecipeAmount(String(m))}
                className="flex-1 rounded-lg border border-[var(--border)] py-1 text-sm text-[var(--text)]"
              >
                ×{m}
              </button>
            ))}
          </div>
          {recipePer && recipeCanLog && (
            <p className="num mt-3 text-sm text-[var(--dim)]">
              記録される値：{Math.round(recipePer.kcal * recipeAmountNum)} kcal ·
              P{fmt(recipePer.proteinG * recipeAmountNum)} F
              {fmt(recipePer.fatG * recipeAmountNum)} C
              {fmt(recipePer.carbsG * recipeAmountNum)}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <EatingOutToggle
              on={eatingOut}
              onChange={setEatingOut}
              label={`${selectedRecipe.title}を外食として記録する`}
            />
            <span className="text-xs text-[var(--dim)]">
              外食のときはオン（推定の目印になります）
            </span>
          </div>
          {recipeLogMutation.error && (
            <p className="mt-2 text-sm text-[var(--accent)]">
              記録できませんでした：{String(recipeLogMutation.error)}
            </p>
          )}
          <button
            disabled={!recipeCanLog || recipeLogMutation.isPending}
            onClick={() =>
              recipeLogMutation.mutate({
                recipeId: selectedRecipe.id,
                amount: recipeAmountNum,
              })
            }
            className="mt-4 w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
          >
            {recipeLogMutation.isPending
              ? "記録中…"
              : `${SLOTS.find((s) => s.key === slot)?.label}に記録`}
          </button>
        </div>
      ) : null}
    </Sheet>
  );
}

// ---------- food form (manual entry + label photo draft) ----------

type FoodFormState = {
  name: string;
  // Maker/brand name for the AI lookup （メーカー名， optional). Split
  // from the product name so the lookup can aim at the maker's official
  // store and tell same-named products apart; never stored on the food
  // itself — it lives on the research record and in this input.
  maker: string;
  basisType: "per100g" | "serving";
  basisLabel: string;
  kcal: string;
  proteinG: string;
  fatG: string;
  carbsG: string;
  saltG: string;
  defaultAmount: string;
  defaultUnit: string;
  unitGrams: string;
  source: "table" | "label" | "manual" | "ai" | "blend";
  sourceName: string;
  sourceUrl: string;
} & Record<MicroKey, string>;

/** Form-string fields for the micronutrients of a food / draft / record. */
const microFormFields = (src: MicroMap): Record<MicroKey, string> => {
  const out = {} as Record<MicroKey, string>;
  for (const f of MICRO_FIELDS) {
    const v = src[f.key];
    out[f.key] = v == null ? "" : String(v);
  }
  return out;
};

const emptyForm: FoodFormState = {
  name: "",
  maker: "",
  basisType: "per100g",
  basisLabel: "100gあたり",
  kcal: "",
  proteinG: "",
  fatG: "",
  carbsG: "",
  saltG: "",
  defaultAmount: "100",
  defaultUnit: "g",
  unitGrams: "",
  source: "manual",
  sourceName: "",
  sourceUrl: "",
  ...microFormFields(emptyMicros()),
};

function foodToForm(food: Food): FoodFormState {
  return {
    name: food.name,
    maker: "",
    basisType: food.basisType,
    basisLabel: food.basisLabel,
    kcal: String(food.kcal),
    proteinG: String(food.proteinG),
    fatG: String(food.fatG),
    carbsG: String(food.carbsG),
    saltG: food.saltG == null ? "" : String(food.saltG),
    ...microFormFields(food),
    defaultAmount: String(food.defaultAmount),
    defaultUnit: food.defaultUnit,
    unitGrams: food.unitGrams == null ? "" : String(food.unitGrams),
    source: food.source,
    sourceName: food.sourceName ?? "",
    sourceUrl: food.sourceUrl ?? "",
  };
}

/** Parse form-string micronutrient fields back into a value map. */
const microFormToMap = (src: Record<MicroKey, string>): MicroMap => {
  const out = emptyMicros();
  for (const f of MICRO_FIELDS) {
    const t = src[f.key].trim();
    if (t === "") continue;
    const n = Number(t);
    if (Number.isFinite(n)) out[f.key] = n;
  }
  return out;
};

/** Prefill the food form from a stored AI research record. */
function researchToForm(record: Research): FoodFormState {
  const basisType = record.basisType === "per100g" ? "per100g" : "serving";
  return {
    name: record.name ?? record.queryName,
    maker: record.maker ?? "",
    basisType,
    basisLabel:
      basisType === "per100g" ? "100gあたり" : record.basisLabel ?? "",
    kcal: record.kcal == null ? "" : String(record.kcal),
    proteinG: record.proteinG == null ? "" : String(record.proteinG),
    fatG: record.fatG == null ? "" : String(record.fatG),
    carbsG: record.carbsG == null ? "" : String(record.carbsG),
    saltG: record.saltG == null ? "" : String(record.saltG),
    ...microFormFields(record),
    defaultAmount: basisType === "per100g" ? "100" : "1",
    defaultUnit: basisType === "per100g" ? "g" : "食",
    unitGrams:
      basisType === "serving" && record.servingGrams != null
        ? String(record.servingGrams)
        : "",
    source: "ai",
    sourceName: record.sourceName ?? "",
    sourceUrl: record.sourceUrl ?? "",
  };
}

/** Prefill the food form from a finished deep-research draft. */
function researchDraftToForm(draft: ResearchDraft): FoodFormState {
  const basisType = draft.basisType === "per100g" ? "per100g" : "serving";
  return {
    ...emptyForm,
    name: draft.name,
    maker: draft.maker ?? "",
    basisType,
    basisLabel:
      basisType === "per100g" ? "100gあたり" : draft.basisLabel,
    kcal: String(draft.kcal),
    proteinG: String(draft.proteinG),
    fatG: String(draft.fatG),
    carbsG: String(draft.carbsG),
    saltG: draft.saltG == null ? "" : String(draft.saltG),
    ...microFormFields(draft),
    defaultAmount: basisType === "per100g" ? "100" : "1",
    defaultUnit: basisType === "per100g" ? "g" : "食",
    unitGrams:
      basisType === "serving" && draft.servingGrams != null
        ? String(draft.servingGrams)
        : "",
    source: "ai",
    sourceName: draft.sourceName,
    sourceUrl: draft.sourceUrl,
  };
}

async function downscaleToJpeg(
  file: File,
): Promise<{ base64: string; mimeType: "image/jpeg" }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("画像を読み込めませんでした"));
      i.src = url;
    });
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const cx = canvas.getContext("2d");
    if (!cx) throw new Error("画像処理に対応していません");
    cx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { base64: dataUrl.split(",")[1] ?? "", mimeType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Current time, re-rendered every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// Finished deep-research jobs the user has already seen the outcome of
// (applied in the form, opened from the banner, or dismissed). Kept in
// localStorage so the completion notice doesn't nag on every open.
const DEEP_DISMISSED_KEY = "deepResearchDismissedJobIds";

function loadDismissedDeepJobs(): number[] {
  try {
    const raw = localStorage.getItem(DEEP_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === "number")
      : [];
  } catch {
    return [];
  }
}

function storeDismissedDeepJobs(ids: number[]) {
  try {
    localStorage.setItem(DEEP_DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Storage unavailable — dismissal just won't persist across opens.
  }
}

// Same idea for unregistered research drafts surfaced by the status
// banner: once the user has opened one in the form or closed its card,
// don't keep showing it. (A draft also disappears on its own once a
// food with the same name is registered — the server filters those.)
const DRAFT_DISMISSED_KEY = "researchDraftDismissedIds";

function loadDismissedDrafts(): number[] {
  try {
    const raw = localStorage.getItem(DRAFT_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === "number")
      : [];
  } catch {
    return [];
  }
}

function storeDismissedDrafts(ids: number[]) {
  try {
    localStorage.setItem(DRAFT_DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Storage unavailable — dismissal just won't persist across opens.
  }
}

/** Seconds elapsed while `pending` is true (for slow AI operations). */
function useElapsed(pending: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!pending) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - t0) / 1000)),
      250,
    );
    return () => clearInterval(id);
  }, [pending]);
  return elapsed;
}

/**
 * Live progress for a synchronous AI wait. A bare "考え中…" button label
 * gives no way to tell a working request from a stuck one, so every
 * in-form AI operation renders this while pending: an animated spinner,
 * the stage the wait has reached (the stages mirror the server-side
 * pipeline, advanced by elapsed time), the elapsed time itself, and how
 * long the operation usually takes. Past `longAfterSec` it says plainly
 * that this is taking longer than usual instead of leaving the user to
 * wonder.
 */
function AiWait({
  elapsed,
  stages,
  typical,
  longAfterSec = 45,
  longText,
}: {
  elapsed: number;
  stages: Array<{ fromSec: number; text: string }>;
  typical: string;
  longAfterSec?: number;
  longText?: string;
}) {
  let stage = stages[0]?.text ?? "";
  for (const s of stages) {
    if (elapsed >= s.fromSec) stage = s.text;
  }
  return (
    <div
      role="status"
      className="mt-2 mb-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
    >
      <p className="flex items-center gap-2 text-sm text-[var(--text)]">
        <span
          aria-hidden
          className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] motion-safe:animate-spin"
        />
        <span>
          {stage}（{fmtElapsed(elapsed)}経過）
        </span>
      </p>
      <p className="mt-0.5 text-xs text-[var(--dim)]">{typical}</p>
      {elapsed >= longAfterSec && (
        <p className="mt-0.5 text-xs text-[var(--dim)]">
          {longText ?? "通常より時間がかかっています。"}
        </p>
      )}
    </div>
  );
}

/**
 * Server-side food search. The master holds the full composition table
 * (~2,500 foods), so pickers never load it whole: they search by name
 * (debounced) and get one page plus the total match count. With an empty
 * query the page is the most-used foods, keeping frequent items one tap
 * away.
 */
function useFoodSearch(query: string, limit: number) {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(id);
  }, [query]);
  return useQuery({
    queryKey: ["foodSearch", debounced, limit],
    queryFn: () => api.listFoods({ query: debounced, limit }),
  });
}

function FoodForm({
  initial,
  foodId,
  onClose,
  onUseExisting,
  onSavedId,
  onDeepJobHandled,
}: {
  initial: FoodFormState;
  foodId?: number;
  onClose: () => void;
  onUseExisting?: (food: Food) => void;
  // Called with the saved food's id (before close) so a caller like the
  // meal picker can select the food the user just registered.
  onSavedId?: (id: number) => void;
  // Called when a deep-research job's outcome has been shown in this
  // form, so the app-level status banner doesn't repeat it.
  onDeepJobHandled?: (jobId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FoodFormState>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Food[] | null>(null);
  // Query name whose last lookup result came from a stored research
  // record (no fresh search ran) — the user can force a re-search.
  const [recordLookupName, setRecordLookupName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  // Deep research (agent opens the manufacturer's pages directly) —
  // started automatically when a fresh fast lookup cannot confirm
  // values, or manually for a name whose stored record is not_found.
  const [deepJobId, setDeepJobId] = useState<number | null>(null);
  // When the form opens on an AI draft that lacks 食塩相当量 (a stored
  // research record or a finished job's draft), offer the deep research
  // up front: packaged foods print salt on the label, so a missing salt
  // usually means the earlier snippet-based pass never saw that row.
  const [deepName, setDeepName] = useState<string | null>(() =>
    foodId == null &&
    initial.source === "ai" &&
    initial.saltG.trim() === "" &&
    initial.name.trim() !== ""
      ? initial.name
      : null,
  );
  // True while a deep job was started only to refill the salt of a
  // draft already in this form (fresh lookup found PFC but no salt).
  // Its completion merges just the salt instead of replacing the whole
  // draft, so edits made while waiting are not clobbered.
  const deepSaltOnlyRef = useRef(false);
  // Run generations for the two independent in-form AI operations
  // (label photo read / public-info lookup). mutation.reset() alone
  // does NOT cancel: the in-flight request still settles later and its
  // onSuccess would apply a draft the user already walked away from.
  // Each start bumps the generation; キャンセル bumps it again and
  // resets the mutation, so a late result whose generation no longer
  // matches is dropped. The two operations have separate generations
  // and never touch each other's state — cancelling or finishing one
  // leaves the other running.
  const parseRunRef = useRef(0);
  const lookupRunRef = useRef(0);

  const set = (patch: Partial<FoodFormState>) =>
    setForm((f) => ({ ...f, ...patch }));

  const saveMutation = useMutation({
    mutationFn: async () => {
      const num = (s: string) => {
        const n = Number(s);
        return Number.isFinite(n) ? n : NaN;
      };
      return api.upsertFood({
        id: foodId,
        name: form.name.trim(),
        basisType: form.basisType,
        basisLabel:
          form.basisType === "per100g" ? "100gあたり" : form.basisLabel.trim(),
        kcal: num(form.kcal),
        proteinG: num(form.proteinG),
        fatG: num(form.fatG),
        carbsG: num(form.carbsG),
        saltG: form.saltG.trim() === "" ? null : num(form.saltG),
        ...(() => {
          const microArgs = {} as Record<MicroKey, number | null>;
          for (const f of MICRO_FIELDS) {
            microArgs[f.key] =
              form[f.key].trim() === "" ? null : num(form[f.key]);
          }
          return microArgs;
        })(),
        source: form.source,
        // The citation must survive a plain rename/edit for every
        // sourced food, not just AI ones: table foods carry the MEXT
        // citation and blend foods carry their calculation basis in
        // sourceName, and the server nulls both when they are not
        // sent. (The server still decides per source which of the two
        // fields it keeps.)
        sourceName:
          (form.source === "ai" ||
            form.source === "table" ||
            form.source === "blend") &&
          form.sourceName.trim() !== ""
            ? form.sourceName.trim()
            : null,
        sourceUrl:
          (form.source === "ai" ||
            form.source === "table" ||
            form.source === "blend") &&
          form.sourceUrl.trim() !== ""
            ? form.sourceUrl.trim()
            : null,
        defaultAmount: num(form.defaultAmount),
        defaultUnit: form.defaultUnit.trim(),
        unitGrams: form.unitGrams.trim() === "" ? null : num(form.unitGrams),
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries();
      onSavedId?.(res.id);
      onClose();
    },
  });

  const parseMutation = useMutation({
    mutationFn: async (file: File) => {
      const run = ++parseRunRef.current;
      try {
        const img = await downscaleToJpeg(file);
        const draft = await api.parseLabelImage({
          imageBase64: img.base64,
          mimeType: img.mimeType,
        });
        return { run, draft, error: null as string | null };
      } catch (e) {
        return {
          run,
          draft: null,
          error: e instanceof Error ? e.message : null,
        };
      }
    },
    onSuccess: (res) => {
      // Cancelled or superseded while in flight: drop the late result.
      if (res.run !== parseRunRef.current) return;
      if (res.error || !res.draft) {
        setNotice(
          res.error ??
            "読み取りに失敗しました。写真を撮り直すか、手入力してください。",
        );
        return;
      }
      const draft = res.draft;
      if (!draft.readable) {
        setNotice("成分表示を読み取れませんでした。写真を撮り直すか、手入力してください。");
        return;
      }
      const basisType =
        draft.basisType === "per100g"
          ? "per100g"
          : "serving"; // 'unknown' falls back to serving; user verifies below
      setForm((f) => ({
        ...f,
        name: draft.name || f.name,
        basisType,
        basisLabel:
          basisType === "per100g" ? "100gあたり" : draft.basisLabel || f.basisLabel,
        kcal: String(draft.kcal),
        proteinG: String(draft.proteinG),
        fatG: String(draft.fatG),
        carbsG: String(draft.carbsG),
        saltG: draft.saltG == null ? "" : String(draft.saltG),
        ...microFormFields(draft),
        unitGrams:
          basisType === "serving" && draft.servingGrams != null
            ? String(draft.servingGrams)
            : f.unitGrams,
        defaultAmount: basisType === "per100g" ? "100" : "1",
        defaultUnit: basisType === "per100g" ? "g" : f.defaultUnit === "g" ? "食" : f.defaultUnit,
        source: "label",
        sourceName: "",
        sourceUrl: "",
      }));
      setCandidates(null);
      setRecordLookupName(null);
      setDeepName(null);
      setNotice("読み取りました。内容を確認して保存してください。");
    },
  });

  const cancelParse = () => {
    // Invalidate the in-flight run, then reset the mutation: the UI
    // frees immediately and the late result is dropped by the
    // generation check in onSuccess.
    parseRunRef.current += 1;
    parseMutation.reset();
    setNotice("読み取りをキャンセルしました。");
  };

  type LookupDraft = NonNullable<
    ApiResponse<typeof api, "lookupFoodInfo">["draft"]
  >;
  const applyDraft = (draft: LookupDraft) => {
    const basisType = draft.basisType === "per100g" ? "per100g" : "serving";
    setForm((f) => ({
      ...f,
      name: draft.name || f.name,
      // The maker the research used or inferred; the user can correct
      // it in the maker field. Keep the typed one when the draft has
      // none.
      maker: draft.maker ?? f.maker,
      basisType,
      basisLabel:
        basisType === "per100g" ? "100gあたり" : draft.basisLabel || f.basisLabel,
      kcal: String(draft.kcal),
      proteinG: String(draft.proteinG),
      fatG: String(draft.fatG),
      carbsG: String(draft.carbsG),
      saltG: draft.saltG == null ? "" : String(draft.saltG),
      ...microFormFields(draft),
      unitGrams:
        basisType === "serving" && draft.servingGrams != null
          ? String(draft.servingGrams)
          : f.unitGrams,
      defaultAmount: basisType === "per100g" ? "100" : "1",
      defaultUnit:
        basisType === "per100g" ? "g" : f.defaultUnit === "g" ? "食" : f.defaultUnit,
      source: "ai",
      sourceName: draft.sourceName,
      sourceUrl: draft.sourceUrl,
    }));
    setCandidates(null);
  };

  const deepMutation = useMutation({
    mutationFn: (args: { name: string; maker?: string }) =>
      api.startDeepFoodResearch(args),
    onSuccess: (res) => {
      // The job runs in the background; the app-level status banner
      // tracks it from here on, whether this form stays open or not.
      queryClient.invalidateQueries({ queryKey: ["deepJobs"] });
      if (res.jobId != null) {
        setDeepName(null);
        setDeepJobId(res.jobId);
      } else if (res.candidates.length > 0) {
        setCandidates(res.candidates);
        setNotice(null);
      }
    },
    onError: () => {
      setNotice(
        "詳しい調査を開始できませんでした。時間をおいて再試行するか、手入力してください。",
      );
    },
  });

  const deepQuery = useQuery({
    queryKey: ["deepFoodResearch", deepJobId],
    queryFn: () => api.getDeepFoodResearch({ jobId: deepJobId ?? 0 }),
    enabled: deepJobId != null,
    refetchInterval: (query) =>
      query.state.data?.job.status === "pending" ? 3000 : false,
  });
  const deepJob =
    deepQuery.data?.job && deepQuery.data.job.id === deepJobId
      ? deepQuery.data.job
      : null;
  // Elapsed counts from the job's server-side start, so re-attaching to
  // a job that has been running in the background shows its real age —
  // the same figure the app-level banner shows.
  const deepAttachElapsed = useElapsed(deepJobId != null);
  const deepNow = useNow(deepJobId != null);
  const deepElapsed = deepJob
    ? Math.max(
        0,
        Math.floor((deepNow - new Date(deepJob.createdAt).getTime()) / 1000),
      )
    : deepAttachElapsed;

  useEffect(() => {
    const job = deepQuery.data?.job;
    if (!job || deepJobId == null || job.id !== deepJobId) return;
    if (job.status === "ready") {
      const saltOnly = deepSaltOnlyRef.current;
      deepSaltOnlyRef.current = false;
      setDeepJobId(null);
      onDeepJobHandled?.(job.id);
      setRecordLookupName(null);
      queryClient.invalidateQueries({ queryKey: ["research"] });
      if (saltOnly && job.draft) {
        // Salt refill: merge only the salt into the draft already in
        // the form (and only while the field is still empty), leaving
        // everything the user may have edited untouched.
        const salt = job.draft.saltG;
        if (salt != null) {
          setForm((f) =>
            f.saltG.trim() === "" ? { ...f, saltG: String(salt) } : f,
          );
          setNotice(
            "詳しい調査でメーカー公式ページの食塩相当量を確認し、下書きに補いました。内容を確認して保存してください（調査記録にも残しました）。",
          );
        } else {
          setNotice(
            "詳しい調査でも食塩相当量を確認できませんでした。出典ページの表に載っていないか、読み取れませんでした。必要なら出典リンクから目視で確認して手入力してください。",
          );
        }
      } else if (job.draft) {
        applyDraft(job.draft);
        setNotice(
          "AIがメーカー公式ページを直接確認して下書きしました。出典と内容を確認して保存してください（調査記録にも残しました）。",
        );
      } else {
        setNotice(
          "メーカー公式ページを直接確認しましたが、栄養成分の値を確認できませんでした。値は推測で埋めていないので、手入力で登録してください（調査記録に残しました）。",
        );
      }
    } else if (job.status === "failed") {
      deepSaltOnlyRef.current = false;
      setDeepJobId(null);
      onDeepJobHandled?.(job.id);
      setNotice(
        `詳しい調査に失敗しました${job.error ? `：${job.error}` : ""}。時間をおいて再試行するか、手入力してください。`,
      );
    }
    // applyDraft only writes form state; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepQuery.data, deepJobId]);

  const lookupMutation = useMutation({
    mutationFn: async (args: {
      name: string;
      maker?: string;
      force?: boolean;
    }) => {
      const run = ++lookupRunRef.current;
      try {
        const res = await api.lookupFoodInfo(args);
        return { run, res, error: null as string | null };
      } catch (e) {
        return {
          run,
          res: null,
          error: e instanceof Error ? e.message : null,
        };
      }
    },
    onSuccess: (out, vars) => {
      // Cancelled or superseded while in flight: drop the late result
      // (the server still saved its research record, and a handed-off
      // deep job still shows in the app-level banner).
      if (out.run !== lookupRunRef.current) return;
      if (!out.res) {
        setNotice(
          out.error ??
            "AI調査に失敗しました。時間をおいて再試行するか、手入力してください。",
        );
        return;
      }
      const res = out.res;
      // How a fresh draft was confirmed: from the search snippets, or
      // from a candidate page's body (the staged lookup's second
      // stage — where branded products' tables actually live).
      const freshDraftNotice =
        res.via === "page"
          ? "AIがメーカー公式ページの本文から栄養成分表示を確認して下書きしました。調査記録にも残しました。出典と内容を確認して保存してください。"
          : "AIが公開情報から下書きしました。調査記録にも残しました。出典と内容を確認して保存してください。";
      // A completed lookup is stored server-side as a research record.
      queryClient.invalidateQueries({ queryKey: ["research"] });
      setRecordLookupName(res.fromRecord ? vars.name : null);
      if (res.status === "existing") {
        setCandidates(res.candidates);
        setNotice(null);
        return;
      }
      setCandidates(null);
      if (res.status === "not_found" || !res.draft) {
        if (res.fromRecord) {
          // A stored not_found: offer the deep research (an agent opens
          // the manufacturer's pages directly) as the next step.
          setDeepName(vars.name);
          setNotice(
            "前回調べたときも、信頼できる出典が見つかりませんでした（調査記録に残っています）。値は推測で埋めていません。下のボタンで、AIがメーカー公式ページを直接確認する詳しい調査もできます。",
          );
        } else if (res.deepJobId != null) {
          // The server already handed off to the background deep
          // research before returning (its sync budget is enforced
          // server-side, so this exit is always reached): attach to
          // that job instead of starting a second one.
          setDeepName(null);
          setDeepJobId(res.deepJobId);
          setNotice(
            "公開情報からは制限時間内に値を確認できませんでした。詳しい調査（バックグラウンド）に引き継ぎました。このまま待つか、フォームを閉じても大丈夫です（結果は画面上部に表示されます）。",
          );
        } else {
          // Fallback (the server-side handoff spawn failed): start
          // the background deep research from here, as before.
          setNotice(
            "公開情報からは値を確認できませんでした。AIがメーカー公式ページを直接確認する詳しい調査（バックグラウンド）を開始します…",
          );
          deepMutation.mutate({ name: vars.name, maker: vars.maker });
        }
        return;
      }
      applyDraft(res.draft);
      if (res.draft.saltG == null && res.draft.basisType === "serving") {
        // PFC was confirmed but 食塩相当量 is missing. Packaged foods
        // print salt on the label by law, yet the salt row sits deep in
        // the maker's table and can still be missed when the confirmed
        // values came from a source that doesn't print it (BASE BREAD
        // was the recurring case). Hand the refill to the deep
        // research, which reads the full table on the manufacturer's
        // page; its result merges just the salt back into this form.
        if (res.fromRecord) {
          // A stored record: don't spawn a background job unasked —
          // offer the refill as a button instead.
          setDeepName(vars.name);
          setNotice(
            "前回の調査記録から下書きしました。出典と内容を確認して保存してください。なお食塩相当量は記録に含まれていません（出典ページに載っていても、検索結果の断片からは拾えていないことがあります）。下のボタンで詳しく調べると、公式ページを直接読んで補えます。",
          );
        } else {
          setDeepName(null);
          deepSaltOnlyRef.current = true;
          setNotice(
            `${freshDraftNotice}ただし食塩相当量は拾えなかったため、メーカー公式ページを直接読んで補う詳しい調査を開始します…`,
          );
          deepMutation.mutate({ name: vars.name, maker: vars.maker });
        }
      } else {
        setDeepName(null);
        setNotice(
          res.fromRecord
            ? "前回の調査記録から下書きしました。出典と内容を確認して保存してください。"
            : freshDraftNotice,
        );
      }
    },
  });

  const cancelLookup = () => {
    // Same generation guard as the photo read: frees the UI now and
    // drops the late result when it lands.
    lookupRunRef.current += 1;
    lookupMutation.reset();
    setNotice(
      "AI調査をキャンセルしました。サーバ側で終わっていた調査は調査記録に残ります。",
    );
  };

  const parseElapsed = useElapsed(parseMutation.isPending);
  const lookupElapsed = useElapsed(lookupMutation.isPending);

  const valid =
    form.name.trim() !== "" &&
    [form.kcal, form.proteinG, form.fatG, form.carbsG, form.defaultAmount].every(
      (s) => s.trim() !== "" && Number.isFinite(Number(s)),
    ) &&
    form.defaultUnit.trim() !== "" &&
    (form.basisType === "per100g" || form.basisLabel.trim() !== "");

  const numField = (
    label: string,
    key: "kcal" | "proteinG" | "fatG" | "carbsG" | "saltG" | MicroKey,
    optional = false,
  ) => (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--dim)]">
        {label}
        {optional && "（任意）"}
      </span>
      <input
        aria-label={label}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={form[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<FoodFormState>)}
        className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
      />
    </label>
  );

  return (
    <Sheet title={foodId ? "食品を編集" : "食品を登録"} onClose={onClose}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) parseMutation.mutate(file);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) parseMutation.mutate(file);
          e.target.value = "";
        }}
      />
      <label className="mb-2 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">
          メーカー名（任意）
        </span>
        <input
          aria-label="メーカー名（任意）"
          value={form.maker}
          onChange={(e) => set({ maker: e.target.value })}
          placeholder="例：ビーレジェンド（分からなければ空でOK）"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
        />
      </label>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">食品名</span>
        <input
          aria-label="食品名"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="例：背中に鬼レモン"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
        />
      </label>

      <div className="mb-1 flex gap-2">
        <button
          onClick={() => cameraRef.current?.click()}
          disabled={parseMutation.isPending}
          className="flex-1 rounded-lg border border-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
        >
          {parseMutation.isPending
            ? `成分表示を読み取り中… ${parseElapsed}秒`
            : "📷 その場で撮影して読み取る"}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={parseMutation.isPending}
          className="flex-1 rounded-lg border border-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
        >
          写真を選ぶ
        </button>
        {parseMutation.isPending && (
          <button
            onClick={cancelParse}
            className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--dim)]"
          >
            キャンセル
          </button>
        )}
      </div>
      {parseMutation.isPending && (
        <AiWait
          elapsed={parseElapsed}
          stages={[{ fromSec: 0, text: "成分表示の写真を読み取っています" }]}
          typical="通常は20秒前後かかります。長くても約1分で自動的に打ち切ります"
          longText="通常より時間がかかっています。キャンセルして撮り直すか、そのままお待ちください（約1分で自動的に打ち切ります）。"
        />
      )}
      <p className="mb-3 text-xs text-[var(--dim)]">
        写真は端末で縮小して読み取りにだけ使い、保存しません。結果は下書きとして入ります。
      </p>

      <div className="mb-1 flex gap-2">
        <button
          onClick={() =>
            lookupMutation.mutate({
              name: form.name.trim(),
              maker: form.maker.trim() || undefined,
            })
          }
          disabled={lookupMutation.isPending || form.name.trim() === ""}
          className="flex-1 rounded-lg border border-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
        >
          {lookupMutation.isPending
            ? `AIが公開情報を調べています… ${lookupElapsed}秒`
            : "🔍 AIで調べる（出典つき）"}
        </button>
        {lookupMutation.isPending && (
          <button
            onClick={cancelLookup}
            className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-2.5 text-sm text-[var(--dim)]"
          >
            キャンセル
          </button>
        )}
      </div>
      {lookupMutation.isPending && (
        <AiWait
          elapsed={lookupElapsed}
          stages={[
            { fromSec: 0, text: "第1段：公開情報を検索しています" },
            { fromSec: 12, text: "第1段：検索結果から栄養成分の値を読み取っています" },
            { fromSec: 32, text: "第2段：候補ページ（メーカー公式など）の本文を確認しています" },
          ]}
          typical="目安は60秒以内です。第1段で当たれば通常30秒前後、見つからなければ公式ページの本文まで読みに行きます。それでも確定しなければ、詳しい調査（バックグラウンド）に引き継いで、この画面は解放されます"
          longText="通常より時間がかかっています。そのまま待つか、キャンセルしてやり直せます。"
        />
      )}
      <p className="mb-3 text-xs text-[var(--dim)]">
        食品名を入れて押すと、成分表やメーカー公式などの公開情報をAIが調べ、出典つきの下書きを作ります。メーカー名を入れると公式ストア・公式サイトに当たりやすくなります（空でも動きます）。調べた結果は「食品」タブの調査記録に残り、同じ食品名なら次回は記録からすぐ表示されます。自動では登録されません。
      </p>

      {recordLookupName != null && !lookupMutation.isPending && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-[var(--dim)]">
            「{recordLookupName}」は前回の調査記録から表示しています
          </p>
          <button
            onClick={() =>
              lookupMutation.mutate({
              name: recordLookupName,
              maker: form.maker.trim() || undefined,
              force: true,
            })
            }
            className="shrink-0 rounded-lg border border-[var(--accent)] px-2.5 py-1 text-sm text-[var(--accent)]"
          >
            もう一度調べる
          </button>
        </div>
      )}

      {candidates && (
        <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
          <p className="mb-1 text-sm font-semibold text-[var(--text)]">
            似た食品がすでに登録されています
          </p>
          <ul className="divide-y divide-[var(--border)]">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text)]">
                    {c.name}
                  </span>
                  <span className="num block text-xs text-[var(--dim)]">
                    {c.basisLabel} · {fmt(c.kcal)} kcal
                  </span>
                </span>
                {onUseExisting && (
                  <button
                    onClick={() => onUseExisting(c)}
                    className="shrink-0 rounded-lg border border-[var(--accent)] px-2.5 py-1 text-sm text-[var(--accent)]"
                  >
                    この食品を使う
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            onClick={() =>
              lookupMutation.mutate({
              name: form.name.trim(),
              maker: form.maker.trim() || undefined,
              force: true,
            })
            }
            disabled={lookupMutation.isPending}
            className="py-1 text-sm text-[var(--accent)] disabled:opacity-50"
          >
            それでもAIで調べる
          </button>
        </div>
      )}

      {notice && <p className="mb-3 text-sm text-[var(--accent)]">{notice}</p>}

      {deepJobId != null && (
        <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
          <p className="text-sm text-[var(--text)]">
            AIがメーカー公式ページを直接確認しています… {deepElapsed}秒
          </p>
          {deepJob?.progressStage && (
            <p className="mt-0.5 text-xs font-semibold text-[var(--accent)]">
              段階：
              {DEEP_STAGE_LABELS[deepJob.progressStage] ?? deepJob.progressStage}
            </p>
          )}
          {deepJob?.progress && (
            <p className="mt-0.5 text-sm text-[var(--text)]">
              いま：{deepJob.progress}
            </p>
          )}
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            ページを開いて栄養成分表示を読むため、1〜2分ほどかかります。調査はバックグラウンドで続くので、このフォームを閉じても大丈夫です。終わると画面上部に結果が表示され、そこから下書きを開けます（このまま開いて待てば、終わり次第ここに結果が反映されます）。
          </p>
          <button
            onClick={onClose}
            className="mt-1.5 rounded-lg border border-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent)]"
          >
            閉じて待つ
          </button>
        </div>
      )}
      {deepJobId == null && deepName != null && (
        <button
          onClick={() =>
            deepMutation.mutate({
              name: deepName,
              maker: form.maker.trim() || undefined,
            })
          }
          disabled={deepMutation.isPending}
          className="mb-3 w-full rounded-lg border border-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
        >
          {deepMutation.isPending
            ? "詳しい調査を開始しています…"
            : "🔍 AIに詳しく調べてもらう（メーカー公式ページを直接確認）"}
        </button>
      )}

      {form.source === "ai" && form.sourceUrl !== "" && (
        <p className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--dim)]">
          出典：
          <a
            href={form.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] underline"
          >
            {form.sourceName || form.sourceUrl}
          </a>
          <span className="mt-0.5 block">
            AI調査の下書きです。リンク先と値が合っているか確認してください。
          </span>
        </p>
      )}

      <div className="mb-3">
        <span className="mb-1 block text-xs text-[var(--dim)]">成分の基準</span>
        <div className="flex gap-1" role="group" aria-label="成分の基準">
          {(
            [
              ["per100g", "100gあたり"],
              ["serving", "1単位あたり"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => set({ basisType: v })}
              aria-pressed={form.basisType === v}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
                form.basisType === v
                  ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
                  : "border-[var(--border)] text-[var(--text)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {form.basisType === "serving" && (
          <input
            aria-label="基準の表記"
            value={form.basisLabel}
            onChange={(e) => set({ basisLabel: e.target.value })}
            placeholder="例：1食分（200g）あたり"
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        )}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        {numField("エネルギー (kcal)", "kcal")}
        {numField("たんぱく質 (g)", "proteinG")}
        {numField("脂質 (g)", "fatG")}
        {numField("炭水化物 (g)", "carbsG")}
        {numField("食塩相当量 (g)", "saltG", true)}
      </div>

      <details className="mb-3 rounded-lg border border-[var(--border)] px-3 py-2">
        <summary className="cursor-pointer text-sm text-[var(--text)]">
          微量栄養素（任意・分かる分だけ）
        </summary>
        <p className="mt-1 text-xs text-[var(--dim)]">
          食物繊維・ミネラル・ビタミン類です。成分表や栄養成分表示に載っている分だけ入れてください。空欄は「不明」として保存され、0にはなりません。
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MICRO_FIELDS.map((f) => (
            <div key={f.key}>
              {numField(`${f.label} (${f.unit})`, f.key, true)}
            </div>
          ))}
        </div>
      </details>

      <div className="mb-1 grid grid-cols-3 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">既定の量</span>
          <input
            aria-label="既定の量"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={form.defaultAmount}
            onChange={(e) => set({ defaultAmount: e.target.value })}
            className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">単位</span>
          <input
            aria-label="既定の単位"
            value={form.defaultUnit}
            onChange={(e) => set({ defaultUnit: e.target.value })}
            placeholder="g・個・食…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">1単位のg数（任意）</span>
          <input
            aria-label="1単位のグラム数"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={form.unitGrams}
            onChange={(e) => set({ unitGrams: e.target.value })}
            placeholder="例：50"
            className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
      </div>
      <p className="mb-3 text-xs text-[var(--dim)]">
        1単位のg数を入れておくと、記録時に「個数 ⇄ グラム」を切り替えて記録できます。
      </p>

      {saveMutation.error && (
        <p className="mb-2 text-sm text-[var(--accent)]">
          保存できませんでした：{String(saveMutation.error)}
        </p>
      )}
      <button
        disabled={!valid || saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
        className="w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
      >
        {saveMutation.isPending ? "保存中…" : "保存"}
      </button>
    </Sheet>
  );
}

// ---------- day view ----------

function DayView({
  date,
  setDate,
  hasFoods,
  settings,
  openPicker,
  openFoodForm,
}: {
  date: string;
  setDate: (d: string) => void;
  hasFoods: boolean;
  settings: Settings | undefined;
  openPicker: (slot: Slot) => void;
  openFoodForm: () => void;
}) {
  const queryClient = useQueryClient();
  const logs = useQuery({
    queryKey: ["mealLogs", date],
    queryFn: () => api.listMealLogs({ date }),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteMealLog({ id }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const eatingOutMutation = useMutation({
    mutationFn: (args: { id: number; eatingOut: boolean }) =>
      api.setMealLogEatingOut(args),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const entries = logs.data?.entries ?? [];
  const totals: Nutrients = entries.reduce<Nutrients>(
    (acc, e) => ({
      kcal: acc.kcal + e.kcal,
      proteinG: acc.proteinG + e.proteinG,
      fatG: acc.fatG + e.fatG,
      carbsG: acc.carbsG + e.carbsG,
      saltG: e.saltG == null ? acc.saltG : (acc.saltG ?? 0) + e.saltG,
      // Micronutrients: sum of the known values only (server summaries
      // use the same rule); a nutrient nobody knows stays null.
      ...sumMicros([acc, e]),
    }),
    { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0, saltG: null, ...emptyMicros() },
  );
  const isToday = date === todayJst();

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button
          aria-label="前日"
          onClick={() => setDate(addDays(date, -1))}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[var(--text)]"
        >
          ←
        </button>
        <div className="text-center">
          <p className="text-lg font-semibold text-[var(--text)]">
            {formatDateJa(date)}
            {isToday && (
              <span className="ml-2 rounded bg-[var(--accent)] px-1.5 py-0.5 text-xs font-semibold text-white">
                今日
              </span>
            )}
          </p>
          {!isToday && (
            <button
              onClick={() => setDate(todayJst())}
              className="text-xs text-[var(--accent)]"
            >
              今日に戻る
            </button>
          )}
        </div>
        <button
          aria-label="翌日"
          onClick={() => setDate(addDays(date, 1))}
          disabled={isToday}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[var(--text)] disabled:opacity-30"
        >
          →
        </button>
      </div>

      {/* Nutrition-label style summary panel */}
      <section
        aria-label="1日の合計"
        className="mb-4 rounded-[var(--radius)] border-2 border-[var(--text)] bg-[var(--surface)] px-4 py-3"
      >
        <p className="border-b border-[var(--border)] pb-1 text-xs font-semibold tracking-wide text-[var(--dim)]">
          栄養成分表示（1日分）
        </p>
        <div className="flex items-baseline gap-2 border-b border-[var(--border)] py-2">
          <span className="text-sm text-[var(--text)]">熱量</span>
          <span className="num ml-auto text-4xl font-bold text-[var(--text)]">
            {fmt(totals.kcal)}
          </span>
          <span className="text-sm text-[var(--dim)]">kcal</span>
          {settings?.targetKcal != null && (
            <span className="num text-xs text-[var(--dim)]">
              / 目標 {fmt(settings.targetKcal)}
            </span>
          )}
        </div>
        {settings?.targetKcal != null && (
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
            role="progressbar"
            aria-valuenow={Math.round(
              Math.min(100, (totals.kcal / settings.targetKcal) * 100),
            )}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="カロリー目標進捗"
          >
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{
                width: `${Math.min(100, (totals.kcal / settings.targetKcal) * 100)}%`,
              }}
            />
          </div>
        )}
        <div className="divide-y divide-[var(--border)]">
          <PfcRow
            label="たんぱく質"
            value={totals.proteinG}
            target={settings?.targetProteinG ?? null}
            color="var(--pfc-p)"
          />
          <PfcRow
            label="脂質"
            value={totals.fatG}
            target={settings?.targetFatG ?? null}
            color="var(--pfc-f)"
          />
          <PfcRow
            label="炭水化物"
            value={totals.carbsG}
            target={settings?.targetCarbsG ?? null}
            color="var(--pfc-c)"
          />
        </div>
        {totals.saltG != null && (
          <p className="num pt-1 text-right text-xs text-[var(--dim)]">
            食塩相当量 {fmt(totals.saltG)}g
          </p>
        )}
        {hasMicros(totals) && (
          <div className="mt-1 border-t border-[var(--border)] pt-2">
            <p className="mb-1 text-xs font-semibold text-[var(--dim)]">
              微量栄養素
            </p>
            <dl className="grid grid-cols-2 gap-x-4">
              {MICRO_FIELDS.filter((f) => totals[f.key] != null).map((f) => (
                <div
                  key={f.key}
                  className="flex items-baseline justify-between gap-2 py-0.5"
                >
                  <dt className="text-xs text-[var(--dim)]">{f.label}</dt>
                  <dd className="num text-sm text-[var(--text)]">
                    {fmtMicro(totals[f.key] as number)}
                    <span className="ml-0.5 text-xs text-[var(--dim)]">
                      {f.unit}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-1 text-right text-[11px] text-[var(--dim)]">
              値が分かる食品分のみの合計です（不明な分は含まれません）
            </p>
          </div>
        )}
        {entries.some((e) => e.eatingOut) && (
          <p className="pt-1 text-right text-xs text-[var(--accent)]">
            外食 {entries.filter((e) => e.eatingOut).length}件を含む日
            （推定の記録あり）
          </p>
        )}
      </section>

      {logs.isPending && <p className="py-6 text-center text-sm text-[var(--dim)]">読み込み中…</p>}
      {logs.error && (
        <p className="py-6 text-center text-sm text-[var(--accent)]">
          読み込めませんでした
        </p>
      )}

      {SLOTS.map((slot) => {
        const slotEntries = entries.filter((e) => e.slot === slot.key);
        return (
          <section key={slot.key} aria-label={slot.label} className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text)]">{slot.label}</h3>
              <button
                onClick={() => openPicker(slot.key)}
                aria-label={`${slot.label}に追加`}
                className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-sm text-[var(--accent)]"
              >
                ＋ 追加
              </button>
            </div>
            {slotEntries.length === 0 ? (
              <p className="py-1 text-sm text-[var(--dim)]">記録なし</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
                {slotEntries.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-base text-[var(--text)]">
                        {e.foodName}
                        {e.eatingOut && (
                          <span className="ml-1.5 rounded bg-[var(--accent)] px-1 align-middle text-[10px] font-semibold text-white">
                            外食
                          </span>
                        )}
                      </p>
                      <p className="num text-xs text-[var(--dim)]">
                        {fmt(e.quantity)}
                        {e.unit} · P{fmt(e.proteinG)} F{fmt(e.fatG)} C{fmt(e.carbsG)}
                        {e.saltG != null && ` · 食塩 ${fmt(e.saltG)}g`}
                      </p>
                      {e.assist &&
                        (e.assist.mode === "decomposed" &&
                        e.assist.parts ? (
                          <div className="mt-0.5 text-xs text-[var(--dim)]">
                            <p>
                              AIアシスト分解（推定）：
                              {e.assist.originalText}
                            </p>
                            <ul className="mt-0.5">
                              {e.assist.parts.map((p, i) => (
                                <li key={i}>
                                  ・{p.partName}
                                  {p.foodName != null &&
                                    p.foodName !== p.partName &&
                                    `（${p.foodName}）`}
                                  {p.grams != null &&
                                    ` ${fmt(p.grams)}g`}
                                  {p.status === "excluded" &&
                                    " — 計算対象外"}
                                  {p.status === "unmatched" &&
                                    " — 未マッチ（計算に含まれない）"}
                                  {p.rationale !== "" && (
                                    <span className="block pl-3">
                                      {p.rationale}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                            {e.assist.rationale !== "" && (
                              <p className="mt-0.5">{e.assist.rationale}</p>
                            )}
                          </div>
                        ) : (
                          <p className="mt-0.5 text-xs text-[var(--dim)]">
                            AIアシスト換算：{e.assist.originalText} → 基準「
                            {e.assist.baseFoodName}」
                            {e.assist.factor != null &&
                              ` ×${fmt(e.assist.factor)}`}
                            {e.assist.rationale !== "" && (
                              <span className="block">
                                {e.assist.rationale}
                              </span>
                            )}
                          </p>
                        ))}
                    </div>
                    <EatingOutToggle
                      on={e.eatingOut}
                      onChange={(next) =>
                        eatingOutMutation.mutate({ id: e.id, eatingOut: next })
                      }
                      label={`${e.foodName}の外食フラグを切り替え`}
                    />
                    <span className="num shrink-0 text-sm text-[var(--text)]">
                      {fmt(e.kcal)}
                      <span className="ml-0.5 text-xs text-[var(--dim)]">kcal</span>
                    </span>
                    <button
                      aria-label={`${e.foodName}の記録を削除`}
                      onClick={() => deleteMutation.mutate(e.id)}
                      className="shrink-0 px-1.5 text-lg leading-none text-[var(--dim)]"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {deleteMutation.error && (
        <p className="mt-2 text-sm text-[var(--accent)]">
          削除できませんでした：{String(deleteMutation.error)}
        </p>
      )}
      <button
        onClick={() => openPicker(defaultSlot())}
        className="mt-2 w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white"
      >
        ＋ 食事を記録
      </button>
      {!hasFoods && (
        <button
          onClick={openFoodForm}
          className="mt-2 w-full rounded-lg border border-dashed border-[var(--border)] py-2.5 text-sm text-[var(--accent)]"
        >
          まず食品を登録する
        </button>
      )}
    </div>
  );
}

// ---------- history (last 14 days) ----------

function HistoryView({ goToDate }: { goToDate: (d: string) => void }) {
  const today = todayJst();
  const start = addDays(today, -13);
  const summaries = useQuery({
    queryKey: ["summaries", start, today],
    queryFn: () => api.getDailySummaries({ startDate: start, endDate: today }),
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings({}),
  });
  const rows = [...(summaries.data?.summaries ?? [])].reverse();
  const maxKcal = Math.max(
    1,
    ...(summaries.data?.summaries.map((s) => s.kcal) ?? [1]),
    settings.data?.targetKcal ?? 0,
  );

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-[var(--text)]">直近14日</h2>
      {summaries.isPending && (
        <p className="py-6 text-center text-sm text-[var(--dim)]">読み込み中…</p>
      )}
      <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
        {rows.map((s) => (
          <li key={s.date}>
            <button
              onClick={() => goToDate(s.date)}
              className="w-full py-2.5 text-left"
              aria-label={`${formatDateJa(s.date)}の記録を開く`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-[var(--text)]">
                  {formatDateJa(s.date)}
                  {s.date === today && (
                    <span className="ml-1.5 text-xs text-[var(--accent)]">今日</span>
                  )}
                  {s.hasEatingOut && (
                    <span className="ml-1.5 rounded bg-[var(--accent)] px-1 py-0.5 align-middle text-[10px] font-semibold text-white">
                      外食
                    </span>
                  )}
                </span>
                {s.logged ? (
                  <span className="num text-sm text-[var(--text)]">
                    {fmt(s.kcal)}
                    <span className="ml-0.5 text-xs text-[var(--dim)]">kcal</span>
                    <span className="ml-2 text-xs text-[var(--dim)]">
                      P{fmt(s.proteinG)} F{fmt(s.fatG)} C{fmt(s.carbsG)}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm text-[var(--dim)]">記録なし</span>
                )}
              </div>
              {s.logged && (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)]"
                    style={{ width: `${Math.min(100, (s.kcal / maxKcal) * 100)}%` }}
                  />
                </div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- consumption pace （消費ペース） ----------
//
// Shopping-reference view: how fast the selected foods are used up, in
// grams, averaged over a long window — daily intake swings too much
// for a short one (soy drops on eating-out nights, whey appears after
// hard training). Several foods can be selected and totalled (e.g. all
// soy proteins together, for replacement comparisons), and a selection
// can be saved under a name. All figures come from
// getConsumptionStats, computed server-side from the meal logs
// (direct entries + decomposition parts + recipe ingredients).

type ConsGroup =
  ApiResponse<typeof api, "listConsumptionGroups">["groups"][number];

const PACE_WINDOWS: Array<{ days: number; label: string }> = [
  { days: 30, label: "30日" },
  { days: 90, label: "90日" },
  { days: 180, label: "180日" },
  { days: 365, label: "1年" },
  { days: 0, label: "全期間" },
];

const PACE_SELECTION_KEY = "consumptionSelectionV1";

function loadPaceSelection(): { ids: number[]; days: number } {
  try {
    const raw = localStorage.getItem(PACE_SELECTION_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as { ids?: unknown; days?: unknown };
      return {
        ids: Array.isArray(p.ids)
          ? p.ids.filter((n): n is number => typeof n === "number")
          : [],
        days: typeof p.days === "number" ? p.days : 90,
      };
    }
  } catch {
    // Storage unavailable — start from the defaults.
  }
  return { ids: [], days: 90 };
}

function storePaceSelection(ids: number[], days: number) {
  try {
    localStorage.setItem(PACE_SELECTION_KEY, JSON.stringify({ ids, days }));
  } catch {
    // Storage unavailable — the selection just won't persist.
  }
}

/** Grams with a kg switch for large totals: 105 g / 5.25 kg. */
const fmtGrams = (g: number): string =>
  g >= 1000 ? `${fmt(Math.round(g / 10) / 100)} kg` : `${fmt(Math.round(g))} g`;

function ConsumptionPicker({
  selectedIds,
  onToggle,
  onClose,
}: {
  selectedIds: number[];
  onToggle: (id: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const usedQuery = useQuery({
    queryKey: ["usedFoods"],
    queryFn: () => api.listUsedFoods({}),
  });
  const search = useFoodSearch(query, 50);
  const list = searching
    ? (search.data?.foods ?? [])
    : (usedQuery.data?.foods ?? []);
  const pending = searching ? search.isPending : usedQuery.isPending;
  return (
    <Sheet title="食品を選ぶ" onClose={onClose}>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="食品名で検索"
        aria-label="食品名で検索"
        className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
      />
      <p className="mt-2 text-xs text-[var(--dim)]">
        {searching
          ? `検索結果 ${search.data?.total ?? 0} 件`
          : "使ったことのある食品（よく使う順）"}
      </p>
      {pending ? (
        <p className="py-6 text-center text-sm text-[var(--dim)]">
          読み込み中…
        </p>
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--dim)]">
          {searching
            ? "見つかりませんでした"
            : "まだ記録に使った食品がありません。上の検索から選べます。"}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--border)]">
          {list.map((f) => {
            const on = selectedIds.includes(f.id);
            return (
              <li key={f.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onToggle(f.id)}
                  className="flex w-full items-center gap-2 py-2.5 text-left"
                >
                  <span
                    aria-hidden
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${
                      on
                        ? "border-[var(--accent)] bg-[var(--accent)] font-bold text-white"
                        : "border-[var(--border)] text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--text)]">
                      {f.name}
                    </span>
                    <span className="block text-xs text-[var(--dim)]">
                      {f.basisLabel}
                      {f.useCount > 0 ? ` · ${f.useCount}回記録` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        onClick={onClose}
        className="mt-3 w-full rounded-[var(--radius)] bg-[var(--accent)] py-2.5 text-base font-semibold text-white"
      >
        完了（{selectedIds.length}件選択中）
      </button>
    </Sheet>
  );
}

function ConsumptionView() {
  const queryClient = useQueryClient();
  const [initial] = useState(loadPaceSelection);
  const [selectedIds, setSelectedIds] = useState<number[]>(initial.ids);
  const [days, setDays] = useState<number>(initial.days);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => {
    storePaceSelection(selectedIds, days);
  }, [selectedIds, days]);

  const toggleFood = (id: number) =>
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= 30
          ? prev
          : [...prev, id],
    );

  const selectedFoodsQuery = useQuery({
    queryKey: ["consumptionFoods", selectedIds.join(",")],
    queryFn: () => api.getFoodsByIds({ ids: selectedIds }),
    enabled: selectedIds.length > 0,
  });
  const foodNameById = new Map(
    (selectedFoodsQuery.data?.foods ?? []).map((f) => [f.id, f.name]),
  );

  const statsQuery = useQuery({
    queryKey: ["consumptionStats", selectedIds.join(","), days],
    queryFn: () => api.getConsumptionStats({ foodIds: selectedIds, days }),
    enabled: selectedIds.length > 0,
  });
  const stats = statsQuery.data;

  const groupsQuery = useQuery({
    queryKey: ["consumptionGroups"],
    queryFn: () => api.listConsumptionGroups({}),
  });
  const groups: ConsGroup[] = groupsQuery.data?.groups ?? [];

  const suggestionsQuery = useQuery({
    queryKey: ["relatedFoods", selectedIds.join(",")],
    queryFn: () => api.suggestRelatedFoods({ foodIds: selectedIds }),
    enabled: selectedIds.length > 0,
  });
  const suggestions = (suggestionsQuery.data?.suggestions ?? []).filter(
    (s) => !selectedIds.includes(s.food.id),
  );

  const saveGroupMutation = useMutation({
    mutationFn: async () =>
      api.saveConsumptionGroup({
        name: groupName.trim(),
        foodIds: selectedIds,
      }),
    onSuccess: () => {
      setGroupName("");
      void queryClient.invalidateQueries({ queryKey: ["consumptionGroups"] });
    },
  });
  const deleteGroupMutation = useMutation({
    mutationFn: async (id: number) => api.deleteConsumptionGroup({ id }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: ["consumptionGroups"] });
    },
  });

  const weeklyShown = stats ? stats.weekly.slice(-26) : [];
  const weeklyMax = Math.max(1, ...weeklyShown.map((w) => w.grams));

  return (
    <div>
      <h2 className="text-base font-semibold text-[var(--text)]">消費ペース</h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        食事の記録から、選んだ食品がどのくらいの速さで消費されているかをグラム換算で見ます。日々のブレが大きいので、長めの期間でならした買い出し用の参考値です。レシピの材料やAIアシストの分解分も合算します。
      </p>

      <div
        className="mt-4 flex flex-wrap gap-1.5"
        role="group"
        aria-label="対象期間"
      >
        {PACE_WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            aria-pressed={days === w.days}
            onClick={() => setDays(w.days)}
            className={`rounded-full border px-3 py-1.5 text-sm ${
              days === w.days
                ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
                : "border-[var(--border)] text-[var(--dim)]"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      <section aria-label="選択中の食品" className="mt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedIds.map((id) => {
            const name = foodNameById.get(id) ?? "読み込み中…";
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] px-2.5 py-1 text-sm text-[var(--text)]"
              >
                {name}
                <button
                  type="button"
                  aria-label={`${name}を外す`}
                  onClick={() => toggleFood(id)}
                  className="px-1 leading-none text-[var(--dim)]"
                >
                  ×
                </button>
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="rounded-full border border-dashed border-[var(--border)] px-3 py-1 text-sm text-[var(--accent)]"
          >
            ＋ 食品を選ぶ
          </button>
        </div>
        {selectedIds.length === 0 && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            食品を選ぶと、その食品の消費ペースが表示されます。複数選ぶと合算できます（例：ソイプロテイン全部）。
          </p>
        )}
      </section>

      {selectedIds.length > 0 && (
        <section aria-label="消費ペースの結果" className="mt-5">
          {statsQuery.isPending && (
            <p className="py-6 text-center text-sm text-[var(--dim)]">
              読み込み中…
            </p>
          )}
          {statsQuery.isError && (
            <p className="py-6 text-center text-sm text-[var(--dim)]">
              読み込めませんでした
            </p>
          )}
          {stats && stats.total.entries === 0 && (
            <p className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-4 text-center text-sm text-[var(--dim)]">
              この期間に、選んだ食品の記録はありません。
            </p>
          )}
          {stats && stats.total.entries > 0 && (
            <>
              <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
                <p className="text-xs text-[var(--dim)]">
                  {formatDateJa(stats.from)}〜{formatDateJa(stats.to)}
                  {stats.observationDays < stats.windowDays &&
                    `（記録のある${stats.observationDays}日分で計算）`}
                </p>
                {stats.total.grams != null ? (
                  <>
                    <p className="num mt-1 text-2xl font-bold text-[var(--text)]">
                      合計 {fmtGrams(stats.total.grams)}
                      <span className="ml-2 text-sm font-normal text-[var(--dim)]">
                        消費
                      </span>
                    </p>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                      {(
                        [
                          ["週あたり", stats.total.perWeek],
                          ["月あたり", stats.total.perMonth],
                          ["年あたり", stats.total.perYear],
                        ] as const
                      ).map(([label, v]) => (
                        <div
                          key={label}
                          className="rounded-[var(--radius)] bg-[var(--bg)] px-1 py-2"
                        >
                          <dt className="text-xs text-[var(--dim)]">{label}</dt>
                          <dd className="num mt-0.5 text-base font-semibold text-[var(--text)]">
                            {v != null ? fmtGrams(v) : "—"}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-[var(--text)]">
                    グラム換算できる記録がありません（件数と日数だけ分かります）。
                  </p>
                )}
                <p className="mt-2 text-sm text-[var(--dim)]">
                  消費した日 {stats.total.daysUsed}日 · 記録{" "}
                  {stats.total.entries}件
                </p>
                {stats.total.unconverted > 0 && (
                  <p className="mt-1 text-xs text-[var(--dim)]">
                    ※
                    グラム換算できない記録が{stats.total.unconverted}
                    件あります（1単位のグラム数が未設定の食品）。その分はグラム合計に含まれていません。
                  </p>
                )}
              </div>

              {stats.total.grams != null && weeklyShown.length > 1 && (
                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-[var(--text)]">
                    週ごとの消費量
                  </h3>
                  <ul className="mt-2 space-y-1">
                    {weeklyShown.map((w) => (
                      <li key={w.weekStart} className="flex items-center gap-2">
                        <span className="w-12 shrink-0 text-xs text-[var(--dim)]">
                          {w.weekStart.slice(5).replace("-", "/")}〜
                        </span>
                        <div className="h-3 flex-1 overflow-hidden rounded bg-[var(--border)]">
                          <div
                            className="h-full rounded bg-[var(--accent)]"
                            style={{
                              width: `${(w.grams / weeklyMax) * 100}%`,
                            }}
                          />
                        </div>
                        <span className="num w-16 shrink-0 text-right text-xs text-[var(--text)]">
                          {fmtGrams(w.grams)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {stats.weekly.length > weeklyShown.length && (
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      直近{weeklyShown.length}週を表示しています
                    </p>
                  )}
                </div>
              )}

              {stats.foods.length > 1 && (
                <div className="mt-4">
                  <h3 className="text-sm font-semibold text-[var(--text)]">
                    内訳
                  </h3>
                  <ul className="mt-1 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
                    {stats.foods.map((f) => (
                      <li key={f.foodId} className="py-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-sm text-[var(--text)]">
                            {f.name}
                          </span>
                          <span className="num shrink-0 text-sm font-semibold text-[var(--text)]">
                            {f.grams != null ? fmtGrams(f.grams) : "—"}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-[var(--dim)]">
                          {f.perWeek != null && (
                            <>週あたり {fmtGrams(f.perWeek)} · </>
                          )}
                          {f.daysUsed}日 · {f.entries}件
                          {f.unconverted > 0 && (
                            <> · 換算不可 {f.unconverted}件</>
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {suggestions.length > 0 && (
        <section aria-label="似ている食品" className="mt-6">
          <h3 className="text-sm font-semibold text-[var(--text)]">
            似ている食品（まとめ候補）
          </h3>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            栄養成分と名前の近さから計算した候補です。自動ではまとめません。
          </p>
          <ul className="mt-1 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
            {suggestions.map((s) => (
              <li
                key={s.food.id}
                className="flex items-center gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-[var(--text)]">
                    {s.food.name}
                  </p>
                  <p className="text-xs text-[var(--dim)]">
                    「{s.similarTo}」に近い · 類似度{" "}
                    {Math.round(s.score * 100)}%
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleFood(s.food.id)}
                  aria-label={`${s.food.name}を追加`}
                  className="shrink-0 rounded-full border border-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-[var(--accent)]"
                >
                  ＋ 追加
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="保存したまとめ" className="mt-6">
        <h3 className="text-sm font-semibold text-[var(--text)]">
          保存したまとめ
        </h3>
        {groups.length === 0 ? (
          <p className="mt-1 text-sm text-[var(--dim)]">
            まだありません。今の選択に名前を付けて保存すると、次から一括で選べます。
          </p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedIds(g.foods.map((f) => f.id))}
                  className="min-w-0 flex-1 truncate rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-sm text-[var(--text)]"
                >
                  {g.name}
                  <span className="ml-1.5 text-xs text-[var(--dim)]">
                    {g.foods.length}品
                  </span>
                </button>
                {confirmDeleteId === g.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => deleteGroupMutation.mutate(g.id)}
                      disabled={deleteGroupMutation.isPending}
                      className="shrink-0 rounded-full bg-[var(--accent)] px-2.5 py-1 text-xs font-semibold text-white"
                    >
                      削除する
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="shrink-0 px-1 text-xs text-[var(--dim)]"
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    aria-label={`${g.name}を削除`}
                    onClick={() => setConfirmDeleteId(g.id)}
                    className="shrink-0 px-1 text-xs text-[var(--dim)]"
                  >
                    削除
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {selectedIds.length > 0 && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (groupName.trim()) saveGroupMutation.mutate();
            }}
          >
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="まとめの名前（例：ソイ系）"
              aria-label="まとめの名前"
              maxLength={50}
              className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
            <button
              type="submit"
              disabled={!groupName.trim() || saveGroupMutation.isPending}
              className="shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saveGroupMutation.isPending ? "保存中…" : "この選択を保存"}
            </button>
          </form>
        )}
        {saveGroupMutation.isError && (
          <p className="mt-1 text-xs text-[var(--accent)]">
            保存できませんでした：{String(saveGroupMutation.error)}
          </p>
        )}
      </section>

      {pickerOpen && (
        <ConsumptionPicker
          selectedIds={selectedIds}
          onToggle={toggleFood}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- foods master ----------

const SOURCE_LABEL: Record<Food["source"], string> = {
  table: "成分表",
  label: "ラベル写真",
  manual: "手入力",
  ai: "AI調査",
  blend: "配合計算",
};

function FoodsView({
  onAdd,
  onBlend,
  onEdit,
}: {
  onAdd: () => void;
  onBlend: () => void;
  onEdit: (food: Food) => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const search = useFoodSearch(query, 100);
  const importMutation = useMutation({
    mutationFn: () => api.importFoodTable({}),
    onSuccess: (res) => {
      queryClient.invalidateQueries();
      const skippedNote =
        res.skipped > 0
          ? `／同名の食品が既にあるため ${res.skipped} 件を飛ばしました（例：${res.skippedNames.join("・")}）`
          : "";
      setImportNote(
        (res.inserted > 0 || res.tagged > 0
          ? `成分表から ${res.inserted} 件を追加しました（マスタ全 ${res.total} 件）`
          : `成分表はすべて取り込み済みです（マスタ全 ${res.total} 件）`) +
          skippedNote,
      );
    },
    onError: () => setImportNote("取り込みに失敗しました"),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteFood({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      setConfirmDelete(null);
    },
  });
  const visible = search.data?.foods ?? [];
  const total = search.data?.total ?? 0;

  return (
    <div>
      <div className="mb-2 flex gap-2">
        <input
          aria-label="食品を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="食品を検索（成分表の全食品から）"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
        />
        <button
          onClick={onAdd}
          className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white"
        >
          ＋ 登録
        </button>
      </div>
      <button
        onClick={onBlend}
        className="mb-2 w-full rounded-lg border border-dashed border-[var(--border)] py-2 text-sm text-[var(--accent)]"
      >
        部品を組み合わせて配合食品を作る（成分表から計算）
      </button>
      <p className="mb-2 text-xs text-[var(--dim)]">
        {query.trim()
          ? `「${query.trim()}」の検索結果 ${total} 件`
          : `食品マスタ全 ${total} 件（よく使う順）`}
        {total > visible.length &&
          ` · ${visible.length} 件を表示中、検索で絞り込めます`}
      </p>
      {deleteMutation.error && (
        <p className="mb-2 text-sm text-[var(--accent)]">
          削除できませんでした：{String(deleteMutation.error)}
        </p>
      )}
      {total === 0 && !search.isPending ? (
        <div className="py-8 text-center">
          <p className="mb-3 text-sm text-[var(--dim)]">まだ食品が登録されていません</p>
          <button
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
            className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
          >
            {importMutation.isPending
              ? "取り込み中…"
              : "成分表の全食品（約2,500件）を入れる"}
          </button>
          <p className="mx-auto mt-3 max-w-xs text-xs text-[var(--dim)]">
            日本食品標準成分表（八訂）増補2023の全食品を100gあたりの値で取り込みます。加工品は「＋
            登録」から栄養成分表示の写真やAI調査（出典つき）で登録できます。
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
          {visible.map((food) => (
            <li key={food.id} className="py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-base text-[var(--text)]">
                  {food.name}
                </p>
                <span className="num shrink-0 text-sm text-[var(--text)]">
                  {fmt(food.kcal)}
                  <span className="ml-0.5 text-xs text-[var(--dim)]">kcal</span>
                </span>
              </div>
              <p className="num mt-0.5 text-xs text-[var(--dim)]">
                {food.basisLabel} · P{fmt(food.proteinG)} F{fmt(food.fatG)} C
                {fmt(food.carbsG)}
                {food.saltG != null && ` · 食塩 ${fmt(food.saltG)}g`} ·{" "}
                {SOURCE_LABEL[food.source]} · 既定 {fmt(food.defaultAmount)}
                {food.defaultUnit}
              </p>
              {hasMicros(food) && (
                <p className="num mt-0.5 text-xs text-[var(--dim)]">
                  {microText(food)}
                </p>
              )}
              {food.sourceUrl && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  出典：
                  <a
                    href={food.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] underline"
                  >
                    {food.sourceName ?? food.sourceUrl}
                  </a>
                </p>
              )}
              {food.source === "blend" && food.sourceName && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  根拠：{food.sourceName}
                </p>
              )}
              <div className="mt-1 flex gap-3">
                <button
                  onClick={() => onEdit(food)}
                  className="py-1 text-sm text-[var(--accent)]"
                >
                  編集
                </button>
                {confirmDelete === food.id ? (
                  <>
                    <button
                      onClick={() => deleteMutation.mutate(food.id)}
                      className="py-1 text-sm font-semibold text-[var(--accent)]"
                    >
                      本当に削除する
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="py-1 text-sm text-[var(--dim)]"
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(food.id)}
                    className="py-1 text-sm text-[var(--dim)]"
                  >
                    削除
                  </button>
                )}
              </div>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="py-4 text-center text-sm text-[var(--dim)]">
              見つかりませんでした
            </li>
          )}
        </ul>
      )}
      {(total > 0 || importNote) && (
        <div className="mt-3 text-center">
          <button
            onClick={() => importMutation.mutate()}
            disabled={importMutation.isPending}
            className="py-1 text-sm text-[var(--accent)] disabled:opacity-50"
          >
            {importMutation.isPending
              ? "取り込み中…"
              : "成分表の全食品を取り込む（未取り込み分）"}
          </button>
          {importNote && (
            <p className="mt-1 text-xs text-[var(--dim)]">{importNote}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- AI research records ----------

function formatInstantJa(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function ResearchSection({
  onUseDraft,
}: {
  onUseDraft: (record: Research) => void;
}) {
  const queryClient = useQueryClient();
  const research = useQuery({
    queryKey: ["research"],
    queryFn: () => api.listResearch({}),
  });
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteResearch({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["research"] });
      setConfirmDelete(null);
    },
  });
  const records = research.data?.records ?? [];
  if (research.isPending || records.length === 0) return null;

  return (
    <section aria-label="AI調査の記録" className="mt-6">
      <h2 className="mb-1 text-base font-semibold text-[var(--text)]">
        AI調査の記録
      </h2>
      <p className="mb-2 text-xs text-[var(--dim)]">
        「AIで調べる」で調べた食品はここに残ります。同じ食品名の調査は次回この記録から表示され、調べ直しはしません。
      </p>
      {deleteMutation.error && (
        <p className="mb-2 text-sm text-[var(--accent)]">
          削除できませんでした：{String(deleteMutation.error)}
        </p>
      )}
      <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
        {records.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-base text-[var(--text)]">
                {r.maker ? `${r.maker} ` : ""}
                {r.name ?? r.queryName}
              </p>
              <span className="shrink-0 text-xs text-[var(--dim)]">
                {formatInstantJa(r.updatedAt)} 調査
              </span>
            </div>
            {r.status === "found" ? (
              <>
                <p className="num mt-0.5 text-xs text-[var(--dim)]">
                  {r.basisLabel} · {fmt(r.kcal ?? 0)} kcal · P{fmt(r.proteinG ?? 0)}{" "}
                  F{fmt(r.fatG ?? 0)} C{fmt(r.carbsG ?? 0)}
                  {r.saltG != null && ` · 食塩 ${fmt(r.saltG)}g`}
                </p>
                {hasMicros(r) && (
                  <p className="num mt-0.5 text-xs text-[var(--dim)]">
                    {microText(r)}
                  </p>
                )}
                {r.sourceUrl && (
                  <p className="mt-0.5 text-xs text-[var(--dim)]">
                    出典：
                    <a
                      href={r.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--accent)] underline"
                    >
                      {r.sourceName ?? r.sourceUrl}
                    </a>
                  </p>
                )}
              </>
            ) : (
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                信頼できる出典が見つからなかった記録です
              </p>
            )}
            <div className="mt-1 flex gap-3">
              {r.status === "found" && (
                <button
                  onClick={() => onUseDraft(r)}
                  className="py-1 text-sm text-[var(--accent)]"
                >
                  この内容で食品を登録
                </button>
              )}
              {confirmDelete === r.id ? (
                <>
                  <button
                    onClick={() => deleteMutation.mutate(r.id)}
                    className="py-1 text-sm font-semibold text-[var(--accent)]"
                  >
                    本当に削除する
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="py-1 text-sm text-[var(--dim)]"
                  >
                    やめる
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDelete(r.id)}
                  className="py-1 text-sm text-[var(--dim)]"
                >
                  記録を削除
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- recipes ----------

type RecipeDraft = NonNullable<
  ApiResponse<typeof api, "getRecipeImport">["import"]["draft"]
>;

type IngredientForm = {
  name: string;
  amount: string;
  unit: string;
  amountText: string;
  grams: string;
  matchedFoodId: number | null;
  matchedFoodName: string | null;
  basisMode: "food" | "manual" | "unknown";
  kcal: string;
  proteinG: string;
  fatG: string;
  carbsG: string;
  saltG: string;
} & Record<MicroKey, string>;

type RecipeFormState = {
  title: string;
  servings: string;
  servingsLabel: string;
  sourceType: "url" | "photo" | "manual";
  sourceUrl: string;
  ingredients: IngredientForm[];
};

const numStr = (n: number | null): string => (n == null ? "" : String(n));
const parseNum = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function blankIngredient(): IngredientForm {
  return {
    name: "",
    amount: "",
    unit: "",
    amountText: "",
    grams: "",
    matchedFoodId: null,
    matchedFoodName: null,
    basisMode: "manual",
    kcal: "",
    proteinG: "",
    fatG: "",
    carbsG: "",
    saltG: "",
    ...microFormFields(emptyMicros()),
  };
}

function ingredientToForm(ing: Ingredient): IngredientForm {
  return {
    name: ing.name,
    amount: numStr(ing.amount),
    unit: ing.unit,
    amountText: ing.amountText,
    grams: numStr(ing.grams),
    matchedFoodId: ing.matchedFoodId,
    matchedFoodName: ing.matchedFoodName,
    basisMode: ing.basisMode,
    kcal: numStr(ing.kcal),
    proteinG: numStr(ing.proteinG),
    fatG: numStr(ing.fatG),
    carbsG: numStr(ing.carbsG),
    saltG: numStr(ing.saltG),
    ...microFormFields(ing),
  };
}

function formToIngredient(f: IngredientForm): Ingredient {
  const unknown = f.basisMode === "unknown";
  return {
    name: f.name.trim(),
    amount: parseNum(f.amount),
    unit: f.unit.trim(),
    amountText: f.amountText,
    grams: parseNum(f.grams),
    matchedFoodId: f.matchedFoodId,
    matchedFoodName: f.matchedFoodName,
    basisMode: f.basisMode,
    kcal: unknown ? null : parseNum(f.kcal),
    proteinG: unknown ? null : parseNum(f.proteinG),
    fatG: unknown ? null : parseNum(f.fatG),
    carbsG: unknown ? null : parseNum(f.carbsG),
    saltG: unknown ? null : parseNum(f.saltG),
    ...(() => {
      const out = {} as MicroMap;
      for (const mf of MICRO_FIELDS) {
        out[mf.key] = unknown ? null : parseNum(f[mf.key]);
      }
      return out;
    })(),
  };
}

function recipeToForm(recipe: Recipe): RecipeFormState {
  return {
    title: recipe.title,
    servings: numStr(recipe.servings),
    servingsLabel: recipe.servingsLabel,
    sourceType: recipe.sourceType,
    sourceUrl: recipe.sourceUrl ?? "",
    ingredients: recipe.ingredients.map(ingredientToForm),
  };
}

function draftToForm(draft: RecipeDraft): RecipeFormState {
  return {
    title: draft.title,
    servings: numStr(draft.servings),
    servingsLabel: draft.servingsLabel,
    sourceType: draft.sourceType,
    sourceUrl: draft.sourceUrl ?? "",
    ingredients: draft.ingredients.map(ingredientToForm),
  };
}

const emptyRecipeForm: RecipeFormState = {
  title: "",
  servings: "",
  servingsLabel: "",
  sourceType: "manual",
  sourceUrl: "",
  ingredients: [blankIngredient()],
};

/**
 * Per-line basis picker for the recipe editor. The master holds ~2,500
 * foods, so instead of a giant <select> this is a search box over the
 * server-side food search; picking a result links the line to that food.
 */
function FoodBasisSearch({
  ingredientName,
  onPick,
  onClose,
}: {
  ingredientName: string;
  onPick: (food: Food | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useFoodSearch(query, 20);
  const results = search.data?.foods ?? [];
  return (
    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
      <input
        aria-label={`${ingredientName || "材料"}の根拠を検索`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="食品名で検索（成分表の全食品から）"
        autoFocus
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]"
      />
      <ul className="mt-1 max-h-52 divide-y divide-[var(--border)] overflow-y-auto">
        <li>
          <button
            onClick={() => onPick(null)}
            className="w-full py-2 text-left text-sm text-[var(--text)]"
          >
            根拠：手入力（マスタと対応づけない）
          </button>
        </li>
        {results.map((f) => (
          <li key={f.id}>
            <button
              onClick={() => onPick(f)}
              className="w-full py-2 text-left text-sm text-[var(--text)]"
            >
              根拠：{f.name}（{f.basisLabel}）
              <span className="num ml-1 text-xs text-[var(--dim)]">
                {fmt(f.kcal)} kcal
              </span>
            </button>
          </li>
        ))}
        {search.isPending && (
          <li className="py-2 text-sm text-[var(--dim)]">検索中…</li>
        )}
        {!search.isPending && results.length === 0 && query.trim() !== "" && (
          <li className="py-2 text-sm text-[var(--dim)]">見つかりませんでした</li>
        )}
      </ul>
      {search.data && search.data.total > results.length && (
        <p className="mt-1 text-xs text-[var(--dim)]">
          他 {search.data.total - results.length} 件あります。検索で絞り込んでください
        </p>
      )}
      <button
        onClick={onClose}
        className="mt-1 py-1 text-xs text-[var(--dim)]"
      >
        閉じる
      </button>
    </div>
  );
}

function FoodBasisPicker({
  ingredientName,
  matchedFoodId,
  matchedFoodName,
  knownFood,
  onPick,
}: {
  ingredientName: string;
  matchedFoodId: number | null;
  matchedFoodName: string | null;
  knownFood: Food | null;
  onPick: (food: Food | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    matchedFoodId == null
      ? "根拠：手入力（マスタと対応づけない）"
      : `根拠：${knownFood ? `${knownFood.name}（${knownFood.basisLabel}）` : (matchedFoodName ?? "読み込み中…")}`;
  return (
    <div>
      <button
        aria-label={`${ingredientName || "材料"}の根拠（食品マスタ）`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-left text-sm text-[var(--text)]"
      >
        {label}
        <span className="float-right text-[var(--dim)]">▾</span>
      </button>
      {open && (
        <FoodBasisSearch
          ingredientName={ingredientName}
          onPick={(food) => {
            onPick(food);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function RecipeEditor({
  initial,
  recipeId,
  onClose,
}: {
  initial: RecipeFormState;
  recipeId?: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RecipeFormState>(initial);
  const [openNutri, setOpenNutri] = useState<number | null>(null);
  // Foods this editor has resolved (already-matched lines fetched by id,
  // plus anything picked while editing) — the master is far too large to
  // hold whole just for recomputing lines.
  const [knownFoods, setKnownFoods] = useState<Map<number, Food>>(new Map());
  const initialIds = [
    ...new Set(
      initial.ingredients
        .map((l) => l.matchedFoodId)
        .filter((x): x is number => x != null),
    ),
  ];
  const byIds = useQuery({
    queryKey: ["foodsByIds", initialIds.join(",")],
    queryFn: () => api.getFoodsByIds({ ids: initialIds }),
    enabled: initialIds.length > 0,
  });
  useEffect(() => {
    if (!byIds.data) return;
    setKnownFoods((prev) => {
      const m = new Map(prev);
      for (const f of byIds.data.foods) m.set(f.id, f);
      return m;
    });
  }, [byIds.data]);

  const set = (patch: Partial<RecipeFormState>) =>
    setForm((f) => ({ ...f, ...patch }));

  const setLine = (i: number, patch: Partial<IngredientForm>) =>
    setForm((f) => ({
      ...f,
      ingredients: f.ingredients.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    }));

  /** Recompute a line's nutrients from its matched master food + grams. */
  const recomputeWith = (
    map: Map<number, Food>,
    line: IngredientForm,
  ): IngredientForm => {
    if (line.matchedFoodId == null) return line;
    const food = map.get(line.matchedFoodId);
    const grams = parseNum(line.grams);
    if (!food || grams == null) return line;
    const n = previewNutrients(food, grams, "g");
    if (!n) return { ...line, basisMode: "unknown" };
    return {
      ...line,
      basisMode: "food",
      matchedFoodName: food.name,
      kcal: String(n.kcal),
      proteinG: String(n.proteinG),
      fatG: String(n.fatG),
      carbsG: String(n.carbsG),
      saltG: numStr(n.saltG),
      ...microFormFields(n),
    };
  };
  const recompute = (line: IngredientForm): IngredientForm =>
    recomputeWith(knownFoods, line);

  const pickFood = (i: number, food: Food | null) => {
    const line = form.ingredients[i];
    if (!line) return;
    if (food == null) {
      // Detach from the master: current numbers stay, now hand-editable.
      setLine(i, { matchedFoodId: null, matchedFoodName: null, basisMode: "manual" });
      return;
    }
    const map = new Map(knownFoods).set(food.id, food);
    setKnownFoods(map);
    const next: IngredientForm = {
      ...line,
      matchedFoodId: food.id,
      matchedFoodName: food.name,
      basisMode: "unknown",
    };
    setLine(i, recomputeWith(map, next));
  };

  const lines = form.ingredients.map(formToIngredient);
  const namedLines = lines.filter((l) => l.name !== "");
  let tKcal = 0, tP = 0, tF = 0, tC = 0, tSalt: number | null = null, incomplete = 0;
  const knownLines: Ingredient[] = [];
  for (const l of namedLines) {
    if (l.kcal == null || l.proteinG == null || l.fatG == null || l.carbsG == null) {
      incomplete++;
      continue;
    }
    knownLines.push(l);
    tKcal += l.kcal;
    tP += l.proteinG;
    tF += l.fatG;
    tC += l.carbsG;
    if (l.saltG != null) tSalt = (tSalt ?? 0) + l.saltG;
  }
  const tMicros = sumMicros(knownLines);
  const servingsNum = parseNum(form.servings);
  const perServing =
    servingsNum != null && servingsNum > 0
      ? {
          kcal: Math.round(tKcal / servingsNum),
          proteinG: Math.round((tP / servingsNum) * 10) / 10,
          fatG: Math.round((tF / servingsNum) * 10) / 10,
          carbsG: Math.round((tC / servingsNum) * 10) / 10,
          micros: scaleMicros(tMicros, 1 / servingsNum),
        }
      : null;

  const saveMutation = useMutation({
    mutationFn: async () =>
      api.saveRecipe({
        id: recipeId,
        title: form.title.trim(),
        servings: servingsNum,
        servingsLabel: form.servingsLabel.trim(),
        sourceType: form.sourceType,
        sourceUrl:
          form.sourceType === "url" && form.sourceUrl.trim() !== ""
            ? form.sourceUrl.trim()
            : null,
        ingredients: namedLines,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      onClose();
    },
  });

  const valid = form.title.trim() !== "" && namedLines.length > 0;

  const nutriInput = (
    i: number,
    key: "kcal" | "proteinG" | "fatG" | "carbsG" | "saltG" | MicroKey,
    label: string,
  ) => (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-[var(--dim)]">{label}</span>
      <input
        aria-label={`${form.ingredients[i]?.name || "材料"}の${label}`}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={form.ingredients[i]?.[key] ?? ""}
        onChange={(e) =>
          setLine(i, { [key]: e.target.value, basisMode: "manual" } as Partial<IngredientForm>)
        }
        className="num w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]"
      />
    </label>
  );

  return (
    <Sheet title={recipeId ? "レシピを編集" : "レシピを保存"} onClose={onClose}>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">料理名</span>
        <input
          aria-label="料理名"
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="例：鶏むね肉のサラダチキン"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
        />
      </label>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">何人分（数値）</span>
          <input
            aria-label="何人分"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={form.servings}
            onChange={(e) => set({ servings: e.target.value })}
            placeholder="例：2"
            className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">分量の表記</span>
          <input
            aria-label="分量の表記"
            value={form.servingsLabel}
            onChange={(e) => set({ servingsLabel: e.target.value })}
            placeholder="例：2人分・直径20cm型1台"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
      </div>
      {form.sourceType === "url" && form.sourceUrl !== "" && (
        <p className="mb-3 truncate text-xs text-[var(--dim)]">
          推定元：
          <a
            href={form.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--accent)] underline"
          >
            {form.sourceUrl}
          </a>
        </p>
      )}
      <p className="mb-2 text-xs text-[var(--dim)]">
        材料ごとに根拠を確認できます。食品マスタと対応づいた材料は、その食品の値×グラム数で計算されます。対応づけ・グラム数・栄養値を直すと合計が変わります。
      </p>

      <ul className="mb-2 space-y-2">
        {form.ingredients.map((line, i) => (
          <li
            key={i}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label="材料名"
                value={line.name}
                onChange={(e) => setLine(i, { name: e.target.value })}
                placeholder="材料名"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-base text-[var(--text)]"
              />
              <button
                aria-label={`${line.name || "材料"}を削除`}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    ingredients: f.ingredients.filter((_, j) => j !== i),
                  }))
                }
                className="shrink-0 px-1.5 text-lg leading-none text-[var(--dim)]"
              >
                ×
              </button>
            </div>
            <div className="mt-2 flex items-end gap-2">
              <label className="w-20 shrink-0">
                <span className="mb-0.5 block text-[11px] text-[var(--dim)]">分量</span>
                <input
                  aria-label={`${line.name || "材料"}の分量`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={line.amount}
                  onChange={(e) => setLine(i, { amount: e.target.value })}
                  className="num w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                />
              </label>
              <label className="w-16 shrink-0">
                <span className="mb-0.5 block text-[11px] text-[var(--dim)]">単位</span>
                <input
                  aria-label={`${line.name || "材料"}の単位`}
                  value={line.unit}
                  onChange={(e) => setLine(i, { unit: e.target.value })}
                  placeholder="個・枚…"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                />
              </label>
              <label className="min-w-0 flex-1">
                <span className="mb-0.5 block text-[11px] text-[var(--dim)]">
                  グラム換算（計算のもと）
                </span>
                <input
                  aria-label={`${line.name || "材料"}のグラム数`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={line.grams}
                  onChange={(e) => {
                    const next = { ...line, grams: e.target.value };
                    setLine(i, recompute(next));
                  }}
                  placeholder="例：200"
                  className="num w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                />
              </label>
            </div>
            {line.amountText !== "" && (
              <p className="mt-1 text-[11px] text-[var(--dim)]">
                元の表記：{line.amountText}
              </p>
            )}
            <div className="mt-2">
              <FoodBasisPicker
                ingredientName={line.name}
                matchedFoodId={line.matchedFoodId}
                matchedFoodName={line.matchedFoodName}
                knownFood={
                  line.matchedFoodId != null
                    ? (knownFoods.get(line.matchedFoodId) ?? null)
                    : null
                }
                onPick={(food) => pickFood(i, food)}
              />
            </div>
            {line.basisMode === "food" && line.kcal !== "" ? (
              <p className="num mt-1.5 text-xs text-[var(--dim)]">
                {line.matchedFoodName} の値で計算：{line.kcal} kcal · P{line.proteinG} F
                {line.fatG} C{line.carbsG}
                {line.saltG !== "" && ` · 食塩 ${line.saltG}g`}
                {microText(microFormToMap(line)) !== "" &&
                  ` · ${microText(microFormToMap(line))}`}
              </p>
            ) : line.basisMode === "unknown" ? (
              <p className="mt-1.5 text-xs text-[var(--accent)]">
                根拠が未確定です（合計に含まれません）。食品マスタと対応づけてグラム数を入れるか、下の「栄養を入力」で値を入れてください。
              </p>
            ) : (
              <p className="num mt-1.5 text-xs text-[var(--dim)]">
                手入力の値：{line.kcal !== "" ? `${line.kcal} kcal` : "未入力"}
                {line.proteinG !== "" && ` · P${line.proteinG} F${line.fatG} C${line.carbsG}`}
              </p>
            )}
            <button
              onClick={() => setOpenNutri(openNutri === i ? null : i)}
              aria-expanded={openNutri === i}
              className="mt-1 py-0.5 text-xs text-[var(--accent)]"
            >
              {openNutri === i ? "栄養入力を閉じる" : "栄養を直接入力する"}
            </button>
            {openNutri === i && (
              <div className="mt-1 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                {nutriInput(i, "kcal", "kcal")}
                {nutriInput(i, "proteinG", "P (g)")}
                {nutriInput(i, "fatG", "F (g)")}
                {nutriInput(i, "carbsG", "C (g)")}
                {nutriInput(i, "saltG", "食塩")}
                {MICRO_FIELDS.map((f) => (
                  <span key={f.key}>
                    {nutriInput(i, f.key, `${f.label} (${f.unit})`)}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          setForm((f) => ({ ...f, ingredients: [...f.ingredients, blankIngredient()] }))
        }
        className="mb-3 w-full rounded-lg border border-dashed border-[var(--border)] py-2 text-sm text-[var(--accent)]"
      >
        ＋ 材料を追加
      </button>

      <div className="mb-3 rounded-lg border border-[var(--border)] px-3 py-2">
        <p className="num text-sm text-[var(--text)]">
          合計 {Math.round(tKcal)} kcal · P{fmt(tP)} F{fmt(tF)} C{fmt(tC)}
          {tSalt != null && ` · 食塩 ${fmt(tSalt)}g`}
        </p>
        {hasMicros(tMicros) && (
          <p className="num mt-0.5 text-xs text-[var(--dim)]">
            合計の微量栄養素：{microText(tMicros)}
          </p>
        )}
        {perServing && (
          <p className="num mt-0.5 text-sm text-[var(--text)]">
            1人分 {perServing.kcal} kcal · P{fmt(perServing.proteinG)} F
            {fmt(perServing.fatG)} C{fmt(perServing.carbsG)}
          </p>
        )}
        {perServing && hasMicros(perServing.micros) && (
          <p className="num mt-0.5 text-xs text-[var(--dim)]">
            1人分の微量栄養素：{microText(perServing.micros)}
          </p>
        )}
        {incomplete > 0 && (
          <p className="mt-0.5 text-xs text-[var(--accent)]">
            根拠未確定の材料が{incomplete}件あり、合計に含まれていません
          </p>
        )}
        {servingsNum == null && (
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            「何人分」を入れると1人分が出て、そのまま食事に記録できます
          </p>
        )}
      </div>

      {saveMutation.error && (
        <p className="mb-2 text-sm text-[var(--accent)]">
          保存できませんでした：{String(saveMutation.error)}
        </p>
      )}
      <button
        disabled={!valid || saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
        className="w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
      >
        {saveMutation.isPending ? "保存中…" : "レシピとして保存"}
      </button>
    </Sheet>
  );
}

// ---------- blend food builder （配合食品：部品から計算して登録） ----------

type BlendPartState = {
  /** Display label: the NL-parsed name, or the picked food's name. */
  text: string;
  foodId: number | null;
  grams: string;
  /** Percentage share from the NL parse, until grams are derived. */
  sharePercent: number | null;
};

type BlendInitial = {
  foodId?: number;
  name: string;
  note: string;
  totalGrams: number | null;
  defaultAmount: number;
  parts: Array<{ foodId: number | null; foodName: string; grams: number }>;
};

const emptyBlendInitial: BlendInitial = {
  name: "",
  note: "",
  totalGrams: null,
  defaultAmount: 100,
  parts: [],
};

function blendToInitial(food: Food): BlendInitial {
  return {
    foodId: food.id,
    name: food.name,
    note: food.blend?.note ?? "",
    totalGrams: food.blend?.totalGrams ?? null,
    defaultAmount: food.defaultAmount,
    parts: (food.blend?.parts ?? []).map((p) => ({
      foodId: p.foodId,
      foodName: p.foodName,
      grams: p.grams,
    })),
  };
}

/** Master-food search for one blend part. Unlike the recipe basis
 * picker there is no manual fallback: a blend part IS a master food —
 * that link is the calculation's basis. */
function BlendPartSearch({
  onPick,
  onClose,
}: {
  onPick: (food: Food) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useFoodSearch(query, 20);
  const results = search.data?.foods ?? [];
  return (
    <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
      <input
        aria-label="部品の食品を検索"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="食品名で検索（成分表の全食品から）"
        autoFocus
        className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]"
      />
      <ul className="mt-1 max-h-52 divide-y divide-[var(--border)] overflow-y-auto">
        {results.map((f) => (
          <li key={f.id}>
            <button
              onClick={() => onPick(f)}
              className="w-full py-2 text-left text-sm text-[var(--text)]"
            >
              {f.name}（{f.basisLabel}）
              <span className="num ml-1 text-xs text-[var(--dim)]">
                {fmt(f.kcal)} kcal
              </span>
            </button>
          </li>
        ))}
        {search.isPending && (
          <li className="py-2 text-sm text-[var(--dim)]">検索中…</li>
        )}
        {!search.isPending && results.length === 0 && query.trim() !== "" && (
          <li className="py-2 text-sm text-[var(--dim)]">見つかりませんでした</li>
        )}
      </ul>
      {search.data && search.data.total > results.length && (
        <p className="mt-1 text-xs text-[var(--dim)]">
          他 {search.data.total - results.length} 件あります。検索で絞り込んでください
        </p>
      )}
      <button onClick={onClose} className="mt-1 py-1 text-xs text-[var(--dim)]">
        閉じる
      </button>
    </div>
  );
}

function BlendEditor({
  initial,
  onClose,
  onSavedId,
}: {
  initial: BlendInitial;
  onClose: () => void;
  onSavedId?: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [note, setNote] = useState(initial.note);
  const [totalStr, setTotalStr] = useState(
    initial.totalGrams != null ? String(initial.totalGrams) : "",
  );
  const [defaultAmountStr, setDefaultAmountStr] = useState(
    String(initial.defaultAmount),
  );
  const [parts, setParts] = useState<BlendPartState[]>(
    initial.parts.map((p) => ({
      text: p.foodName,
      foodId: p.foodId,
      grams: String(p.grams),
      sharePercent: null,
    })),
  );
  const [openSearch, setOpenSearch] = useState<number | null>(null);
  const [nlText, setNlText] = useState("");
  const [nlNote, setNlNote] = useState<string | null>(null);
  // Master foods resolved for parts (initial ids, NL matches, picks) —
  // the master is far too large to hold whole just for previews.
  const [knownFoods, setKnownFoods] = useState<Map<number, Food>>(new Map());
  const initialIds = [
    ...new Set(
      initial.parts
        .map((p) => p.foodId)
        .filter((x): x is number => x != null),
    ),
  ];
  const byIds = useQuery({
    queryKey: ["foodsByIds", initialIds.join(",")],
    queryFn: () => api.getFoodsByIds({ ids: initialIds }),
    enabled: initialIds.length > 0,
  });
  useEffect(() => {
    if (!byIds.data) return;
    setKnownFoods((prev) => {
      const m = new Map(prev);
      for (const f of byIds.data.foods) m.set(f.id, f);
      return m;
    });
  }, [byIds.data]);

  const rememberFood = (food: Food) =>
    setKnownFoods((prev) => new Map(prev).set(food.id, food));
  const foodOf = (p: BlendPartState): Food | null =>
    p.foodId != null ? (knownFoods.get(p.foodId) ?? null) : null;

  const setPart = (i: number, patch: Partial<BlendPartState>) =>
    setParts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const parseMutation = useMutation({
    mutationFn: (text: string) => api.parseBlendText({ text }),
    onSuccess: (draft) => {
      if (name.trim() === "" && draft.name !== "") setName(draft.name);
      if (draft.note !== "") {
        setNote((prev) => (prev.trim() === "" ? draft.note : prev));
        setNlNote(draft.note);
      } else {
        setNlNote(null);
      }
      for (const p of draft.parts) if (p.food) rememberFood(p.food);
      setParts(
        draft.parts.map((p) => ({
          text: p.text,
          foodId: p.food?.id ?? null,
          grams: p.grams != null ? String(p.grams) : "",
          sharePercent: p.sharePercent,
        })),
      );
      setOpenSearch(null);
    },
  });
  const blendParseElapsed = useElapsed(parseMutation.isPending);

  const sumGrams = parts.reduce((s, p) => s + (parseNum(p.grams) ?? 0), 0);
  const totalNum = parseNum(totalStr);
  const effectiveTotal = totalNum ?? (sumGrams > 0 ? sumGrams : null);

  // Live per-100 g computation, mirroring the server (each part scaled
  // from its master entry, summed, normalized by the total weight).
  let tKcal = 0,
    tP = 0,
    tF = 0,
    tC = 0,
    tSalt = 0,
    saltMissing = false,
    unresolved = 0;
  // Micronutrients follow the salt rule, per nutrient (mirrors the
  // server): if any part lacks a value, that nutrient is not computed
  // at all — a partial sum would understate it as if confirmed.
  const microSums = {} as Record<MicroKey, number>;
  const microMissing = new Set<MicroKey>();
  for (const f of MICRO_FIELDS) microSums[f.key] = 0;
  for (const p of parts) {
    const food = foodOf(p);
    const grams = parseNum(p.grams);
    if (!food || grams == null || grams <= 0) {
      unresolved++;
      continue;
    }
    const n = previewNutrients(food, grams, "g");
    if (!n) {
      unresolved++;
      continue;
    }
    tKcal += n.kcal;
    tP += n.proteinG;
    tF += n.fatG;
    tC += n.carbsG;
    if (n.saltG == null) saltMissing = true;
    else tSalt += n.saltG;
    for (const f of MICRO_FIELDS) {
      const v = n[f.key];
      if (v == null) microMissing.add(f.key);
      else microSums[f.key] += v;
    }
  }
  const per100: (Nutrients & { kcal: number }) | null =
    effectiveTotal != null && effectiveTotal > 0 && unresolved === 0 && parts.length > 0
      ? {
          kcal: Math.round((tKcal * 100) / effectiveTotal),
          proteinG: Math.round(((tP * 100) / effectiveTotal) * 10) / 10,
          fatG: Math.round(((tF * 100) / effectiveTotal) * 10) / 10,
          carbsG: Math.round(((tC * 100) / effectiveTotal) * 10) / 10,
          saltG: saltMissing
            ? null
            : Math.round(((tSalt * 100) / effectiveTotal) * 100) / 100,
          ...(() => {
            const out = emptyMicros();
            for (const f of MICRO_FIELDS) {
              out[f.key] = microMissing.has(f.key)
                ? null
                : roundMicro(f.key, (microSums[f.key] * 100) / effectiveTotal);
            }
            return out;
          })(),
        }
      : null;

  const hasShares = parts.some(
    (p) => p.sharePercent != null && parseNum(p.grams) == null,
  );
  const applyShares = () => {
    if (effectiveTotal == null) return;
    setParts((prev) =>
      prev.map((p) =>
        p.sharePercent != null && parseNum(p.grams) == null
          ? {
              ...p,
              grams: String(
                Math.round(((p.sharePercent / 100) * effectiveTotal) * 10) / 10,
              ),
            }
          : p,
      ),
    );
  };
  const splitEvenly = () => {
    if (effectiveTotal == null || parts.length === 0) return;
    const each =
      Math.round((effectiveTotal / parts.length) * 10) / 10;
    setParts((prev) => prev.map((p) => ({ ...p, grams: String(each) })));
  };

  const saveMutation = useMutation({
    mutationFn: async () =>
      api.saveBlendFood({
        id: initial.foodId,
        name: name.trim(),
        note: note.trim(),
        totalGrams: effectiveTotal ?? 0,
        defaultAmount: parseNum(defaultAmountStr) ?? effectiveTotal ?? 100,
        parts: parts
          .filter((p) => p.foodId != null && (parseNum(p.grams) ?? 0) > 0)
          .map((p) => ({ foodId: p.foodId as number, grams: parseNum(p.grams) as number })),
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries();
      onSavedId?.(res.id);
      onClose();
    },
  });

  const valid =
    name.trim() !== "" &&
    parts.length >= 2 &&
    unresolved === 0 &&
    effectiveTotal != null &&
    effectiveTotal > 0;

  return (
    <Sheet
      title={initial.foodId ? "配合食品を編集" : "配合食品を作る"}
      onClose={onClose}
    >
      <p className="mb-3 text-xs text-[var(--dim)]">
        ラベルも公式ページもない家庭の配合ものは、食品マスタの部品から計算して登録します。登録されるのは最後に「登録する」を押したときだけです。
      </p>

      <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">
            自然言語で伝える（AIが部品と分量に読み替えます）
          </span>
          <textarea
            aria-label="配合の説明（自然言語）"
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            rows={2}
            placeholder="例：もち麦50%ご飯。ご飯ともち麦を半々で炊いたもの"
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
          />
        </label>
        <button
          onClick={() => parseMutation.mutate(nlText.trim())}
          disabled={nlText.trim() === "" || parseMutation.isPending}
          className="mt-1 w-full rounded-lg border border-[var(--accent)] py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-40"
        >
          {parseMutation.isPending
            ? `AIが読み取り中… ${blendParseElapsed}秒`
            : "AIに読み取らせる"}
        </button>
        {parseMutation.isPending && (
          <AiWait
            elapsed={blendParseElapsed}
            stages={[
              { fromSec: 0, text: "説明文から部品と分量を読み取っています" },
              { fromSec: 8, text: "部品を食品マスタと照合しています" },
            ]}
            typical="通常は10秒前後かかります"
          />
        )}
        {parseMutation.error && (
          <p className="mt-1 text-xs text-[var(--accent)]">
            読み取れませんでした：{String(parseMutation.error)}
          </p>
        )}
        {nlNote && (
          <p className="mt-1 text-xs text-[var(--dim)]">AIの解釈：{nlNote}</p>
        )}
        <p className="mt-1 text-xs text-[var(--dim)]">
          読み取り結果は下書きです。部品の対応づけと分量を確認・修正してから登録してください。
        </p>
      </div>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">食品名</span>
        <input
          aria-label="配合食品名"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：もち麦50%ご飯"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
        />
      </label>

      <ul className="mb-2 space-y-2">
        {parts.map((p, i) => {
          const food = foodOf(p);
          const grams = parseNum(p.grams);
          const contrib =
            food && grams != null && grams > 0
              ? previewNutrients(food, grams, "g")
              : null;
          const share =
            effectiveTotal != null && grams != null && effectiveTotal > 0
              ? Math.round(((grams / effectiveTotal) * 100) * 10) / 10
              : null;
          return (
            <li
              key={i}
              className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-base text-[var(--text)]">
                  {food ? food.name : p.text || "（部品）"}
                </p>
                <button
                  aria-label={`${p.text || "部品"}を削除`}
                  onClick={() =>
                    setParts((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="shrink-0 px-1.5 text-lg leading-none text-[var(--dim)]"
                >
                  ×
                </button>
              </div>
              {food ? (
                <p className="num mt-0.5 text-xs text-[var(--dim)]">
                  根拠：{food.name}（{food.basisLabel} · {fmt(food.kcal)} kcal ·
                  P{fmt(food.proteinG)} F{fmt(food.fatG)} C{fmt(food.carbsG)}
                  {food.saltG != null && ` · 食塩 ${fmt(food.saltG)}g`}）
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-[var(--accent)]">
                  {p.text
                    ? `「${p.text}」に対応する食品が決まっていません。下のボタンから選んでください`
                    : "食品が選ばれていません。下のボタンから選んでください"}
                </p>
              )}
              <div className="mt-2 flex items-end gap-2">
                <button
                  onClick={() => setOpenSearch(openSearch === i ? null : i)}
                  aria-expanded={openSearch === i}
                  className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--accent)]"
                >
                  {food ? "食品を変更" : "食品を選ぶ"}
                </button>
                <label className="min-w-0 flex-1">
                  <span className="mb-0.5 block text-[11px] text-[var(--dim)]">
                    分量（g）{p.sharePercent != null && grams == null && ` · 割合の目安 ${p.sharePercent}%`}
                  </span>
                  <input
                    aria-label={`${p.text || "部品"}の分量（グラム）`}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={p.grams}
                    onChange={(e) => setPart(i, { grams: e.target.value })}
                    placeholder="例：75"
                    className="num w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
                  />
                </label>
                {share != null && (
                  <span className="num shrink-0 pb-2 text-xs text-[var(--dim)]">
                    {share}%
                  </span>
                )}
              </div>
              {openSearch === i && (
                <BlendPartSearch
                  onPick={(f) => {
                    rememberFood(f);
                    setPart(i, { foodId: f.id, text: f.name });
                    setOpenSearch(null);
                  }}
                  onClose={() => setOpenSearch(null)}
                />
              )}
              {contrib && (
                <p className="num mt-1.5 text-xs text-[var(--dim)]">
                  この部品の寄与：{contrib.kcal} kcal · P{fmt(contrib.proteinG)} F
                  {fmt(contrib.fatG)} C{fmt(contrib.carbsG)}
                  {contrib.saltG != null && ` · 食塩 ${fmt(contrib.saltG)}g`}
                  {hasMicros(contrib) && ` · ${microText(contrib)}`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <button
        onClick={() =>
          setParts((prev) => [
            ...prev,
            { text: "", foodId: null, grams: "", sharePercent: null },
          ])
        }
        className="mb-3 w-full rounded-lg border border-dashed border-[var(--border)] py-2 text-sm text-[var(--accent)]"
      >
        ＋ 部品を追加
      </button>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">
            出来上がりの合計（g）
          </span>
          <input
            aria-label="出来上がりの合計グラム数"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={totalStr}
            onChange={(e) => setTotalStr(e.target.value)}
            placeholder={sumGrams > 0 ? `部品の合計 ${fmt(sumGrams)}` : "例：150"}
            className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--dim)]">
            記録時の既定量（g）
          </span>
          <input
            aria-label="記録時の既定量（グラム）"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={defaultAmountStr}
            onChange={(e) => setDefaultAmountStr(e.target.value)}
            className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </label>
      </div>
      <p className="mb-3 -mt-2 text-xs text-[var(--dim)]">
        合計を空欄にすると部品の合計（{fmt(sumGrams)}g）を使います。炊飯などで重さが変わる場合は出来上がりの重さを入れてください。
      </p>
      {(hasShares || parts.length >= 2) && effectiveTotal != null && (
        <div className="mb-3 flex gap-2">
          {hasShares && (
            <button
              onClick={applyShares}
              className="flex-1 rounded-lg border border-[var(--border)] py-2 text-sm text-[var(--text)]"
            >
              割合からグラム数を計算
            </button>
          )}
          {parts.length >= 2 && (
            <button
              onClick={splitEvenly}
              className="flex-1 rounded-lg border border-[var(--border)] py-2 text-sm text-[var(--text)]"
            >
              均等に分ける
            </button>
          )}
        </div>
      )}

      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">
          計算の前提（メモ）
        </span>
        <input
          aria-label="計算の前提メモ"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="例：炊き上がり重量で50:50"
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
        />
      </label>

      <div className="mb-3 rounded-lg border border-[var(--border)] px-3 py-2">
        <p className="mb-1 text-xs font-semibold text-[var(--dim)]">
          計算の根拠（100gあたり）
        </p>
        {per100 ? (
          <>
            <p className="num text-sm text-[var(--text)]">
              {per100.kcal} kcal · P{fmt(per100.proteinG)} F{fmt(per100.fatG)} C
              {fmt(per100.carbsG)}
              {per100.saltG != null && ` · 食塩 ${fmt(per100.saltG)}g`}
            </p>
            {hasMicros(per100) && (
              <p className="num mt-0.5 text-xs text-[var(--dim)]">
                微量栄養素：{microText(per100)}
              </p>
            )}
            <ul className="mt-1 space-y-0.5">
              {parts.map((p, i) => {
                const food = foodOf(p);
                const grams = parseNum(p.grams);
                if (!food || grams == null || effectiveTotal == null) return null;
                const n = previewNutrients(food, grams, "g");
                if (!n) return null;
                const k = 100 / effectiveTotal;
                return (
                  <li key={i} className="num text-xs text-[var(--dim)]">
                    {food.name} {fmt(grams)}g → 100gあたり {Math.round(n.kcal * k)}{" "}
                    kcal · P{fmt(Math.round(n.proteinG * k * 10) / 10)} F
                    {fmt(Math.round(n.fatG * k * 10) / 10)} C
                    {fmt(Math.round(n.carbsG * k * 10) / 10)}
                  </li>
                );
              })}
            </ul>
            {saltMissing && (
              <p className="mt-1 text-xs text-[var(--accent)]">
                一部の部品に食塩相当量の値がないため、食塩は未算出（空欄）で登録されます
              </p>
            )}
            {microMissing.size > 0 && (
              <p className="mt-1 text-xs text-[var(--accent)]">
                一部の部品に値がない微量栄養素（
                {MICRO_FIELDS.filter((f) => microMissing.has(f.key))
                  .map((f) => f.label)
                  .join("・")}
                ）は未算出（空欄）で登録されます
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-[var(--dim)]">
            部品が2つ以上そろい、分量と合計が決まると、ここに100gあたりの計算結果と部品ごとの寄与が出ます
          </p>
        )}
        {parts.length > 0 && parts.length < 2 && (
          <p className="mt-1 text-xs text-[var(--accent)]">
            配合食品には部品が2つ以上必要です
          </p>
        )}
        {unresolved > 0 && parts.length >= 2 && (
          <p className="mt-1 text-xs text-[var(--accent)]">
            食品か分量が未確定の部品が{unresolved}件あります
          </p>
        )}
      </div>

      {saveMutation.error && (
        <p className="mb-2 text-sm text-[var(--accent)]">
          登録できませんでした：{String(saveMutation.error)}
        </p>
      )}
      <button
        disabled={!valid || saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
        className="w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
      >
        {saveMutation.isPending
          ? "登録中…"
          : "根拠を確認したので、この内容で登録する"}
      </button>
    </Sheet>
  );
}

function RecipeLogSheet({
  recipe,
  onClose,
  onLogged,
}: {
  recipe: Recipe;
  onClose: () => void;
  onLogged: (date: string) => void;
}) {
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string>(todayJst());
  const [slot, setSlot] = useState<Slot>(defaultSlot());
  const [amount, setAmount] = useState("1");
  const [eatingOut, setEatingOut] = useState(false);
  const amountNum = Number(amount);
  const per = recipe.perServing;
  const canLog =
    per != null && Number.isFinite(amountNum) && amountNum > 0;

  const mutation = useMutation({
    mutationFn: () =>
      api.logRecipe({
        date,
        slot,
        recipeId: recipe.id,
        amount: amountNum,
        eatingOut,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      onLogged(date);
      onClose();
    },
  });

  return (
    <Sheet title="レシピを記録" onClose={onClose}>
      <p className="mb-1 text-lg font-semibold text-[var(--text)]">{recipe.title}</p>
      {per ? (
        <p className="num mb-3 text-sm text-[var(--dim)]">
          1人分 {per.kcal} kcal · P{fmt(per.proteinG)} F{fmt(per.fatG)} C
          {fmt(per.carbsG)}
          {per.complete ? "" : "（一部の材料が未確定の概算）"}
          {hasMicros(per) && (
            <span className="block">微量栄養素：{microText(per)}</span>
          )}
        </p>
      ) : (
        <p className="mb-3 text-sm text-[var(--accent)]">
          このレシピは人数（何人分）が未設定のため記録できません。先にレシピを編集して人数を設定してください。
        </p>
      )}
      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">日付</span>
        <input
          aria-label="記録する日付"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-base text-[var(--text)]"
        />
      </label>
      <div className="mb-3 flex gap-1" role="group" aria-label="食事の区分">
        {SLOTS.map((s) => (
          <button
            key={s.key}
            onClick={() => setSlot(s.key)}
            aria-pressed={slot === s.key}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-sm ${
              slot === s.key
                ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-white"
                : "border-[var(--border)] text-[var(--text)]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-[var(--dim)]">食べた量（人前）</span>
        <input
          aria-label="食べた量（人前）"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="num w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-lg text-[var(--text)]"
        />
      </label>
      {per && canLog && (
        <p className="num mb-3 text-sm text-[var(--dim)]">
          記録される値：{Math.round(per.kcal * amountNum)} kcal · P
          {fmt(per.proteinG * amountNum)} F{fmt(per.fatG * amountNum)} C
          {fmt(per.carbsG * amountNum)}
        </p>
      )}
      <div className="mb-3 flex items-center gap-2">
        <EatingOutToggle
          on={eatingOut}
          onChange={setEatingOut}
          label={`${recipe.title}を外食として記録する`}
        />
        <span className="text-xs text-[var(--dim)]">
          外食のときはオン（推定の目印になります）
        </span>
      </div>
      {mutation.error && (
        <p className="mb-2 text-sm text-[var(--accent)]">
          記録できませんでした：{String(mutation.error)}
        </p>
      )}
      <button
        disabled={!canLog || mutation.isPending}
        onClick={() => mutation.mutate()}
        className="w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
      >
        {mutation.isPending ? "記録中…" : "記録する"}
      </button>
    </Sheet>
  );
}

const RECIPE_SOURCE_LABEL: Record<Recipe["sourceType"], string> = {
  url: "URLから推定",
  photo: "写真から推定",
  manual: "手入力",
};

function RecipesView({
  onLogged,
}: {
  onLogged: (date: string) => void;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [pendingImportId, setPendingImportId] = useState<number | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    initial: RecipeFormState;
    recipeId?: number;
  } | null>(null);
  const [logTarget, setLogTarget] = useState<Recipe | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const recipesQuery = useQuery({
    queryKey: ["recipes"],
    queryFn: () => api.listRecipes({}),
  });
  const recipes = recipesQuery.data?.recipes ?? [];

  const importQuery = useQuery({
    queryKey: ["recipeImport", pendingImportId],
    queryFn: () => api.getRecipeImport({ importId: pendingImportId ?? 0 }),
    enabled: pendingImportId != null,
    refetchInterval: (query) =>
      query.state.data?.import.status === "pending" ? 3000 : false,
  });
  const importElapsed = useElapsed(pendingImportId != null);

  useEffect(() => {
    const imp = importQuery.data?.import;
    if (!imp || pendingImportId == null || imp.id !== pendingImportId) return;
    if (imp.status === "ready" && imp.draft) {
      setPendingImportId(null);
      setEditor({ initial: draftToForm(imp.draft) });
    } else if (imp.status === "failed") {
      setPendingImportId(null);
      setImportError(imp.error ?? "レシピを読み取れませんでした");
    }
  }, [importQuery.data, pendingImportId]);

  const urlMutation = useMutation({
    mutationFn: (u: string) => api.startRecipeImportFromUrl({ url: u }),
    onSuccess: (res) => {
      setImportError(null);
      setPendingImportId(res.importId);
    },
    onError: () => setImportError("URLの取り込みを開始できませんでした"),
  });

  const photoMutation = useMutation({
    mutationFn: async (file: File) => {
      const img = await downscaleToJpeg(file);
      const res = await api.importRecipeFromPhoto({
        imageBase64: img.base64,
        mimeType: img.mimeType,
      });
      const got = await api.getRecipeImport({ importId: res.importId });
      return got.import;
    },
    onSuccess: (imp) => {
      if (imp.draft) {
        setImportError(null);
        setEditor({ initial: draftToForm(imp.draft) });
      }
    },
    onError: (e) => setImportError(String(e)),
  });
  const photoElapsed = useElapsed(photoMutation.isPending);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteRecipe({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries();
      setConfirmDelete(null);
    },
  });

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) photoMutation.mutate(file);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) photoMutation.mutate(file);
          e.target.value = "";
        }}
      />
      <div className="mb-2 flex gap-2">
        <input
          aria-label="レシピページのURL"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="レシピページのURLを貼る"
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
        />
        <button
          onClick={() => urlMutation.mutate(url.trim())}
          disabled={url.trim() === "" || urlMutation.isPending || pendingImportId != null}
          className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          URLから推定
        </button>
      </div>
      <div className="mb-2 flex gap-2">
        <button
          onClick={() => cameraRef.current?.click()}
          disabled={photoMutation.isPending}
          className="flex-1 rounded-lg border border-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
        >
          {photoMutation.isPending
            ? `写真を読み取り中… ${photoElapsed}秒`
            : "📷 撮影して推定"}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={photoMutation.isPending}
          className="flex-1 rounded-lg border border-[var(--accent)] py-2.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
        >
          写真を選ぶ
        </button>
        <button
          onClick={() => setEditor({ initial: emptyRecipeForm })}
          className="flex-1 rounded-lg border border-[var(--border)] py-2.5 text-sm text-[var(--text)]"
        >
          ＋ 手入力で作る
        </button>
      </div>
      {photoMutation.isPending && (
        <AiWait
          elapsed={photoElapsed}
          stages={[
            { fromSec: 0, text: "写真から料理と材料を読み取っています" },
            { fromSec: 25, text: "材料を食品マスタと照合しています" },
          ]}
          typical="通常は30秒〜1分ほどかかります"
        />
      )}
      <p className="mb-3 text-xs text-[var(--dim)]">
        URL・写真からの推定は下書きです。保存前に材料ごとの根拠（どの食品マスタの値で計算したか）を1つずつ確認・修正できます。写真は読み取りにだけ使い、保存しません。
      </p>

      {pendingImportId != null && (
        <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <p className="text-sm text-[var(--text)]">
            レシピページを読み取り中… {importElapsed}秒（ページの読み込みと照合に数分かかることがあります。このまま待つと下書きが開きます）
          </p>
          {importQuery.data?.import.progressStage && (
            <p className="mt-0.5 text-xs font-semibold text-[var(--accent)]">
              段階：
              {RECIPE_STAGE_LABELS[importQuery.data.import.progressStage] ??
                importQuery.data.import.progressStage}
            </p>
          )}
          {importQuery.data?.import.progress && (
            <p className="mt-0.5 text-sm text-[var(--text)]">
              いま：{importQuery.data.import.progress}
            </p>
          )}
        </div>
      )}
      {importError && (
        <p className="mb-3 text-sm text-[var(--accent)]">{importError}</p>
      )}
      {deleteMutation.error && (
        <p className="mb-3 text-sm text-[var(--accent)]">
          削除できませんでした：{String(deleteMutation.error)}
        </p>
      )}

      {recipesQuery.isPending && (
        <p className="py-6 text-center text-sm text-[var(--dim)]">読み込み中…</p>
      )}
      {!recipesQuery.isPending && recipes.length === 0 && (
        <p className="py-6 text-center text-sm text-[var(--dim)]">
          まだレシピがありません。URLか写真から推定するか、手入力で作れます。
        </p>
      )}
      <ul className="divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3">
        {recipes.map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-base text-[var(--text)]">
                {r.title}
              </p>
              <span className="shrink-0 text-xs text-[var(--dim)]">
                {RECIPE_SOURCE_LABEL[r.sourceType]}
              </span>
            </div>
            <p className="num mt-0.5 text-xs text-[var(--dim)]">
              {r.servingsLabel !== ""
                ? r.servingsLabel
                : r.servings != null
                  ? `${fmt(r.servings)}人分`
                  : "人数未設定"}
              {" · "}
              {r.perServing ? (
                <>
                  1人分 {r.perServing.kcal} kcal · P{fmt(r.perServing.proteinG)} F
                  {fmt(r.perServing.fatG)} C{fmt(r.perServing.carbsG)}
                </>
              ) : (
                <>合計 {r.totals.kcal} kcal</>
              )}
              {!r.totals.complete && "（一部の材料が未確定の概算）"}
            </p>
            {hasMicros(r.perServing ?? r.totals) && (
              <p className="num mt-0.5 text-xs text-[var(--dim)]">
                {r.perServing ? "1人分" : "合計"}の微量栄養素：
                {microText(r.perServing ?? r.totals)}
              </p>
            )}
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              材料{r.ingredients.length}件
              {r.basis.length > 0 && (
                <>
                  {" · 根拠："}
                  {r.basis.map((b, j) => (
                    <span key={j}>
                      {j > 0 && "、"}
                      {b.sourceUrl ? (
                        <a
                          href={b.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[var(--accent)] underline"
                        >
                          {b.label}
                        </a>
                      ) : (
                        b.label
                      )}
                    </span>
                  ))}
                </>
              )}
            </p>
            {r.sourceType === "url" && r.sourceUrl && (
              <p className="mt-0.5 truncate text-xs text-[var(--dim)]">
                推定元：
                <a
                  href={r.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] underline"
                >
                  {r.sourceUrl}
                </a>
              </p>
            )}
            <div className="mt-1 flex gap-3">
              <button
                onClick={() => setLogTarget(r)}
                className="py-1 text-sm font-semibold text-[var(--accent)]"
              >
                食事に記録
              </button>
              <button
                onClick={() =>
                  setEditor({ initial: recipeToForm(r), recipeId: r.id })
                }
                className="py-1 text-sm text-[var(--accent)]"
              >
                編集
              </button>
              {confirmDelete === r.id ? (
                <>
                  <button
                    onClick={() => deleteMutation.mutate(r.id)}
                    className="py-1 text-sm font-semibold text-[var(--accent)]"
                  >
                    本当に削除する
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="py-1 text-sm text-[var(--dim)]"
                  >
                    やめる
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmDelete(r.id)}
                  className="py-1 text-sm text-[var(--dim)]"
                >
                  削除
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editor && (
        <RecipeEditor
          initial={editor.initial}
          recipeId={editor.recipeId}
          onClose={() => setEditor(null)}
        />
      )}
      {logTarget && (
        <RecipeLogSheet
          recipe={logTarget}
          onClose={() => setLogTarget(null)}
          onLogged={onLogged}
        />
      )}
    </div>
  );
}

// ---------- settings ----------

type TargetFormState = {
  id?: number;
  effectiveDate: string;
  kcal: string;
  proteinG: string;
  fatG: string;
  carbsG: string;
};

function TargetHistorySection() {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: ["targetHistory"],
    queryFn: () => api.listTargetHistory({}),
  });
  const [form, setForm] = useState<TargetFormState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (args: {
      id?: number;
      effectiveDate: string;
      kcal: number;
      proteinG: number;
      fatG: number;
      carbsG: number;
    }) => await api.upsertTargetHistory(args),
    onSuccess: () => {
      setForm(null);
      queryClient.invalidateQueries();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteTargetHistory({ id }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      queryClient.invalidateQueries();
    },
  });

  const entries = historyQuery.data?.entries ?? [];
  // Newest first for display; the newest row is the current target.
  const display = [...entries].reverse();
  const latestId = entries[entries.length - 1]?.id;

  const numField = (
    label: string,
    key: "kcal" | "proteinG" | "fatG" | "carbsG",
    unit: string,
  ) => (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--dim)]">
        {label}（{unit}）
      </span>
      <input
        aria-label={label}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={form?.[key] ?? ""}
        onChange={(e) =>
          setForm((f) => (f ? { ...f, [key]: e.target.value } : f))
        }
        className="num w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
      />
    </label>
  );

  const submitForm = () => {
    if (!form) return;
    const kcal = Number(form.kcal);
    const proteinG = Number(form.proteinG);
    const fatG = Number(form.fatG);
    const carbsG = Number(form.carbsG);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(form.effectiveDate) ||
      ![kcal, proteinG, fatG, carbsG].every(
        (n) => Number.isFinite(n) && n > 0,
      )
    ) {
      return;
    }
    saveMutation.mutate({
      id: form.id,
      effectiveDate: form.effectiveDate,
      kcal,
      proteinG,
      fatG,
      carbsG,
    });
  };

  return (
    <section className="mt-10">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-[var(--text)]">目標の履歴</h2>
        {!form && (
          <button
            type="button"
            onClick={() =>
              setForm({
                effectiveDate: todayJst(),
                kcal: "",
                proteinG: "",
                fatG: "",
                carbsG: "",
              })
            }
            className="rounded-lg border border-[var(--border)] px-3 py-1 text-sm text-[var(--text)]"
          >
            追加
          </button>
        )}
      </div>
      <p className="mb-3 text-sm text-[var(--dim)]">
        開始日ごとの目標です。いちばん新しい行が現在の目標になります。上の「1日の目標」を保存すると、今日の日付で履歴にも追加されます。
      </p>
      {deleteMutation.error && (
        <p className="mb-3 text-sm text-[var(--accent)]">
          削除できませんでした：{String(deleteMutation.error)}
        </p>
      )}

      {historyQuery.isLoading ? (
        <p className="py-4 text-center text-sm text-[var(--dim)]">読み込み中…</p>
      ) : display.length === 0 && !form ? (
        <p className="py-4 text-center text-sm text-[var(--dim)]">
          まだ履歴がありません
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {display.map((e) => (
            <li key={e.id} className="py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-[var(--text)]">
                  {e.effectiveDate}
                  {e.id === latestId && (
                    <span className="ml-2 rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-semibold text-white">
                      現在の目標
                    </span>
                  )}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    aria-label={`${e.effectiveDate} の目標を編集`}
                    onClick={() => {
                      setConfirmDeleteId(null);
                      setForm({
                        id: e.id,
                        effectiveDate: e.effectiveDate,
                        kcal: String(e.kcal),
                        proteinG: String(e.proteinG),
                        fatG: String(e.fatG),
                        carbsG: String(e.carbsG),
                      });
                    }}
                    className="text-sm text-[var(--dim)]"
                  >
                    編集
                  </button>
                  {confirmDeleteId === e.id ? (
                    <>
                      <button
                        type="button"
                        aria-label={`${e.effectiveDate} の目標を削除する（確認）`}
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(e.id)}
                        className="text-sm font-semibold text-[var(--accent)]"
                      >
                        削除する
                      </button>
                      <button
                        type="button"
                        aria-label="削除をキャンセル"
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-sm text-[var(--dim)]"
                      >
                        やめる
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      aria-label={`${e.effectiveDate} の目標を削除`}
                      onClick={() => setConfirmDeleteId(e.id)}
                      className="text-sm text-[var(--dim)]"
                    >
                      削除
                    </button>
                  )}
                </span>
              </div>
              <p className="num mt-1 text-sm text-[var(--text)]">
                {fmt(e.kcal)} kcal
                <span className="text-[var(--dim)]">
                  {"　"}P {fmt(e.proteinG)}g / F {fmt(e.fatG)}g / C{" "}
                  {fmt(e.carbsG)}g
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <p className="mb-2 text-sm font-medium text-[var(--text)]">
            {form.id != null ? "目標を編集" : "目標を追加"}
          </p>
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-[var(--dim)]">開始日</span>
            <input
              aria-label="開始日"
              type="date"
              value={form.effectiveDate}
              onChange={(e) =>
                setForm((f) =>
                  f ? { ...f, effectiveDate: e.target.value } : f,
                )
              }
              className="num w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            {numField("エネルギー", "kcal", "kcal")}
            {numField("たんぱく質", "proteinG", "g")}
            {numField("脂質", "fatG", "g")}
            {numField("炭水化物", "carbsG", "g")}
          </div>
          {saveMutation.error && (
            <p className="mt-2 text-sm text-[var(--accent)]">
              保存できませんでした。同じ開始日の目標がすでにある場合は日付を変えてください。
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={submitForm}
              disabled={saveMutation.isPending}
              className="flex-1 rounded-lg bg-[var(--accent)] py-2 text-base font-semibold text-white disabled:opacity-40"
            >
              {saveMutation.isPending ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-base text-[var(--text)]"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function SettingsView({ settings }: { settings: Settings | undefined }) {
  const queryClient = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: (args: {
      targetKcal: number | null;
      targetProteinG: number | null;
      targetFatG: number | null;
      targetCarbsG: number | null;
    }) => api.updateSettings(args),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  if (!settings) {
    return <p className="py-6 text-center text-sm text-[var(--dim)]">読み込み中…</p>;
  }

  const field = (
    label: string,
    name: string,
    value: number | null,
    unit: string,
  ) => (
    <label className="block">
      <span className="mb-1 block text-xs text-[var(--dim)]">
        {label}（{unit}・空欄で未設定）
      </span>
      <input
        aria-label={label}
        name={name}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        defaultValue={value ?? ""}
        className="num w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
      />
    </label>
  );

  return (
    <>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const num = (name: string): number | null => {
          const v = String(fd.get(name) ?? "").trim();
          if (v === "") return null;
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        saveMutation.mutate({
          targetKcal: num("kcal"),
          targetProteinG: num("protein"),
          targetFatG: num("fat"),
          targetCarbsG: num("carbs"),
        });
      }}
    >
      <h2 className="mb-1 text-base font-semibold text-[var(--text)]">1日の目標</h2>
      <p className="mb-3 text-sm text-[var(--dim)]">
        設定すると、記録画面に進捗バーが出ます。未設定でも記録はできます。
      </p>
      <div className="grid grid-cols-2 gap-2">
        {field("エネルギー", "kcal", settings.targetKcal, "kcal")}
        {field("たんぱく質", "protein", settings.targetProteinG, "g")}
        {field("脂質", "fat", settings.targetFatG, "g")}
        {field("炭水化物", "carbs", settings.targetCarbsG, "g")}
      </div>
      {saveMutation.isSuccess && (
        <p className="mt-2 text-sm text-[var(--dim)]">保存しました</p>
      )}
      {saveMutation.error && (
        <p className="mt-2 text-sm text-[var(--accent)]">保存できませんでした</p>
      )}
      <button
        type="submit"
        disabled={saveMutation.isPending}
        className="mt-4 w-full rounded-lg bg-[var(--accent)] py-3 text-base font-semibold text-white disabled:opacity-40"
      >
        {saveMutation.isPending ? "保存中…" : "保存"}
      </button>
    </form>
    <TargetHistorySection />
    <AiMetricsSection />
    </>
  );
}

/**
 * The AI layer's durable counters (getAiMetrics): per flow, how many
 * inference attempts ran, how many failed, how many were rejected by
 * the response schema, and how many retries were needed — plus the
 * background-job expiries. This is how the effect of schema hardening
 * gets checked after the fact instead of by feel.
 */
const AI_FLOW_LABELS: Array<[string, string]> = [
  ["label_photo", "成分表示の写真読み取り"],
  ["lookup_extract", "AI食品検索（抽出）"],
  ["recipe_photo", "レシピ写真の推定"],
  ["blend_parse", "配合の自然言語読み取り"],
  ["assist_parse", "AIアシスト（読み取り）"],
  ["assist_pick", "AIアシスト（基準の選定）"],
  ["assist_decompose", "AIアシスト（分解）"],
];

function AiMetricsSection() {
  const metricsQuery = useQuery({
    queryKey: ["aiMetrics"],
    queryFn: () => api.getAiMetrics({}),
  });
  const byKey = new Map(
    (metricsQuery.data?.metrics ?? []).map((m) => [m.key, m.count]),
  );
  const count = (key: string) => byKey.get(key) ?? 0;
  const flows = AI_FLOW_LABELS.filter(([k]) => count(`${k}.attempts`) > 0);
  const expiredDeep = count("deep_research.expired");
  const expiredRecipe = count("recipe_import.expired");
  const versionMismatch = count("assist_cache.version_mismatch");
  const hasAny =
    flows.length > 0 || expiredDeep > 0 || expiredRecipe > 0 || versionMismatch > 0;

  return (
    <section className="mt-8">
      <h2 className="mb-1 text-base font-semibold text-[var(--text)]">
        AI呼び出しの記録
      </h2>
      <p className="mb-3 text-sm text-[var(--dim)]">
        AIの応答がスキーマ検証で弾かれた回数・リトライ・背景調査の失効を数えたものです。失敗しやすさの変化を後から確認するために残しています。
      </p>
      {metricsQuery.isPending ? (
        <p className="text-sm text-[var(--dim)]">読み込み中…</p>
      ) : !hasAny ? (
        <p className="text-sm text-[var(--dim)]">まだ記録がありません。</p>
      ) : (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          {flows.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--dim)]">
                  <th className="py-1 font-normal">処理</th>
                  <th className="py-1 text-right font-normal">呼出</th>
                  <th className="py-1 text-right font-normal">失敗</th>
                  <th className="py-1 text-right font-normal">検証エラー</th>
                  <th className="py-1 text-right font-normal">リトライ</th>
                </tr>
              </thead>
              <tbody className="num">
                {flows.map(([key, label]) => (
                  <tr key={key} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-2 text-[var(--text)]">{label}</td>
                    <td className="py-1.5 text-right">{count(`${key}.attempts`)}</td>
                    <td className="py-1.5 text-right">{count(`${key}.failures`)}</td>
                    <td className="py-1.5 text-right">
                      {count(`${key}.schema_failures`)}
                    </td>
                    <td className="py-1.5 text-right">{count(`${key}.retries`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(expiredDeep > 0 || expiredRecipe > 0 || versionMismatch > 0) && (
            <ul className="num mt-1 space-y-0.5 text-sm text-[var(--text)]">
              {expiredDeep > 0 && (
                <li>詳しい調査の失効（無応答で終了）：{expiredDeep}件</li>
              )}
              {expiredRecipe > 0 && (
                <li>レシピURL取込の失効（無応答で終了）：{expiredRecipe}件</li>
              )}
              {versionMismatch > 0 && (
                <li>換算案キャッシュの形式不一致：{versionMismatch}件</li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- deep research status (background, app-wide) ----------

/**
 * The deep food research runs as a background agent job (1–2 minutes),
 * so its status lives here at app level — not inside the registration
 * form. While a job runs this shows what the agent is doing (its own
 * progress notes) and how long it has been going; when it finishes, the
 * outcome stays here until the user opens the draft or dismisses it,
 * even if the form was closed or the app was reopened meanwhile.
 * The same banner also surfaces finished fast lookups whose draft was
 * never registered (the form was closed before the lookup returned):
 * without this, a completed 「AIで調べる」 left no trace outside the
 * foods tab's research-records list.
 */
/** Stage labels for the background flows' structured progress. */
const DEEP_STAGE_LABELS: Record<string, string> = {
  searching: "公式サイトを検索中",
  opening_page: "公式ページを確認中",
  reading_table: "栄養成分表示を確認中",
  saving: "結果を保存中",
};

const RECIPE_STAGE_LABELS: Record<string, string> = {
  opening_page: "ページを開いています",
  extracting: "材料を抽出しました",
  saving: "結果を保存中",
};

function DeepResearchStatus({
  dismissed,
  onDismiss,
  onOpenDraft,
  dismissedDrafts,
  onDismissDraft,
  onOpenResearchDraft,
}: {
  dismissed: number[];
  onDismiss: (jobId: number) => void;
  onOpenDraft: (job: DeepJob) => void;
  dismissedDrafts: number[];
  onDismissDraft: (recordId: number) => void;
  onOpenResearchDraft: (notice: ResearchDraftNotice) => void;
}) {
  const queryClient = useQueryClient();
  const retryMutation = useMutation({
    mutationFn: async (name: string) =>
      await api.startDeepFoodResearch({ name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["deepJobs"] });
    },
  });
  const jobsQuery = useQuery({
    queryKey: ["deepJobs"],
    queryFn: () => api.listDeepFoodResearchJobs({}),
    refetchInterval: (query) =>
      (query.state.data?.jobs ?? []).some((j) => j.status === "pending")
        ? 4000
        : false,
  });
  const jobs = (jobsQuery.data?.jobs ?? []).filter(
    (j) => j.status === "pending" || !dismissed.includes(j.id),
  );
  // Research results that arrived through the fast in-form lookup: if
  // the form was closed before the lookup finished, the draft prefill
  // was never seen — surface the stored result here instead, the same
  // way finished deep-research jobs are surfaced. Polled so a result
  // that lands while the app is open appears without reopening the
  // form.
  const draftsQuery = useQuery({
    queryKey: ["researchDrafts"],
    queryFn: () => api.listUnregisteredResearchDrafts({}),
    refetchInterval: 10000,
  });
  const drafts = (draftsQuery.data?.drafts ?? []).filter(
    (d) => !dismissedDrafts.includes(d.id),
  );
  const anyPending = jobs.some((j) => j.status === "pending");
  const now = useNow(anyPending);
  if (jobs.length === 0 && drafts.length === 0) return null;

  return (
    <section aria-label="AI調査の状況" className="mb-4 space-y-2">
      {jobs.map((job) => {
        if (job.status === "pending") {
          const elapsedSec =
            (now - new Date(job.createdAt).getTime()) / 1000;
          return (
            <div
              key={job.id}
              role="status"
              className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] px-3 py-2.5"
            >
              <p className="text-sm font-semibold text-[var(--text)]">
                「{job.queryName}」をAIが詳しく調査中です（
                {fmtElapsed(elapsedSec)}経過）
              </p>
              {job.progressStage && (
                <p className="mt-0.5 text-xs font-semibold text-[var(--accent)]">
                  段階：{DEEP_STAGE_LABELS[job.progressStage] ?? job.progressStage}
                </p>
              )}
              <p className="mt-0.5 text-sm text-[var(--text)]">
                {job.progress ?? "メーカー公式ページを探しています"}
              </p>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                メーカー公式ページを直接開いて栄養成分表示を確認しています（1〜2分ほどかかります）。このまま他の操作をして大丈夫です。終わったらここに結果が出ます。
              </p>
              {elapsedSec > 180 && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  通常より時間がかかっています。応答がない場合は自動的に終了します。
                </p>
              )}
            </div>
          );
        }
        if (job.status === "ready" && job.draft) {
          const d = job.draft;
          return (
            <div
              key={job.id}
              role="status"
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
            >
              <p className="text-sm font-semibold text-[var(--text)]">
                「{job.queryName}」の詳しい調査が終わりました
              </p>
              <p className="num mt-0.5 text-xs text-[var(--dim)]">
                {d.name} · {d.basisLabel} · {fmt(d.kcal)} kcal · P
                {fmt(d.proteinG)} F{fmt(d.fatG)} C{fmt(d.carbsG)}
                {d.saltG != null && ` · 食塩 ${fmt(d.saltG)}g`}
              </p>
              {hasMicros(d) && (
                <p className="num mt-0.5 text-xs text-[var(--dim)]">
                  {microText(d)}
                </p>
              )}
              {d.sourceUrl && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  出典：
                  <a
                    href={d.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] underline"
                  >
                    {d.sourceName || d.sourceUrl}
                  </a>
                </p>
              )}
              <div className="mt-1.5 flex gap-3">
                <button
                  onClick={() => onOpenDraft(job)}
                  className="py-1 text-sm font-semibold text-[var(--accent)]"
                >
                  下書きを開いて登録する
                </button>
                <button
                  onClick={() => onDismiss(job.id)}
                  className="py-1 text-sm text-[var(--dim)]"
                >
                  閉じる
                </button>
              </div>
            </div>
          );
        }
        return (
          <div
            key={job.id}
            role="status"
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
          >
            <p className="text-sm text-[var(--text)]">
              {job.status === "failed"
                ? `「${job.queryName}」の詳しい調査に失敗しました${job.error ? `：${job.error}` : ""}`
                : `「${job.queryName}」はメーカー公式ページを直接確認しましたが、栄養成分の値を確認できませんでした（調査記録に残しました）。`}
            </p>
            <div className="mt-1.5 flex gap-3">
              {job.status === "failed" && (
                <button
                  onClick={() => {
                    retryMutation.mutate(job.queryName);
                    onDismiss(job.id);
                  }}
                  disabled={retryMutation.isPending}
                  className="py-1 text-sm font-semibold text-[var(--accent)]"
                >
                  もう一度調べる
                </button>
              )}
              <button
                onClick={() => onDismiss(job.id)}
                className="py-1 text-sm text-[var(--dim)]"
              >
                閉じる
              </button>
            </div>
          </div>
        );
      })}
      {drafts.map((notice) => {
        const d = notice.draft;
        return (
          <div
            key={`draft-${notice.id}`}
            role="status"
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
          >
            <p className="text-sm font-semibold text-[var(--text)]">
              「{notice.queryName}」のAI調査が終わっています（まだ食品として登録されていません）
            </p>
            <p className="num mt-0.5 text-xs text-[var(--dim)]">
              {d.name} · {d.basisLabel} · {fmt(d.kcal)} kcal · P
              {fmt(d.proteinG)} F{fmt(d.fatG)} C{fmt(d.carbsG)}
              {d.saltG != null && ` · 食塩 ${fmt(d.saltG)}g`}
            </p>
            {d.sourceUrl && (
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                出典：
                <a
                  href={d.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] underline"
                >
                  {d.sourceName || d.sourceUrl}
                </a>
              </p>
            )}
            <div className="mt-1.5 flex gap-3">
              <button
                onClick={() => onOpenResearchDraft(notice)}
                className="py-1 text-sm font-semibold text-[var(--accent)]"
              >
                下書きを開いて登録する
              </button>
              <button
                onClick={() => onDismissDraft(notice.id)}
                className="py-1 text-sm text-[var(--dim)]"
              >
                閉じる
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ---------- app shell ----------

export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [date, setDate] = useState<string>(todayJst());
  const [pickerSlot, setPickerSlot] = useState<Slot | null>(null);
  // Food the picker should select as soon as the registration form
  // closes (set when a food is saved or an existing one is chosen while
  // the picker is open underneath).
  const [pickerPickId, setPickerPickId] = useState<number | null>(null);
  const [foodForm, setFoodForm] = useState<{
    initial: FoodFormState;
    foodId?: number;
  } | null>(null);
  const [blendEditor, setBlendEditor] = useState<{
    initial: BlendInitial;
  } | null>(null);
  // Deep-research jobs whose outcome the user has already seen; the
  // app-level status banner hides those (persisted across opens).
  const [dismissedDeep, setDismissedDeep] =
    useState<number[]>(loadDismissedDeepJobs);
  const dismissDeep = (jobId: number) =>
    setDismissedDeep((prev) => {
      if (prev.includes(jobId)) return prev;
      const next = [...prev, jobId];
      storeDismissedDeepJobs(next);
      return next;
    });
  // Same for unregistered research drafts shown by the status banner.
  const [dismissedDrafts, setDismissedDrafts] =
    useState<number[]>(loadDismissedDrafts);
  const dismissDraft = (recordId: number) =>
    setDismissedDrafts((prev) => {
      if (prev.includes(recordId)) return prev;
      const next = [...prev, recordId];
      storeDismissedDrafts(next);
      return next;
    });

  // Only the master size is needed at shell level (for the first-run
  // hint); every surface searches the master itself.
  const foodsQuery = useQuery({
    queryKey: ["foodsTotal"],
    queryFn: () => api.listFoods({ limit: 1 }),
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings({}),
  });
  const hasFoods = (foodsQuery.data?.total ?? 0) > 0;

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "today", label: "記録" },
    { key: "history", label: "履歴" },
    { key: "pace", label: "消費" },
    { key: "recipes", label: "レシピ" },
    { key: "foods", label: "食品" },
    { key: "settings", label: "設定" },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-3">
        <DeepResearchStatus
          dismissed={dismissedDeep}
          onDismiss={dismissDeep}
          onOpenDraft={(job) => {
            if (job.draft) {
              setFoodForm({ initial: researchDraftToForm(job.draft) });
            }
            dismissDeep(job.id);
          }}
          dismissedDrafts={dismissedDrafts}
          onDismissDraft={dismissDraft}
          onOpenResearchDraft={(notice) => {
            setFoodForm({ initial: researchDraftToForm(notice.draft) });
            dismissDraft(notice.id);
          }}
        />
        {tab === "today" && (
          <DayView
            date={date}
            setDate={setDate}
            hasFoods={hasFoods}
            settings={settingsQuery.data}
            openPicker={(slot) => setPickerSlot(slot)}
            openFoodForm={() => setFoodForm({ initial: emptyForm })}
          />
        )}
        {tab === "history" && (
          <HistoryView
            goToDate={(d) => {
              setDate(d);
              setTab("today");
            }}
          />
        )}
        {tab === "pace" && <ConsumptionView />}
        {tab === "recipes" && (
          <RecipesView
            onLogged={(d) => {
              setDate(d);
              setTab("today");
            }}
          />
        )}
        {tab === "foods" && (
          <>
            <FoodsView
              onAdd={() => setFoodForm({ initial: emptyForm })}
              onBlend={() => setBlendEditor({ initial: emptyBlendInitial })}
              onEdit={(food) =>
                food.source === "blend" && food.blend != null
                  ? setBlendEditor({ initial: blendToInitial(food) })
                  : setFoodForm({ initial: foodToForm(food), foodId: food.id })
              }
            />
            <ResearchSection
              onUseDraft={(record) =>
                setFoodForm({ initial: researchToForm(record) })
              }
            />
          </>
        )}
        {tab === "settings" && <SettingsView settings={settingsQuery.data} />}
      </main>

      <nav
        aria-label="画面切り替え"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] pb-safe"
      >
        <div className="mx-auto flex max-w-2xl">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={`flex-1 py-3 text-sm ${
                tab === t.key
                  ? "font-bold text-[var(--accent)]"
                  : "text-[var(--dim)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {pickerSlot && (
        <FoodPicker
          date={date}
          initialSlot={pickerSlot}
          onClose={() => setPickerSlot(null)}
          pickFoodId={pickerPickId}
          onPickHandled={() => setPickerPickId(null)}
          onAddFood={(prefillName) =>
            // Keep the picker mounted underneath: closing the form returns
            // to it, with the newly registered food selected for logging.
            setFoodForm({ initial: { ...emptyForm, name: prefillName } })
          }
          onAddBlend={(prefillName) =>
            // Same flow as the form: the picker stays underneath and the
            // saved blend is selected for logging on return.
            setBlendEditor({
              initial: { ...emptyBlendInitial, name: prefillName },
            })
          }
        />
      )}
      {blendEditor && (
        <BlendEditor
          initial={blendEditor.initial}
          onClose={() => setBlendEditor(null)}
          onSavedId={
            pickerSlot != null ? (id) => setPickerPickId(id) : undefined
          }
        />
      )}
      {foodForm && (
        <FoodForm
          initial={foodForm.initial}
          foodId={foodForm.foodId}
          onClose={() => setFoodForm(null)}
          onDeepJobHandled={dismissDeep}
          onSavedId={
            pickerSlot != null ? (id) => setPickerPickId(id) : undefined
          }
          onUseExisting={(food) => {
            if (pickerSlot != null) {
              // Back to the picker with this food selected for logging.
              setFoodForm(null);
              setPickerPickId(food.id);
            } else {
              setFoodForm({ initial: foodToForm(food), foodId: food.id });
            }
          }}
        />
      )}
    </div>
  );
}
