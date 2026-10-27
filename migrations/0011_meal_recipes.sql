-- Snapshot every recipe field without changing meal identity or attaching note-only rows.
ALTER TABLE meals ADD COLUMN recipe TEXT CHECK (recipe IS NULL OR json_valid(recipe));
UPDATE meals SET recipe = (
  SELECT json_object(
    'id',id,'title',title,'description',description,'servings',servings,
    'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
    'ingredients',json(ingredients),'instructions',json(instructions)
  ) FROM recipes WHERE recipes.id = meals.recipeId
) WHERE recipeId IS NOT NULL;

-- Overlapping Workers omit recipe. Capture at their write, not just at migration time.
CREATE TRIGGER meals_snapshot_insert AFTER INSERT ON meals
WHEN NEW.recipeId IS NOT NULL AND NEW.recipe IS NULL
BEGIN
  UPDATE meals SET recipe=(SELECT json_object(
    'id',id,'title',title,'description',description,'servings',servings,
    'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
    'ingredients',json(ingredients),'instructions',json(instructions)
  ) FROM recipes WHERE id=NEW.recipeId) WHERE id=NEW.id;
END;
CREATE TRIGGER meals_snapshot_update AFTER UPDATE OF recipeId,recipe ON meals
WHEN (NEW.recipeId IS NULL AND NEW.recipe IS NOT NULL)
  OR (NEW.recipeId IS NOT NULL AND (NEW.recipe IS NULL
    OR (NEW.recipeId IS NOT OLD.recipeId AND NEW.recipe IS OLD.recipe)))
BEGIN
  UPDATE meals SET recipe=(SELECT json_object(
    'id',id,'title',title,'description',description,'servings',servings,
    'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
    'ingredients',json(ingredients),'instructions',json(instructions)
  ) FROM recipes WHERE id=NEW.recipeId) WHERE id=NEW.id;
END;
