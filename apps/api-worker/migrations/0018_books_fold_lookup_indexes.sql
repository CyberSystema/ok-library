-- Two exact-match lookups on folded text run often enough to be worth an index:
--
--  1. The duplicate warning shown after every book is added. It compared
--     LOWER(TRIM(title)) — a function of the column, so SQLite could not use
--     any index and read all ~12.5K rows every time a librarian added a book.
--  2. "Select all books by this author", which filters on author_fold.
--
-- The folded columns are pre-normalized in JS (accent- and case-folded, Greek
-- included, which SQLite's ASCII-only LOWER() cannot do), so a plain equality
-- index on them is directly usable.
CREATE INDEX IF NOT EXISTS idx_books_title_author_fold ON books(title_fold, author_fold);
CREATE INDEX IF NOT EXISTS idx_books_author_fold ON books(author_fold);
