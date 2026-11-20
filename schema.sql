-- Cloudflare D1 schema. Apply with:
--   npx wrangler d1 execute rever --remote --file=schema.sql

-- Stripe purchases. key = Checkout Session id (cs_...), used as the customer's access key.
CREATE TABLE IF NOT EXISTS access_keys (
  key        TEXT PRIMARY KEY,
  remaining  INTEGER NOT NULL CHECK (remaining >= 0),
  purchased  INTEGER NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- USDC payments from agents. One row per tx hash → no replay.
CREATE TABLE IF NOT EXISTS agent_payments (
  tx_hash      TEXT PRIMARY KEY,
  payer        TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  target_url   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at  TEXT
);

-- Crawler / AI agent visits (filled by functions/_middleware.ts)
CREATE TABLE IF NOT EXISTS bot_visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot        TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bot_visits_created ON bot_visits (created_at);

-- Free MCP tier: calls per hashed IP per UTC day (created lazily by functions/_free.ts too)
CREATE TABLE IF NOT EXISTS free_usage (
  day TEXT NOT NULL,
  client TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, client)
);
