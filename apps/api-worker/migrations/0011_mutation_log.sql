-- Idempotency log: when the client sends a write with X-Client-Mutation-Id, we
-- store the (status, response_body) under that id. If the same id replays
-- (because the network dropped between server commit and client ACK and the
-- client retried), we replay the same response instead of re-executing the
-- mutation. This is the single most important guard against silent duplicate
-- writes when retrying a "lost" request.
--
-- We deliberately do NOT bind the id to a specific user so that retries that
-- happen to land after a session refresh still match. Mutation ids are v4
-- UUIDs generated client-side; collision risk is negligible.
CREATE TABLE IF NOT EXISTS mutation_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mutation_log_created_at ON mutation_log(created_at);
