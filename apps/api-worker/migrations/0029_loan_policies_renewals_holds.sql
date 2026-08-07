-- Loan policies, renewals and holds.
--
-- Due dates have always been typed by hand: three 7/14/30-day buttons in the
-- web app and a hard-coded 14 in the mobile one. That is fine with two staff
-- and one kind of reader, and wrong as soon as the answer depends on who is
-- borrowing and what they are borrowing — a reference volume that must not
-- leave the building, a periodical issue lent for a week, a researcher allowed
-- a term. A policy is the librarian's rule written down once instead of
-- remembered every time.
--
-- Holds only became expressible in migration 0028. "The next copy to come back
-- goes to whoever is first in the queue" cannot be said at all while a loan
-- names a title rather than a copy.

PRAGMA foreign_keys = ON;

-- ─── Who is borrowing ──────────────────────────────────────────────────────
--
-- One axis of the policy matrix. 'standard' for everyone who exists today: the
-- 51 borrowers on file were entered as bare names and nobody can retroactively
-- say which were monks, students or visiting researchers.
ALTER TABLE borrowers ADD COLUMN category TEXT NOT NULL DEFAULT 'standard';

CREATE INDEX IF NOT EXISTS idx_borrowers_category ON borrowers(category);

-- ─── The rule ──────────────────────────────────────────────────────────────
--
-- Resolution is most-specific-wins: (category, type) beats (category, '*'),
-- which beats ('*', type), which beats ('*', '*'). '*' is a literal wildcard
-- rather than NULL so the UNIQUE constraint actually constrains — SQLite treats
-- NULLs as distinct, and two rows of (NULL, 'book') would both be allowed.
CREATE TABLE IF NOT EXISTS loan_policies (
  id TEXT PRIMARY KEY,
  borrower_category TEXT NOT NULL DEFAULT '*',
  item_type TEXT NOT NULL DEFAULT '*',
  -- How long a loan runs. Anchored to the end of the local day by the caller,
  -- so "14 days" means a date, not an hour of the afternoon.
  loan_days INTEGER NOT NULL DEFAULT 14,
  -- 0 = no renewals. A limit is the point of recording renewals at all.
  renewal_limit INTEGER NOT NULL DEFAULT 2,
  -- NULL = a renewal runs for another loan_days.
  renewal_days INTEGER,
  -- NULL = unlimited. Checked inside the borrow transaction, never before it.
  max_concurrent_loans INTEGER,
  -- 0 = consultation only. This is how a reference collection is expressed;
  -- there is no separate 'reference' status on the copy.
  lendable INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (borrower_category, item_type)
);

-- The fallback that makes every existing borrow keep working unchanged: 14 days
-- is what the web app's middle button and the mobile app already used.
INSERT OR IGNORE INTO loan_policies
  (id, borrower_category, item_type, loan_days, renewal_limit, renewal_days, max_concurrent_loans, lendable, notes, created_at, updated_at)
VALUES
  ('pol_default', '*', '*', 14, 2, 14, NULL, 1,
   'Default rule. Applies when nothing more specific matches.',
   '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z');

-- ─── Renewals ──────────────────────────────────────────────────────────────
--
-- A renewal is not idempotent, and the web client retries a write up to four
-- times on a 5xx. Keeping the count on the row is what lets the endpoint take
-- the caller's expected count as a precondition, so a replayed request changes
-- nothing instead of silently extending the loan twice.
ALTER TABLE borrow_transactions ADD COLUMN renewal_count INTEGER NOT NULL DEFAULT 0;

-- What the loan was due before anyone renewed it. NULL until the first renewal,
-- so history can show "due 12 May, renewed twice, now due 9 June".
ALTER TABLE borrow_transactions ADD COLUMN original_due_at TEXT;

-- ─── Holds ─────────────────────────────────────────────────────────────────
--
-- The queue is on the TITLE — a reader wants the book, not copy 2 — and is
-- filled by whichever copy comes back first. `item_id` is set at that moment
-- and is what puts the copy aside.
--
-- Deliberately NOT a new value of items.status: that column is CHECK-
-- constrained on two tables and adding to it means rebuilding both, and a copy
-- being spoken for is not a fact about the physical copy. A copy is lendable
-- when nothing here is holding it; the hold row is the reservation.
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id),
  borrower_id TEXT REFERENCES borrowers(id),
  -- Denormalized like borrow_transactions, and for the same reason: the queue
  -- must still read correctly after a GDPR erase anonymizes the borrower.
  borrower_name TEXT NOT NULL,
  borrower_contact TEXT,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'fulfilled', 'cancelled', 'expired')),
  -- The copy set aside for this hold. NULL while still queued.
  item_id TEXT REFERENCES items(id),
  placed_at TEXT NOT NULL,
  ready_at TEXT,
  -- When an uncollected hold stops holding the copy. There is no cron in this
  -- worker, so expiry is evaluated on read and swept when the queue is next
  -- looked at — which is honest about what the platform can actually do.
  expires_at TEXT,
  fulfilled_at TEXT,
  closed_at TEXT,
  notes TEXT,
  created_by TEXT REFERENCES staff_users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The queue itself: waiting holds for a title, oldest first.
CREATE INDEX IF NOT EXISTS idx_holds_queue ON holds(book_id, status, placed_at);
-- "Is this copy spoken for?" — asked by every availability check.
CREATE INDEX IF NOT EXISTS idx_holds_item ON holds(item_id) WHERE status = 'ready';
-- A borrower's own holds, and the expiry sweep.
CREATE INDEX IF NOT EXISTS idx_holds_borrower ON holds(borrower_id, status);
CREATE INDEX IF NOT EXISTS idx_holds_expiry ON holds(expires_at) WHERE status = 'ready';

-- One live hold per borrower per title. Placing the same hold twice is a
-- double-click, not a request for two copies.
CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_one_per_borrower
  ON holds(book_id, borrower_id) WHERE status IN ('waiting', 'ready') AND borrower_id IS NOT NULL;
