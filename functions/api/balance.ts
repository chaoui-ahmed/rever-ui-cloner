import { type Env, json, corsHeaders, redeemAccessKey } from "../_shared";
import { resolveKey, usd } from "../_credits";

export const onRequestOptions: PagesFunction<Env> = () => new Response(null, { headers: corsHeaders });

/** GET /api/balance with header X-Access-Key (or ?key=) → { remaining } */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const key = request.headers.get("X-Access-Key")?.trim() ?? new URL(request.url).searchParams.get("key") ?? "";
  const state = await resolveKey(env, key);
  if (state.kind === "error") return json({ error: state.reason }, state.status);
  if (state.kind === "credits") return json({ balanceUsd: usd(state.balanceUnits), validOn: "all paid tools (API and MCP)" });
  const result = await redeemAccessKey(env, key);
  if (!result.ok) return json({ error: result.reason }, result.status);
  return json({ remaining: result.remaining });
};
