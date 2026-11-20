import type { Env } from "./_shared";

// Logs visits from known crawlers and AI agents to D1 (table bot_visits), without slowing the response.
const BOT_PATTERN =
  /(GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|PerplexityBot|Perplexity-User|Googlebot|Google-Extended|GoogleOther|bingbot|Applebot|DuckDuckBot|DuckAssistBot|YandexBot|CCBot|Meta-External|Amazonbot|MistralAI|cohere|YouBot|Bytespider|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|python-requests|curl|axios|node-fetch|undici|Go-http-client|bot|crawler|spider)/i;

export const onRequest: PagesFunction<Env> = async ({ request, env, next, waitUntil }) => {
  const { pathname } = new URL(request.url);
  // API routes never fall back to the SPA page: unknown methods get 405, not index.html with 200
  const isApi = pathname.startsWith("/api/") || pathname === "/mcp";
  const response = isApi && request.method === "HEAD"
    ? new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } })
    : await next();
  const ua = request.headers.get("User-Agent") ?? "";
  const match = ua.match(BOT_PATTERN);
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
