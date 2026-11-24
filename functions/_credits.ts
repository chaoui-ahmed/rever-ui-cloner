// Prepaid card credits (Stripe Checkout), valid on every paid tool via the X-Access-Key header
// or the MCP access_key argument. The Checkout Session id (cs_live_...) is the key. Not a route.
import type { Env } from "./_shared";

export const UNITS_PER_USD = 1_000_000; // same unit as USDC (6 decimals)
/** price in cents → credit in units. Bigger packs get a bonus. */
export const CREDIT_PACKS: Record<string, { cents: number; units: number; label: string }> = {
  "5": { cents: 500, units: 5 * UNITS_PER_USD, label: "$5 of credit" },
  "20": { cents: 2000, units: 22 * UNITS_PER_USD, label: "$22 of credit (10% bonus)" },
  "50": { cents: 5000, units: 60 * UNITS_PER_USD, label: "$60 of credit (20% bonus)" },
};

export const usd = (units: number) => Math.round(units / 10) / 100_000; // 5 decimals
export const KEY_RE = /^cs_(live|test)_[A-Za-z0-9]{10,}$/;

let ready = false;
async function ensureTable(env: Env) {
  if (ready) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS credits (key TEXT PRIMARY KEY, balance_units INTEGER NOT NULL CHECK (balance_units >= 0), purchased_units INTEGER NOT NULL, email TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  ).run();
  ready = true;
}

export type KeyState =
  | { kind: "credits"; balanceUnits: number }
  | { kind: "legacy" } // old generate-prompt pack (counted in generations)
  | { kind: "error"; status: number; reason: string };

/** Finds a key's credit balance, activating it from Stripe on first use. */
export async function resolveKey(env: Env, key: string): Promise<KeyState> {
  if (!KEY_RE.test(key)) return { kind: "error", status: 401, reason: "Invalid access key" };
  await ensureTable(env);
  const row = await env.DB.prepare("SELECT balance_units FROM credits WHERE key = ?").bind(key).first<{ balance_units: number }>();
  if (row) return { kind: "credits", balanceUnits: row.balance_units };
  const legacy = await env.DB.prepare("SELECT remaining FROM access_keys WHERE key = ?").bind(key).first().catch(() => null);
  if (legacy) return { kind: "legacy" };

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${key}`, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  if (!res.ok) return { kind: "error", status: 401, reason: "Unknown access key" };
  const s = (await res.json()) as { payment_status: string; metadata?: Record<string, string>; customer_details?: { email?: string } };
  if (s.payment_status !== "paid") return { kind: "error", status: 402, reason: "Payment not completed" };
  const units = Number(s.metadata?.rever_credit_units);
  if (!units) return { kind: "legacy" };
  await env.DB.prepare("INSERT OR IGNORE INTO credits (key, balance_units, purchased_units, email) VALUES (?, ?, ?, ?)")
    .bind(key, units, units, s.customer_details?.email ?? null).run();
  const created = await env.DB.prepare("SELECT balance_units FROM credits WHERE key = ?").bind(key).first<{ balance_units: number }>();
  return { kind: "credits", balanceUnits: created!.balance_units };
}

/** Atomically takes `units` from the key. Returns the new balance, or null if not enough credit. */
export async function charge(env: Env, key: string, units: number): Promise<number | null> {
  const r = await env.DB.prepare("UPDATE credits SET balance_units = balance_units - ? WHERE key = ? AND balance_units >= ? RETURNING balance_units")
    .bind(units, key, units).first<{ balance_units: number }>();
  return r ? r.balance_units : null;
}

export async function refund(env: Env, key: string, units: number) {
  await env.DB.prepare("UPDATE credits SET balance_units = balance_units + ? WHERE key = ?").bind(units, key).run();
}

export function accessKeyFrom(request: Request) {
  const h = request.headers.get("X-Access-Key")?.trim();
  if (h) return h;
  const auth = request.headers.get("Authorization")?.match(/^Bearer\s+(cs_(?:live|test)_\S+)$/i)?.[1];
  return auth ?? null;
}
