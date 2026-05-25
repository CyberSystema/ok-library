-- 0014_vectorize_tracking
--
-- Tiny bookkeeping table used by the semantic-search feature. Each row
-- records when a book was embedded and into which Vectorize index/model,
-- so the backfill job can find books that still need an embedding (or
-- need re-embedding after a model swap) without scanning Vectorize itself.
--
-- We intentionally don't store the embedding vector here — that lives in
-- the Vectorize index keyed by `book_id`. Keeping the cardinality 1:1 with
-- `books` means routine deletes are easy (one DELETE here + one Vectorize
-- delete in code), and a missing row simply means "needs (re-)embedding".

CREATE TABLE IF NOT EXISTS book_vectorized (
  book_id     TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  -- A short identifier for the embedding generation, so a future model
  -- swap can flag every existing row for re-embedding by bumping this
  -- string in code. We default-store the model id; comparing to the
  -- current model is what `needs reindex` checks.
  model       TEXT NOT NULL,
  -- Source signature (a short hash) of the text that was embedded — lets
  -- us skip work when a book updates without any change to the fields the
  -- embedding actually consumes (title/author/description/tags).
  source_hash TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_book_vectorized_model ON book_vectorized(model);
