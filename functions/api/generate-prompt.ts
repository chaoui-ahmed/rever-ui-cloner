import {
  type Env, json, corsHeaders, paymentRequired, verifyUsdcPayment, redeemAccessKey,
  validateTargetUrl, arrayBufferToBase64, AGENT_PRICE_UNITS, USDC_BASE,
} from "../_shared";

const SYSTEM_PROMPT =
  "You are an expert UI/UX reverse-engineer. Given a screenshot of a website, produce a detailed, actionable prompt that a developer could paste into Lovable or v0 to recreate the UI faithfully. Return ONLY the prompt text.";

class UpstreamError extends Error {}

async function generate(env: Env, url: string) {
  const params = new URLSearchParams({
    // Capped size: Claude rejects images over 8000 px on a side or ~5 MB
    token: env.SCREENSHOT_API_KEY, url, output: "json", file_type: "jpeg", wait_for_event: "load",
    full_page: "false", width: "1280", height: "3200",
  });
  const shotRes = await fetch(`https://shot.screenshotapi.net/screenshot?${params}`);
  const shot = shotRes.ok ? ((await shotRes.json()) as { screenshot?: string }) : null;
  if (!shot?.screenshot) throw new UpstreamError("Screenshot failed");

  const imgRes = await fetch(shot.screenshot);
  if (!imgRes.ok) throw new UpstreamError("Screenshot download failed");
  const bytes = await imgRes.arrayBuffer();
  if (bytes.byteLength > 5 * 1024 * 1024) throw new UpstreamError("Screenshot too large");
  const image = arrayBufferToBase64(bytes);

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: "Reverse-engineer this UI." },
        ],
      }],
    }),
  });
  const ai = (await aiRes.json()) as { content?: { text?: string }[]; error?: { message?: string } };
  const prompt = ai?.content?.[0]?.text;
  if (!aiRes.ok || !prompt) throw new UpstreamError(`Model error: ${ai?.error?.message ?? aiRes.status}`);
  return prompt;
}

export const onRequestOptions: PagesFunction<Env> = () => new Response(null, { headers: corsHeaders });

export const onRequestGet: PagesFunction<Env> = () =>
  json({ error: "Use POST with JSON body {\"url\": \"https://...\"}. Docs: https://www.aypiai.online/llms.txt" }, 405);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be valid JSON" }, 400);
  }
  const url = validateTargetUrl(body?.url);
  if (!url) return json({ error: "Valid public http(s) URL required in field \"url\"" }, 400);

  const resource = new URL(request.url).origin + "/api/generate-prompt";
  const accessKey = request.headers.get("X-Access-Key")?.trim();
  const txHash = request.headers.get("X-Payment")?.trim().toLowerCase();

  // ---- Human with a Stripe pack ----
  if (accessKey) {
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

  // ---- Agent paying in USDC ----
  if (!txHash) return paymentRequired(env, resource);

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
