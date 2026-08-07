-- Holdings layer: the physical copies of a bibliographic record.
--
-- Until now one row in `books` meant one book AND one copy, which is why the
-- librarian had to type 29 records twice to shelve duplicates on "19-000 πίσω".
-- Every real library system separates the two, and IFLA LRM names them
-- Manifestation (the edition you catalogue) and Item (the object on the shelf).
-- MARC 21 keeps holdings in their own format for the same reason.
--
-- Scope note: this adds Item beneath the existing record. It deliberately does
-- NOT introduce Work and Expression — the librarian chose the two-level model,
-- and grouping translations of one text is a separate problem.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  -- Code 128 payload once labels are reprinted; NULL until then. UNIQUE, but
  -- SQLite treats NULLs as distinct, so unlabelled copies coexist freely.
  barcode TEXT UNIQUE,
  copy_number INTEGER NOT NULL DEFAULT 1,
  -- Which volume this copy is, when a multi-part set is held as ONE record.
  -- (Sets whose volumes have their own titles get a record each instead — see
  -- the sets work.) Free text: real volume designations are "Α'", "τ. 3", "1-2".
  volume_num TEXT,
  volume_label TEXT,
  room_code TEXT,
  shelf_code TEXT,
  -- Local class number + cutter, once a call number is distinct from the shelf.
  call_number TEXT,
  -- Drives loan policy later (book / reference / periodical issue …).
  item_type TEXT NOT NULL DEFAULT 'book',
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'borrowed', 'lost', 'maintenance')),
  condition TEXT,
  acquisition_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE INDEX IF NOT EXISTS idx_items_book ON items(book_id, deleted_at);
-- The shelf facet and "select all on this shelf" both read items now, and both
-- run against the whole catalogue.
CREATE INDEX IF NOT EXISTS idx_items_shelf ON items(shelf_code, deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_room ON items(room_code, deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, deleted_at);

-- A "bound-with": two or more works bound into ONE physical volume, each
-- catalogued in its own right. The primary record is items.book_id; the others
-- are listed here. This is what finally makes two publication dates on one
-- object expressible — each record carries its own.
CREATE TABLE IF NOT EXISTS bound_with_items (
  item_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, book_id),
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bound_with_book ON bound_with_items(book_id);

-- ─── Backfill: every existing book becomes one copy ────────────────────────
--
-- One statement rather than a paged Worker sweep: this runs inside SQLite via
-- the migration runner, so there is no subrequest budget and no partial-apply
-- window for 13,128 rows.
--
-- The id is derived from the book's, which makes the backfill deterministic and
-- therefore re-runnable — INSERT OR IGNORE turns a repeat into a no-op instead
-- of minting a second copy of everything. Matches the `newId('itm')` shape used
-- for copies created later.
--
-- Soft-deleted books get an item too, with deleted_at mirrored, so restoring a
-- book restores its copy rather than resurrecting it holdings-less.
INSERT OR IGNORE INTO items (
  id, book_id, copy_number, room_code, shelf_code, item_type, status,
  condition, acquisition_date, created_at, updated_at, deleted_at, version
)
SELECT
  'itm_' || REPLACE(b.id, '-', ''),
  b.id,
  1,
  b.room_code,
  b.shelf_code,
  'book',
  -- `borrowed` is owned by the circulation flow; a copy inherits whatever the
  -- record already said, and the CHECK above guarantees it is one of the four.
  b.status,
  -- Condition was recorded as a custom attribute of the record, but it is a
  -- property of the physical object — it belongs on the copy. The attribute is
  -- left in place for now so nothing that reads it breaks.
  CASE
    WHEN json_valid(b.custom_fields)
     AND TRIM(COALESCE(CAST(json_extract(b.custom_fields, '$.condition') AS TEXT), '')) <> ''
    THEN CAST(json_extract(b.custom_fields, '$.condition') AS TEXT)
    ELSE NULL
  END,
  b.acquisition_date,
  b.created_at,
  b.updated_at,
  b.deleted_at,
  0
FROM books b;
