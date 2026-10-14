-- Keep the 0007 shopping-membership cleanup; deletion now also preserves recipes by unlinking.
DROP TRIGGER groceries_restrict_delete;
CREATE TRIGGER groceries_unlink_delete BEFORE DELETE ON groceries
BEGIN
  UPDATE recipes SET ingredients = (
    SELECT json_group_array(json(value)) FROM (
      SELECT CASE WHEN json_extract(ingredient.value, '$.groceryItemId') = OLD.id
          THEN json_set(ingredient.value, '$.groceryItemId', NULL)
          ELSE ingredient.value
        END AS value
      FROM json_each(recipes.ingredients) AS ingredient
      ORDER BY CAST(ingredient.key AS INTEGER)
    )
  ) WHERE EXISTS (
    SELECT 1 FROM json_each(recipes.ingredients) AS ingredient
    WHERE json_extract(ingredient.value, '$.groceryItemId') = OLD.id
  );
END;
