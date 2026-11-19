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
