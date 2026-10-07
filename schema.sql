PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cocktails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  strength TEXT DEFAULT '',
  price_rub INTEGER DEFAULT 0,
  photo_url TEXT DEFAULT '',
  glass TEXT DEFAULT '',
  ice TEXT DEFAULT '',
  method TEXT DEFAULT '',
  garnish TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT DEFAULT '',
  category TEXT DEFAULT '',
  unit TEXT NOT NULL CHECK(unit IN ('ml','g','pcs')),
  min_stock REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cocktail_id INTEGER NOT NULL REFERENCES cocktails(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL CHECK(quantity > 0),
  UNIQUE(cocktail_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchase_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  purchased_qty REAL NOT NULL CHECK(purchased_qty > 0),
  remaining_qty REAL NOT NULL CHECK(remaining_qty >= 0),
  price_rub REAL NOT NULL DEFAULT 0,
  purchased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id INTEGER REFERENCES purchase_batches(id),
  movement_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  order_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  pin_salt TEXT,
  pin_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guest_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guest_login_attempts (
  phone TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER REFERENCES guests(id),
  status TEXT NOT NULL DEFAULT 'pending',
  total_rub INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  served_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  cocktail_id INTEGER NOT NULL REFERENCES cocktails(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_rub INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL REFERENCES guests(id),
  cocktail_id INTEGER NOT NULL REFERENCES cocktails(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  text TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(guest_id, cocktail_id, order_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  cocktail_id INTEGER NOT NULL REFERENCES cocktails(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(guest_id, cocktail_id)
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bartender_name TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS idx_recipe_items_cocktail ON recipe_items(cocktail_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_product ON recipe_items(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batches_product ON purchase_batches(product_id, purchased_at);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_guest ON orders(guest_id, created_at);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_token ON guest_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_guest ON guest_sessions(guest_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
