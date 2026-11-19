import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-payment",
  "Access-Control-Expose-Headers": "x-payment-response",
};

// Human pricing (credits)
const COST_PER_SCREENSHOT = 50;
const COST_PER_1000_INPUT_TOKENS = 3;
const COST_PER_1000_OUTPUT_TOKENS = 15;
const MINIMUM_CREDITS_REQUIRED = 100;

// Agent pricing (USDC on Base)
const AGENT_PRICE_USDC = 1;
const USDC_DECIMALS = 6n;
const AGENT_PRICE_UNITS = BigInt(AGENT_PRICE_USDC) * 10n ** USDC_DECIMALS;
const BASE_CHAIN_ID = 8453;
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = (Deno.env.get("AGENT_PAYMENT_ADDRESS") ?? "0xB64b22C09d24921f1b4a5599941a27dbCA61b542").toLowerCase();
const BASE_RPC_URL = Deno.env.get("BASE_RPC_URL") ?? "https://mainnet.base.org";
const MIN_CONFIRMATIONS = 2n;
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });

const paymentRequired = (reason?: string) =>
  json(
    {
      error: "Payment Required",
      reason,
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          chainId: BASE_CHAIN_ID,
          asset: USDC_BASE,
          maxAmountRequired: AGENT_PRICE_UNITS.toString(),
          payTo: PAY_TO,
          resource: "https://nrzwlorjbcmfuikzrwoq.supabase.co/functions/v1/generate-prompt",
          description: `UI-to-prompt blueprint for one URL (${AGENT_PRICE_USDC} USDC)`,
          mimeType: "application/json",
        },
      ],
      howToPay:
        `Send ${AGENT_PRICE_USDC} USDC on Base to ${PAY_TO}, then retry with header "X-Payment: <transaction hash>". Each transaction can be used once.`,
    },
    402,
  );

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(BASE_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

/** Verifies on-chain that txHash is a confirmed USDC transfer to PAY_TO of at least the price. */
async function verifyPayment(txHash: string): Promise<{ ok: true; payer: string } | { ok: false; reason: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "X-Payment must be a 0x-prefixed transaction hash" };

  const [receipt, head] = await Promise.all([
    rpc("eth_getTransactionReceipt", [txHash]),
    rpc("eth_blockNumber", []),
  ]);
  if (!receipt) return { ok: false, reason: "Transaction not found (not mined yet?)" };
  if (receipt.status !== "0x1") return { ok: false, reason: "Transaction failed" };
  if (BigInt(head) - BigInt(receipt.blockNumber) + 1n < MIN_CONFIRMATIONS) {
    return { ok: false, reason: "Transaction not confirmed yet, retry in a few seconds" };
  }

  for (const log of receipt.logs ?? []) {
    if (log.address?.toLowerCase() !== USDC_BASE) continue;
    if (log.topics?.[0] !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const to = "0x" + log.topics[2].slice(26).toLowerCase();
    if (to !== PAY_TO) continue;
    if (BigInt(log.data) >= AGENT_PRICE_UNITS) {
      return { ok: true, payer: "0x" + log.topics[1].slice(26).toLowerCase() };
    }
  }
  return { ok: false, reason: `No USDC transfer of >= ${AGENT_PRICE_USDC} USDC to ${PAY_TO} in this transaction` };
}

function validateTargetUrl(raw: unknown): string | null {
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST with JSON body {\"url\": \"https://...\"}" }, 405);

  const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Agent payment claimed but not yet consumed (released if generation fails)
  let claimedTx: string | null = null;

  try {
    const bodyText = await req.text();
    let body: Record<string, unknown> = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }

    const url = validateTargetUrl(body.url);
    if (!url) return json({ error: "Valid public http(s) URL required in field \"url\"" }, 400);

    // --- Who is paying? Decided by credentials, never by User-Agent. ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const paymentHeader = req.headers.get("X-Payment")?.trim();
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    let userId: string | null = null;

    // A real user JWT (not just the public anon key) → credits path
    if (bearer && bearer !== anonKey) {
      const supabaseAuth = createClient(Deno.env.get("SUPABASE_URL")!, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: claimsData, error: claimsError } = await supabaseAuth.auth.getClaims(bearer);
      if (claimsError || !claimsData?.claims?.sub) return json({ error: "Unauthorized" }, 401);
      userId = claimsData.claims.sub as string;

      const { data: profile } = await supabaseAdmin.from("profiles").select("credits").eq("id", userId).single();
      if (!profile || profile.credits < MINIMUM_CREDITS_REQUIRED) {
        return json({ error: `Not enough credits (minimum ${MINIMUM_CREDITS_REQUIRED} required)` }, 403);
      }
    } else {
      // Agent path: must prove an on-chain payment
      if (!paymentHeader) return paymentRequired();

      const txHash = paymentHeader.toLowerCase();
      const check = await verifyPayment(txHash);
      if (!check.ok) return paymentRequired(check.reason);

      // Claim the tx atomically (primary key) → prevents replay
      const { error: claimError } = await supabaseAdmin
        .from("agent_payments")
        .insert({ tx_hash: txHash, payer: check.payer, amount_units: AGENT_PRICE_UNITS.toString(), target_url: url });
      if (claimError) {
        if (claimError.code === "23505") return paymentRequired("This transaction hash has already been used");
        throw new Error("Could not record payment");
      }
      claimedTx = txHash;
    }

    // --- Core: screenshot → Claude ---
    const screenshotApiKey = Deno.env.get("SCREENSHOT_API_KEY");
    if (!screenshotApiKey) throw new Error("Screenshot API key missing");

    const screenshotParams = new URLSearchParams({
      token: screenshotApiKey, url, output: "json", file_type: "png", wait_for_event: "load", full_page: "true",
    });
    const screenshotResponse = await fetch(`https://shot.screenshotapi.net/screenshot?${screenshotParams}`);
    const screenshotData = screenshotResponse.ok ? await screenshotResponse.json() : null;
    const imageUrl = screenshotData?.screenshot;
    if (!imageUrl) throw Object.assign(new Error("Screenshot failed"), { status: 502 });

    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) throw Object.assign(new Error("Screenshot download failed"), { status: 502 });
    const base64Image = arrayBufferToBase64(await imageRes.arrayBuffer());

    const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicApiKey) throw new Error("Anthropic API key missing");

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 4096,
        system:
          "You are an expert UI/UX reverse-engineer. Given a screenshot of a website, produce a detailed, actionable prompt that a developer could paste into Lovable or v0 to recreate the UI faithfully. Return ONLY the prompt text.",
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: base64Image } },
            { type: "text", text: "Reverse-engineer this UI." },
          ],
        }],
      }),
    });
    const anthropicData = await anthropicResponse.json();
    if (!anthropicResponse.ok || !anthropicData?.content?.[0]?.text) {
      throw Object.assign(new Error("Model error"), { status: 502 });
    }

    const prompt: string = anthropicData.content[0].text;
    const inputTokens = anthropicData.usage?.input_tokens || 0;
    const outputTokens = anthropicData.usage?.output_tokens || 0;

    if (claimedTx) {
      await supabaseAdmin.from("agent_payments").update({ consumed_at: new Date().toISOString() }).eq("tx_hash", claimedTx);
      claimedTx = null;
      return json({ prompt, url, inputTokens, outputTokens }, 200, {
        "X-Payment-Response": btoa(JSON.stringify({ success: true, network: "base", asset: USDC_BASE })),
      });
    }

    // Human: atomic server-side deduction (refuses if balance would go negative)
    const totalCost = Math.ceil(
      COST_PER_SCREENSHOT + (inputTokens / 1000) * COST_PER_1000_INPUT_TOKENS + (outputTokens / 1000) * COST_PER_1000_OUTPUT_TOKENS,
    );
    const { data: remaining, error: deductError } = await supabaseAdmin.rpc("spend_credits", {
      p_user_id: userId, p_amount: totalCost,
    });
    if (deductError || remaining === null || remaining < 0) {
      return json({ error: "Not enough credits" }, 403);
    }

    return json({ prompt, url, creditsRemaining: remaining, costDetail: { totalCost, inputTokens, outputTokens } });
  } catch (err: unknown) {
    // Generation failed after an agent paid → release the tx so it can be retried
    if (claimedTx) await supabaseAdmin.from("agent_payments").delete().eq("tx_hash", claimedTx);
    const status = (err as { status?: number })?.status ?? 500;
    return json({ error: err instanceof Error ? err.message : "Internal error" }, status);
  }
});
