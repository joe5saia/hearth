-- Remove catalog memberships left by checks written after a product was deleted.
-- Keep every live product's membership and all legacy recipe check identities.
DELETE FROM checks
WHERE substr(key, 1, length('["shopping-list",')) = '["shopping-list",'
  AND NOT EXISTS (SELECT 1 FROM groceries WHERE json_array('shopping-list', id) = checks.key);
