-- 0015_drop_redundant_book_indexes
--
-- Drop five secondary indexes on `books` that no query plan can use, so every
-- book INSERT/UPDATE (and especially a bulk import) writes five fewer index
-- rows. On the Cloudflare free tier "rows written" (100k/day) counts index
-- maintenance, so this is a direct write-cost saving with zero read cost — each
-- dropped index was verified unused:
--
--   idx_books_title_lower  ON books(LOWER(title))    -- search moved to the
--   idx_books_author_lower ON books(LOWER(author))   -- *_fold columns + FTS;
--                                                       no query references the
--                                                       bare LOWER(col) form
--                                                       (dedup uses LOWER(TRIM())).
--   idx_books_language_lower ON books(LOWER(language)) -- the only reader is
--                                                       `LOWER(language) LIKE '%x%'`,
--                                                       whose leading wildcard
--                                                       forces a full scan anyway.
--   idx_books_title  ON books(title)   -- superseded by idx_books_active_title
--   idx_books_author ON books(author)  -- and idx_books_active_author; the list
--                                         sort prepends a CASE (blank-last), which
--                                         already defeats index-ordered scans, and
--                                         no query does a bare `WHERE title = ?`.
--
-- idx_books_isbn / idx_books_isbn_lower are intentionally KEPT: ISBN is a
-- book's natural key and exact-lookup paths are plausible to add.

DROP INDEX IF EXISTS idx_books_title_lower;
DROP INDEX IF EXISTS idx_books_author_lower;
DROP INDEX IF EXISTS idx_books_language_lower;
DROP INDEX IF EXISTS idx_books_title;
DROP INDEX IF EXISTS idx_books_author;
