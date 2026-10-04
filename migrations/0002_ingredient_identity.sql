PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_aliases (
  alias_key TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_product_aliases_product ON product_aliases(product_id);
