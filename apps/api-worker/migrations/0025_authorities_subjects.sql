-- Authority control, and the catalogue's first subject access.
--
-- Two gaps this closes:
--
--  * Names are free text, so one person is several people. The existing
--    value-consistency tool already found 61 author and 67 publisher fold-groups
--    — "ST. VLADIMIR'S SEMINARY PRESS" vs "ST VLADIMIR'S…" is 130 books. Merging
--    after the fact treats the symptom; an authority record is the cure, because
--    it gives the preferred form somewhere to live and the variants somewhere to
--    point.
--  * There are no subject headings at all. For a research collection that is the
--    single biggest gap — you cannot ask "what do we hold on hesychasm".
--
-- One table for both, because a subject heading and a personal name are the same
-- kind of object: a controlled term with one preferred form, a set of variants,
-- and optionally an identifier in someone else's file.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS authorities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'corporate', 'publisher', 'subject', 'uniform_title')),
  preferred_form TEXT NOT NULL,
  -- MARC 880-style parallel form, same reasoning as on books.
  preferred_form_romanized TEXT,
  preferred_form_fold TEXT,
  -- Where the term comes from: the librarian's own list, LCSH imported from a
  -- MARC 650, or a linked external file.
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'lcsh', 'viaf', 'lc', 'imported')),
  -- Optional identifiers in external files. NEVER looked up synchronously — a
  -- cataloguing form must not block on someone else's server.
  viaf_id TEXT,
  lc_id TEXT,
  isni TEXT,
  -- "1899-1977" — MARC 100$d. Free text: real date qualifiers include "fl. 4th c."
  dates TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_authorities_kind ON authorities(kind, deleted_at);
CREATE INDEX IF NOT EXISTS idx_authorities_fold ON authorities(preferred_form_fold, kind);

-- The spellings that all mean the same thing. "See" references, in card-catalogue
-- terms. Folded so a lookup is accent- and case-insensitive.
CREATE TABLE IF NOT EXISTS authority_variants (
  id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  form TEXT NOT NULL,
  form_fold TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (authority_id) REFERENCES authorities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_authority_variants_fold ON authority_variants(form_fold);
CREATE INDEX IF NOT EXISTS idx_authority_variants_auth ON authority_variants(authority_id);

-- Which authority applies to which book, and in what capacity.
--
-- `role` uses MARC RELATOR CODES (aut, edt, trl, ill, cmp, pbl, …) rather than
-- an invented enum. That finally gives the existing `editor` and `translator`
-- custom attributes a standard home, and it is what a MARC export needs in
-- $4/$e. Subjects use the pseudo-role 'sub' so one table covers both.
CREATE TABLE IF NOT EXISTS book_authorities (
  book_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'aut',
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (book_id, authority_id, role),
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
  FOREIGN KEY (authority_id) REFERENCES authorities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_book_authorities_book ON book_authorities(book_id, role);
CREATE INDEX IF NOT EXISTS idx_book_authorities_auth ON book_authorities(authority_id, role);

-- NOTE: no data migration, deliberately.
--
-- The free-text `author` / `publisher` columns stay AUTHORITATIVE until a book
-- is explicitly linked to an authority. Nothing breaks mid-transition, and the
-- librarian converts at their own pace: seeding subjects from the 629 existing
-- `category_label` values, and names from the fold-groups the value-consistency
-- tool already surfaces, are both preview-and-approve operations rather than
-- something that rewrites 12,528 records on deploy.
