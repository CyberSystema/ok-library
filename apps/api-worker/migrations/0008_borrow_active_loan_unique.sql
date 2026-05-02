-- 0008_borrow_active_loan_unique
--
-- Defence-in-depth against duplicate active loans on the same book. The
-- application code already uses an atomic UPDATE to flip status='available'
-- → 'borrowed' before inserting a borrow_transactions row, but a partial
-- unique index gives the database the final say if anything ever races
-- around that path (offline sync replays, manual D1 edits, future code).
--
-- The index covers exactly the rows where returned_at IS NULL — i.e. open
-- loans — so historical loans on the same book remain unconstrained.
--
-- Heal step (defensive): close any pre-existing duplicate open loans before
-- creating the unique index, so this migration can be applied to databases
-- that pre-date the atomic-borrow fix without erroring out. We keep the
-- most recently borrowed open loan per book and synthetically close the
-- rest by stamping `returned_at` = the latest borrow time on that book and
-- appending an explanatory note. The index is created afterwards and will
-- only be enforced going forward.

UPDATE borrow_transactions
   SET returned_at = COALESCE(
         (SELECT MAX(borrowed_at) FROM borrow_transactions x
           WHERE x.book_id = borrow_transactions.book_id),
         borrowed_at
       ),
       notes = COALESCE(notes, '') ||
               CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE ' | ' END ||
               '[auto-closed by migration 0008: duplicate open loan]'
 WHERE returned_at IS NULL
   AND id NOT IN (
     SELECT id FROM (
       SELECT id,
              ROW_NUMBER() OVER (PARTITION BY book_id ORDER BY borrowed_at DESC, id DESC) AS rn
         FROM borrow_transactions
        WHERE returned_at IS NULL
     ) ranked
     WHERE rn = 1
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_borrow_transactions_active_loan
  ON borrow_transactions (book_id)
  WHERE returned_at IS NULL;

-- Convenience index for borrower-overdue queries (used by /api/borrowers).
CREATE INDEX IF NOT EXISTS idx_borrow_transactions_borrower_open
  ON borrow_transactions (borrower_id)
  WHERE returned_at IS NULL;
