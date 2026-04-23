PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS book_attribute_values (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  attribute_definition_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(book_id, attribute_definition_id),
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
  FOREIGN KEY (attribute_definition_id) REFERENCES custom_field_definitions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_book_attribute_values_book_id ON book_attribute_values(book_id);
CREATE INDEX IF NOT EXISTS idx_book_attribute_values_definition_id ON book_attribute_values(attribute_definition_id);
