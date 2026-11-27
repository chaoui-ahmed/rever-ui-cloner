// HTML for the public tool pages (/tools, /tools/<name>): one indexable page per tool, so agents
// that search the web for a capability ("website contacts extraction API") land here. Not a route.
import { SERVICES, type ServiceDef } from "../_services";
import { FREE_RUNNERS, FREE_PER_DAY } from "../_free";
import { slug, toolName, shortTitle } from "../_discovery";

const SITE = "https://www.aypiai.online";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CSS = `body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#111;background:#fafafa}
a{color:#0a58ca}h1{font-size:30px;line-height:1.2;margin:8px 0}h2{margin-top:32px;font-size:20px}.price{display:inline-block;background:#111;color:#fff;border-radius:6px;padding:2px 10px;font-weight:600}
.free{display:inline-block;background:#e6f4ea;color:#137333;border-radius:6px;padding:2px 10px;font-weight:600;margin-left:6px}
pre{background:#f0f0f0;border-radius:8px;padding:14px;overflow:auto;font-size:13px;white-space:pre-wrap;word-break:break-word}code{background:#f0f0f0;padding:1px 5px;border-radius:4px;font-size:13px}
.tags span{display:inline-block;border:1px solid #ddd;border-radius:20px;padding:1px 10px;margin:2px;font-size:13px;color:#444}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e5e5e5;padding:8px 6px;text-align:left;vertical-align:top;font-size:15px}nav{font-size:14px}`;

const shell = (title: string, description: string, canonical: string, body: string, jsonLd: unknown) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${canonical}"><meta property="og:type" content="website">
<link rel="alternate" type="text/plain" href="${SITE}/llms.txt"><link rel="service-desc" type="application/json" href="${SITE}/openapi.json">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>
<style>${CSS}</style></head><body><nav><a href="/tools">All ${SERVICES.length} tools</a> · <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/credits">Credits</a></nav>${body}
<p style="margin-top:40px;color:#666;font-size:14px">Rever: website intelligence for AI agents. MCP server: <code>${SITE}/mcp</code> · x402 catalog: <a href="/.well-known/x402">/.well-known/x402</a></p></body></html>`;

const html = (s: string) => new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });

export function toolPage(s: ServiceDef): Response {
  const name = toolName(s);
  const title = `${shortTitle(s)}: API and MCP tool for AI agents ($${s.priceUsd}/call) | Rever`;
  const free = FREE_RUNNERS.has(s.path);
  const body = JSON.stringify(s.inputExample);
  const desc = `${s.description} $${s.priceUsd} per call${free ? `, ${FREE_PER_DAY} free calls/day over MCP` : ""}. No signup: pay with x402 (USDC on Base) or card credits.`;
  const page = `<h1>${esc(shortTitle(s))}</h1>
<p><span class="price">$${s.priceUsd} per call</span>${free ? `<span class="free">${FREE_PER_DAY} free calls/day via MCP</span>` : ""}</p>
<p>${esc(s.description)}</p>
<p class="tags">${s.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>
<h2>Call it from an AI agent (MCP)</h2>
<p>Add the remote MCP server <code>${SITE}/mcp</code> (Streamable HTTP, no auth) to Claude, Cursor, ChatGPT or any MCP client, then call the tool <code>${name}</code>:</p>
<pre>${esc(JSON.stringify({ name, arguments: s.inputExample }, null, 2))}</pre>
<h2>Call it over HTTP</h2>
<pre>curl -X POST ${SITE}${s.path} \\
  -H "Content-Type: application/json" \\
  -H "X-Access-Key: YOUR_CREDIT_KEY" \\
  -d '${esc(body)}'</pre>
<p>No key? Without one the endpoint answers <code>402 Payment Required</code> with an x402 <code>PAYMENT-REQUIRED</code> header: any x402 client (USDC on Base, gasless) pays $${s.priceUsd} and retries automatically. Works with any x402 wallet: <b>Base MCP</b>, <b>Coinbase AgentKit</b>, <code>x402-fetch</code> / <code>x402-axios</code>, Cloudflare Agents. Or buy card credits at <a href="/credits">/credits</a> (from $5, valid on all tools). Failed calls are never charged.</p>
<h2>Input</h2><pre>${esc(JSON.stringify(s.inputSchema, null, 2))}</pre>
<h2>Example output</h2><pre>${esc(JSON.stringify(s.outputExample, null, 2))}</pre>
<h2>Related tools</h2><p>${SERVICES.filter((o) => o !== s && o.tags.some((t) => s.tags.includes(t))).slice(0, 8).map((o) => `<a href="/tools/${slug(o)}">${esc(shortTitle(o))}</a> ($${o.priceUsd})`).join(" · ") || `<a href="/tools">All tools</a>`}</p>`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: `Rever ${shortTitle(s)}`,
    description: s.description,
    url: `${SITE}/tools/${slug(s)}`,
    documentation: `${SITE}/openapi.json`,
    provider: { "@type": "Organization", name: "Rever", url: SITE },
    keywords: s.tags.join(", "),
    offers: { "@type": "Offer", price: s.priceUsd, priceCurrency: "USD", description: "Per successful call (x402 USDC on Base or prepaid card credits)" },
    potentialAction: { "@type": "Action", target: { "@type": "EntryPoint", urlTemplate: `${SITE}${s.path}`, httpMethod: "POST", contentType: "application/json" } },
  };
  return html(shell(title, desc, `${SITE}/tools/${slug(s)}`, page, ld));
}

export function indexPage(): Response {
  const rows = SERVICES.map((s) => `<tr><td><a href="/tools/${slug(s)}"><b>${esc(shortTitle(s))}</b></a><br><code>${toolName(s)}</code> · <code>POST ${s.path}</code></td><td>$${s.priceUsd}${FREE_RUNNERS.has(s.path) ? "<br><small>free tier</small>" : ""}</td></tr>`).join("");
  const page = `<h1>${SERVICES.length} website tools for AI agents</h1>
<p>Give a URL, get JSON. Every tool works as an MCP tool (<code>${SITE}/mcp</code>) and as an HTTP endpoint. Pay per call with x402 (USDC on Base), with prepaid <a href="/credits">card credits</a>, or use ${FREE_PER_DAY} free MCP calls a day on most tools.</p>
<table><tr><th>Tool</th><th>Price</th></tr>${rows}</table>`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Rever tools for AI agents",
    itemListElement: SERVICES.map((s, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/tools/${slug(s)}`, name: shortTitle(s) })),
  };
  return html(shell(`${SERVICES.length} website-intelligence tools for AI agents (MCP + x402) | Rever`, `Pay-per-call website tools for AI agents: markdown, contacts, SEO, security, DNS, WHOIS, tech stack, crypto checks, design. From $0.001, free MCP tier.`, `${SITE}/tools`, page, ld));
}

export const findService = (name: string) => SERVICES.find((s) => slug(s) === name || toolName(s) === name);
