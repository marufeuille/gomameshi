CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  servings REAL,
  servings_label TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_url TEXT,
  ingredients_json TEXT NOT NULL,
  totals_kcal REAL NOT NULL DEFAULT 0,
  totals_protein_g REAL NOT NULL DEFAULT 0,
  totals_fat_g REAL NOT NULL DEFAULT 0,
  totals_carbs_g REAL NOT NULL DEFAULT 0,
  totals_salt_g REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE recipe_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL,
  error TEXT,
  draft_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
