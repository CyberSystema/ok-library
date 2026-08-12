-- The smart list for broken ISBNs and the record's own badge disagreed 33 times.
--
-- Migration 0031 added `isbn_valid` as a GENERATED column and claimed "The
-- arithmetic mirrors `checkIsbn` in packages/shared exactly." It does not, and it
-- cannot: `checkIsbn` begins by stripping every character outside [0-9Xx], and
-- SQLite's core has no way to do that. Two divergences follow, both measured
-- against the live catalogue:
--
--   * SEPARATORS. `LENGTH(isbn) = 13` is tested on the raw column, so
--     978-960-7407-12-3 — seventeen characters, and the way every book on the
--     shelf actually prints its ISBN — matches neither branch and yields NULL.
--     A hyphenated ISBN with a wrong check digit is therefore invisible to the
--     list built to find exactly that. 242 of 826 stored ISBNs carry a separator
--     or a letter.
--
--   * `isbn GLOB '[0-9]*'` constrains only the FIRST character; the rest of the
--     pattern matches anything. So `978A42016B85A` passed the guard, each letter
--     CAST to 0, and the arithmetic happened to land on the check digit: the
--     column said VALID for a string that is not an ISBN, while the record's own
--     badge — from `checkIsbn` — said broken.
--
-- The drift is the symptom. The defect is that one rule had two implementations,
-- and the SQL one would re-diverge the moment `checkIsbn` changed. 0031 chose
-- GENERATED to avoid "eight write paths each of which must remember", which is a
-- real risk and the right thing to worry about — but it is the risk this codebase
-- has already built machinery against. `computeBookFolds` is exactly that
-- mechanism: one JS function, spread into every books INSERT and UPDATE, healed
-- by two admin sweeps, and guarded by two static assertions in the gate that fail
-- when a write path forgets a column. `isbn_valid` joins it, so the value ships
-- from the same function the badge reads and there is no second arithmetic to
-- keep in step.
--
-- The index has to go first: SQLite refuses to drop a column an index mentions.
DROP INDEX IF EXISTS idx_books_isbn_invalid;
ALTER TABLE books DROP COLUMN isbn_valid;

--   NULL = no ISBN at all
--   1    = the check digit computes
--   0    = it does not, INCLUDING a value that is not 10 or 13 characters once
--          the separators come off — which is `checkIsbn`'s answer for a
--          truncated or overtyped number, and the one the badge shows.
--
-- Deliberately never a reason to refuse a save. Small publishers really do
-- misprint check digits, and a catalogue that rejects the number printed in the
-- book is worse than one that flags it.
ALTER TABLE books ADD COLUMN isbn_valid INTEGER;

-- Partial, on the broken ones only. They are a rounding error against 12,675
-- rows, and on the free tier "rows written" counts index maintenance
-- (migration 0015), so indexing the whole column would cost on every write to
-- earn nothing.
CREATE INDEX IF NOT EXISTS idx_books_isbn_invalid ON books(isbn_valid) WHERE isbn_valid = 0;

-- Backfill. Only rows that HAVE an ISBN can be anything but NULL, and the value
-- cannot be computed here — that is the entire point of the migration — so this
-- marks them 0 and leaves the real answer to `POST /api/admin/normalize-books`,
-- the sweep that already rewrites every fold for every row and now writes this
-- column with them.
--
-- 0 rather than NULL on purpose: a record with an ISBN whose validity is not yet
-- known appears in the "broken ISBN" list until the sweep runs. Over-reporting
-- sends the librarian to look at a good record; under-reporting silently drops a
-- bad one from the only list that would have surfaced it. The first is a wasted
-- minute, the second is the bug this migration exists to close.
UPDATE books SET isbn_valid = 0 WHERE isbn IS NOT NULL AND TRIM(isbn) <> '';
