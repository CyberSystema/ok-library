PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'librarian', 'viewer')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  map_metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id TEXT PRIMARY KEY,
  field_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'boolean', 'date', 'enum')),
  required INTEGER NOT NULL DEFAULT 0,
  enum_options TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  isbn TEXT,
  publication_year INTEGER,
  publisher TEXT,
  language TEXT,
  description TEXT,
  room_code TEXT,
  shelf_code TEXT,
  acquisition_date TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  custom_fields TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('available', 'borrowed', 'lost', 'maintenance')) DEFAULT 'available',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (room_code) REFERENCES rooms(code)
);

CREATE TABLE IF NOT EXISTS code_assignments (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  code_type TEXT NOT NULL CHECK (code_type IN ('qr', 'barcode')),
  code_value TEXT NOT NULL UNIQUE,
  label TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
);

CREATE TABLE IF NOT EXISTS borrow_transactions (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  borrower_name TEXT NOT NULL,
  borrower_contact TEXT,
  borrowed_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  returned_at TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE TABLE IF NOT EXISTS sync_mutations (
  id TEXT PRIMARY KEY,
  client_mutation_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result_status TEXT NOT NULL,
  result_data TEXT,
  FOREIGN KEY (actor_id) REFERENCES staff_users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (actor_id) REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author);
CREATE INDEX IF NOT EXISTS idx_books_status ON books(status);
CREATE INDEX IF NOT EXISTS idx_books_room_shelf ON books(room_code, shelf_code);
CREATE INDEX IF NOT EXISTS idx_books_updated_at ON books(updated_at);
CREATE INDEX IF NOT EXISTS idx_books_deleted_at ON books(deleted_at);
CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_codes_book_id ON code_assignments(book_id);
CREATE INDEX IF NOT EXISTS idx_codes_active_value ON code_assignments(active, code_value);
CREATE INDEX IF NOT EXISTS idx_borrow_book_open ON borrow_transactions(book_id, returned_at);
CREATE INDEX IF NOT EXISTS idx_borrow_due_at ON borrow_transactions(due_at);
CREATE INDEX IF NOT EXISTS idx_custom_fields_deleted ON custom_field_definitions(deleted_at, field_key);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sync_actor_processed ON sync_mutations(actor_id, processed_at);
