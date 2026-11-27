// All micro-services (functions/_micro.ts) share this route. Static route files take precedence.
import { paidEndpoint } from "../_paid";
import { MICRO } from "../_micro";
import { validateAddress } from "../_token";
import { json, corsHeaders, type Env } from "../_shared";

const handlers = new Map(MICRO.map((m) => [m.def.path, paidEndpoint(m.run, m.def.inputKey === "address" ? '{"address": "0x..."}' : '{"url": "https://..."}', m.def.inputKey === "address" ? validateAddress : undefined).onRequest]));

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const handler = handlers.get(new URL(ctx.request.url).pathname.replace(/\/$/, ""));
  if (!handler) {
    if (ctx.request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    return json({ error: "Unknown endpoint. Catalog: https://www.aypiai.online/.well-known/x402.json" }, 404);
  }
  return handler(ctx);
};
