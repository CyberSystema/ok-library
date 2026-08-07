-- Where a merged record went.
--
-- The librarian catalogued ~44 books twice because each also sits on a back
-- shelf — the very problem the holdings layer was built to remove. Folding each
-- duplicate into a COPY of its twin is the cleanup, but it soft-deletes a record
-- that other things may still point at: an old printed label, a bookmarked URL,
-- an OAI-PMH harvester that has the identifier cached.
--
-- `merged_into` is the forwarding address. It also makes the merge auditable
-- and, if it ever comes to it, undoable: the tombstone says exactly which
-- record absorbed this one.
ALTER TABLE books ADD COLUMN merged_into TEXT REFERENCES books(id);

CREATE INDEX IF NOT EXISTS idx_books_merged_into ON books(merged_into);
