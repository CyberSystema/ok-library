-- Add seed rows for two new permissions: `labels.print` and `export.csv`.
-- Defaults grant librarians both privileges; viewers get neither.
-- The librarian rows use UPDATE-then-INSERT to preserve any existing override.
INSERT OR IGNORE INTO role_permissions (role, permission, allowed, updated_at) VALUES
  ('librarian', 'labels.print', 1, datetime('now')),
  ('librarian', 'export.csv',   1, datetime('now')),
  ('viewer',    'labels.print', 0, datetime('now')),
  ('viewer',    'export.csv',   0, datetime('now'));
