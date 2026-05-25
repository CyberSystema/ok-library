-- 0013_borrow_due_returned_idx
--
-- Composite index supporting the very common "open and overdue" queries:
--
--   SELECT ... FROM borrow_transactions
--    WHERE returned_at IS NULL AND due_at < ?
--
-- and the per-book "active loan" lookup:
--
--   SELECT id FROM borrow_transactions
--    WHERE book_id = ? AND returned_at IS NULL ORDER BY borrowed_at DESC
--
-- The existing `idx_borrow_due_at` covers due_at alone; pairing it with
-- returned_at lets SQLite use the index directly for the open-loans plan
-- (partial null-aware index since we keep filtering on returned_at IS NULL).
-- Keeping the existing idx_borrow_due_at as well because some plans rely on
-- it for unfiltered ORDER BY due_at queries.

CREATE INDEX IF NOT EXISTS idx_borrow_due_returned
  ON borrow_transactions (returned_at, due_at);
