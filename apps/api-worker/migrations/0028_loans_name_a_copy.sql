-- A loan names a COPY, not a title.
--
-- Migration 0008 put a UNIQUE index on (book_id) WHERE returned_at IS NULL, so
-- exactly one loan could be open per bibliographic record. That was correct
-- when a record WAS a book. Since 0021 a record has copies, and the librarian
-- has just folded 44 twice-catalogued books into records holding two — at which
-- point the second copy became permanently unlendable: the borrow guard reads
-- `books.status = 'available'` and the first loan flips the whole record.
--
-- Everything else in this phase depends on this one change. A hold "filled by
-- whichever copy returns first" has no meaning until a loan names a copy; a
-- Code 128 label on a copy is pointless if scanning it cannot say which copy
-- went out; and ISO 2789 counts loans of items, not of titles.
--
-- It also closes a live bug. No circulation path has ever written items.status,
-- so `syncBookFromItems` — which derives books.status from the copies — resets a
-- borrowed record to 'available' whenever it runs. That is reachable today
-- through POST /api/items/add-copies and through the merge tool.

PRAGMA foreign_keys = ON;

-- Nullable: a loan whose book somehow has no copy must still be recorded rather
-- than refused. The partial unique index below simply does not police those.
ALTER TABLE borrow_transactions ADD COLUMN item_id TEXT REFERENCES items(id);

-- Attribute every existing loan — open and closed — to the record's PRIMARY
-- copy (lowest copy_number, the same ordering ensurePrimaryItem uses). For the
-- whole legacy catalogue that is the only copy, so the attribution is exact,
-- not a guess. Where a record has since gained a second copy the primary is
-- still the right answer: it is the one that existed when the loan was taken.
UPDATE borrow_transactions
   SET item_id = (
     SELECT i.id FROM items i
      WHERE i.book_id = borrow_transactions.book_id AND i.deleted_at IS NULL
      ORDER BY i.copy_number ASC, i.created_at ASC, i.id ASC LIMIT 1)
 WHERE item_id IS NULL;

-- Fallback for a record whose copies were all soft-deleted: history must still
-- point somewhere, and a deleted copy is a truer answer than NULL.
UPDATE borrow_transactions
   SET item_id = (
     SELECT i.id FROM items i
      WHERE i.book_id = borrow_transactions.book_id
      ORDER BY i.copy_number ASC, i.created_at ASC, i.id ASC LIMIT 1)
 WHERE item_id IS NULL;

-- Make items.status tell the truth for loans that are open right now. Until
-- this statement runs, every copy in the catalogue reads 'available' — which is
-- exactly the bug described above.
UPDATE items
   SET status = 'borrowed', updated_at = items.updated_at
 WHERE deleted_at IS NULL
   AND status = 'available'
   AND EXISTS (SELECT 1 FROM borrow_transactions t
                WHERE t.item_id = items.id AND t.returned_at IS NULL);

-- The invariant moves from the record to the copy. Dropping the old index is
-- the point of the migration: two copies of one title must be lendable at the
-- same time. `item_id IS NOT NULL` keeps the unattributable rows above out of
-- the index rather than collapsing them into one another.
DROP INDEX IF EXISTS idx_borrow_transactions_active_loan;

CREATE UNIQUE INDEX IF NOT EXISTS idx_borrow_active_item
  ON borrow_transactions (item_id) WHERE returned_at IS NULL AND item_id IS NOT NULL;

-- Loan history for one copy — the Copies panel and the ISO 2789 item counts.
CREATE INDEX IF NOT EXISTS idx_borrow_item ON borrow_transactions (item_id, returned_at);
