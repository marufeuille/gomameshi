CREATE TABLE food_research (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_name TEXT NOT NULL,
  query_norm TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  name TEXT,
  basis_type TEXT,
  basis_label TEXT,
  serving_grams REAL,
  kcal REAL,
  protein_g REAL,
  fat_g REAL,
  carbs_g REAL,
  salt_g REAL,
  source_name TEXT,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
