-- The source link is optional; the snapshot belongs to the meal, not its recipe.
CREATE TABLE meals_detachable (
  id TEXT PRIMARY KEY,
  recipeId TEXT REFERENCES recipes(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('Breakfast', 'Lunch', 'Dinner')),
  scale REAL NOT NULL CHECK (scale > 0 AND scale <= 100),
  note TEXT NOT NULL DEFAULT '',
  recipe TEXT CHECK (recipe IS NULL OR json_valid(recipe)),
  revision TEXT NOT NULL DEFAULT '',
  CHECK (recipeId IS NOT NULL OR recipe IS NOT NULL OR length(trim(note)) > 0)
);
INSERT INTO meals_detachable (id,recipeId,date,slot,scale,note,recipe,revision)
SELECT id,recipeId,date,slot,scale,note,recipe,revision FROM meals;
DROP TABLE meals;
ALTER TABLE meals_detachable RENAME TO meals;
CREATE INDEX meals_date ON meals(date);

CREATE TRIGGER meals_token_insert AFTER INSERT ON meals BEGIN
  UPDATE meals SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER meals_token_update AFTER UPDATE OF id,recipeId,date,slot,scale,note,recipe ON meals BEGIN
  UPDATE meals SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;

CREATE TRIGGER meals_snapshot_insert AFTER INSERT ON meals
WHEN NEW.recipeId IS NOT NULL AND NEW.recipe IS NULL
BEGIN
  UPDATE meals SET recipe=(SELECT json_object(
    'id',id,'title',title,'description',description,'servings',servings,
    'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
    'ingredients',json(ingredients),'instructions',json(instructions)
  ) FROM recipes WHERE id=NEW.recipeId) WHERE id=NEW.id;
END;
-- Old SQL can still change sources or convert linked meals to notes. A deleted
-- parent is already absent when SET NULL runs, so that action keeps the snapshot.
CREATE TRIGGER meals_snapshot_update AFTER UPDATE OF recipeId,recipe ON meals
WHEN (NEW.recipeId IS NOT NULL AND (NEW.recipe IS NULL
    OR (NEW.recipeId IS NOT OLD.recipeId AND NEW.recipe IS OLD.recipe)))
  OR (NEW.recipeId IS NULL AND OLD.recipeId IS NOT NULL
    AND NEW.recipe IS OLD.recipe AND NEW.revision IS OLD.revision
    AND EXISTS (SELECT 1 FROM recipes WHERE id=OLD.recipeId))
BEGIN
  UPDATE meals SET recipe=(SELECT json_object(
    'id',id,'title',title,'description',description,'servings',servings,
    'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
    'ingredients',json(ingredients),'instructions',json(instructions)
  ) FROM recipes WHERE id=NEW.recipeId),revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
-- Previous Workers treat every null source as note-only and erase its snapshot.
-- Reject those writes. Current full saves explicitly rotate the token, allowing
-- deliberate conversion to a note while retaining the normal revision guard.
CREATE TRIGGER meals_detached_snapshot_guard BEFORE UPDATE OF recipe ON meals
WHEN OLD.recipeId IS NULL AND OLD.recipe IS NOT NULL
  AND NEW.recipeId IS NULL AND NEW.recipe IS NULL AND NEW.revision IS OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'Reload before changing a detached meal');
END;

CREATE TRIGGER meals_photo_insert AFTER INSERT ON meals
WHEN NEW.recipe IS NOT NULL AND json_extract(NEW.recipe,'$.photo') LIKE 'data:image/%;base64,%'
BEGIN
  INSERT INTO photos(data) SELECT json_extract(NEW.recipe,'$.photo')
    WHERE NOT EXISTS (SELECT 1 FROM photos WHERE data=json_extract(NEW.recipe,'$.photo'));
  UPDATE meals SET recipe=json_set(recipe,'$.photo',(
    SELECT path FROM photos WHERE data=json_extract(NEW.recipe,'$.photo')
  )) WHERE id=NEW.id;
END;
CREATE TRIGGER meals_photo_update AFTER UPDATE OF recipe ON meals
WHEN NEW.recipe IS NOT NULL AND json_extract(NEW.recipe,'$.photo') LIKE 'data:image/%;base64,%'
BEGIN
  INSERT INTO photos(data) SELECT json_extract(NEW.recipe,'$.photo')
    WHERE NOT EXISTS (SELECT 1 FROM photos WHERE data=json_extract(NEW.recipe,'$.photo'));
  UPDATE meals SET recipe=json_set(recipe,'$.photo',(
    SELECT path FROM photos WHERE data=json_extract(NEW.recipe,'$.photo')
  )) WHERE id=NEW.id;
END;
