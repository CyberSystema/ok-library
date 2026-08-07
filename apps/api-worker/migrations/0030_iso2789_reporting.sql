-- What has to be recorded before ISO 2789 can be answered honestly.
--
-- The standard asks for stock AND flow: how much is held, and how much was
-- added, withdrawn and lent IN A PERIOD. Stock is mostly answerable from what
-- is already here. Flow is not, and the reasons are worth stating because they
-- decide what this migration adds and what it deliberately does not:
--
--   * `items.acquisition_date` is NULL on all 12,528 copies. The catalogue
--     importer binds a literal NULL and no screen has ever offered the field.
--   * `books.created_at` is the same import timestamp for the entire legacy
--     catalogue — all of it within 35 seconds on 2026-04-28. Grouping by it
--     would report 12,528 additions on one day and nothing since.
--   * `deleted_at` is the only withdrawal signal, and the merge tool now writes
--     it too. Those are duplicate records folded together, not books withdrawn
--     from stock; counting them would over-report by every merge.
--
-- So: the columns and indexes that make future periods countable, plus a
-- recorded baseline date. Nothing fabricates a history the library does not
-- have — the report says what it cannot know instead of guessing.

PRAGMA foreign_keys = ON;

-- Why a copy left the collection. ISO 2789 distinguishes withdrawal reasons,
-- and 'lost' is not the same event as 'discarded' or 'transferred'. NULL on
-- everything withdrawn before now, which the report shows as 'unrecorded'
-- rather than silently folding into one bucket.
ALTER TABLE items ADD COLUMN withdrawal_reason TEXT;

-- ─── Indexes for period queries ────────────────────────────────────────────
--
-- Every one of these is a column no query has ever filtered on, so nothing
-- pays for them today. On the free tier "rows written" counts index
-- maintenance (see migration 0015), so each is justified individually rather
-- than added by reflex:
--
--   acquisition_date — additions in a period. Written once per copy, ever.
--   deleted_at       — withdrawals in a period. Written once per withdrawal.
--   borrowed_at      — loans in a period, the single largest ISO 2789 figure.
--                      Written once per loan; the alternative is a full scan of
--                      the ledger against the 5M/day read budget.
--
-- All three are partial where that is possible, so the index only carries the
-- rows a period query can actually match.
CREATE INDEX IF NOT EXISTS idx_items_acquisition ON items(acquisition_date)
  WHERE acquisition_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_withdrawn ON items(deleted_at)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_borrow_borrowed_at ON borrow_transactions(borrowed_at);

-- ─── The stock baseline ────────────────────────────────────────────────────
--
-- The one honest answer for a collection catalogued in a single import: say
-- how much stock existed as at that date, and count additions only from then
-- on. Reporting the import as 12,528 acquisitions would be a fabrication, and
-- reporting zero additions would be a different one.
--
-- Seeded from the catalogue's own earliest created_at rather than hard-coded,
-- so a fresh install gets its own date and a re-run does not move it.
INSERT OR IGNORE INTO library_settings (key, value, updated_at)
SELECT 'stockBaselineDate',
       (SELECT MIN(created_at) FROM books WHERE deleted_at IS NULL),
       '2026-08-07T00:00:00.000Z'
 WHERE EXISTS (SELECT 1 FROM books WHERE deleted_at IS NULL);
