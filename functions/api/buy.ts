// GET /api/buy?pack=5|20|50 → Stripe Checkout for prepaid credits, then back to /credits?key=...
import { type Env, json } from "../_shared";
import { CREDIT_PACKS } from "../_credits";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const pack = CREDIT_PACKS[url.searchParams.get("pack") ?? "5"];
  if (!pack) return json({ error: "pack must be 5, 20 or 50" }, 400);
  const origin = url.origin;
  const form = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(pack.cents),
    "line_items[0][price_data][product_data][name]": `Rever API credits: ${pack.label}`,
    "line_items[0][price_data][product_data][description]": "Prepaid credit for all 40 Rever website tools (API and MCP). Each call deducts its price ($0.001-$0.05). No expiry.",
    "metadata[rever_credit_units]": String(pack.units),
    "payment_intent_data[metadata][rever_credit_units]": String(pack.units),
    success_url: url.searchParams.get("return") === "app" ? `${origin}/?session_id={CHECKOUT_SESSION_ID}` : `${origin}/credits?key={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/credits`,
    allow_promotion_codes: "true",
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const s = (await r.json()) as { url?: string; error?: { message?: string } };
  if (!r.ok || !s.url) return json({ error: "Checkout unavailable", detail: s.error?.message ?? r.status }, 502);
  return Response.redirect(s.url, 303);
};
