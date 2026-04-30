PRAGMA foreign_keys = ON;

-- Borrowers table: turn what was a free-text "borrower name" on each loan
-- into a real entity, so we can autocomplete in the borrow form, see who has
-- borrowed how often, and reach out about overdue books.
CREATE TABLE IF NOT EXISTS borrowers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_borrowers_name_lower ON borrowers(LOWER(name));

-- Add an optional FK on borrow_transactions; existing rows keep using the free-text
-- borrower_name field, while new flows can reference borrower_id.
ALTER TABLE borrow_transactions ADD COLUMN borrower_id TEXT REFERENCES borrowers(id);
CREATE INDEX IF NOT EXISTS idx_borrow_borrower_id ON borrow_transactions(borrower_id);

-- Backfill borrowers from existing borrow_transactions.borrower_name values.
-- Each unique (lower-trimmed name, contact) pair becomes one borrower row,
-- and we point the historical loan rows at it.
INSERT OR IGNORE INTO borrowers (id, name, contact, created_at, updated_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  TRIM(borrower_name),
  borrower_contact,
  COALESCE(MIN(borrowed_at), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  COALESCE(MAX(borrowed_at), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
FROM borrow_transactions
WHERE TRIM(borrower_name) != ''
GROUP BY LOWER(TRIM(borrower_name)), COALESCE(borrower_contact, '');

UPDATE borrow_transactions
SET borrower_id = (
  SELECT b.id FROM borrowers b
  WHERE LOWER(b.name) = LOWER(TRIM(borrow_transactions.borrower_name))
    AND COALESCE(b.contact, '') = COALESCE(borrow_transactions.borrower_contact, '')
  LIMIT 1
)
WHERE borrower_id IS NULL AND TRIM(borrower_name) != '';

-- Cover image URL on books. Files are stored in R2 (the ASSETS bucket); the
-- column holds a worker-served path like "/api/books/<id>/cover" so the
-- frontend doesn't need direct R2 credentials.
ALTER TABLE books ADD COLUMN cover_url TEXT;

-- Per-user password salt + iteration count for PBKDF2-SHA-256 hashing.
-- Existing rows have NULL salt and the legacy unsalted SHA-256 hash; the
-- login handler lazy-rehashes on the next successful login. New users get
-- PBKDF2 from the start.
ALTER TABLE staff_users ADD COLUMN password_salt TEXT;
ALTER TABLE staff_users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 0;
