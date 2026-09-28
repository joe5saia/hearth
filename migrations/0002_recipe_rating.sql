ALTER TABLE recipes ADD COLUMN rating TEXT NOT NULL DEFAULT 'neutral' CHECK (rating IN ('up', 'down', 'neutral'));
