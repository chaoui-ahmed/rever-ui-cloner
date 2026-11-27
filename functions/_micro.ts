// Cheap website micro-services (no screenshot, no AI). Each entry is one x402 route,
// served by functions/api/[service].ts. Not a route.
import { parse, type HTMLElement } from "node-html-parser";
import { type Env, validateTargetUrl, UpstreamError } from "./_shared";
import { UA, abs, meta } from "./_web";
import { TOKEN_CHECK } from "./_token";

export type MicroDef = {
  path: string;
  priceUsd: string;
  description: string;
  tags: string[];
  inputExample: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputExample: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** Body field validated instead of "url" (default url). */
  inputKey?: "address";
};
type Run = (env: Env, url: string, body: Record<string, unknown>) => Promise<unknown>;
export type Micro = { def: MicroDef; run: Run };

// ---------- helpers ----------

const T = 8000;
const MAX_HTML = 2_000_000;

async function get(url: string, init: RequestInit = {}, timeout = T) {
  if (!validateTargetUrl(url)) throw new UpstreamError(`Refused URL ${url}`);
  return fetch(url, { redirect: "follow", ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
}

async function tryText(url: string, max = 500_000): Promise<{ status: number; text: string; type: string } | null> {
  try {
    const r = await get(url);
    return { status: r.status, text: r.ok ? (await r.text()).slice(0, max) : "", type: r.headers.get("content-type") ?? "" };
  } catch {
    return null;
  }
}

type Page = { url: string; finalUrl: string; status: number; headers: Headers; html: string; root: HTMLElement; ms: number; bytes: number };

async function page(url: string): Promise<Page> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await get(url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  } catch (e) {
    throw new UpstreamError(`Could not reach site: ${(e as Error).message}`);
  }
  const ms = Date.now() - t0;
  if (!res.ok) throw new UpstreamError(`Site answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|xml/i.test(type)) throw new UpstreamError(`Not an HTML page (${type})`);
  const raw = await res.text();
  const html = raw.slice(0, MAX_HTML);
  return { url, finalUrl: res.url || url, status: res.status, headers: res.headers, html, root: parse(html, { comment: false }), ms, bytes: raw.length };
}

function visibleText(root: HTMLElement) {
  const clone = parse(root.toString());
  clone.querySelectorAll("script, style, noscript, template, svg").forEach((e) => e.remove());
  return (clone.querySelector("body") ?? clone).text.replace(/\s+/g, " ").trim();
}

const anchors = (p: Page) =>
  p.root.querySelectorAll("a[href]").map((a) => ({ href: abs(a.getAttribute("href"), p.finalUrl), text: a.text.replace(/\s+/g, " ").trim().slice(0, 120), rel: a.getAttribute("rel") ?? "" }))
    .filter((a) => a.href) as { href: string; text: string; rel: string }[];

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const uniq = <X>(xs: X[]) => [...new Set(xs)];

async function pool<I, O>(items: I[], n: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const out: O[] = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) { const i = k++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const MULTI_TLD = /\.(co|com|org|net|gov|ac|edu|ltd|plc|me|ne|or)\.[a-z]{2}$/i;
function registrableDomain(host: string) {
  const parts = host.replace(/^www\./, "").split(".");
  return parts.slice(MULTI_TLD.test(host) ? -3 : -2).join(".");
}

async function doh(name: string, type: string): Promise<string[]> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
    const d = (await r.json()) as { Answer?: { type: number; data: string }[] };
    const code: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };
    return (d.Answer ?? []).filter((a) => a.type === code[type]).map((a) => a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, ""));
  } catch {
    return [];
  }
}

let rdapBootstrap: Record<string, string> | null = null;
async function rdapServers(tld: string): Promise<string[]> {
  if (!rdapBootstrap) {
    try {
      const r = await fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(5000) });
      const d = (await r.json()) as { services: [string[], string[]][] };
      rdapBootstrap = {};
      for (const [tlds, urls] of d.services) for (const t of tlds) rdapBootstrap[t] = urls[0];
    } catch { rdapBootstrap = null; }
  }
  const base = rdapBootstrap?.[tld];
  return [...(base ? [base.replace(/\/?$/, "/")] : []), "https://rdap.org/"];
}

async function rdap(domain: string) {
  const tld = domain.split(".").pop() ?? "";
  for (const base of await rdapServers(tld)) {
    try {
      const r = await fetch(`${base}domain/${domain}`, { headers: { Accept: "application/rdap+json, application/json" }, redirect: "follow", signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const d = (await r.json()) as any;
      const ev = (a: string) => d.events?.find((e: any) => e.eventAction === a)?.eventDate ?? null;
      const registrar = d.entities?.find((e: any) => e.roles?.includes("registrar"));
      const created = ev("registration");
      return {
        domain,
        registrar: registrar?.vcardArray?.[1]?.find((v: any) => v[0] === "fn")?.[3] ?? registrar?.handle ?? null,
        created,
        updated: ev("last changed"),
        expires: ev("expiration"),
        ageDays: created ? Math.floor((Date.now() - Date.parse(created)) / 86_400_000) : null,
        status: d.status ?? [],
        nameservers: (d.nameservers ?? []).map((n: any) => (n.ldhName ?? "").toLowerCase()).filter(Boolean),
        source: base,
      };
    } catch { /* try next server */ }
  }
  return null;
}

async function wayback(host: string) {
  const snap = async (ts?: string) => {
    try {
      const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(host)}${ts ? `&timestamp=${ts}` : ""}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      const c = ((await r.json()) as any)?.archived_snapshots?.closest;
      if (!c?.timestamp) return null;
      const t = String(c.timestamp);
      return { date: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`, url: String(c.url).replace(/^http:/, "https:") };
    } catch {
      return null;
    }
  };
  const [first, last] = await Promise.all([snap("19960101"), snap()]);
  return { first, last, ageDays: first ? Math.floor((Date.now() - Date.parse(first.date)) / 86_400_000) : null };
}

const SOCIAL: [string, RegExp][] = [
  ["x", /^(?:twitter\.com|x\.com)\/(?!intent|share|home|search|hashtag)[A-Za-z0-9_]{1,30}\/?$/i],
  ["linkedin", /^linkedin\.com\/(company|in|school|showcase)\//i],
  ["facebook", /^(?:facebook|fb)\.com\/(?!sharer|share|dialog|plugins)[^/?#]+/i],
  ["instagram", /^instagram\.com\/[^/?#]+/i],
  ["youtube", /^(?:youtube\.com\/(@|c\/|channel\/|user\/)|youtu\.be\/)/i],
  ["tiktok", /^tiktok\.com\/@/i],
  ["github", /^github\.com\/[^/?#]+\/?$/i],
  ["discord", /^(?:discord\.gg|discord\.com\/invite)\//i],
  ["telegram", /^(?:t\.me|telegram\.me)\/[^/?#]+/i],
  ["medium", /^medium\.com\/@?[^/?#]+|\.medium\.com/i],
  ["reddit", /^reddit\.com\/(r|user|u)\//i],
  ["pinterest", /^pinterest\.[a-z.]+\/[^/?#]+/i],
  ["threads", /^threads\.net\/@/i],
  ["bluesky", /^bsky\.app\/profile\//i],
  ["farcaster", /^(?:warpcast\.com|farcaster\.xyz)\/[^/?#]+/i],
  ["mastodon", /^[a-z0-9.-]+\/@[A-Za-z0-9_]+$/i],
];

function socials(links: { href: string }[]) {
  const out: Record<string, string[]> = {};
  for (const { href } of links) {
    const bare = href.replace(/^https?:\/\/(www\.|m\.)?/i, "").replace(/[?#].*$/, "");
    for (const [name, re] of SOCIAL) {
      if (name === "mastodon" && !/mastodon|mstdn|fosstodon/i.test(bare)) continue;
      if (re.test(bare)) { (out[name] ??= []).includes(href) || out[name].push(href); break; }
    }
  }
  return out;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
function emails(p: Page, text: string) {
  const deob = text.replace(/\s*[[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".");
  const fromLinks = p.root.querySelectorAll('a[href^="mailto:"]').map((a) => decodeURIComponent((a.getAttribute("href") ?? "").slice(7).split("?")[0]));
  return uniq([...fromLinks, ...(deob.match(EMAIL) ?? [])].map((e) => e.toLowerCase().trim()))
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(e) && !/(example|sentry|wixpress|domain)\.(com|io)$/.test(e) && e.length < 80)
    .slice(0, 30);
}

function phones(p: Page, text: string) {
  const tel = p.root.querySelectorAll('a[href^="tel:"]').map((a) => decodeURIComponent((a.getAttribute("href") ?? "").slice(4)).trim());
  const found = text.match(/(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4})?/g) ?? [];
  return uniq([...tel, ...found.filter((n) => n.replace(/\D/g, "").length >= 9 && n.replace(/\D/g, "").length <= 15 && !/^\d{4}[\s.-]\d{2}[\s.-]\d{2}$/.test(n.trim()))].map((s) => s.trim())).slice(0, 20);
}

function jsonLd(root: HTMLElement): any[] {
  return root.querySelectorAll('script[type="application/ld+json"]').flatMap((s) => {
    try {
      const d = JSON.parse(s.text);
      return Array.isArray(d) ? d : d["@graph"] ?? [d];
    } catch {
      return [];
    }
  });
}

const typeIs = (x: any, t: RegExp) => [x?.["@type"]].flat().some((v) => typeof v === "string" && t.test(v));

const KEY_PAGES: [string, RegExp][] = [
  ["about", /\/(about|about-us|company|who-we-are|a-propos|qui-sommes-nous)\/?$|^(about|about us|company|our story|à propos)$/i],
  ["contact", /\/(contact|contact-us|contactez-nous|support)\/?$|^(contact|contact us|get in touch|support)$/i],
  ["pricing", /\/(pricing|plans|tarifs|prices)\/?$|^(pricing|plans|tarifs)$/i],
  ["careers", /\/(careers|jobs|join-us|hiring|work-with-us|carrieres|recrutement)\/?$|^(careers|jobs|we're hiring|join us)$/i],
  ["blog", /\/(blog|news|articles|insights|journal|actualites)\/?$|^(blog|news)$/i],
  ["docs", /\/(docs|documentation|developers|api|help|guides?)\/?$|docs\.|gitbook\.io|^(docs|documentation|developers|api)$/i],
  ["login", /\/(login|log-in|signin|sign-in|connexion)\/?$|^(log ?in|sign ?in)$/i],
  ["signup", /\/(signup|sign-up|register|get-started|start|join)\/?$|^(sign ?up|get started|start free|register)$/i],
  ["privacy", /\/(privacy|privacy-policy|confidentialite)\/?$|privacy/i],
  ["terms", /\/(terms|tos|terms-of-service|terms-and-conditions|legal|cgu|cgv|mentions-legales)\/?$/i],
  ["team", /\/(team|our-team|equipe|leadership)\/?$|^(team|our team|leadership)$/i],
];

function keyPages(p: Page) {
  const out: Record<string, string> = {};
  for (const a of anchors(p)) {
    let path = "";
    try { path = new URL(a.href).pathname.toLowerCase(); } catch { continue; }
    for (const [k, re] of KEY_PAGES) if (!out[k] && (re.test(path) || re.test(a.text.toLowerCase()) || (k === "docs" && re.test(a.href)))) out[k] = a.href;
  }
  return out;
}

const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider", "Amazonbot", "meta-externalagent", "cohere-ai", "MistralAI-User"];

function parseRobots(txt: string) {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[0] | null = null;
  let lastWasAgent = false;
  for (const line of txt.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    const key = k.toLowerCase();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(v.trim());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(v.trim());
    else if (cur && key === "allow") cur.allow.push(v.trim());
    else if (cur && key === "disallow") cur.disallow.push(v.trim());
  }
  const blocksRoot = (agent: string) => {
    const g = groups.find((g) => g.agents.some((a) => a.toLowerCase() === agent.toLowerCase())) ?? groups.find((g) => g.agents.includes("*"));
    if (!g) return false;
    return g.disallow.includes("/") && !g.allow.includes("/");
  };
  return { groups, sitemaps, blocksRoot };
}

const scoreOf = (checks: { ok: boolean; weight?: number }[]) => {
  const total = checks.reduce((s, c) => s + (c.weight ?? 1), 0);
  return Math.round((100 * checks.reduce((s, c) => s + (c.ok ? c.weight ?? 1 : 0), 0)) / (total || 1));
};
const grade = (s: number) => (s >= 90 ? "A" : s >= 75 ? "B" : s >= 60 ? "C" : s >= 40 ? "D" : "F");

// ---------- services ----------

const urlProp = { url: { type: "string", description: "Public http(s) URL" } };
const urlSchema = { type: "object", properties: urlProp, required: ["url"] };

function svc(path: string, priceUsd: string, description: string, tags: string[], outputExample: Record<string, unknown>, run: Run, extraProps: Record<string, unknown> = {}, inputExtra: Record<string, unknown> = {}): Micro {
  const props = { ...urlProp, ...extraProps };
  return {
    def: {
      path: `/api/${path}`,
      priceUsd,
      description,
      tags,
      inputExample: { url: "https://stripe.com", ...inputExtra },
      inputSchema: Object.keys(extraProps).length ? { type: "object", properties: props, required: ["url"] } : urlSchema,
      outputExample,
      outputSchema: { type: "object", properties: Object.fromEntries(Object.keys(outputExample).map((k) => [k, {}])) },
    },
    run,
  };
}

const EVM_ADDR = /\b0x[a-fA-F0-9]{40}\b/g;
const AUDITORS = /certik|hacken|peckshield|quantstamp|trail ?of ?bits|openzeppelin|consensys diligence|cyberscope|solidproof|interfi|sourcehat|halborn|spywolf|zellic|spearbit|code4rena|sherlock|ottersec|slowmist|beosin|chainsecurity|least authority|omniscia|veridise|cantina/i;
const SCAM_PHRASES = /guaranteed (returns|profit)|risk[- ]free|(next|guaranteed|easy) 1000?x|double your (crypto|money|investment)|validate (your )?wallet|rectify|wallet (sync|validation)|claim (your )?(airdrop|reward)s? now|enter (your )?(seed|recovery|secret) phrase|private key|send .{0,20}(eth|btc|usdt|sol).{0,20}(receive|get back)|presale ends in/i;

export const MICRO: Micro[] = [
  svc("contacts", "0.003",
    "Extract contact details from a web page: email addresses (including mailto links and [at]-obfuscated ones), phone numbers (tel links and visible numbers) and postal addresses from structured data. Fast (1-3 s).",
    ["contacts", "email", "phone", "lead-generation", "scrape", "enrichment", "sales"],
    { url: "https://example.com/", emails: ["hello@example.com"], phones: ["+1 415 555 0100"], addresses: [] },
    async (_e, url) => {
      const p = await page(url);
      const text = visibleText(p.root);
      const addresses = jsonLd(p.root).flatMap((x) => [x?.address].flat()).filter((a) => a && typeof a === "object").map((a: any) =>
        [a.streetAddress, a.postalCode, a.addressLocality, a.addressRegion, a.addressCountry?.name ?? a.addressCountry].filter(Boolean).join(", ")).filter(Boolean);
      return { url, finalUrl: p.finalUrl, emails: emails(p, text), phones: phones(p, text), addresses: uniq(addresses) };
    }),

  svc("social-links", "0.002",
    "Find a website's social media profiles: X/Twitter, LinkedIn, Facebook, Instagram, YouTube, TikTok, GitHub, Discord, Telegram, Medium, Reddit, Threads, Bluesky, Farcaster and more, from its links. Fast (1-3 s).",
    ["social", "twitter", "linkedin", "profiles", "enrichment", "lead-research", "osint"],
    { url: "https://stripe.com/", profiles: { x: ["https://twitter.com/stripe"], linkedin: ["https://www.linkedin.com/company/stripe"] }, count: 2 },
    async (_e, url) => {
      const p = await page(url);
      const profiles = socials(anchors(p));
      return { url, finalUrl: p.finalUrl, profiles, count: Object.values(profiles).flat().length };
    }),

  svc("links", "0.002",
    "List every link on a web page with its anchor text, split into internal and external, with nofollow flags and the external domains linked to. Up to 500 links. Fast (1-3 s).",
    ["links", "crawl", "scrape", "seo", "backlinks", "urls", "outbound"],
    { url: "https://example.com/", internal: [{ href: "https://example.com/about", text: "About" }], external: [{ href: "https://iana.org/", text: "More", nofollow: false }], externalDomains: ["iana.org"] },
    async (_e, url) => {
      const p = await page(url);
      const host = hostOf(p.finalUrl);
      const seen = new Set<string>();
      const all = anchors(p).filter((a) => /^https?:/.test(a.href) && !seen.has(a.href) && seen.add(a.href)).slice(0, 500);
      const internal = all.filter((a) => hostOf(a.href) === host).map((a) => ({ href: a.href, text: a.text }));
      const external = all.filter((a) => hostOf(a.href) !== host).map((a) => ({ href: a.href, text: a.text, nofollow: /nofollow|sponsored|ugc/i.test(a.rel) }));
      return { url, finalUrl: p.finalUrl, total: all.length, internal, external, externalDomains: uniq(external.map((e) => hostOf(e.href))) };
    }),

  svc("broken-links", "0.005",
    "Check the links on a web page for broken ones: requests up to 40 unique links in parallel and reports each status code, broken links (4xx/5xx/unreachable) and redirects. Takes 2-10 s.",
    ["broken-links", "link-checker", "seo", "qa", "404", "website-audit", "monitoring"],
    { url: "https://example.com/", checked: 12, broken: [{ href: "https://example.com/old", status: 404 }], redirected: 2, ok: 9 },
    async (_e, url, body) => {
      const p = await page(url);
      const max = Math.min(Math.max(Number(body.limit) || 40, 1), 40);
      const links = uniq(anchors(p).map((a) => a.href.replace(/#.*$/, "")).filter((h) => /^https?:/.test(h) && validateTargetUrl(h))).slice(0, max);
      const results = await pool(links, 10, async (href) => {
        try {
          let r = await fetch(href, { method: "HEAD", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
          if (r.status === 405 || r.status === 403 || r.status === 501) r = await fetch(href, { method: "GET", redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
          return { href, status: r.status, location: r.headers.get("location") ?? undefined };
        } catch (e) {
          return { href, status: 0, error: (e as Error).name === "TimeoutError" ? "timeout" : "unreachable" };
        }
      });
      const broken = results.filter((r) => r.status === 0 || r.status >= 400);
      return { url, finalUrl: p.finalUrl, checked: results.length, ok: results.filter((r) => r.status >= 200 && r.status < 300).length, redirected: results.filter((r) => r.status >= 300 && r.status < 400).length, broken, results };
    }, { limit: { type: "number", description: "Max links to check (1-40, default 40)" } }),

  svc("sitemap", "0.003",
    "Get every URL a website lists in its XML sitemaps: finds sitemaps via robots.txt and common paths, follows sitemap indexes (up to 5 children) and returns URLs with lastmod dates. Optional limit (default 1000, max 5000). Takes 1-6 s.",
    ["sitemap", "crawl", "urls", "seo", "site-map", "indexing", "discovery"],
    { url: "https://example.com/", sitemaps: ["https://example.com/sitemap.xml"], total: 120, urls: [{ loc: "https://example.com/pricing", lastmod: "2026-10-01" }] },
    async (_e, url, body) => {
      const origin = new URL(url).origin;
      const limit = Math.min(Math.max(Number(body.limit) || 1000, 1), 5000);
      const robots = await tryText(`${origin}/robots.txt`);
      let candidates = robots?.status === 200 ? parseRobots(robots.text).sitemaps : [];
      if (!candidates.length) candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`];
      const found: string[] = [];
      const urls: { loc: string; lastmod?: string }[] = [];
      let total = 0;
      const readMap = async (sm: string, depth: number) => {
        const r = await tryText(sm, 5_000_000);
        if (!r || r.status !== 200 || !/<(urlset|sitemapindex)/i.test(r.text)) return false;
        found.push(sm);
        if (/<sitemapindex/i.test(r.text)) {
          const kids = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
          if (depth < 1) for (const k of kids.slice(0, 5)) await readMap(k, depth + 1);
          return true;
        }
        for (const m of r.text.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
          total++;
          if (urls.length >= limit) continue;
          const loc = m[1].match(/<loc>\s*([^<\s]+)/i)?.[1]?.replace(/&amp;/g, "&");
          const lastmod = m[1].match(/<lastmod>\s*([^<\s]+)/i)?.[1];
          if (loc) urls.push(lastmod ? { loc, lastmod } : { loc });
        }
        return true;
      };
      for (const c of candidates.slice(0, 3)) if ((await readMap(c, 0)) && urls.length >= limit) break;
      return { url, sitemaps: found, total, returned: urls.length, truncated: total > urls.length, urls, note: found.length ? undefined : "No XML sitemap found." };
    }, { limit: { type: "number", description: "Max URLs returned (1-5000, default 1000)" } }),

  svc("robots", "0.002",
    "Read and parse a website's robots.txt: user-agent groups with allow/disallow rules, declared sitemaps, and which AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot...) are blocked from the whole site. Fast (under 2 s).",
    ["robots.txt", "crawler", "ai-bots", "seo", "scraping", "compliance", "gptbot"],
    { url: "https://example.com/", exists: true, sitemaps: ["https://example.com/sitemap.xml"], aiBots: { GPTBot: "blocked", ClaudeBot: "allowed" }, groups: [] },
    async (_e, url) => {
      const origin = new URL(url).origin;
      const r = await tryText(`${origin}/robots.txt`, 200_000);
      if (!r || r.status !== 200) return { url, robotsUrl: `${origin}/robots.txt`, exists: false, status: r?.status ?? 0, note: "No robots.txt: everything is allowed by default." };
      const parsed = parseRobots(r.text);
      return {
        url,
        robotsUrl: `${origin}/robots.txt`,
        exists: true,
        sitemaps: parsed.sitemaps,
        aiBots: Object.fromEntries(AI_BOTS.map((b) => [b, parsed.blocksRoot(b) ? "blocked" : "allowed"])),
        allBotsBlocked: parsed.blocksRoot("*"),
        groups: parsed.groups.slice(0, 50),
        raw: r.text.slice(0, 20_000),
      };
    }),

  svc("security-headers", "0.002",
    "Grade a website's HTTP security headers (A-F): HSTS, Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, plus leaked server/version headers, with a fix hint for each missing one. Fast (under 2 s).",
    ["security", "headers", "hsts", "csp", "audit", "pentest", "compliance"],
    { url: "https://example.com/", grade: "C", score: 57, missing: ["content-security-policy"], present: { "strict-transport-security": "max-age=31536000" } },
    async (_e, url) => {
      const r = await get(url, { headers: { Accept: "text/html" } }).catch((e) => { throw new UpstreamError(`Could not reach site: ${e.message}`); });
      const h = r.headers;
      const spec: [string, number, string][] = [
        ["strict-transport-security", 3, "Add Strict-Transport-Security: max-age=31536000; includeSubDomains"],
        ["content-security-policy", 3, "Add a Content-Security-Policy restricting script sources"],
        ["x-frame-options", 2, "Add X-Frame-Options: DENY (or CSP frame-ancestors) to prevent clickjacking"],
        ["x-content-type-options", 2, "Add X-Content-Type-Options: nosniff"],
        ["referrer-policy", 1, "Add Referrer-Policy: strict-origin-when-cross-origin"],
        ["permissions-policy", 1, "Add Permissions-Policy to disable unused browser features"],
        ["cross-origin-opener-policy", 1, "Add Cross-Origin-Opener-Policy: same-origin"],
      ];
      const present: Record<string, string> = {};
      const missing: { header: string; fix: string }[] = [];
      const checks = spec.map(([name, weight, fix]) => {
        const v = h.get(name) ?? (name === "x-frame-options" && /frame-ancestors/i.test(h.get("content-security-policy") ?? "") ? "via CSP frame-ancestors" : null);
        if (v) present[name] = v.slice(0, 300); else missing.push({ header: name, fix });
        return { ok: !!v, weight };
      });
      const leaks = ["server", "x-powered-by", "x-aspnet-version", "x-generator"].map((k) => [k, h.get(k)]).filter(([, v]) => v && /\d/.test(v as string));
      const score = Math.max(0, scoreOf(checks) - leaks.length * 5);
      return { url, finalUrl: r.url, status: r.status, https: r.url.startsWith("https:"), grade: grade(score), score, present, missing, versionLeaks: Object.fromEntries(leaks) };
    }),

  svc("https-check", "0.002",
    "Check a site's HTTPS setup: whether http:// redirects to https://, HSTS and preload readiness, final URL, and mixed content (insecure http:// scripts, styles, images or iframes on the https page). Fast (1-3 s).",
    ["https", "ssl", "tls", "hsts", "mixed-content", "security", "audit"],
    { url: "https://example.com/", httpRedirectsToHttps: true, hsts: "max-age=31536000", hstsPreloadReady: false, mixedContent: [] },
    async (_e, url) => {
      const host = new URL(url).host;
      let httpRedirectsToHttps: boolean | null = null;
      let httpLocation: string | null = null;
      try {
        const r = await fetch(`http://${host}/`, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
        httpLocation = r.headers.get("location");
        httpRedirectsToHttps = r.status >= 300 && r.status < 400 && !!httpLocation && httpLocation.startsWith("https:");
      } catch { /* http not served */ }
      const p = await page(`https://${host}/`).catch(() => null);
      const hsts = p?.headers.get("strict-transport-security") ?? null;
      const maxAge = Number(hsts?.match(/max-age=(\d+)/i)?.[1] ?? 0);
      const mixed = p ? uniq(p.root.querySelectorAll("script[src], link[href], img[src], iframe[src], source[src], video[src], audio[src]")
        .map((e) => e.getAttribute("src") ?? (e.tagName === "LINK" && /stylesheet|icon/i.test(e.getAttribute("rel") ?? "") ? e.getAttribute("href") : null))
        .filter((s): s is string => !!s && s.startsWith("http://"))).slice(0, 50) : [];
      return {
        url,
        httpsWorks: !!p,
        finalUrl: p?.finalUrl ?? null,
        httpRedirectsToHttps,
        httpLocation,
        hsts,
        hstsMaxAgeDays: maxAge ? Math.round(maxAge / 86400) : null,
        hstsPreloadReady: maxAge >= 31536000 && /includesubdomains/i.test(hsts ?? "") && /preload/i.test(hsts ?? ""),
        mixedContent: mixed,
      };
    }),

  svc("redirects", "0.002",
    "Trace a URL's full redirect chain hop by hop (up to 10): status code, Location and server for each hop, final URL, and loop detection. Useful for link unshortening and SEO migrations. Fast (1-3 s).",
    ["redirects", "redirect-chain", "unshorten", "seo", "301", "url", "tracking"],
    { url: "http://stripe.com", hops: [{ url: "http://stripe.com/", status: 301, location: "https://stripe.com/" }, { url: "https://stripe.com/", status: 200 }], finalUrl: "https://stripe.com/", count: 1 },
    async (_e, url) => {
      const hops: { url: string; status: number; location?: string; server?: string }[] = [];
      let cur = url;
      for (let i = 0; i < 11; i++) {
        if (!validateTargetUrl(cur)) break;
        let r: Response;
        try {
          r = await fetch(cur, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
        } catch (e) {
          hops.push({ url: cur, status: 0, location: undefined, server: (e as Error).message });
          break;
        }
        const loc = r.headers.get("location");
        hops.push({ url: cur, status: r.status, location: loc ?? undefined, server: r.headers.get("server") ?? undefined });
        if (!(r.status >= 300 && r.status < 400 && loc)) break;
        const next = abs(loc, cur);
        if (!next || hops.some((h) => h.url === next)) { hops.push({ url: next ?? loc, status: -1, location: "loop" }); break; }
        cur = next;
      }
      const last = hops[hops.length - 1];
      return { url, hops, count: Math.max(0, hops.length - 1), finalUrl: last?.url ?? url, finalStatus: last?.status ?? 0, loop: last?.status === -1 };
    }),

  svc("headers", "0.001",
    "Get the raw HTTP response headers of any URL, with status code, final URL after redirects and response time. Fast (under 2 s).",
    ["http", "headers", "debug", "cache", "cdn", "api", "network"],
    { url: "https://example.com/", status: 200, ms: 120, headers: { "content-type": "text/html", server: "cloudflare" } },
    async (_e, url) => {
      const t0 = Date.now();
      const r = await get(url).catch((e) => { throw new UpstreamError(`Could not reach site: ${e.message}`); });
      r.body?.cancel();
      return { url, finalUrl: r.url, status: r.status, ms: Date.now() - t0, headers: Object.fromEntries(r.headers.entries()) };
    }),

  svc("status", "0.001",
    "Is this website up? Returns up/down, HTTP status, response time in ms, final URL and content type. Cheapest uptime check for agents. Fast (under 2 s).",
    ["uptime", "status", "monitoring", "ping", "health-check", "is-it-down", "availability"],
    { url: "https://example.com/", up: true, status: 200, ms: 98, finalUrl: "https://example.com/" },
    async (_e, url) => {
      const t0 = Date.now();
      try {
        const r = await get(url, {}, 10_000);
        r.body?.cancel();
        return { url, up: r.status < 500, status: r.status, ms: Date.now() - t0, finalUrl: r.url, contentType: r.headers.get("content-type") };
      } catch (e) {
        return { url, up: false, status: 0, ms: Date.now() - t0, error: (e as Error).name === "TimeoutError" ? "timeout after 10 s" : (e as Error).message };
      }
    }),

  svc("language", "0.001",
    "Detect a web page's language: html lang attribute, Content-Language header, og:locale, hreflang alternates (other language versions) and a guess from the visible text. Fast (1-3 s).",
    ["language", "locale", "i18n", "hreflang", "translation", "detection", "seo"],
    { url: "https://example.com/", declared: "en", detected: "en", hreflang: [{ lang: "fr", href: "https://example.com/fr" }] },
    async (_e, url) => {
      const p = await page(url);
      const text = visibleText(p.root).toLowerCase().slice(0, 20_000);
      const words = text.split(/[^a-zà-ÿ]+/);
      const STOP: Record<string, string[]> = {
        en: ["the", "and", "of", "to", "is", "in", "for", "with", "you", "that"],
        fr: ["le", "la", "les", "et", "des", "est", "pour", "dans", "une", "vous"],
        es: ["el", "la", "los", "y", "de", "que", "para", "con", "una", "por"],
        de: ["der", "die", "und", "das", "ist", "mit", "für", "nicht", "ein", "sie"],
        it: ["il", "di", "che", "e", "la", "per", "con", "una", "non", "sono"],
        pt: ["o", "de", "que", "e", "para", "com", "uma", "não", "os", "você"],
        nl: ["de", "het", "en", "van", "een", "voor", "met", "niet", "zijn", "je"],
      };
      const scores = Object.fromEntries(Object.entries(STOP).map(([l, sw]) => [l, words.filter((w) => sw.includes(w)).length]));
      let detected = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      let guess: string | null = detected[1] > 5 ? detected[0] : null;
      if (/[぀-ヿ]/.test(text)) guess = "ja"; else if (/[一-鿿]/.test(text)) guess = "zh"; else if (/[가-힯]/.test(text)) guess = "ko";
      else if (/[؀-ۿ]/.test(text)) guess = "ar"; else if (/[Ѐ-ӿ]/.test(text)) guess = "ru";
      return {
        url,
        finalUrl: p.finalUrl,
        declared: p.root.querySelector("html")?.getAttribute("lang") ?? null,
        contentLanguage: p.headers.get("content-language"),
        ogLocale: meta(p.root, "og:locale"),
        detected: guess,
        hreflang: p.root.querySelectorAll('link[rel="alternate"][hreflang]').map((l) => ({ lang: l.getAttribute("hreflang"), href: abs(l.getAttribute("href"), p.finalUrl) })).slice(0, 100),
      };
    }),

  svc("text-stats", "0.002",
    "Text statistics for a web page's visible content: word, sentence and paragraph counts, reading time, Flesch reading-ease score and top keywords (stop words removed). Fast (1-3 s).",
    ["word-count", "readability", "keywords", "content", "seo", "text-analysis", "reading-time"],
    { url: "https://example.com/", words: 830, sentences: 41, readingTimeMin: 4, fleschReadingEase: 58.2, topKeywords: [{ word: "payments", count: 14 }] },
    async (_e, url) => {
      const p = await page(url);
      const text = visibleText(p.root);
      const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
      const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
      const syll = (w: string) => Math.max(1, (w.toLowerCase().replace(/[^a-z]/g, "").replace(/e$/, "").match(/[aeiouy]+/g) ?? []).length);
      const syllables = words.reduce((s, w) => s + syll(w), 0);
      const STOP = new Set("the a an and or but of to in on at for with by from is are was were be been it this that these those you your we our they their as not can will just more all any how what when which who why about into over than then there here also has have had do does did its it's i me my he she his her them so if no yes up out get new use one two".split(" "));
      const freq = new Map<string, number>();
      for (const w of words) {
        const k = w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
        if (k.length > 2 && !STOP.has(k) && !/^\d+$/.test(k)) freq.set(k, (freq.get(k) ?? 0) + 1);
      }
      return {
        url,
        finalUrl: p.finalUrl,
        words: words.length,
        characters: text.length,
        sentences,
        paragraphs: p.root.querySelectorAll("p").filter((x) => x.text.trim().length > 30).length,
        readingTimeMin: Math.max(1, Math.round(words.length / 230)),
        fleschReadingEase: words.length ? Math.round((206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length)) * 10) / 10 : null,
        topKeywords: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count })),
      };
    }),

  svc("structured-data", "0.003",
    "Extract all structured data from a web page: every JSON-LD block parsed (Organization, Product, Article, FAQ, Breadcrumb, Event...), microdata item types and RDFa types. Fast (1-3 s).",
    ["structured-data", "json-ld", "schema.org", "microdata", "seo", "rich-results", "scrape"],
    { url: "https://example.com/", types: ["Organization", "WebSite"], jsonLd: [{ "@type": "Organization", name: "Example" }], microdata: [] },
    async (_e, url) => {
      const p = await page(url);
      const blocks = jsonLd(p.root);
      const microdata = uniq(p.root.querySelectorAll("[itemtype]").map((e) => e.getAttribute("itemtype") ?? "")).filter(Boolean);
      const rdfa = uniq(p.root.querySelectorAll("[typeof]").map((e) => e.getAttribute("typeof") ?? "")).filter(Boolean);
      return { url, finalUrl: p.finalUrl, types: uniq(blocks.flatMap((b) => [b?.["@type"]].flat()).filter(Boolean)), jsonLd: blocks.slice(0, 30), microdata, rdfa };
    }),

  svc("og-image", "0.001",
    "Get the social preview image of a page (what shows when a link is shared): og:image and twitter:image with declared size and alt text, or the first large page image as a fallback. Fast (under 2 s).",
    ["og-image", "open-graph", "link-preview", "thumbnail", "social", "unfurl", "image"],
    { url: "https://stripe.com/", image: "https://images.stripeassets.com/.../og.png", width: "1200", height: "630", alt: null, source: "og:image" },
    async (_e, url) => {
      const p = await page(url);
      const og = abs(meta(p.root, "og:image") ?? meta(p.root, "og:image:url") ?? meta(p.root, "og:image:secure_url"), p.finalUrl);
      const tw = abs(meta(p.root, "twitter:image") ?? meta(p.root, "twitter:image:src"), p.finalUrl);
      const firstImg = p.root.querySelectorAll("img[src]").find((i) => Number(i.getAttribute("width") ?? 999) >= 200);
      const fallback = firstImg ? abs(firstImg.getAttribute("src"), p.finalUrl) : null;
      return {
        url,
        finalUrl: p.finalUrl,
        image: og ?? tw ?? fallback,
        source: og ? "og:image" : tw ? "twitter:image" : fallback ? "first page image" : null,
        width: meta(p.root, "og:image:width"),
        height: meta(p.root, "og:image:height"),
        alt: meta(p.root, "og:image:alt") ?? meta(p.root, "twitter:image:alt"),
        ogImage: og,
        twitterImage: tw,
        twitterCard: meta(p.root, "twitter:card"),
      };
    }),

  svc("feeds", "0.003",
    "Find a website's RSS/Atom feeds (declared links and common paths like /feed and /rss.xml) and return the latest items from the first one: title, link, date, summary. Takes 1-5 s.",
    ["rss", "atom", "feed", "news", "blog", "monitoring", "content"],
    { url: "https://example.com/", feeds: ["https://example.com/feed.xml"], feedTitle: "Example Blog", items: [{ title: "Hello", link: "https://example.com/hello", date: "2026-11-01" }] },
    async (_e, url, body) => {
      const p = await page(url).catch(() => null);
      const origin = new URL(url).origin;
      const declared = p ? p.root.querySelectorAll('link[rel="alternate"]').filter((l) => /rss|atom|feed/i.test(l.getAttribute("type") ?? "")).map((l) => abs(l.getAttribute("href"), p.finalUrl)).filter(Boolean) as string[] : [];
      const guesses = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/rss", "/blog/rss.xml", "/blog/feed"].map((x) => origin + x);
      const n = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
      for (const f of uniq([...declared, ...guesses]).slice(0, 8)) {
        const r = await tryText(f, 3_000_000);
        if (!r || r.status !== 200 || !/<(rss|feed|rdf)/i.test(r.text.slice(0, 2000))) continue;
        const tag = (chunk: string, names: string[]) => {
          for (const nm of names) {
            const m = chunk.match(new RegExp(`<${nm}[^>]*>([\\s\\S]*?)</${nm}>`, "i"));
            if (m) return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
          }
          return null;
        };
        const chunks = [...r.text.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]).slice(0, n);
        const items = chunks.map((c) => ({
          title: tag(c, ["title"]),
          link: c.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i)?.[1] ?? c.match(/<link[^>]*href=["']([^"']+)/i)?.[1] ?? tag(c, ["link", "guid"]),
          date: tag(c, ["pubDate", "published", "updated", "dc:date"]),
          summary: tag(c, ["description", "summary", "content"])?.slice(0, 300) ?? null,
        }));
        const head = r.text.split(/<(item|entry)[\s>]/i)[0];
        return { url, feeds: uniq([...declared, f]), feedUrl: f, feedTitle: tag(head, ["title"]), items };
      }
      return { url, feeds: declared, items: [], note: "No readable RSS/Atom feed found." };
    }, { limit: { type: "number", description: "Max items (1-50, default 20)" } }),

  svc("images", "0.002",
    "List the images on a web page with absolute URL, alt text, declared width/height and lazy-loading, plus counts of images missing alt text (accessibility/SEO). Up to 300 images. Fast (1-3 s).",
    ["images", "alt-text", "accessibility", "seo", "scrape", "media", "a11y"],
    { url: "https://example.com/", count: 14, missingAlt: 3, images: [{ src: "https://example.com/hero.png", alt: "Dashboard", width: "1200", height: "800", loading: "lazy" }] },
    async (_e, url) => {
      const p = await page(url);
      const imgs = p.root.querySelectorAll("img").map((i) => ({
        src: abs(i.getAttribute("src") ?? i.getAttribute("data-src") ?? i.getAttribute("srcset")?.split(/\s/)[0], p.finalUrl),
        alt: i.getAttribute("alt") ?? null,
        width: i.getAttribute("width") ?? null,
        height: i.getAttribute("height") ?? null,
        loading: i.getAttribute("loading") ?? null,
      })).filter((i) => i.src);
      return { url, finalUrl: p.finalUrl, count: imgs.length, missingAlt: imgs.filter((i) => i.alt === null).length, emptyAlt: imgs.filter((i) => i.alt === "").length, images: imgs.slice(0, 300) };
    }),

  svc("headings", "0.001",
    "Get the heading outline of a web page (H1-H6 in document order) with counts per level and structure warnings (no H1, several H1s, skipped levels). Fast (under 2 s).",
    ["headings", "outline", "h1", "seo", "structure", "content", "accessibility"],
    { url: "https://example.com/", outline: [{ level: 1, text: "Example Domain" }], counts: { h1: 1, h2: 0 }, warnings: [] },
    async (_e, url) => {
      const p = await page(url);
      const outline = p.root.querySelectorAll("h1, h2, h3, h4, h5, h6").map((h) => ({ level: Number(h.tagName[1]), text: h.text.replace(/\s+/g, " ").trim().slice(0, 200) })).filter((h) => h.text);
      const counts = Object.fromEntries([1, 2, 3, 4, 5, 6].map((l) => [`h${l}`, outline.filter((h) => h.level === l).length]));
      const warnings: string[] = [];
      if (!counts.h1) warnings.push("No H1");
      if (counts.h1 > 1) warnings.push(`${counts.h1} H1 headings`);
      outline.forEach((h, i) => { if (i && h.level > outline[i - 1].level + 1) warnings.push(`Skipped level: H${outline[i - 1].level} → H${h.level} ("${h.text.slice(0, 40)}")`); });
      return { url, finalUrl: p.finalUrl, outline: outline.slice(0, 300), counts, warnings: uniq(warnings).slice(0, 20) };
    }),

  svc("seo-audit", "0.005",
    "Quick on-page SEO audit with a 0-100 score: title and meta description length, H1, canonical, lang, viewport, noindex, Open Graph, image alt text, structured data, HTTPS, robots.txt and sitemap, with a fix for each failed check. Takes 2-5 s.",
    ["seo", "audit", "on-page", "meta-tags", "website-audit", "marketing", "ranking"],
    { url: "https://example.com/", score: 72, grade: "C", failed: [{ check: "meta description", fix: "Add a 70-160 character meta description" }], passed: ["title", "h1"] },
    async (_e, url) => {
      const p = await page(url);
      const origin = new URL(p.finalUrl).origin;
      const [robots, sm] = await Promise.all([tryText(`${origin}/robots.txt`, 100_000), tryText(`${origin}/sitemap.xml`, 200_000)]);
      const title = p.root.querySelector("title")?.text.trim() ?? "";
      const desc = meta(p.root, "description") ?? "";
      const imgs = p.root.querySelectorAll("img");
      const noAlt = imgs.filter((i) => i.getAttribute("alt") === undefined || i.getAttribute("alt") === null).length;
      const hasSitemap = (sm?.status === 200 && /<(urlset|sitemapindex)/i.test(sm.text)) || /sitemap:/i.test(robots?.text ?? "");
      const checks: { check: string; ok: boolean; weight: number; value?: unknown; fix: string }[] = [
        { check: "title", ok: title.length >= 10 && title.length <= 65, weight: 3, value: `${title.length} chars`, fix: "Use a 10-65 character <title>" },
        { check: "meta description", ok: desc.length >= 70 && desc.length <= 160, weight: 2, value: `${desc.length} chars`, fix: "Add a 70-160 character meta description" },
        { check: "single h1", ok: p.root.querySelectorAll("h1").length === 1, weight: 2, value: p.root.querySelectorAll("h1").length, fix: "Use exactly one <h1>" },
        { check: "canonical", ok: !!p.root.querySelector('link[rel="canonical"]'), weight: 1, fix: 'Add <link rel="canonical">' },
        { check: "lang", ok: !!p.root.querySelector("html")?.getAttribute("lang"), weight: 1, fix: "Set <html lang>" },
        { check: "viewport", ok: !!p.root.querySelector('meta[name="viewport"]'), weight: 2, fix: "Add a responsive viewport meta tag" },
        { check: "indexable", ok: !/noindex/i.test((meta(p.root, "robots") ?? "") + (p.headers.get("x-robots-tag") ?? "")), weight: 3, fix: "Remove noindex" },
        { check: "open graph", ok: !!meta(p.root, "og:title") && !!meta(p.root, "og:image"), weight: 1, fix: "Add og:title and og:image" },
        { check: "image alt", ok: noAlt === 0, weight: 1, value: `${noAlt}/${imgs.length} missing`, fix: "Add alt text to every image" },
        { check: "structured data", ok: jsonLd(p.root).length > 0, weight: 1, fix: "Add schema.org JSON-LD" },
        { check: "https", ok: p.finalUrl.startsWith("https:"), weight: 2, fix: "Serve the site over HTTPS" },
        { check: "robots.txt", ok: robots?.status === 200, weight: 1, fix: "Add /robots.txt" },
        { check: "sitemap", ok: hasSitemap, weight: 1, fix: "Add an XML sitemap and reference it in robots.txt" },
        { check: "content length", ok: visibleText(p.root).split(/\s+/).length >= 300, weight: 1, fix: "Pages with under 300 words rank poorly" },
      ];
      const score = scoreOf(checks);
      return { url, finalUrl: p.finalUrl, score, grade: grade(score), title, description: desc, failed: checks.filter((c) => !c.ok).map(({ check, value, fix }) => ({ check, value, fix })), passed: checks.filter((c) => c.ok).map((c) => c.check) };
    }),

  svc("favicon", "0.001",
    "Get the best favicon/icon for a website: the largest declared icon (apple-touch-icon, SVG, sized PNGs), all candidates with sizes, and whether /favicon.ico exists. Fast (under 2 s).",
    ["favicon", "icon", "logo", "branding", "link-preview", "website", "image"],
    { url: "https://stripe.com/", best: "https://stripe.com/apple-touch-icon.png", candidates: [{ rel: "icon", href: "https://stripe.com/favicon.ico", sizes: null }] },
    async (_e, url) => {
      const p = await page(url);
      const cand = p.root.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel~="apple-touch-icon"], link[rel="mask-icon"]').map((l) => ({
        rel: l.getAttribute("rel") ?? "", href: abs(l.getAttribute("href"), p.finalUrl), sizes: l.getAttribute("sizes") ?? null, type: l.getAttribute("type") ?? null,
      })).filter((c) => c.href) as { rel: string; href: string; sizes: string | null; type: string | null }[];
      const size = (c: (typeof cand)[0]) => (c.type?.includes("svg") || c.href.endsWith(".svg") ? 10_000 : Number(c.sizes?.match(/(\d+)/)?.[1] ?? (c.rel.includes("apple") ? 180 : 16)));
      const ico = `${new URL(p.finalUrl).origin}/favicon.ico`;
      let icoExists = false;
      try { const r = await get(ico, { method: "HEAD" }, 4000); icoExists = r.ok; } catch { /* ignore */ }
      const best = [...cand].sort((a, b) => size(b) - size(a))[0]?.href ?? (icoExists ? ico : null);
      return { url, finalUrl: p.finalUrl, best, candidates: cand, faviconIco: icoExists ? ico : null };
    }),

  svc("dns", "0.002",
    "DNS lookup for a website's domain: A, AAAA, CNAME, MX, NS, TXT and CAA records, via Cloudflare DNS-over-HTTPS. Pass a URL or bare hostname. Fast (under 2 s).",
    ["dns", "domain", "mx", "txt", "nameservers", "network", "infrastructure"],
    { host: "stripe.com", A: ["1.2.3.4"], MX: ["10 aspmx.l.google.com."], NS: ["ns-1.awsdns.com."], TXT: ["v=spf1 ..."] },
    async (_e, url) => {
      const host = new URL(url).hostname;
      const types = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "CAA"];
      const res = await Promise.all(types.map((t) => doh(host, t)));
      const out: Record<string, unknown> = { host };
      types.forEach((t, i) => (out[t] = res[i]));
      if (host !== registrableDomain(host)) out.apexNS = await doh(registrableDomain(host), "NS");
      return out;
    }),

  svc("email-security", "0.003",
    "Check a domain's email setup and spoofing protection: MX records and email provider (Google Workspace, Microsoft 365, Zoho...), SPF, DMARC policy and common DKIM selectors, with a 0-100 score. Fast (1-3 s).",
    ["email", "spf", "dmarc", "dkim", "mx", "deliverability", "security"],
    { domain: "stripe.com", provider: "Google Workspace", spf: "v=spf1 include:_spf.google.com ~all", dmarc: { record: "v=DMARC1; p=reject", policy: "reject" }, dkimSelectors: ["google"], score: 100 },
    async (_e, url) => {
      const domain = registrableDomain(new URL(url).hostname);
      const [mx, txt, dmarcTxt, ...dkim] = await Promise.all([
        doh(domain, "MX"), doh(domain, "TXT"), doh(`_dmarc.${domain}`, "TXT"),
        ...["google", "selector1", "selector2", "default", "k1", "s1", "mail", "dkim"].map((s) => doh(`${s}._domainkey.${domain}`, "TXT")),
      ]);
      const mxs = mx.join(" ").toLowerCase();
      const provider = /google|googlemail/.test(mxs) ? "Google Workspace" : /outlook|protection\.outlook/.test(mxs) ? "Microsoft 365" : /zoho/.test(mxs) ? "Zoho Mail" : /protonmail|proton\.me/.test(mxs) ? "Proton Mail" : /mimecast/.test(mxs) ? "Mimecast" : /pphosted|proofpoint/.test(mxs) ? "Proofpoint" : /secureserver/.test(mxs) ? "GoDaddy" : /ovh/.test(mxs) ? "OVH" : /mailgun/.test(mxs) ? "Mailgun" : /amazonaws|awsapps/.test(mxs) ? "Amazon SES/WorkMail" : /icloud/.test(mxs) ? "iCloud" : mx.length ? "Other / self-hosted" : null;
      const spf = txt.find((t) => /^v=spf1/i.test(t)) ?? null;
      const dmarc = dmarcTxt.find((t) => /^v=DMARC1/i.test(t)) ?? null;
      const policy = dmarc?.match(/;\s*p=(\w+)/i)?.[1]?.toLowerCase() ?? null;
      const sels = ["google", "selector1", "selector2", "default", "k1", "s1", "mail", "dkim"].filter((_, i) => dkim[i].some((t) => /p=/i.test(t)));
      const score = scoreOf([
        { ok: mx.length > 0, weight: 1 },
        { ok: !!spf, weight: 2 },
        { ok: !!spf && /[-~]all/.test(spf), weight: 1 },
        { ok: !!dmarc, weight: 2 },
        { ok: policy === "reject" || policy === "quarantine", weight: 2 },
        { ok: sels.length > 0, weight: 1 },
      ]);
      return { domain, mx, provider, spf, dmarc: dmarc ? { record: dmarc, policy } : null, dkimSelectors: sels, score, spoofable: !(dmarc && (policy === "reject" || policy === "quarantine")) };
    }),

  svc("domain-whois", "0.003",
    "Domain registration data via RDAP (modern WHOIS): registrar, creation, update and expiry dates, domain age in days, status flags and nameservers. Useful for trust and fraud checks. Takes 1-4 s.",
    ["whois", "rdap", "domain", "domain-age", "registrar", "fraud", "trust"],
    { domain: "stripe.com", registrar: "SafeNames Ltd.", created: "1995-09-12T04:00:00Z", expires: "2031-09-11T04:00:00Z", ageDays: 11393, nameservers: ["ns-cloud-a1.googledomains.com"] },
    async (_e, url) => {
      const domain = registrableDomain(new URL(url).hostname);
      const d = await rdap(domain);
      if (!d) throw new UpstreamError(`No RDAP data for ${domain} (some country TLDs do not publish RDAP)`);
      return d;
    }),

  svc("ai-readiness", "0.003",
    "How readable is a website for AI agents? Checks llms.txt and llms-full.txt, AI crawler rules in robots.txt, sitemap, JSON-LD, whether content renders without JavaScript, OpenAPI, MCP and x402 manifests, with a 0-100 score and fixes. Takes 2-5 s.",
    ["ai-readiness", "llms.txt", "geo", "aeo", "ai-seo", "agents", "mcp"],
    { url: "https://example.com/", score: 45, grade: "D", llmsTxt: false, aiBotsBlocked: ["GPTBot"], serverRendered: true, failed: [{ check: "llms.txt", fix: "Publish /llms.txt" }] },
    async (_e, url) => {
      const origin = new URL(url).origin;
      const [p, llms, llmsFull, robots, sm, openapi, mcp, x402, plugin] = await Promise.all([
        page(url).catch(() => null), tryText(`${origin}/llms.txt`, 50_000), tryText(`${origin}/llms-full.txt`, 10_000), tryText(`${origin}/robots.txt`, 100_000),
        tryText(`${origin}/sitemap.xml`, 100_000), tryText(`${origin}/openapi.json`, 10_000), tryText(`${origin}/.well-known/mcp.json`, 10_000),
        tryText(`${origin}/.well-known/x402.json`, 10_000), tryText(`${origin}/.well-known/ai-plugin.json`, 10_000),
      ]);
      const isReal = (r: typeof llms, re: RegExp) => !!r && r.status === 200 && re.test(r.text.slice(0, 2000)) && !/<html/i.test(r.text.slice(0, 300));
      const parsed = robots?.status === 200 ? parseRobots(robots.text) : null;
      const blocked = parsed ? AI_BOTS.filter((b) => parsed.blocksRoot(b)) : [];
      const words = p ? visibleText(p.root).split(/\s+/).length : 0;
      const checks = [
        { check: "llms.txt", ok: isReal(llms, /^#|\w/), weight: 2, fix: "Publish /llms.txt: a markdown summary of the site for LLMs" },
        { check: "llms-full.txt", ok: isReal(llmsFull, /\w/), weight: 1, fix: "Publish /llms-full.txt with the full docs in markdown" },
        { check: "AI crawlers allowed", ok: blocked.length === 0, weight: 2, fix: `Allow ${blocked.join(", ") || "AI crawlers"} in robots.txt` },
        { check: "sitemap", ok: (sm?.status === 200 && /<(urlset|sitemapindex)/i.test(sm.text)) || !!parsed?.sitemaps.length, weight: 1, fix: "Add an XML sitemap" },
        { check: "server-rendered content", ok: words >= 150, weight: 2, fix: "Render main content in HTML; many AI crawlers do not run JavaScript" },
        { check: "structured data", ok: !!p && jsonLd(p.root).length > 0, weight: 1, fix: "Add schema.org JSON-LD" },
        { check: "meta description", ok: !!p && !!meta(p.root, "description"), weight: 1, fix: "Add a meta description" },
        { check: "OpenAPI / MCP / x402 manifest", ok: isReal(openapi, /openapi|swagger/i) || isReal(mcp, /\{/) || isReal(x402, /\{/) || isReal(plugin, /\{/), weight: 1, fix: "If you have an API, publish /openapi.json or /.well-known/mcp.json" },
      ];
      const score = scoreOf(checks);
      return {
        url, score, grade: grade(score), llmsTxt: checks[0].ok, llmsFullTxt: checks[1].ok, aiBotsBlocked: blocked, serverRendered: checks[4].ok, visibleWords: words,
        manifests: { openapi: isReal(openapi, /openapi|swagger/i), mcp: isReal(mcp, /\{/), x402: isReal(x402, /\{/), aiPlugin: isReal(plugin, /\{/) },
        failed: checks.filter((c) => !c.ok).map(({ check, fix }) => ({ check, fix })), passed: checks.filter((c) => c.ok).map((c) => c.check),
      };
    }),

  svc("page-text", "0.002",
    "Get the plain visible text of a web page (no HTML, scripts or styles), whitespace-normalized, with title and word count. Optional maxChars (1,000-200,000, default 50,000). Fast (1-3 s).",
    ["text", "scrape", "extract", "content", "llm", "reader", "plain-text"],
    { url: "https://example.com/", title: "Example Domain", text: "Example Domain This domain is for use in illustrative examples...", words: 28, truncated: false },
    async (_e, url, body) => {
      const p = await page(url);
      const full = visibleText(p.root);
      const max = Math.min(Math.max(Number(body.maxChars) || 50_000, 1_000), 200_000);
      return { url, finalUrl: p.finalUrl, title: p.root.querySelector("title")?.text.trim() ?? null, text: full.slice(0, max), words: full.split(/\s+/).length, truncated: full.length > max };
    }, { maxChars: { type: "number", description: "Max characters (1000-200000)" } }),

  svc("forms", "0.002",
    "List the forms on a web page: action URL, method, fields (name, type, label, required) and a guess of each form's purpose (login, signup, newsletter, search, contact, payment). Fast (1-3 s).",
    ["forms", "inputs", "scrape", "automation", "lead-capture", "qa", "browser-agent"],
    { url: "https://example.com/", forms: [{ purpose: "newsletter", action: "https://example.com/subscribe", method: "post", fields: [{ name: "email", type: "email", required: true }] }] },
    async (_e, url) => {
      const p = await page(url);
      const forms = p.root.querySelectorAll("form").slice(0, 30).map((f) => {
        const fields = f.querySelectorAll("input, select, textarea").filter((i) => !["hidden", "submit", "button", "image", "reset"].includes((i.getAttribute("type") ?? "").toLowerCase())).map((i) => {
          const id = i.getAttribute("id");
          return {
            name: i.getAttribute("name") ?? id ?? null,
            type: i.tagName === "INPUT" ? i.getAttribute("type") ?? "text" : i.tagName.toLowerCase(),
            label: (id && p.root.querySelector(`label[for="${id}"]`)?.text.trim()) || i.getAttribute("aria-label") || i.getAttribute("placeholder") || null,
            required: i.hasAttribute("required"),
          };
        });
        const sig = (f.toString().toLowerCase().slice(0, 5000));
        const types = fields.map((x) => x.type);
        const purpose = types.includes("password") ? (/confirm|sign ?up|register|create/.test(sig) ? "signup" : "login") : /card|cvc|cvv|iban/.test(sig) ? "payment" : types.includes("search") || /search|q"/.test(sig) ? "search" : types.includes("textarea") || /message/.test(sig) ? "contact" : fields.length <= 2 && types.includes("email") ? "newsletter" : "other";
        return { purpose, action: abs(f.getAttribute("action") ?? "", p.finalUrl), method: (f.getAttribute("method") ?? "get").toLowerCase(), fields };
      });
      return { url, finalUrl: p.finalUrl, count: forms.length, forms };
    }),

  svc("trackers", "0.003",
    "Detect analytics, ad and tracking scripts on a web page (Google Analytics/Tag Manager, Meta Pixel, TikTok, LinkedIn, Hotjar, Clarity, Segment, Mixpanel, HubSpot, Plausible...), cookie-consent tools and all third-party script domains. Fast (1-3 s).",
    ["trackers", "privacy", "gdpr", "analytics", "cookies", "pixels", "compliance"],
    { url: "https://example.com/", trackers: [{ name: "Google Tag Manager", category: "tag-manager" }], consentManager: "OneTrust", thirdPartyDomains: ["googletagmanager.com"] },
    async (_e, url) => {
      const p = await page(url);
      const h = p.html;
      const sig: [string, string, RegExp][] = [
        ["Google Analytics", "analytics", /google-analytics\.com|gtag\(|\bga\(['"]create|G-[A-Z0-9]{6,}/],
        ["Google Tag Manager", "tag-manager", /googletagmanager\.com\/gtm|GTM-[A-Z0-9]{4,}/],
        ["Google Ads", "ads", /googleadservices|doubleclick\.net|AW-\d{6,}/],
        ["Meta Pixel", "ads", /connect\.facebook\.net\/[^"']*fbevents|fbq\(/],
        ["TikTok Pixel", "ads", /analytics\.tiktok\.com|ttq\.load/],
        ["LinkedIn Insight", "ads", /snap\.licdn\.com|_linkedin_partner_id/],
        ["X/Twitter Pixel", "ads", /static\.ads-twitter\.com|twq\(/],
        ["Reddit Pixel", "ads", /redditstatic\.com\/ads|rdt\(/],
        ["Pinterest Tag", "ads", /s\.pinimg\.com\/ct|pintrk\(/],
        ["Microsoft Clarity", "session-replay", /clarity\.ms/],
        ["Hotjar", "session-replay", /static\.hotjar\.com|hjSiteSettings/],
        ["FullStory", "session-replay", /fullstory\.com\/s\/fs\.js|_fs_org/],
        ["Segment", "analytics", /cdn\.segment\.com|analytics\.load\(/],
        ["Mixpanel", "analytics", /cdn\.mxpnl\.com|mixpanel\.init/],
        ["Amplitude", "analytics", /cdn\.amplitude\.com|amplitude\.getInstance/],
        ["PostHog", "analytics", /posthog\.init|i\.posthog\.com/],
        ["Heap", "analytics", /heapanalytics\.com/],
        ["Plausible", "analytics", /plausible\.io\/js/],
        ["Fathom", "analytics", /usefathom\.com/],
        ["Matomo", "analytics", /matomo\.js|piwik\.js|_paq\.push/],
        ["Vercel Analytics", "analytics", /\/_vercel\/insights|va\.vercel-scripts/],
        ["Cloudflare Web Analytics", "analytics", /static\.cloudflareinsights\.com/],
        ["HubSpot", "marketing", /js\.hs-scripts\.com|js\.hs-analytics\.net/],
        ["Intercom", "support", /widget\.intercom\.io|intercomSettings/],
        ["Drift", "support", /js\.driftt\.com/],
        ["Crisp", "support", /client\.crisp\.chat/],
        ["Hubspot Forms", "marketing", /js\.hsforms\.net/],
        ["Klaviyo", "marketing", /static\.klaviyo\.com/],
        ["Sentry", "monitoring", /browser\.sentry-cdn\.com|sentry\.io\/api/],
        ["Datadog RUM", "monitoring", /datadoghq-browser-agent|DD_RUM/],
      ];
      const consent: [string, RegExp][] = [["OneTrust", /cdn\.cookielaw\.org|optanon/i], ["Cookiebot", /consent\.cookiebot\.com/i], ["Didomi", /sdk\.privacy-center\.org|didomi/i], ["Axeptio", /axeptio/i], ["Osano", /osano\.com/i], ["Usercentrics", /usercentrics/i], ["Termly", /termly\.io/i], ["CookieYes", /cookieyes/i], ["Iubenda", /iubenda/i], ["Quantcast Choice", /quantcast\.mgr|cmp\.quantcast/i], ["TrustArc", /trustarc/i], ["Complianz", /complianz/i]];
      const host = registrableDomain(new URL(p.finalUrl).hostname);
      const third = uniq(p.root.querySelectorAll("script[src], iframe[src], img[src]").map((s) => hostOf(abs(s.getAttribute("src"), p.finalUrl) ?? "")).filter((d) => d && registrableDomain(d) !== host)).slice(0, 60);
      const found = sig.filter(([, , re]) => re.test(h)).map(([name, category]) => ({ name, category }));
      return { url, finalUrl: p.finalUrl, trackers: found, consentManager: consent.find(([, re]) => re.test(h))?.[0] ?? null, thirdPartyDomains: third, count: found.length };
    }),

  svc("company-info", "0.005",
    "Company profile from its website in one call: name, description, logo, founding date, address, phones, emails, social profiles and links to about/contact/careers/pricing pages, from structured data and the page. Takes 1-4 s.",
    ["company", "enrichment", "firmographics", "lead-research", "crm", "b2b", "sales"],
    { url: "https://stripe.com/", name: "Stripe", description: "Financial infrastructure for the internet", logo: "https://stripe.com/img/logo.png", emails: [], socials: { x: ["https://twitter.com/stripe"] }, pages: { careers: "https://stripe.com/jobs" } },
    async (_e, url) => {
      const p = await page(url);
      const text = visibleText(p.root);
      const org = jsonLd(p.root).find((x) => typeIs(x, /Organization|Corporation|LocalBusiness|Company|Store|Restaurant/i)) ?? {};
      const addr = [org.address].flat().find((a: any) => a && typeof a === "object");
      return {
        url,
        finalUrl: p.finalUrl,
        domain: registrableDomain(new URL(p.finalUrl).hostname),
        name: org.name ?? meta(p.root, "og:site_name") ?? p.root.querySelector("title")?.text.split(/[|\-–—:]/)[0].trim() ?? null,
        legalName: org.legalName ?? null,
        description: org.description ?? meta(p.root, "description") ?? meta(p.root, "og:description"),
        logo: abs(typeof org.logo === "string" ? org.logo : org.logo?.url, p.finalUrl) ?? abs(meta(p.root, "og:image"), p.finalUrl),
        foundingDate: org.foundingDate ?? null,
        address: addr ? [addr.streetAddress, addr.postalCode, addr.addressLocality, addr.addressRegion, addr.addressCountry?.name ?? addr.addressCountry].filter(Boolean).join(", ") : null,
        emails: uniq([org.email, ...emails(p, text)].filter(Boolean)).slice(0, 15),
        phones: uniq([org.telephone, ...phones(p, text)].filter(Boolean)).slice(0, 10),
        socials: socials([...anchors(p), ...[org.sameAs].flat().filter((s: any) => typeof s === "string").map((href: string) => ({ href }))]),
        pages: keyPages(p),
        language: p.root.querySelector("html")?.getAttribute("lang") ?? null,
      };
    }),

  svc("key-pages", "0.002",
    "Find the important pages of a website from its home page links: about, contact, pricing, careers, blog, docs, login, signup, team, privacy and terms. Saves agents from crawling. Fast (1-3 s).",
    ["navigation", "pages", "crawl", "pricing", "careers", "contact", "browser-agent"],
    { url: "https://stripe.com/", pages: { pricing: "https://stripe.com/pricing", docs: "https://docs.stripe.com/", careers: "https://stripe.com/jobs" } },
    async (_e, url) => {
      const p = await page(url);
      return { url, finalUrl: p.finalUrl, pages: keyPages(p) };
    }),

  svc("page-weight", "0.002",
    "Page performance basics without a browser: time to first byte, HTML size, compression, caching headers, CDN, and counts of scripts, stylesheets, images, fonts and iframes, with inline script/style size. Fast (1-3 s).",
    ["performance", "page-speed", "ttfb", "web-vitals", "cdn", "cache", "audit"],
    { url: "https://example.com/", ttfbMs: 110, htmlKb: 48.2, compression: "br", scripts: 12, stylesheets: 3, images: 20, cacheControl: "max-age=0" },
    async (_e, url) => {
      const p = await page(url);
      const h = p.headers;
      const inlineJs = p.root.querySelectorAll("script:not([src])").reduce((s, x) => s + x.text.length, 0);
      const inlineCss = p.root.querySelectorAll("style").reduce((s, x) => s + x.text.length, 0);
      const cdn = h.get("cf-ray") ? "Cloudflare" : h.get("x-vercel-id") ? "Vercel" : h.get("x-amz-cf-id") ? "CloudFront" : h.get("x-served-by")?.includes("cache") ? "Fastly" : h.get("x-nf-request-id") ? "Netlify" : /akamai/i.test(h.get("server") ?? "") ? "Akamai" : h.get("x-github-request-id") ? "GitHub Pages" : null;
      return {
        url,
        finalUrl: p.finalUrl,
        ttfbMs: p.ms,
        htmlKb: Math.round(p.bytes / 102.4) / 10,
        compression: h.get("content-encoding") ?? "none (or decoded by edge)",
        cacheControl: h.get("cache-control"),
        cdn,
        http: { server: h.get("server"), age: h.get("age") },
        scripts: p.root.querySelectorAll("script[src]").length,
        asyncOrDeferScripts: p.root.querySelectorAll("script[src][async], script[src][defer], script[type=module]").length,
        stylesheets: p.root.querySelectorAll('link[rel="stylesheet"]').length,
        images: p.root.querySelectorAll("img").length,
        lazyImages: p.root.querySelectorAll('img[loading="lazy"]').length,
        fonts: p.root.querySelectorAll('link[rel="preload"][as="font"], link[href*="fonts.googleapis"]').length,
        iframes: p.root.querySelectorAll("iframe").length,
        inlineScriptKb: Math.round(inlineJs / 102.4) / 10,
        inlineStyleKb: Math.round(inlineCss / 102.4) / 10,
        domElements: p.root.querySelectorAll("*").length,
      };
    }),

  svc("wayback", "0.002",
    "Internet Archive history of a website: first and latest Wayback Machine snapshot (date and link) and how long the site has existed online. Useful for trust checks and research. Takes 1-5 s.",
    ["wayback-machine", "archive", "history", "domain-age", "trust", "research", "osint"],
    { host: "stripe.com", first: { date: "2010-09-29", url: "https://web.archive.org/web/20100929.../stripe.com" }, last: { date: "2026-11-19", url: "https://web.archive.org/web/..." }, ageDays: 5895 },
    async (_e, url) => {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return { host, ...(await wayback(host)) };
    }),

  // ---------- crypto: the bridge to where agent money is ----------
  {
    def: {
      path: "/api/crypto-site-check",
      priceUsd: "0.02",
      description:
        "Due-diligence check of a crypto project's website before you buy or interact: domain age (RDAP) and first archive date, HTTPS/security, socials (X, Telegram, Discord, GitHub), docs/whitepaper, team page, audit firms mentioned, contract addresses on the page (optionally verifies yours), scam phrases and wallet-drainer signals (seed-phrase inputs), template/free-hosting signs. Returns a 0-100 trust score, red and green flags. Heuristics, not financial advice. Takes 3-8 s.",
      tags: ["crypto", "token", "scam-check", "rug-pull", "due-diligence", "web3", "defi", "trust-score", "memecoin"],
      inputExample: { url: "https://uniswap.org", contract: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Project website (public http(s) URL)" },
          contract: { type: "string", description: "Optional token contract address to verify it is published on the site" },
        },
        required: ["url"],
      },
      outputExample: {
        url: "https://uniswap.org/", score: 86, verdict: "low risk signals", domainAgeDays: 2400, firstArchived: "2018-11-02",
        socials: { x: ["https://x.com/Uniswap"], github: ["https://github.com/Uniswap"] }, auditsMentioned: ["openzeppelin"],
        contractsOnPage: [], contractListed: null, redFlags: [], greenFlags: ["Domain older than 1 year", "GitHub linked"],
      },
      outputSchema: { type: "object", properties: { score: { type: "number" }, verdict: { type: "string" }, redFlags: { type: "array" }, greenFlags: { type: "array" } }, required: ["score", "verdict"] },
    },
    run: async (_e, url, body) => {
      let p: Page;
      try {
        p = await page(url);
      } catch (e) {
        // Bot-protected sites (403/503 challenge): still answer from domain registration and archive history.
        const host = new URL(url).hostname;
        const domain = registrableDomain(host);
        const [who, wb] = await Promise.all([rdap(domain), wayback(host.replace(/^www\./, ""))]);
        if (!who && !wb.first) throw e;
        const age = who?.ageDays ?? wb.ageDays;
        const red = [`Website could not be read (${(e as Error).message}); result based on domain and archive history only`];
        const green: string[] = [];
        let score = 50;
        if (age !== null && age < 30) { score -= 25; red.push(`Domain is only ${age} days old`); }
        else if (age !== null && age < 180) { score -= 10; red.push(`Domain is ${age} days old (under 6 months)`); }
        else if (age !== null && age > 365) { score += age > 1095 ? 15 : 8; green.push(`Domain older than ${age > 1095 ? "3 years" : "1 year"} (${age} days)`); }
        return {
          url, partial: true, score, verdict: score < 35 ? "high risk signals" : score < 65 ? "mixed signals" : "low risk signals",
          domain, domainAgeDays: age, domainCreated: who?.created ?? null, registrar: who?.registrar ?? null, firstArchived: wb.first?.date ?? null,
          redFlags: red, greenFlags: green,
          disclaimer: "Automated heuristics from public data only. Not financial advice; does not analyze the token contract or liquidity.",
        };
      }
      const host = new URL(p.finalUrl).hostname;
      const domain = registrableDomain(host);
      const [who, wb] = await Promise.all([rdap(domain), wayback(host.replace(/^www\./, ""))]);
      const text = visibleText(p.root);
      const lower = text.toLowerCase();
      const links = anchors(p);
      // JS-rendered apps show no links in HTML: also read URLs embedded in the raw page code and meta tags.
      const rawUrls = uniq((p.html.match(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|t\.me|discord\.gg|discord\.com\/invite|github\.com|medium\.com|warpcast\.com)\/[A-Za-z0-9_@./-]{2,60}/g) ?? []).map((u) => u.replace(/[.\/]+$/, "")));
      const twSite = meta(p.root, "twitter:site")?.replace(/^@/, "");
      const soc = socials([...links, ...rawUrls.map((href) => ({ href })), ...(twSite ? [{ href: `https://x.com/${twSite}` }] : [])]);
      const scriptCount = p.root.querySelectorAll("script[src]").length;
      const kp = keyPages(p);
      const docs = links.find((a) => /whitepaper|litepaper|gitbook|docs\.|\/docs|documentation/i.test(a.href + " " + a.text))?.href
        ?? p.html.match(/https?:\/\/[a-z0-9.-]*(?:gitbook\.io|docs\.[a-z0-9.-]+)[^"'\s<>]*/i)?.[0] ?? null;
      const audits = uniq([...(text.match(new RegExp(AUDITORS.source, "gi")) ?? []), ...links.filter((a) => AUDITORS.test(a.href)).map((a) => a.href.match(AUDITORS)?.[0] ?? "")].map((s) => s.toLowerCase()).filter(Boolean));
      const evm = uniq((p.html.match(EVM_ADDR) ?? []).map((a) => a.toLowerCase())).filter((a) => !/^0x0{40}$/.test(a)).slice(0, 10);
      const sol = uniq([...text.matchAll(/(?:contract|address|\bca\b|mint|token)[^A-Za-z0-9]{0,20}([1-9A-HJ-NP-Za-km-z]{32,44})/gi)].map((m) => m[1])).filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).slice(0, 5);
      const contract = typeof body.contract === "string" ? body.contract.trim() : "";
      const contractListed = contract ? (p.html.toLowerCase().includes(contract.toLowerCase()) || text.includes(contract)) : null;
      const seedInput = p.root.querySelectorAll("input, textarea").some((i) => /seed|mnemonic|recovery|secret phrase|private key|12 words|24 words/i.test(`${i.getAttribute("name") ?? ""} ${i.getAttribute("placeholder") ?? ""} ${i.getAttribute("id") ?? ""} ${i.getAttribute("aria-label") ?? ""}`));
      const scam = uniq((text.match(new RegExp(SCAM_PHRASES.source, "gi")) ?? []).map((s) => s.toLowerCase())).slice(0, 8);
      const freeHost = /\.(vercel\.app|netlify\.app|github\.io|pages\.dev|carrd\.co|webflow\.io|framer\.website|framer\.app|wixsite\.com|weebly\.com|square\.site|godaddysites\.com|replit\.app|glitch\.me|firebaseapp\.com|web\.app|onrender\.com)$/i.test(host);
      const template = /lorem ipsum|your token name|token name here|\$ticker|coming soon\s*coming soon|insert (text|contract)/i.test(lower);
      const words = text.split(/\s+/).filter(Boolean).length;
      const jsRendered = words < 80 && (scriptCount >= 1 || /id=["'](root|app|__next|__nuxt|svelte)["']/i.test(p.html));
      const age = who?.ageDays ?? wb.ageDays;

      const red: string[] = [];
      const green: string[] = [];
      let score = 50;
      const add = (pts: number, msg: string) => { score += pts; (pts >= 0 ? green : red).push(msg); };
      if (seedInput) add(-60, "Page has a seed phrase / private key input: classic wallet-drainer phishing");
      if (scam.length) add(-8 * Math.min(scam.length, 3), `Scam-style phrases: ${scam.join(", ")}`);
      if (age === null) red.push("Domain age unknown");
      else if (age < 30) add(-25, `Domain is only ${age} days old`);
      else if (age < 180) add(-10, `Domain is ${age} days old (under 6 months)`);
      else if (age > 365) add(age > 1095 ? 15 : 8, `Domain older than ${age > 1095 ? "3 years" : "1 year"} (${age} days)`);
      if (!p.finalUrl.startsWith("https:")) add(-10, "No HTTPS");
      if (freeHost) add(-10, `Hosted on a free subdomain (${host})`);
      if (template) add(-10, "Template/placeholder text left on the page");
      if (jsRendered) red.push("Page renders with JavaScript only: content, team and docs could not be read (score relies on domain, archive and code signals)");
      else if (words < 150) add(-5, `Very little content (${words} words)`);
      if (soc.x) add(4, "X/Twitter linked");
      if (soc.telegram || soc.discord) add(3, "Community channel linked (Telegram/Discord)");
      if (soc.github) add(8, "GitHub linked");
      if (!soc.x && !soc.telegram && !soc.discord) add(jsRendered ? -3 : -8, "No X, Telegram or Discord linked");
      if (docs) add(6, "Docs or whitepaper linked");
      if (kp.team || kp.about || /\bteam\b|founder|co-founder/i.test(lower)) add(4, "Team/about information present"); else if (!jsRendered) red.push("No team or about information");
      if (audits.length) add(6, `Audit firm mentioned: ${audits.join(", ")}`);
      if (kp.privacy || kp.terms) add(2, "Legal pages (privacy/terms)");
      if (contract) contractListed ? add(8, "Your contract address is published on the site") : add(-15, "Your contract address does NOT appear on the site");
      if (evm.length > 3) red.push(`${evm.length} different EVM addresses on the page: check which one is the real token`);
      score = Math.max(0, Math.min(100, score));

      return {
        url,
        finalUrl: p.finalUrl,
        score,
        verdict: seedInput || score < 35 ? "high risk signals" : score < 65 ? "mixed signals" : "low risk signals",
        domain,
        domainAgeDays: age,
        domainCreated: who?.created ?? null,
        registrar: who?.registrar ?? null,
        firstArchived: wb.first?.date ?? null,
        https: p.finalUrl.startsWith("https:"),
        jsRendered,
        socials: soc,
        docs,
        teamPage: kp.team ?? kp.about ?? null,
        auditsMentioned: audits,
        contractsOnPage: { evm, solana: sol },
        contractListed,
        seedPhraseInput: seedInput,
        scamPhrases: scam,
        freeHosting: freeHost,
        redFlags: red,
        greenFlags: green,
        disclaimer: "Automated heuristics from the public website only. Not financial advice; does not analyze the token contract or liquidity.",
      };
    },
  },
  TOKEN_CHECK,
];
