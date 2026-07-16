-- 0016_staff_onboarding_version
--
-- Track, per librarian account, the highest version of the onboarding course
-- they have completed. The client compares this to the server's current
-- ONBOARDING_VERSION: a librarian whose stored value is lower is shown the
-- mandatory course on next sign-in. Bumping ONBOARDING_VERSION in the Worker
-- re-triggers the course for everyone (e.g. after a major workflow change).
-- Additive, backfill-free (mirrors 0006's password_iterations column): every
-- existing user starts at 0 = "never completed".

PRAGMA foreign_keys = ON;

ALTER TABLE staff_users ADD COLUMN onboarding_completed_version INTEGER NOT NULL DEFAULT 0;
