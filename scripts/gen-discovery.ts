// Regenerates the discovery files from the service catalog (functions/_services.ts).
// Run after adding or repricing a service:  npx tsx scripts/gen-discovery.ts
import { readFileSync, writeFileSync } from "node:fs";
import { SERVICES } from "../functions/_services";

const SITE = "https://www.aypiai.online";
const units = (usd: string) => String(Math.round(Number(usd) * 1_000_000));
const camel = (p: string) => "get" + p.replace("/api/", "").split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const firstSentence = (d: string) => d.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, "");
const prices = SERVICES.map((s) => Number(s.priceUsd));
const range = `$${Math.min(...prices)} to $${Math.max(...prices)}`;
const n = SERVICES.length;

// ---------- openapi.json ----------
const oa = JSON.parse(readFileSync("public/openapi.json", "utf8"));
const keep = { "/generate-prompt": oa.paths["/generate-prompt"], "/balance": oa.paths["/balance"] };
oa.info.version = "6.0.0";
oa.info.summary = `Website intelligence for AI agents: ${n} pay-per-call endpoints (${range}) for scraping, SEO, security, DNS, design and crypto due diligence.`;
oa.info.description =
  `${n} website-analysis endpoints for AI agents, priced ${range} per call: page to markdown/text, metadata, contacts, social links, sitemap, robots.txt, broken links, ` +
  `SEO and AI-readiness audits, security headers, HTTPS, DNS, email security, WHOIS/RDAP, Wayback history, tech stack, trackers, company info, brand kit, design tokens, ` +
  `screenshots, UI-recreation prompts and a crypto project website trust check. All are POST with JSON {"url": "..."}. Agents pay with x402 v2 (exact scheme, USDC on Base eip155:8453): ` +
  `the first call returns 402 with a PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE. You are never charged for a failed call. Full guide: ${SITE}/llms-full.txt`;
keep["/generate-prompt"].post.description = keep["/generate-prompt"].post.description.replace(/\$0\.\d+/g, `$${SERVICES[0].priceUsd}`);
keep["/generate-prompt"].post["x-payment-info"] && (keep["/generate-prompt"].post["x-payment-info"].price = SERVICES[0].priceUsd);
const paths: Record<string, unknown> = { ...keep };
for (const s of SERVICES.slice(1)) {
  paths[s.path.replace("/api", "")] = {
    post: {
      operationId: camel(s.path),
      summary: firstSentence(s.description).slice(0, 90),
      description: `${s.description} Price: $${s.priceUsd} per call via x402 (USDC on Base).`,
      tags: s.tags.slice(0, 3),
      security: [{ x402: [] }],
      requestBody: { required: true, content: { "application/json": { schema: s.inputSchema, example: s.inputExample } } },
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: s.outputSchema, example: s.outputExample } } },
        "402": { description: "Payment required (x402)." },
        "400": { description: "Invalid URL." },
        "502": { description: "Upstream failure; not charged." },
      },
      "x-payment-info": { protocol: "x402", price: s.priceUsd, network: "eip155:8453", asset: "USDC" },
    },
  };
}
oa.paths = paths;
oa["x-payment-info"].price = SERVICES[0].priceUsd;
writeFileSync("public/openapi.json", JSON.stringify(oa, null, 2) + "\n");

// ---------- .well-known/x402.json ----------
const xm = JSON.parse(readFileSync("public/.well-known/x402.json", "utf8"));
xm.description = `Website intelligence for AI agents: ${n} pay-per-call endpoints (${range}): scraping, SEO, security, DNS, WHOIS, tech stack, design, screenshots and crypto project trust checks. USDC on Base, no API key.`;
xm.resources = SERVICES.map((s) => ({
  resource: `${SITE}${s.path}`,
  method: "POST",
  scheme: "exact",
  price: `$${s.priceUsd}`,
  amount: units(s.priceUsd),
  description: s.description,
  tags: s.tags,
  input: { contentType: "application/json", example: s.inputExample, schema: s.inputSchema },
}));
writeFileSync("public/.well-known/x402.json", JSON.stringify(xm, null, 2) + "\n");

// ---------- llms.txt / llms-full.txt ----------
const line = (s: (typeof SERVICES)[0]) => `- \`${s.path}\` ($${s.priceUsd}): ${firstSentence(s.description)}`;
const groups: [string, string[]][] = [
  ["Read a page", ["page-markdown", "page-text", "meta", "links", "images", "headings", "structured-data", "og-image", "favicon", "forms", "feeds", "key-pages", "language", "text-stats"]],
  ["Companies and leads", ["company-info", "contacts", "social-links", "tech-stack", "trackers"]],
  ["SEO and site audits", ["seo-audit", "ai-readiness", "broken-links", "sitemap", "robots", "page-weight", "redirects"]],
  ["Security, domain and network", ["security-headers", "https-check", "dns", "email-security", "domain-whois", "wayback", "headers", "status"]],
  ["Crypto", ["token-check", "crypto-site-check"]],
  ["Design and visuals", ["generate-prompt", "design-tokens", "brand-kit", "screenshot"]],
];
const byName = new Map(SERVICES.map((s) => [s.path.replace("/api/", ""), s]));
const listed = new Set(groups.flatMap(([, g]) => g));
const missing = [...byName.keys()].filter((k) => !listed.has(k));
if (missing.length) throw new Error(`Add to a group: ${missing.join(", ")}`);
const servicesMd = groups.map(([title, g]) => `### ${title}\n\n${g.map((k) => line(byName.get(k)!)).join("\n")}`).join("\n\n");

let llms = readFileSync("public/llms.txt", "utf8");
llms = llms.replace(/^> .*$/m,
  `> Rever is a pay-per-call toolbox of ${n} website-intelligence endpoints for AI agents: give it a URL, get JSON back. Read pages as markdown or text, extract contacts, socials, metadata, sitemaps and structured data, audit SEO, AI-readiness, security headers, HTTPS and email security, look up DNS, WHOIS and Wayback history, detect tech stacks and trackers, check whether a crypto project's website looks legit, and turn a site's design into tokens, brand kits, screenshots or a prompt to rebuild its UI.`);
llms = llms.replace(/AI agents pay per request \(\$[\d.]+ to \$[\d.]+\)/, `AI agents pay per request (${range})`);
llms = llms.replace(/## What you get[\s\S]*?(?=## Services)/, `## How it works\n\n- Every endpoint: \`POST\` with JSON \`{"url": "https://..."}\` (some take an extra option, see the OpenAPI spec). Response: JSON.\n- Most answer in 1-3 s. You are only charged when the call succeeds.\n\n`);
llms = llms.replace(/## Services[\s\S]*?(?=## API)/, `## Services (${n}, all paid per call with x402)\n\n${servicesMd}\n\n`);
llms = llms.replace(/amount `\d+` \(\$[\d.]+\)/, "the amount of the endpoint (e.g. `1000` = $0.001)");
llms = llms.replace(/You get the prompt, plus/, "You get the JSON result, plus");
llms = llms.replace(/(?<!only: )send [\d.]+ USDC on Base to the `payTo` address and retry with `X-Payment: <transaction hash>`, or use a pack key in `X-Access-Key`\./,
  `for \`/api/generate-prompt\` only: send ${SERVICES[0].priceUsd} USDC on Base to the \`payTo\` address and retry with \`X-Payment: <transaction hash>\`, or use a pack key in \`X-Access-Key\`.`);
writeFileSync("public/llms.txt", llms);

let full = readFileSync("public/llms-full.txt", "utf8");
full = full.replace(/Price: \$[\d.]+ per successful call/, `Price: $${SERVICES[0].priceUsd} per successful call`);
full = full.replace(/## Other services \(x402 only\)[\s\S]*?(?=## Option 1)/,
  `## Other services (x402 only)\n\nSame request shape: POST JSON \`{"url": "https://..."}\`. Example output shown for each.\n\n` +
  SERVICES.slice(1).map((s) => `### POST ${s.path} ($${s.priceUsd})\n\n${s.description}\n\nInput: \`${JSON.stringify(s.inputExample)}\`\n\nOutput: \`${JSON.stringify(s.outputExample).slice(0, 600)}\``).join("\n\n") + "\n\n");
full = full.replace(/amount `\d+` \(6 decimals = \$[\d.]+\)/, `amount in 6-decimal units per endpoint (\`50000\` = $${SERVICES[0].priceUsd} for generate-prompt, \`1000\` = $0.001)`);
full = full.replace(/Send at least [\d.]+ USDC/, `Send at least ${SERVICES[0].priceUsd} USDC`);
writeFileSync("public/llms-full.txt", full);

console.log(`${n} services written to openapi.json, x402.json, llms.txt, llms-full.txt`);

// ---------- .well-known/mcp.json (server card) ----------
const card = JSON.parse(readFileSync("public/.well-known/mcp.json", "utf8"));
const tname = (p: string) => (p === "/api/generate-prompt" ? "clone_ui" : p.replace("/api/", "").replace(/-/g, "_"));
card.description = `${n + 1} website-intelligence tools for agents. 20 free calls/day on most tools, then ${range} per call (x402, USDC on Base): page to markdown, contacts, socials, SEO and security audits, DNS, WHOIS, tech stack, crypto project trust check, design tokens, screenshots, UI-recreation prompts.`;
card.version = "4.0.0";
card.tools = [
  { name: "list_services", description: "Free. Lists all tools with prices.", inputSchema: { type: "object", properties: {} } },
  ...SERVICES.map((s) => ({ name: tname(s.path), description: `${firstSentence(s.description)} ($${s.priceUsd})`, inputSchema: s.inputSchema })),
];
card.pricing = { amount: `${Math.min(...prices)}-${Math.max(...prices)}`, currency: "USDC", network: "base", protocol: "x402" };
writeFileSync("public/.well-known/mcp.json", JSON.stringify(card, null, 2) + "\n");
console.log(`mcp.json: ${card.tools.length} tools`);

// ---------- sitemap.xml ----------
const slugOf = (p: string) => p.replace("/api/", "");
const urls: [string, string, string][] = [
  ["/", "weekly", "1.0"], ["/tools", "weekly", "0.9"], ["/credits", "monthly", "0.7"], ["/showcase", "daily", "0.6"],
  ["/llms.txt", "weekly", "0.8"], ["/llms-full.txt", "weekly", "0.7"], ["/openapi.json", "weekly", "0.7"],
  ["/.well-known/x402", "weekly", "0.6"], ["/.well-known/agent-card.json", "weekly", "0.5"], ["/agents.json", "weekly", "0.5"],
  ...SERVICES.map((s) => [`/tools/${slugOf(s.path)}`, "weekly", "0.8"] as [string, string, string]),
  ["/terms", "yearly", "0.2"],
];
writeFileSync("public/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, f, p]) => `  <url><loc>${SITE}${u}</loc><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join("\n")}\n</urlset>\n`);
console.log(`sitemap: ${urls.length} urls`);
