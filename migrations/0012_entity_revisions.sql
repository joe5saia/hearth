-- Random tokens avoid ABA after delete/recreate and cover overlapping old Workers.
ALTER TABLE recipes ADD COLUMN revision TEXT NOT NULL DEFAULT '';
ALTER TABLE meals ADD COLUMN revision TEXT NOT NULL DEFAULT '';
ALTER TABLE groceries ADD COLUMN revision TEXT NOT NULL DEFAULT '';
ALTER TABLE collections ADD COLUMN revision TEXT NOT NULL DEFAULT '';
ALTER TABLE extras ADD COLUMN revision TEXT NOT NULL DEFAULT '';
ALTER TABLE shopping_order ADD COLUMN revision TEXT NOT NULL DEFAULT '';
INSERT OR IGNORE INTO shopping_order(id,aisles,items) VALUES(1,'[]','[]');
-- Token bookkeeping must not invalidate the matching catalog an additional time.
DROP TRIGGER grocery_revision_update;
CREATE TRIGGER grocery_revision_update AFTER UPDATE OF id,name,url,aisle,quantity,unit,aliases ON groceries BEGIN
  UPDATE grocery_revision SET version=version+1 WHERE id=1;
END;
UPDATE recipes SET revision=lower(hex(randomblob(16)));
UPDATE meals SET revision=lower(hex(randomblob(16)));
UPDATE groceries SET revision=lower(hex(randomblob(16)));
UPDATE collections SET revision=lower(hex(randomblob(16)));
UPDATE extras SET revision=lower(hex(randomblob(16)));
UPDATE shopping_order SET revision=lower(hex(randomblob(16)));

CREATE TRIGGER recipes_token_insert AFTER INSERT ON recipes BEGIN
  UPDATE recipes SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER recipes_token_update AFTER UPDATE OF id,title,description,servings,minutes,category,photo,source,rating,ingredients,instructions ON recipes BEGIN
  UPDATE recipes SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER meals_token_insert AFTER INSERT ON meals BEGIN
  UPDATE meals SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER meals_token_update AFTER UPDATE OF id,recipeId,date,slot,scale,note,recipe ON meals BEGIN
  UPDATE meals SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER groceries_token_insert AFTER INSERT ON groceries BEGIN
  UPDATE groceries SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER groceries_token_update AFTER UPDATE OF id,name,url,aisle,quantity,unit,aliases ON groceries BEGIN
  UPDATE groceries SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER collections_token_insert AFTER INSERT ON collections BEGIN
  UPDATE collections SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER collections_token_update AFTER UPDATE OF id,name ON collections BEGIN
  UPDATE collections SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER extras_token_insert AFTER INSERT ON extras BEGIN
  UPDATE extras SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER extras_token_update AFTER UPDATE OF id,name,checked ON extras BEGIN
  UPDATE extras SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER shopping_order_token_insert AFTER INSERT ON shopping_order BEGIN
  UPDATE shopping_order SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER shopping_order_token_update AFTER UPDATE OF id,aisles,items ON shopping_order BEGIN
  UPDATE shopping_order SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;

-- Also upgrade databases that already applied the original snapshot-only 0011.
DROP TRIGGER IF EXISTS meals_snapshot_insert;
DROP TRIGGER IF EXISTS meals_snapshot_update;
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

-- Repair only impossible legacy states; retain every valid customized snapshot.
UPDATE meals SET recipe=(SELECT json_object(
  'id',id,'title',title,'description',description,'servings',servings,
  'minutes',minutes,'category',category,'photo',photo,'source',source,'rating',rating,
  'ingredients',json(ingredients),'instructions',json(instructions)
) FROM recipes WHERE id=meals.recipeId)
WHERE (recipeId IS NULL AND recipe IS NOT NULL)
  OR (recipeId IS NOT NULL AND (recipe IS NULL OR json_extract(recipe,'$.id') IS NOT recipeId));
