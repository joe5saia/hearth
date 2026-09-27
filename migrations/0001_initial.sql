CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  servings REAL NOT NULL CHECK (servings > 0),
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  category TEXT NOT NULL,
  photo TEXT NOT NULL,
  source TEXT NOT NULL,
  ingredients TEXT NOT NULL CHECK (json_valid(ingredients)),
  instructions TEXT NOT NULL CHECK (json_valid(instructions))
);
CREATE TABLE meals (
  id TEXT PRIMARY KEY,
  recipeId TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  date TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('Breakfast', 'Lunch', 'Dinner')),
  scale REAL NOT NULL CHECK (scale > 0 AND scale <= 100),
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX meals_date ON meals(date);
CREATE TABLE extras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1))
);
CREATE TABLE checks (
  key TEXT PRIMARY KEY,
  checked INTEGER NOT NULL CHECK (checked IN (0, 1))
);
