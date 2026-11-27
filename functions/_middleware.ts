import type { Env } from "./_shared";
import { discoveryResponse, isFileLike } from "./_discovery";

// Logs visits from known crawlers and AI agents to D1 (table bot_visits), without slowing the response.
const BOT_PATTERN =
  /(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|Googlebot|Google-Extended|GoogleOther|bingbot|Applebot|DuckDuckBot|DuckAssistBot|YandexBot|CCBot|Meta-External|Amazonbot|MistralAI|cohere|YouBot|Bytespider|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|python-requests|curl|axios|node-fetch|undici|Go-http-client|bot|crawler|spider)/i;

export const onRequest: PagesFunction<Env> = async ({ request, env, next, waitUntil }) => {
  const { pathname } = new URL(request.url);
  // API routes never fall back to the SPA page: unknown methods get 405, not index.html with 200
  const isApi = pathname.startsWith("/api/") || pathname === "/mcp";
  let response = discoveryResponse(pathname) ?? (isApi && request.method === "HEAD"
    ? new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } })
    : await next());
  // Missing files never fall back to the SPA page (scanners and agents should see a real 404)
  if (response.status === 200 && (isFileLike(pathname) || pathname.startsWith("/api/")) && (response.headers.get("content-type") ?? "").includes("text/html")) {
    response = new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  const ua = request.headers.get("User-Agent") ?? "";
  const match = ua.match(BOT_PATTERN) ?? (isApi && request.method !== "OPTIONS" ? ([ua, request.headers.get("mcp-protocol-version") ? "mcp-client" : "api-client"] as unknown as RegExpMatchArray) : null);
  if (match && env.DB) {
    const url = new URL(request.url);
    waitUntil(
      env.DB.prepare("INSERT INTO bot_visits (bot, path, status, user_agent) VALUES (?, ?, ?, ?)")
        .bind(match[1], url.pathname, response.status, ua.slice(0, 300))
        .run()
        .catch(() => {}),
    );
  }
  return response;
};
