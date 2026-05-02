PRAGMA foreign_keys = ON;

-- Per-role permission flags. The permission catalogue is defined in code
-- (apps/api-worker/src/index.ts → PERMISSION_CATALOG). Rows here override the
-- defaults; missing rows fall back to the in-code defaults.
--
-- Admins always implicitly have every permission; the worker never consults
-- this table for the admin role to prevent accidental lock-out.
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL CHECK (role IN ('admin', 'librarian', 'viewer')),
  permission TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

-- Seed defaults that mirror the previous hard-coded behaviour.
INSERT OR IGNORE INTO role_permissions (role, permission, allowed, updated_at) VALUES
  ('librarian', 'books.write',          1, datetime('now')),
  ('librarian', 'books.delete',         0, datetime('now')),
  ('librarian', 'rooms.write',          1, datetime('now')),
  ('librarian', 'rooms.delete',         0, datetime('now')),
  ('librarian', 'customFields.manage',  0, datetime('now')),
  ('librarian', 'import',               0, datetime('now')),
  ('librarian', 'setup',                0, datetime('now')),
  ('librarian', 'circulation',          1, datetime('now')),
  ('librarian', 'dashboard',            1, datetime('now')),
  ('librarian', 'settings',             1, datetime('now')),
  ('viewer',    'books.write',          0, datetime('now')),
  ('viewer',    'books.delete',         0, datetime('now')),
  ('viewer',    'rooms.write',          0, datetime('now')),
  ('viewer',    'rooms.delete',         0, datetime('now')),
  ('viewer',    'customFields.manage',  0, datetime('now')),
  ('viewer',    'import',               0, datetime('now')),
  ('viewer',    'setup',                0, datetime('now')),
  ('viewer',    'circulation',          0, datetime('now')),
  ('viewer',    'dashboard',            0, datetime('now')),
  ('viewer',    'settings',             0, datetime('now'));
