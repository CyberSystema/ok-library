PRAGMA foreign_keys = ON;

-- Search hardening: store pre-folded copies of every searchable column
-- alongside the source columns. The Worker writes these on every
-- INSERT/UPDATE using a JS fold (lowercase + NFKD + strip combining marks
-- + ς→σ) which is something SQLite's FTS5 `unicode61 remove_diacritics 2`
-- tokenizer cannot do on its own (it leaves Greek tonos intact on
-- precomposed code points like ή/ά/ί).
--
-- Triggers below COALESCE to the raw column when the fold is NULL so
-- legacy rows written before this migration stay searchable until the
-- next time they're updated. No backfill is required for the current
-- dataset (verified zero rows contain lowercase Greek tonos).

ALTER TABLE books ADD COLUMN title_fold TEXT;
ALTER TABLE books ADD COLUMN author_fold TEXT;
ALTER TABLE books ADD COLUMN isbn_fold TEXT;
ALTER TABLE books ADD COLUMN publisher_fold TEXT;
ALTER TABLE books ADD COLUMN description_fold TEXT;
ALTER TABLE books ADD COLUMN tags_fold TEXT;
ALTER TABLE books ADD COLUMN custom_fields_fold TEXT;

DROP TRIGGER IF EXISTS books_fts_ai;
DROP TRIGGER IF EXISTS books_fts_au;
DROP TRIGGER IF EXISTS books_fts_ad;

CREATE TRIGGER books_fts_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    new.ROWID,
    COALESCE(new.title_fold, new.title, ''),
    COALESCE(new.author_fold, new.author, ''),
    COALESCE(new.isbn_fold, new.isbn, ''),
    COALESCE(new.publisher_fold, new.publisher, ''),
    COALESCE(new.description_fold, new.description, ''),
    COALESCE(new.tags_fold, new.tags, ''),
    COALESCE(new.custom_fields_fold, new.custom_fields, '')
  );
END;

CREATE TRIGGER books_fts_ad AFTER DELETE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    'delete',
    old.ROWID,
    COALESCE(old.title_fold, old.title, ''),
    COALESCE(old.author_fold, old.author, ''),
    COALESCE(old.isbn_fold, old.isbn, ''),
    COALESCE(old.publisher_fold, old.publisher, ''),
    COALESCE(old.description_fold, old.description, ''),
    COALESCE(old.tags_fold, old.tags, ''),
    COALESCE(old.custom_fields_fold, old.custom_fields, '')
  );
END;

CREATE TRIGGER books_fts_au AFTER UPDATE ON books BEGIN
  INSERT INTO books_fts(books_fts, rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    'delete',
    old.ROWID,
    COALESCE(old.title_fold, old.title, ''),
    COALESCE(old.author_fold, old.author, ''),
    COALESCE(old.isbn_fold, old.isbn, ''),
    COALESCE(old.publisher_fold, old.publisher, ''),
    COALESCE(old.description_fold, old.description, ''),
    COALESCE(old.tags_fold, old.tags, ''),
    COALESCE(old.custom_fields_fold, old.custom_fields, '')
  );
  INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    new.ROWID,
    COALESCE(new.title_fold, new.title, ''),
    COALESCE(new.author_fold, new.author, ''),
    COALESCE(new.isbn_fold, new.isbn, ''),
    COALESCE(new.publisher_fold, new.publisher, ''),
    COALESCE(new.description_fold, new.description, ''),
    COALESCE(new.tags_fold, new.tags, ''),
    COALESCE(new.custom_fields_fold, new.custom_fields, '')
  );
END;
