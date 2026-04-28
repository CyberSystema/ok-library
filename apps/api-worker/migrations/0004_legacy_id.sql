PRAGMA foreign_keys = ON;

-- Source-of-truth identifier for rows imported from external catalogues
-- (e.g. the LIBRARY_normalized.xlsx where rows look like "OLD-9", "OLD-10").
-- Storing it explicitly lets the importer upsert by legacy_id, so re-running
-- an xlsx import refreshes existing rows instead of duplicating them.
ALTER TABLE books ADD COLUMN legacy_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_books_legacy_id
  ON books(legacy_id)
  WHERE legacy_id IS NOT NULL;
