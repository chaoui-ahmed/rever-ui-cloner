// Free tier for MCP clients: FREE_PER_DAY calls per client per UTC day on the cheap, no-AI tools.
// HTTP API routes stay strictly x402 (directories expect a 402 on unpaid probes). Not a route.
import type { Env } from "./_shared";
import { MICRO } from "./_micro";
import { pageMeta, pageMarkdown } from "./_web";
import { detectTechStack } from "./_services";

export const FREE_PER_DAY = 20;
const GLOBAL_PER_DAY = 20_000; // cost safety net across all clients
export const FREE_MAX_PRICE = 0.005;

type Run = (env: Env, url: string, body: Record<string, unknown>) => Promise<unknown>;
export const FREE_RUNNERS = new Map<string, Run>([
  ...MICRO.filter((m) => Number(m.def.priceUsd) <= FREE_MAX_PRICE).map((m) => [m.def.path, m.run] as [string, Run]),
  ["/api/meta", pageMeta],
  ["/api/page-markdown", pageMarkdown],
  ["/api/tech-stack", (env, url) => detectTechStack(env, url)],
]);

let tableReady = false;
async function ensureTable(env: Env) {
  if (tableReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS free_usage (day TEXT NOT NULL, client TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, client))").run();
  tableReady = true;
}

async function clientId(request: Request) {
  const ip = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0] ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rever-free:${ip}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reserves one free call. Returns calls left after this one, or null if the limit is reached. */
export let lastClient = "";
export async function takeFreeCall(env: Env, request: Request): Promise<number | null> {
  if (!env.DB) return null;
  try {
    await ensureTable(env);
    const day = new Date().toISOString().slice(0, 10);
    const client = await clientId(request);
    lastClient = client.slice(0, 6);
    const total = await env.DB.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM free_usage WHERE day = ?").bind(day).first<{ n: number }>();
    if ((total?.n ?? 0) >= GLOBAL_PER_DAY) return null;
    const row = await env.DB.prepare(
      "INSERT INTO free_usage (day, client, calls) VALUES (?, ?, 1) ON CONFLICT(day, client) DO UPDATE SET calls = calls + 1 WHERE calls < ? RETURNING calls",
    ).bind(day, client, FREE_PER_DAY).first<{ calls: number }>();
    return row ? FREE_PER_DAY - row.calls : null;
  } catch {
    return null;
  }
}

/** Gives a reserved free call back (the tool failed). */
export async function refundFreeCall(env: Env, request: Request) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("UPDATE free_usage SET calls = MAX(calls - 1, 0) WHERE day = ? AND client = ?").bind(day, await clientId(request)).run();
  } catch { /* best effort */ }
}
