PRAGMA foreign_keys = ON;

-- Replace the partial unique index from 0004 with a plain UNIQUE index.
--
-- SQLite's UPSERT (`ON CONFLICT(col) DO UPDATE`) requires the conflict target
-- to match a non-partial unique index/constraint. The partial form rejected
-- catalog upserts at runtime ("ON CONFLICT clause does not match any PRIMARY
-- KEY or UNIQUE constraint").
--
-- We don't lose anything by dropping the WHERE clause: SQLite treats every
-- NULL as distinct in a unique index, so multiple manually-created books
-- without a legacy_id still coexist happily.
DROP INDEX IF EXISTS idx_books_legacy_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_books_legacy_id ON books(legacy_id);
