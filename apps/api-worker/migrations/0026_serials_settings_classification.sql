-- Serials, the institution's own settings, and a standard class number.
--
-- Three smaller standards gaps, grouped because none needs its own migration.

PRAGMA foreign_keys = ON;

-- ─── Serials ───────────────────────────────────────────────────────────────
--
-- ΕΚΚΛΗΣΙΑΣΤΙΚΗ ΑΛΗΘΕΙΑ is catalogued as 47 separate books. A periodical is one
-- title with a RUN of issues held, which is why MARC keeps holdings statements
-- (853/863 captions and enumeration) rather than a record per issue: "vol.
-- 1–10, 1975–1984; vol. 12 missing" says in one line what 47 rows cannot.
--
-- `books.bib_level` (added in 0024) marks the title as 'serial'; this holds what
-- is actually on the shelf.
CREATE TABLE IF NOT EXISTS serial_holdings (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  -- What the enumeration is called on the piece: "τόμος", "vol.", "έτος".
  caption TEXT,
  from_volume TEXT,
  to_volume TEXT,
  from_year INTEGER,
  to_year INTEGER,
  -- Free text, because a real gap statement is "τ. 7, 12-14" and forcing that
  -- into a numeric model loses the librarian's own qualification of it.
  gaps TEXT,
  note TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_serial_holdings_book ON serial_holdings(book_id, seq);

-- ─── Classification ────────────────────────────────────────────────────────
--
-- The shelf mark here IS a local class number (category_code 19000 ↔ shelf
-- 19-000), and it stays exactly as it is — nobody is re-labelling 12,528 spines.
-- Dewey sits ALONGSIDE it, populated from MARC 082 when a record is imported,
-- so the collection gains standard subject access without physical work.
ALTER TABLE books ADD COLUMN ddc TEXT;
CREATE INDEX IF NOT EXISTS idx_books_ddc ON books(ddc, deleted_at);

-- ─── The library itself ────────────────────────────────────────────────────
--
-- There was nowhere to record who this catalogue belongs to. MARC 040/852, an
-- OAI-PMH repository identifier and an SRU response all need it, and the ISIL
-- (International Standard Identifier for Libraries) is how an institution is
-- named in shared records. Left blank until one is assigned; exports fall back
-- to the library's name.
CREATE TABLE IF NOT EXISTS library_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO library_settings (key, value, updated_at) VALUES
  ('isil', NULL, datetime('now')),
  ('libraryName', NULL, datetime('now')),
  ('libraryPlace', NULL, datetime('now')),
  -- ISO 639-2/B code for the catalogue's own language of description.
  ('catalogueLanguage', 'gre', datetime('now'));
