// Private traffic stats: GET /api/stats?token=... (token kept by the owner; only its SHA-256 is here).
import { type Env, json } from "../_shared";

const TOKEN_SHA256 = "5bf7b1ea4a01d0851c1ccfb5ad385faf15e1cfc47ee17151bb91144bb3411c48";

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const q = async (env: Env, sql: string, ...args: unknown[]) => {
  try { return (await env.DB.prepare(sql).bind(...args).all()).results; } catch (e) { return [{ error: (e as Error).message }]; }
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  if ((await sha256(url.searchParams.get("token") ?? "")) !== TOKEN_SHA256) return json({ error: "Not found" }, 404);
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 14, 1), 90);
  const since = `-${days} days`;
  return json({
    days,
    botVisitsByDay: await q(env, "SELECT date(created_at) d, COUNT(*) n FROM bot_visits WHERE created_at >= datetime('now', ?) GROUP BY d ORDER BY d", since),
    botVisitsByBot: await q(env, "SELECT bot, COUNT(*) n FROM bot_visits WHERE created_at >= datetime('now', ?) GROUP BY bot ORDER BY n DESC LIMIT 40", since),
    topPaths: await q(env, "SELECT path, COUNT(*) n FROM bot_visits WHERE created_at >= datetime('now', ?) GROUP BY path ORDER BY n DESC LIMIT 40", since),
    apiCalls: await q(env, "SELECT path, status, COUNT(*) n FROM bot_visits WHERE created_at >= datetime('now', ?) AND (path LIKE '/api/%' OR path = '/mcp') GROUP BY path, status ORDER BY n DESC LIMIT 60", since),
    recentApi: await q(env, "SELECT created_at, bot, path, status, user_agent FROM bot_visits WHERE (path LIKE '/api/%' OR path = '/mcp') AND path != '/api/stats' ORDER BY id DESC LIMIT 40"),
    agentsByUa: await q(env, "SELECT substr(user_agent, 1, 60) ua, COUNT(*) n, SUM(path = '/mcp') mcp, SUM(path LIKE '/api/%') api FROM bot_visits WHERE created_at >= datetime('now', ?) GROUP BY ua ORDER BY n DESC LIMIT 40", since),
    paidSuccess: await q(env, "SELECT date(created_at) d, path, COUNT(*) n FROM bot_visits WHERE created_at >= datetime('now', ?) AND path LIKE '/api/%' AND status = 200 AND path NOT IN ('/api/stats', '/api/balance') GROUP BY d, path ORDER BY d", since),
    nonApiPaths: await q(env, "SELECT path, status, COUNT(*) n FROM bot_visits WHERE created_at >= datetime('now', ?) AND path NOT LIKE '/api/%' AND path != '/mcp' GROUP BY path, status ORDER BY n DESC LIMIT 120", since),
    uaSearch: url.searchParams.get("ua") ? await q(env, "SELECT DISTINCT user_agent FROM bot_visits WHERE user_agent LIKE ? LIMIT 10", `%${url.searchParams.get("ua")}%`) : [],
    mcpByUaDay: await q(env, "SELECT date(created_at) d, substr(user_agent, 1, 90) ua, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM bot_visits WHERE path = '/mcp' AND date(created_at) IN ('2026-11-22', '2026-11-23') GROUP BY d, ua ORDER BY d, n DESC"),
    freeCalls: await q(env, "SELECT created_at, tool, target, user_agent FROM free_calls ORDER BY id DESC LIMIT 100"),
    x402Payments: await q(env, "SELECT created_at, path, amount_units, payer, tx FROM x402_payments ORDER BY id DESC LIMIT 100"),
    legacyPayments: await q(env, "SELECT created_at, payer, amount_units, target_url FROM agent_payments ORDER BY created_at DESC LIMIT 50"),
    freeUsageByDay: await q(env, "SELECT day, COUNT(*) users, SUM(calls) calls FROM free_usage GROUP BY day ORDER BY day DESC LIMIT 30"),
    packs: await q(env, "SELECT created_at, purchased, remaining FROM access_keys ORDER BY created_at DESC LIMIT 20"),
  });
};
