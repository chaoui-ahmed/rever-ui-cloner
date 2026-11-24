// GET /credits → buy page; /credits?key=cs_... → shows the key, balance and how to use it.
import type { Env } from "./_shared";
import { CREDIT_PACKS, resolveKey, usd } from "./_credits";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (body: string) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rever API credits</title><meta name="description" content="Prepaid card credits for the Rever website-intelligence API and MCP server: 40 tools from $0.001 per call.">
<meta name="robots" content="noindex">
<style>
body{font:16px/1.55 system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111;background:#fafafa}
h1{font-size:28px;margin:0 0 6px}p.sub{color:#555;margin:0 0 28px}
.packs{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:20px 0}
a.pack{display:block;padding:18px;border:1px solid #ddd;border-radius:12px;background:#fff;text-decoration:none;color:#111}
a.pack:hover{border-color:#111}a.pack b{font-size:22px;display:block}a.pack span{color:#555;font-size:14px}
code,pre{background:#f0f0f0;border-radius:6px;font-size:13px}code{padding:2px 6px}pre{padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-all}
.key{font-size:15px;padding:12px;background:#fff;border:2px solid #111;border-radius:8px;word-break:break-all;font-family:ui-monospace,monospace}
.muted{color:#666;font-size:14px}
</style></head><body>${body}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const key = new URL(request.url).searchParams.get("key")?.trim();
  if (key) {
    const st = await resolveKey(env, key);
    if (st.kind === "error") return page(`<h1>Key not active</h1><p>${esc(st.reason)}. If you just paid, refresh this page in a few seconds.</p><p><a href="/credits">Back</a></p>`);
    if (st.kind === "legacy") return page(`<h1>Old pack key</h1><p>This key is valid on <code>/api/generate-prompt</code> only. <a href="/credits">Buy credits for all tools</a>.</p>`);
    const k = esc(key);
    return page(`<h1>Your credits are ready</h1><p class="sub">Balance: <b>$${usd(st.balanceUnits)}</b>, valid on all 40 tools, no expiry.</p>
<p><b>Your key</b> (save it, it is the only way to use your credit):</p><div class="key">${k}</div>
<h3>Use it in an MCP client</h3><p>Server: <code>https://www.aypiai.online/mcp</code>. Pass <code>"access_key": "${k}"</code> in any tool call (or tell your agent to).</p>
<h3>Use it with the HTTP API</h3><pre>curl -X POST https://www.aypiai.online/api/page-markdown \\
  -H "Content-Type: application/json" \\
  -H "X-Access-Key: ${k}" \\
  -d '{"url": "https://stripe.com"}'</pre>
<p class="muted">Each successful call deducts its price; failed calls are free. Check your balance: <code>GET /api/balance</code> with the same header. Tools and prices: <a href="/llms.txt">llms.txt</a>.</p>`);
  }
  const packs = Object.entries(CREDIT_PACKS).map(([id, p]) => `<a class="pack" href="/api/buy?pack=${id}"><b>$${id}</b><span>${esc(p.label)}</span></a>`).join("");
  return page(`<h1>Rever API credits</h1><p class="sub">Pay by card, get a key that works on all 40 website tools, over the HTTP API or the MCP server. No crypto, no subscription.</p>
<div class="packs">${packs}</div>
<p>What $5 buys, for example: 5,000 status checks ($0.001), 1,600 page-to-markdown calls ($0.003), 250 crypto project checks ($0.02) or 100 UI-recreation prompts ($0.05). Failed calls are never charged.</p>
<p class="muted">Agents with a USDC wallet can skip this and pay per call with x402. MCP users also get 20 free calls a day on most tools. Docs: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a></p>`);
};
