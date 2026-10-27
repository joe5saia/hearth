-- Keep references inside the previous PhotoSchema's /photos/[a-z-]+.jpg namespace
-- so overlapping Workers can still decode household data. Content-Type, not the
-- suffix, identifies PNG/WebP/JPEG. Legacy assets receive random stable IDs;
-- new uploads use SHA-256 with hexadecimal digits 0-9 encoded as g-p.
CREATE TABLE IF NOT EXISTS photos (
  path TEXT PRIMARY KEY NOT NULL DEFAULT ('/photos/upload-' ||
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      lower(hex(randomblob(32))), '0','g'),'1','h'),'2','i'),'3','j'),'4','k'),
      '5','l'),'6','m'),'7','n'),'8','o'),'9','p') || '.jpg'),
  data TEXT NOT NULL
);

-- Old Workers can still write inline uploads. Extract inside the same transaction
-- and preserve customized snapshots rather than deriving photos from live recipes.
-- Install these BEFORE backfilling so overlapping writes cannot escape extraction.
CREATE TRIGGER IF NOT EXISTS recipes_photo_insert AFTER INSERT ON recipes
WHEN NEW.photo LIKE 'data:image/%;base64,%'
BEGIN
  INSERT INTO photos(data) SELECT NEW.photo WHERE NOT EXISTS (SELECT 1 FROM photos WHERE data=NEW.photo);
  UPDATE recipes SET photo=(SELECT path FROM photos WHERE data=NEW.photo) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS recipes_photo_update AFTER UPDATE OF photo ON recipes
WHEN NEW.photo LIKE 'data:image/%;base64,%'
BEGIN
  INSERT INTO photos(data) SELECT NEW.photo WHERE NOT EXISTS (SELECT 1 FROM photos WHERE data=NEW.photo);
  UPDATE recipes SET photo=(SELECT path FROM photos WHERE data=NEW.photo) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS meals_photo_insert AFTER INSERT ON meals
WHEN NEW.recipe IS NOT NULL AND json_extract(NEW.recipe,'$.photo') LIKE 'data:image/%;base64,%'
BEGIN
  INSERT INTO photos(data) SELECT json_extract(NEW.recipe,'$.photo')
    WHERE NOT EXISTS (SELECT 1 FROM photos WHERE data=json_extract(NEW.recipe,'$.photo'));
  UPDATE meals SET recipe=json_set(recipe,'$.photo',(
    SELECT path FROM photos WHERE data=json_extract(NEW.recipe,'$.photo')
  )) WHERE id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS meals_photo_update AFTER UPDATE OF recipe ON meals
WHEN NEW.recipe IS NOT NULL AND json_extract(NEW.recipe,'$.photo') LIKE 'data:image/%;base64,%'
BEGIN
  INSERT INTO photos(data) SELECT json_extract(NEW.recipe,'$.photo')
    WHERE NOT EXISTS (SELECT 1 FROM photos WHERE data=json_extract(NEW.recipe,'$.photo'));
  UPDATE meals SET recipe=json_set(recipe,'$.photo',(
    SELECT path FROM photos WHERE data=json_extract(NEW.recipe,'$.photo')
  )) WHERE id=NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS photos_immutable BEFORE UPDATE ON photos
BEGIN
  SELECT RAISE(ABORT, 'Photo assets are immutable');
END;

-- Extract every distinct upload before replacing either source or snapshot.
-- Rerunning after an interrupted migration preserves existing asset identities.
INSERT INTO photos(data)
SELECT photo FROM (
  SELECT photo FROM recipes
  UNION SELECT json_extract(recipe,'$.photo') FROM meals WHERE recipe IS NOT NULL
) WHERE photo LIKE 'data:image/%;base64,%'
  AND NOT EXISTS (SELECT 1 FROM photos WHERE data=photo);
UPDATE recipes SET photo=(SELECT path FROM photos WHERE data=recipes.photo)
WHERE photo LIKE 'data:image/%;base64,%';
UPDATE meals SET recipe=json_set(recipe,'$.photo',(
  SELECT path FROM photos WHERE data=json_extract(meals.recipe,'$.photo')
)) WHERE recipe IS NOT NULL AND json_extract(recipe,'$.photo') LIKE 'data:image/%;base64,%';
