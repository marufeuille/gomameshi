DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE foods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  basis_type TEXT NOT NULL,
  basis_label TEXT NOT NULL,
  kcal REAL NOT NULL,
  protein_g REAL NOT NULL,
  fat_g REAL NOT NULL,
  carbs_g REAL NOT NULL,
  salt_g REAL,
  source TEXT NOT NULL,
  default_amount REAL NOT NULL,
  default_unit TEXT NOT NULL,
  unit_grams REAL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE meal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  food_id INTEGER,
  food_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  kcal REAL NOT NULL,
  protein_g REAL NOT NULL,
  fat_g REAL NOT NULL,
  carbs_g REAL NOT NULL,
  salt_g REAL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX meal_logs_date_idx ON meal_logs (date);
--> statement-breakpoint
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
