-- Separate the note taken when a book is HANDED OUT from the note taken when
-- it comes BACK. Both were being written to `notes`, so a return note ("cover
-- torn") silently destroyed the borrow note ("promised back before Easter") —
-- the loan's own record of why it was made. Existing `notes` values are borrow
-- notes and stay put.
ALTER TABLE borrow_transactions ADD COLUMN return_notes TEXT;
