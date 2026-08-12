-- The hold shelf reads the whole catalogue to show a list of about a hundred.
--
-- `GET /api/holds` filters holds on `status IN ('waiting','ready')` and joins books
-- and items. The only index on holds that mentions status is `idx_holds_queue`,
-- which LEADS with book_id — useless for a bare status predicate — so SQLite chose
-- books as the driving table and probed holds once per live record:
--
--   SEARCH b USING INDEX idx_books_active_author (deleted_at=?)
--   SEARCH h USING INDEX idx_holds_queue (book_id=? AND status=?)
--
-- 12,796 rows read to return 130 candidates, on a screen the desk opens all day, on
-- a plan with a daily row-read budget. The index below lets holds drive instead, and
-- carries placed_at so the queue order comes out of the index rather than a temp
-- B-tree.
--
-- PARTIAL, on the two open statuses. A hold spends a few days open and then stays
-- closed forever, so the live set is a small and roughly constant fraction of the
-- table — indexing only those keeps it small as the history grows, and every query
-- that reads this table for the shelf carries exactly this predicate.
CREATE INDEX IF NOT EXISTS idx_holds_open
  ON holds(status, placed_at)
  WHERE status IN ('waiting', 'ready');
