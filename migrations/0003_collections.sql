CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 100)
);
INSERT INTO collections (id,name) VALUES
  ('weeknight','Weeknight favorites'),
  ('vegetarian','Vegetarian'),
  ('comfort','Comfort food'),
  ('special','Something special');
INSERT OR IGNORE INTO collections (id,name) SELECT 'legacy-' || category,category FROM recipes WHERE category <> '';
CREATE TRIGGER collection_rename AFTER UPDATE OF name ON collections BEGIN
  UPDATE recipes SET category=NEW.name WHERE category=OLD.name;
END;
CREATE TRIGGER collection_delete BEFORE DELETE ON collections BEGIN
  UPDATE recipes SET category='' WHERE category=OLD.name;
END;
CREATE TRIGGER recipe_collection_insert BEFORE INSERT ON recipes
WHEN NEW.category <> '' AND NOT EXISTS (SELECT 1 FROM collections WHERE name=NEW.category COLLATE BINARY)
BEGIN SELECT RAISE(ABORT, 'Collection does not exist'); END;
CREATE TRIGGER recipe_collection_update BEFORE UPDATE OF category ON recipes
WHEN NEW.category <> '' AND NOT EXISTS (SELECT 1 FROM collections WHERE name=NEW.category COLLATE BINARY)
BEGIN SELECT RAISE(ABORT, 'Collection does not exist'); END;
