PRAGMA foreign_keys = ON;

-- Lowercase / numeric expression indexes used by list and filter queries.
-- D1 (SQLite) supports expression indexes; LIKE with leading wildcards on the
-- *expression* (LOWER(col)) is still a scan, but equality and prefix filters
-- use these directly, and FTS5 (below) handles full-text search.
CREATE INDEX IF NOT EXISTS idx_books_title_lower ON books(LOWER(title));
CREATE INDEX IF NOT EXISTS idx_books_author_lower ON books(LOWER(author));
CREATE INDEX IF NOT EXISTS idx_books_isbn_lower ON books(LOWER(isbn));
CREATE INDEX IF NOT EXISTS idx_books_language_lower ON books(LOWER(language));
CREATE INDEX IF NOT EXISTS idx_books_publication_year ON books(publication_year);
CREATE INDEX IF NOT EXISTS idx_books_active_updated ON books(deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_books_active_title ON books(deleted_at, title);
CREATE INDEX IF NOT EXISTS idx_books_active_author ON books(deleted_at, author);

-- FTS5 contentless table indexed manually via triggers below. Tokenizer
-- "unicode61 remove_diacritics 2" gives accent-insensitive matching, which
-- matters for catalogues with mixed-language titles.
CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
  title,
  author,
  isbn,
  publisher,
  description,
  tags,
  custom_text,
  content=''
);

-- Backfill FTS for any pre-existing rows. INSERT OR REPLACE keeps re-runs idempotent.
INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
SELECT
  ROWID,
  COALESCE(title, ''),
  COALESCE(author, ''),
  COALESCE(isbn, ''),
  COALESCE(publisher, ''),
  COALESCE(description, ''),
  COALESCE(tags, ''),
  COALESCE(custom_fields, '')
FROM books
WHERE deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM books_fts WHERE books_fts.rowid = books.ROWID);

-- Keep FTS in sync with the books table.
CREATE TRIGGER IF NOT EXISTS books_fts_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    new.ROWID,
    COALESCE(new.title, ''),
    COALESCE(new.author, ''),
    COALESCE(new.isbn, ''),
    COALESCE(new.publisher, ''),
    COALESCE(new.description, ''),
    COALESCE(new.tags, ''),
    COALESCE(new.custom_fields, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS books_fts_ad AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    'delete',
    old.ROWID,
    COALESCE(old.title, ''),
    COALESCE(old.author, ''),
    COALESCE(old.isbn, ''),
    COALESCE(old.publisher, ''),
    COALESCE(old.description, ''),
    COALESCE(old.tags, ''),
    COALESCE(old.custom_fields, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS books_fts_au AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    'delete',
    old.ROWID,
    COALESCE(old.title, ''),
    COALESCE(old.author, ''),
    COALESCE(old.isbn, ''),
    COALESCE(old.publisher, ''),
    COALESCE(old.description, ''),
    COALESCE(old.tags, ''),
    COALESCE(old.custom_fields, '')
  );
  INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    new.ROWID,
    COALESCE(new.title, ''),
    COALESCE(new.author, ''),
    COALESCE(new.isbn, ''),
    COALESCE(new.publisher, ''),
    COALESCE(new.description, ''),
    COALESCE(new.tags, ''),
    COALESCE(new.custom_fields, '')
  );
END;
