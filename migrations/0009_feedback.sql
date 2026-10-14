CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  envelope TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  queued INTEGER NOT NULL DEFAULT 0 CHECK (queued IN (0, 1))
);
CREATE INDEX feedback_created ON feedback(createdAt);
