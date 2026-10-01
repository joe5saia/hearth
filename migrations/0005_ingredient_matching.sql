CREATE TABLE ingredient_match_cache (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK(json_valid(value)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE grocery_revision (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  version INTEGER NOT NULL
);
INSERT INTO grocery_revision(id, version) VALUES (1, 0);
CREATE TRIGGER grocery_revision_insert AFTER INSERT ON groceries
BEGIN
  UPDATE grocery_revision SET version = version + 1 WHERE id = 1;
END;
CREATE TRIGGER grocery_revision_update AFTER UPDATE ON groceries
BEGIN
  UPDATE grocery_revision SET version = version + 1 WHERE id = 1;
END;
CREATE TRIGGER grocery_revision_delete AFTER DELETE ON groceries
BEGIN
  UPDATE grocery_revision SET version = version + 1 WHERE id = 1;
END;
