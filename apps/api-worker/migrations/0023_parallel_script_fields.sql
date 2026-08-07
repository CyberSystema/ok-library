-- Parallel script fields, modelled on MARC 880 linked fields.
--
-- The librarian's complaint: "ISBN όταν κάνω αναζήτηση για metadata … συμπληρώνει
-- τα πεδία σε περίεργη γλώσσα (ούτε ελληνικά, ούτε αγγλικά — σαν greeklish με
-- διαλυτικά σε ορισμένα γράμματα επάνω)."
--
-- Diagnosed: not an encoding fault. Open Library serves ALA-LC ROMANIZED MARC
-- for Greek books — "Epiphanios Salaminos Kyprou", "Apostolikē Diakonia tēs
-- Ekklēsias tēs Hellados". The macrons are U+0304, arriving decomposed. The
-- reason it always won is that there was only ever ONE slot per field, so the
-- romanized form overwrote the Greek one.
--
-- MARC's answer is to carry both: the vernacular form for display, the
-- romanized form linked alongside for matching and exchange. With somewhere
-- legitimate to put it, Open Library's data turns from harmful into useful —
-- and the same applies to the Korean part of this collection.

ALTER TABLE books ADD COLUMN title_romanized TEXT;
ALTER TABLE books ADD COLUMN author_romanized TEXT;
ALTER TABLE books ADD COLUMN publisher_romanized TEXT;

-- Folded copies, so a romanized form is searchable the same accent- and
-- case-insensitive way everything else is. SQLite's LOWER() is ASCII-only, so
-- these are computed in JS by computeBookFolds like the other seven.
ALTER TABLE books ADD COLUMN title_romanized_fold TEXT;
ALTER TABLE books ADD COLUMN author_romanized_fold TEXT;
ALTER TABLE books ADD COLUMN publisher_romanized_fold TEXT;

-- Each parallel form is indexed into the FTS column it belongs to — a romanized
-- title is a title — so it is reachable with the DEFAULT search fields
-- (title/author/isbn). Appending it to `custom_text` instead would have made it
-- findable only when the librarian widened the search to custom fields, which
-- is to say never. No new FTS column: adding one means dropping and rebuilding
-- the whole index for 13,128 rows, with search degraded throughout.
-- The triggers below are cheap to replace, and because every existing row has
-- NULL romanized folds their FTS entries are byte-identical afterwards — no
-- backfill, no rebuild. A row that GAINS a romanized form is re-indexed by the
-- AU trigger on the very same UPDATE that writes it.
DROP TRIGGER IF EXISTS books_fts_ai;
DROP TRIGGER IF EXISTS books_fts_au;
DROP TRIGGER IF EXISTS books_fts_ad;

CREATE TRIGGER books_fts_ai AFTER INSERT ON books BEGIN
  INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    new.ROWID,
    COALESCE(new.title_fold, new.title, '') || ' ' || COALESCE(new.title_romanized_fold, ''),
    COALESCE(new.author_fold, new.author, '') || ' ' || COALESCE(new.author_romanized_fold, ''),
    COALESCE(new.isbn_fold, new.isbn, ''),
    COALESCE(new.publisher_fold, new.publisher, '') || ' ' || COALESCE(new.publisher_romanized_fold, ''),
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
    COALESCE(old.title_fold, old.title, '') || ' ' || COALESCE(old.title_romanized_fold, ''),
    COALESCE(old.author_fold, old.author, '') || ' ' || COALESCE(old.author_romanized_fold, ''),
    COALESCE(old.isbn_fold, old.isbn, ''),
    COALESCE(old.publisher_fold, old.publisher, '') || ' ' || COALESCE(old.publisher_romanized_fold, ''),
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
    COALESCE(old.title_fold, old.title, '') || ' ' || COALESCE(old.title_romanized_fold, ''),
    COALESCE(old.author_fold, old.author, '') || ' ' || COALESCE(old.author_romanized_fold, ''),
    COALESCE(old.isbn_fold, old.isbn, ''),
    COALESCE(old.publisher_fold, old.publisher, '') || ' ' || COALESCE(old.publisher_romanized_fold, ''),
    COALESCE(old.description_fold, old.description, ''),
    COALESCE(old.tags_fold, old.tags, ''),
    COALESCE(old.custom_fields_fold, old.custom_fields, '')
  );
  INSERT INTO books_fts(rowid, title, author, isbn, publisher, description, tags, custom_text)
  VALUES (
    new.ROWID,
    COALESCE(new.title_fold, new.title, '') || ' ' || COALESCE(new.title_romanized_fold, ''),
    COALESCE(new.author_fold, new.author, '') || ' ' || COALESCE(new.author_romanized_fold, ''),
    COALESCE(new.isbn_fold, new.isbn, ''),
    COALESCE(new.publisher_fold, new.publisher, '') || ' ' || COALESCE(new.publisher_romanized_fold, ''),
    COALESCE(new.description_fold, new.description, ''),
    COALESCE(new.tags_fold, new.tags, ''),
    COALESCE(new.custom_fields_fold, new.custom_fields, '')
  );
END;
