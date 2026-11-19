// Shared helpers for Cloudflare Pages Functions (not a route: no onRequest export)

export interface Env {
  DB: D1Database;
  SCREENSHOT_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  AGENT_PAYMENT_ADDRESS?: string;
  BASE_RPC_URL?: string;
  /** JSON map of Stripe amount_total (cents) → generations, e.g. {"999":10,"1999":15,"4999":50} */
  PACKS?: string;
}

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-payment, x-access-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-payment-response",
};

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });

// ---------- Agent payments: USDC on Base ----------

export const AGENT_PRICE_USDC = 1;
export const AGENT_PRICE_UNITS = BigInt(AGENT_PRICE_USDC) * 1_000_000n; // USDC has 6 decimals
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DEFAULT_PAY_TO = "0xB64b22C09d24921f1b4a5599941a27dbCA61b542";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MIN_CONFIRMATIONS = 2n;

export const payTo = (env: Env) => (env.AGENT_PAYMENT_ADDRESS ?? DEFAULT_PAY_TO).toLowerCase();

export const paymentRequired = (env: Env, resource: string, reason?: string) =>
  json(
    {
      error: "Payment Required",
      reason,
      x402Version: 1,
      accepts: [{
        scheme: "exact",
        network: "base",
        chainId: 8453,
        asset: USDC_BASE,
        maxAmountRequired: AGENT_PRICE_UNITS.toString(),
        payTo: payTo(env),
        resource,
        description: `UI-to-prompt blueprint for one URL (${AGENT_PRICE_USDC} USDC)`,
        mimeType: "application/json",
      }],
      howToPay:
        `Send ${AGENT_PRICE_USDC} USDC on Base to ${payTo(env)}, then retry with header "X-Payment: <transaction hash>". ` +
        `Each transaction can be used once. Humans can buy a pack at https://www.aypiai.online and send "X-Access-Key" instead.`,
    },
    402,
  );

async function rpc(env: Env, method: string, params: unknown[]) {
  const res = await fetch(env.BASE_RPC_URL ?? "https://mainnet.base.org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = (await res.json()) as { result?: any; error?: { message: string } };
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

/** Checks on-chain that txHash is a confirmed USDC transfer of >= price to payTo. */
export async function verifyUsdcPayment(env: Env, txHash: string):
  Promise<{ ok: true; payer: string } | { ok: false; reason: string }> {
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return { ok: false, reason: "X-Payment must be a 0x-prefixed transaction hash" };

  const [receipt, head] = await Promise.all([
    rpc(env, "eth_getTransactionReceipt", [txHash]),
    rpc(env, "eth_blockNumber", []),
  ]);
  if (!receipt) return { ok: false, reason: "Transaction not found (not mined yet?)" };
  if (receipt.status !== "0x1") return { ok: false, reason: "Transaction failed" };
  if (BigInt(head) - BigInt(receipt.blockNumber) + 1n < MIN_CONFIRMATIONS) {
    return { ok: false, reason: "Transaction not confirmed yet, retry in a few seconds" };
  }
  const to = payTo(env);
  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== USDC_BASE) continue;
    if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    if ("0x" + log.topics[2].slice(26).toLowerCase() !== to) continue;
    if (BigInt(log.data) >= AGENT_PRICE_UNITS) {
      return { ok: true, payer: "0x" + log.topics[1].slice(26).toLowerCase() };
    }
  }
  return { ok: false, reason: `No USDC transfer of >= ${AGENT_PRICE_USDC} USDC to ${to} in this transaction` };
}

// ---------- Human payments: Stripe packs ----------

const DEFAULT_PACKS: Record<string, number> = { "999": 10, "1999": 15, "4999": 50 };

/**
 * An access key is a Stripe Checkout Session id (cs_...). The first time we see it,
 * we ask Stripe whether it was paid and store the number of generations it bought.
 * Returns the remaining generations, or an error.
 */
export async function redeemAccessKey(env: Env, key: string):
  Promise<{ ok: true; remaining: number } | { ok: false; status: number; reason: string }> {
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,}$/.test(key)) return { ok: false, status: 401, reason: "Invalid access key" };

  const row = await env.DB.prepare("SELECT remaining FROM access_keys WHERE key = ?").bind(key).first<{ remaining: number }>();
  if (row) return { ok: true, remaining: row.remaining };

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${key}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) return { ok: false, status: 401, reason: "Unknown access key" };
  const session = (await res.json()) as { payment_status: string; amount_total: number | null; customer_details?: { email?: string } };
  if (session.payment_status !== "paid") return { ok: false, status: 402, reason: "Payment not completed" };

  let packs = DEFAULT_PACKS;
  try { if (env.PACKS) packs = JSON.parse(env.PACKS); } catch { /* keep defaults */ }
  const generations = packs[String(session.amount_total)];
  if (!generations) return { ok: false, status: 400, reason: `No pack configured for amount ${session.amount_total}` };

  // INSERT OR IGNORE: if two requests race, only one row is created
  await env.DB.prepare("INSERT OR IGNORE INTO access_keys (key, remaining, purchased, email) VALUES (?, ?, ?, ?)")
    .bind(key, generations, generations, session.customer_details?.email ?? null).run();
  const created = await env.DB.prepare("SELECT remaining FROM access_keys WHERE key = ?").bind(key).first<{ remaining: number }>();
  return { ok: true, remaining: created!.remaining };
}

// ---------- Misc ----------

export function validateTargetUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname;
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
