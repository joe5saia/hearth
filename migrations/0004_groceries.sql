CREATE TABLE groceries (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  aisle TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0 AND quantity <= 1000000),
  unit TEXT NOT NULL,
  aliases TEXT NOT NULL CHECK(json_valid(aliases))
);
CREATE TABLE shopping_order (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  aisles TEXT NOT NULL,
  items TEXT NOT NULL
);
CREATE TRIGGER groceries_restrict_delete BEFORE DELETE ON groceries
WHEN EXISTS (SELECT 1 FROM recipes, json_each(recipes.ingredients) AS ingredient
  WHERE json_extract(ingredient.value, '$.groceryItemId') = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'Grocery item is used by a recipe');
END;
CREATE TRIGGER recipes_grocery_insert BEFORE INSERT ON recipes
WHEN EXISTS (SELECT 1 FROM json_each(NEW.ingredients) AS ingredient
  WHERE json_extract(ingredient.value, '$.groceryItemId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM groceries WHERE id = json_extract(ingredient.value, '$.groceryItemId')))
BEGIN
  SELECT RAISE(ABORT, 'Grocery item does not exist');
END;
CREATE TRIGGER recipes_grocery_update BEFORE UPDATE OF ingredients ON recipes
WHEN EXISTS (SELECT 1 FROM json_each(NEW.ingredients) AS ingredient
  WHERE json_extract(ingredient.value, '$.groceryItemId') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM groceries WHERE id = json_extract(ingredient.value, '$.groceryItemId')))
BEGIN
  SELECT RAISE(ABORT, 'Grocery item does not exist');
END;
