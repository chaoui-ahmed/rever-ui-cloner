import {
  type Env, json, corsHeaders, paymentRequired, verifyUsdcPayment, redeemAccessKey,
  validateTargetUrl, AGENT_PRICE_UNITS, USDC_BASE,
} from "../_shared";
import { withX402, x402Enabled } from "../_x402";
import { generateUiPrompt, UpstreamError } from "../_services";
import { methodNotAllowed, readJsonBody } from "../_paid";

const withCors = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
  return out;
};

async function generate(env: Env, url: string) {
  return (await generateUiPrompt(env, url)).prompt;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  if (ctx.request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (ctx.request.method !== "POST") return methodNotAllowed('{"url": "https://..."}');
  return withCors(await handlePost(ctx));
};

const handlePost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJsonBody(request);
  const url = validateTargetUrl(body.url);
  const badUrl = () => json({ error: "Valid public http(s) URL required in field \"url\"" }, 400);

  const resource = new URL(request.url).origin + "/api/generate-prompt";
  const accessKey = request.headers.get("X-Access-Key")?.trim();
  const txHash = request.headers.get("X-Payment")?.trim().toLowerCase();

  // ---- Human with a Stripe pack ----
  if (accessKey) {
    if (!url) return badUrl();
    const redeemed = await redeemAccessKey(env, accessKey);
    if (!redeemed.ok) return json({ error: redeemed.reason }, redeemed.status);

    // Atomic: only succeeds if a generation is left
    const spent = await env.DB.prepare(
      "UPDATE access_keys SET remaining = remaining - 1 WHERE key = ? AND remaining > 0 RETURNING remaining",
    ).bind(accessKey).first<{ remaining: number }>();
    if (!spent) return json({ error: "No generations left on this key", remaining: 0 }, 402);

    try {
      const prompt = await generate(env, url);
      return json({ prompt, url, remaining: spent.remaining });
    } catch (err) {
      await env.DB.prepare("UPDATE access_keys SET remaining = remaining + 1 WHERE key = ?").bind(accessKey).run();
      return json({ error: (err as Error).message }, err instanceof UpstreamError ? 502 : 500);
    }
  }

  // ---- Agent paying with standard x402 (signed payload, settled by the facilitator) ----
  const isTxHash = !!txHash && /^0x[0-9a-f]{64}$/.test(txHash);
  if (!isTxHash && x402Enabled(env)) {
    const x402Response = await withX402(env, request, body, async () => {
      if (!url) return badUrl(); // after verification: cancels the payment, never charged
      try {
        return json({ prompt: await generate(env, url), url });
      } catch (err) {
        return json({ error: (err as Error).message }, err instanceof UpstreamError ? 502 : 500);
      }
    });
    if (x402Response) return x402Response;
  }

  // ---- Agent paying by direct USDC transfer + tx hash (fallback) ----
  if (!txHash) return paymentRequired(env, resource);
  if (!url) return badUrl();

  const check = await verifyUsdcPayment(env, txHash);
  if (!check.ok) return paymentRequired(env, resource, check.reason);

  // Primary key on tx_hash → a payment can only be claimed once
  const claim = await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_payments (tx_hash, payer, amount_units, target_url) VALUES (?, ?, ?, ?)",
  ).bind(txHash, check.payer, AGENT_PRICE_UNITS.toString(), url).run();
  if (!claim.meta.changes) return paymentRequired(env, resource, "This transaction hash has already been used");

  try {
    const prompt = await generate(env, url);
    await env.DB.prepare("UPDATE agent_payments SET consumed_at = datetime('now') WHERE tx_hash = ?").bind(txHash).run();
    return json({ prompt, url }, 200, {
      "X-Payment-Response": btoa(JSON.stringify({ success: true, network: "base", asset: USDC_BASE, transaction: txHash })),
    });
  } catch (err) {
    // Release the payment so the agent can retry with the same hash
    await env.DB.prepare("DELETE FROM agent_payments WHERE tx_hash = ?").bind(txHash).run();
    return json({ error: (err as Error).message }, err instanceof UpstreamError ? 502 : 500);
  }
};
