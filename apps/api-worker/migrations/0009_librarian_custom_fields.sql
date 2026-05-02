-- Grant the `librarian` role permission to manage custom attribute
-- definitions. Previously this required admin; librarians frequently need to
-- add new catalog fields when importing donated collections, so the default
-- has been promoted to allowed.
--
-- Note: only updates the existing row if it is still at the original default
-- of 0. If an admin has explicitly toggled it off via the Settings UI we
-- preserve their choice.
UPDATE role_permissions
SET allowed = 1,
    updated_at = datetime('now')
WHERE role = 'librarian'
  AND permission = 'customFields.manage'
  AND allowed = 0;

-- Make sure the row exists for fresh databases that somehow skipped the seed.
INSERT OR IGNORE INTO role_permissions (role, permission, allowed, updated_at)
VALUES ('librarian', 'customFields.manage', 1, datetime('now'));
