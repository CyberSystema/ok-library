-- Make a bad ISBN findable.
--
-- `checkIsbn` has been computed on every read since Phase B — `parseBook` puts
-- `isbnValid` on every record — and nothing has ever displayed it. So a mistyped
-- ISBN is silently wrong forever: it never matches a lookup, never matches
-- another library's record, and nobody is told.
--
-- Showing it is a UI change. FINDING them is not: a value computed in the Worker
-- cannot appear in a WHERE clause, so "show me every book with a broken ISBN"
-- needs a column.
--
-- ─── Why a GENERATED column and not an ordinary one ────────────────────────
--
-- The obvious implementation is a plain column written beside `isbn_fold`. That
-- means eight write paths — create, update, merge, two imports, MARCXML, sync
-- and the two healing passes — each of which must remember. The romanized folds
-- are the cautionary tale: migration 0023 added three columns, two write paths
-- forgot them, and the omission survived four phases because the value looked
-- right everywhere it was written and was simply absent everywhere it was not.
--
-- A generated column cannot be forgotten. It is not stored and not written; it
-- is recomputed from `isbn` on every read, so it is correct by construction for
-- every row that exists today and every row any future code path inserts. No
-- backfill, no sweep, no healing pass, nothing to drift.
--
-- VIRTUAL rather than STORED because SQLite only permits VIRTUAL in ALTER TABLE
-- — and it costs nothing here, since the only query that reads it is the smart
-- list and the partial index below already materialises the answer.
--
--   NULL = no ISBN, or not 10/13 characters (the honest answer for most rows)
--   1    = the check digit computes
--   0    = it does not
--
-- Deliberately never a reason to refuse a save. Small publishers really do
-- misprint check digits, and a catalogue that rejects the number printed in the
-- book is worse than one that flags it.
--
-- The arithmetic mirrors `checkIsbn` in packages/shared exactly: ISBN-13 is the
-- alternating 1/3 weighting mod 10; ISBN-10 is the descending 10..2 weighting
-- mod 11 with 'X' meaning 10. Verified against both valid and corrupted forms
-- of each, plus an X check digit, junk and NULL.

ALTER TABLE books ADD COLUMN isbn_valid INTEGER GENERATED ALWAYS AS (
  CASE
    WHEN isbn IS NULL OR TRIM(isbn) = '' THEN NULL
    -- ISBN-13: digits only, alternating weights 1 and 3, checksum mod 10.
    WHEN LENGTH(isbn) = 13 AND isbn GLOB '[0-9]*' THEN
      CASE WHEN (10 - ((
          CAST(substr(isbn,1,1) AS INTEGER)+CAST(substr(isbn,3,1) AS INTEGER)+CAST(substr(isbn,5,1) AS INTEGER)
        + CAST(substr(isbn,7,1) AS INTEGER)+CAST(substr(isbn,9,1) AS INTEGER)+CAST(substr(isbn,11,1) AS INTEGER)
        + 3*(CAST(substr(isbn,2,1) AS INTEGER)+CAST(substr(isbn,4,1) AS INTEGER)+CAST(substr(isbn,6,1) AS INTEGER)
           + CAST(substr(isbn,8,1) AS INTEGER)+CAST(substr(isbn,10,1) AS INTEGER)+CAST(substr(isbn,12,1) AS INTEGER))
        ) % 10)) % 10 = CAST(substr(isbn,13,1) AS INTEGER) THEN 1 ELSE 0 END
    -- ISBN-10: nine digits weighted 10..2, checksum mod 11, final char may be X.
    WHEN LENGTH(isbn) = 10 AND substr(isbn,1,9) GLOB '[0-9]*' THEN
      CASE WHEN ((11 - ((
          10*CAST(substr(isbn,1,1) AS INTEGER)+9*CAST(substr(isbn,2,1) AS INTEGER)+8*CAST(substr(isbn,3,1) AS INTEGER)
        + 7*CAST(substr(isbn,4,1) AS INTEGER)+6*CAST(substr(isbn,5,1) AS INTEGER)+5*CAST(substr(isbn,6,1) AS INTEGER)
        + 4*CAST(substr(isbn,7,1) AS INTEGER)+3*CAST(substr(isbn,8,1) AS INTEGER)+2*CAST(substr(isbn,9,1) AS INTEGER)
        ) % 11)) % 11) = (CASE WHEN upper(substr(isbn,10,1)) = 'X' THEN 10 ELSE CAST(substr(isbn,10,1) AS INTEGER) END)
      THEN 1 ELSE 0 END
    ELSE NULL
  END
) VIRTUAL;

-- Partial: only the broken ones are ever queried and they are a rounding error
-- against 12,675 rows. On the free tier "rows written" counts index maintenance
-- (migration 0015), so indexing the whole column would cost on every write to
-- earn nothing.
CREATE INDEX IF NOT EXISTS idx_books_isbn_invalid ON books(isbn_valid) WHERE isbn_valid = 0;
