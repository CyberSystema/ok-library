-- Multi-part works: the 29 "Φιλοσοφία" volumes, ΒΙΒΛΙΟΘΗΚΗ ΕΛΛΗΝΩΝ ΠΑΤΕΡΩΝ,
-- ΠΑΠΥΡΟΣ ΛΑΡΟΥΣ, and the ~930 other sets already in this catalogue.
--
-- Two shapes exist here and both have to work:
--
--  * Volumes with their own titles — ΒΙΒΛΙΟΘΗΚΗ ΕΛΛΗΝΩΝ ΠΑΤΕΡΩΝ is a different
--    Father per volume — so each volume is its own record, joined by `set_id`
--    and ordered by `set_position`.
--  * Volumes without distinct titles, held as ONE record whose copies carry
--    `items.volume_num` (already supported by the holdings layer).
--
-- `bib_level` names which kind of thing a record is, the way MARC leader/07
-- does: a monograph, one part of a multi-part work, or a serial (B6).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS book_sets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_romanized TEXT,
  -- Folded for the same accent/case-insensitive matching everything else gets.
  title_fold TEXT,
  author TEXT,
  publisher TEXT,
  -- How many volumes the set SHOULD have, when that is known. Without it the
  -- gap report can only infer the highest volume held, which under-reports a
  -- set whose tail is missing entirely.
  expected_volumes INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_book_sets_fold ON book_sets(title_fold, deleted_at);

ALTER TABLE books ADD COLUMN set_id TEXT REFERENCES book_sets(id);
-- REAL, not INTEGER: real volume designations include "2α" and "3 bis", and a
-- sortable position has to be able to sit between two integers.
ALTER TABLE books ADD COLUMN set_position REAL;
-- As authored ("Α'", "τ. 3", "1-2"). `set_position` is the sortable reading of
-- it; this is what gets displayed.
ALTER TABLE books ADD COLUMN volume_designation TEXT;
ALTER TABLE books ADD COLUMN bib_level TEXT NOT NULL DEFAULT 'monograph';

CREATE INDEX IF NOT EXISTS idx_books_set ON books(set_id, set_position);
CREATE INDEX IF NOT EXISTS idx_books_bib_level ON books(bib_level, deleted_at);

-- NOTE: no data migration here, deliberately.
--
-- 930 clusters are already inferable from the `series` custom field, and 644
-- books carry `volume_num` — but 7,144 rows have `series` equal to their own
-- title (an import artifact), and hundreds of titles end in "(ΜΕΡΟΣ Α')" that
-- would need splitting. Deciding which of those are real sets is a judgement
-- call, so it goes through a preview-and-approve tool rather than a migration
-- that rewrites the catalogue on deploy. `GET /api/books/set-candidates`
-- proposes; the librarian confirms.
