CREATE TABLE meals_with_notes (
  id TEXT PRIMARY KEY,
  recipeId TEXT REFERENCES recipes(id) ON DELETE RESTRICT,
  date TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('Breakfast', 'Lunch', 'Dinner')),
  scale REAL NOT NULL CHECK (scale > 0 AND scale <= 100),
  note TEXT NOT NULL DEFAULT '',
  CHECK (recipeId IS NOT NULL OR length(trim(note)) > 0)
);
INSERT INTO meals_with_notes (id,recipeId,date,slot,scale,note)
SELECT id,recipeId,date,slot,scale,note FROM meals;
DROP TABLE meals;
ALTER TABLE meals_with_notes RENAME TO meals;
CREATE INDEX meals_date ON meals(date);
