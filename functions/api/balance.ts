import { type Env, json, corsHeaders, redeemAccessKey } from "../_shared";

export const onRequestOptions: PagesFunction<Env> = () => new Response(null, { headers: corsHeaders });

/** GET /api/balance with header X-Access-Key (or ?key=) → { remaining } */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const key = request.headers.get("X-Access-Key")?.trim() ?? new URL(request.url).searchParams.get("key") ?? "";
  const result = await redeemAccessKey(env, key);
  if (!result.ok) return json({ error: result.reason }, result.status);
  return json({ remaining: result.remaining });
};
