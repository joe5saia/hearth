-- Dated shopping lists. A grocery is on a list only while its row exists; checked means picked up.
-- Any number of lists may share a date. Lists are never finished or locked.
CREATE TABLE shopping_lists (
  id TEXT PRIMARY KEY NOT NULL,
  date TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revision TEXT NOT NULL DEFAULT ''
);
CREATE INDEX shopping_lists_date ON shopping_lists(date);
CREATE TRIGGER shopping_lists_token_insert AFTER INSERT ON shopping_lists BEGIN
  UPDATE shopping_lists SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
CREATE TRIGGER shopping_lists_token_update AFTER UPDATE OF id,date,label ON shopping_lists BEGIN
  UPDATE shopping_lists SET revision=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;

-- Deleting a list or a catalog grocery removes its list rows.
CREATE TABLE shopping_list_items (
  list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  grocery_id TEXT NOT NULL REFERENCES groceries(id) ON DELETE CASCADE,
  checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
  packages INTEGER NOT NULL DEFAULT 1
    CHECK (packages >= 1 AND packages <= 1000000 AND packages = CAST(packages AS INTEGER)),
  sources TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources) AND json_type(sources) = 'array'),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  checked_at TEXT,
  PRIMARY KEY (list_id, grocery_id)
);
CREATE INDEX shopping_list_items_grocery ON shopping_list_items(grocery_id);

-- Carry the single legacy list into one list dated at the start of this (Saturday–Friday) week.
-- Legacy checked catalog rows meant "off the list", so only unchecked rows and open extras move.
-- Fixed identifiers and timestamps keep the carried-over rows identical wherever this migration runs.
INSERT INTO shopping_lists(id,date,created_at)
SELECT 'legacy-list', date('now','-6 days','weekday 6'), date('now','-6 days','weekday 6')||'T00:00:00.000Z'
WHERE EXISTS (SELECT 1 FROM checks JOIN groceries ON checks.key=json_array('shopping-list',groceries.id)
    WHERE checks.checked=0)
  OR EXISTS (SELECT 1 FROM extras WHERE checked=0 AND length(trim(name))>0);

INSERT INTO shopping_list_items(list_id,grocery_id,packages,added_at)
SELECT 'legacy-list', groceries.id, checks.packages, (SELECT created_at FROM shopping_lists WHERE id='legacy-list')
FROM checks JOIN groceries ON checks.key=json_array('shopping-list',groceries.id)
WHERE checks.checked=0;

-- Free-text extras become catalog groceries, reusing an existing product with the same name.
-- Group by name so repeated extras create one product. Extra IDs could be 100 characters, so
-- long ones get a random ID that fits the 100-character grocery ID; rows are linked by name below.
INSERT INTO groceries(id,name,url,aisle,quantity,unit,aliases)
SELECT CASE WHEN length(open.id) <= 94 THEN 'extra-'||open.id ELSE 'extra-'||lower(hex(randomblob(16))) END,
  open.name, '', '', 1, 'each', json_array(open.name)
FROM (
  SELECT MIN(id) AS id, substr(trim(name),1,150) AS name FROM extras
  WHERE checked=0 AND length(trim(name))>0
  GROUP BY lower(substr(trim(name),1,150))
) AS open
WHERE NOT EXISTS (SELECT 1 FROM groceries WHERE lower(groceries.name)=lower(open.name))
  AND NOT EXISTS (SELECT 1 FROM groceries WHERE id='extra-'||open.id);

INSERT OR IGNORE INTO shopping_list_items(list_id,grocery_id,added_at)
SELECT 'legacy-list', (SELECT groceries.id FROM groceries
  WHERE lower(groceries.name)=lower(substr(trim(extras.name),1,150)) ORDER BY groceries.id LIMIT 1),
  (SELECT created_at FROM shopping_lists WHERE id='legacy-list')
FROM extras
WHERE extras.checked=0 AND length(trim(extras.name))>0;
-- The legacy checks and extras tables stay readable by Workers still serving the previous release.
