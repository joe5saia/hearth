ALTER TABLE checks ADD COLUMN packages INTEGER NOT NULL DEFAULT 1
  CHECK (packages >= 1 AND packages <= 1000000 AND packages = CAST(packages AS INTEGER));
