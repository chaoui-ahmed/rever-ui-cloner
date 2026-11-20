// HTML-based services (no screenshot, no AI): page metadata, page → markdown, brand kit.
// Not a route.
import { parse, HTMLElement, TextNode, type Node } from "node-html-parser";
import { type Env, validateTargetUrl } from "./_shared";
import { UpstreamError } from "./_services";

const UA = "Mozilla/5.0 (compatible; ReverBot/1.0; +https://www.aypiai.online)";
const MAX_HTML = 2_000_000;

async function fetchHtml(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
  if (!res.ok) throw new UpstreamError(`Site answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|xml/i.test(type)) throw new UpstreamError(`Not an HTML page (${type})`);
  const html = (await res.text()).slice(0, MAX_HTML);
  return { html, finalUrl: res.url || url, root: parse(html, { comment: false }) };
}

const abs = (href: string | undefined | null, base: string) => {
  if (!href) return null;
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return null;
  }
};

const meta = (root: HTMLElement, key: string) =>
  root.querySelector(`meta[property="${key}"]`)?.getAttribute("content") ??
  root.querySelector(`meta[name="${key}"]`)?.getAttribute("content") ??
  null;

// ---------- 1. Page metadata ----------

export async function pageMeta(_env: Env, url: string, _body?: Record<string, unknown>) {
  const { root, finalUrl } = await fetchHtml(url);
  const icons = root.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]')
    .map((l) => ({ rel: l.getAttribute("rel"), sizes: l.getAttribute("sizes") ?? null, href: abs(l.getAttribute("href"), finalUrl) }))
    .filter((i) => i.href);
  const jsonLdTypes = root.querySelectorAll('script[type="application/ld+json"]').flatMap((s) => {
    try {
      const d = JSON.parse(s.text);
      const items = Array.isArray(d) ? d : d["@graph"] ?? [d];
      return items.map((x: any) => x?.["@type"]).flat().filter(Boolean);
    } catch {
      return [];
    }
  });
  const host = new URL(finalUrl).host;
  const links = root.querySelectorAll("a[href]").map((a) => abs(a.getAttribute("href"), finalUrl)).filter(Boolean) as string[];
  const internal = links.filter((l) => { try { return new URL(l).host === host; } catch { return false; } });

  return {
    url,
    finalUrl,
    title: root.querySelector("title")?.text.trim() || null,
    description: meta(root, "description"),
    canonical: abs(root.querySelector('link[rel="canonical"]')?.getAttribute("href"), finalUrl),
    lang: root.querySelector("html")?.getAttribute("lang") ?? null,
    robots: meta(root, "robots"),
    themeColor: meta(root, "theme-color"),
    openGraph: {
      title: meta(root, "og:title"),
      description: meta(root, "og:description"),
      image: abs(meta(root, "og:image"), finalUrl),
      type: meta(root, "og:type"),
      siteName: meta(root, "og:site_name"),
    },
    twitter: { card: meta(root, "twitter:card"), site: meta(root, "twitter:site"), image: abs(meta(root, "twitter:image"), finalUrl) },
    icons,
    feeds: root.querySelectorAll('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]').map((l) => abs(l.getAttribute("href"), finalUrl)),
    jsonLdTypes: [...new Set(jsonLdTypes)],
    headings: { h1: root.querySelectorAll("h1").map((h) => h.text.trim()).filter(Boolean).slice(0, 5), h2Count: root.querySelectorAll("h2").length },
    links: { total: links.length, internal: internal.length, external: links.length - internal.length },
    images: root.querySelectorAll("img").length,
    wordCount: root.querySelector("body")?.text.split(/\s+/).filter(Boolean).length ?? 0,
  };
}

// ---------- 2. Page → Markdown ----------

const DROP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "form", "button", "select", "input", "textarea", "nav", "footer", "aside", "header"]);

function toMarkdown(node: Node, base: string, listDepth = 0): string {
  if (node instanceof TextNode) return node.text.replace(/\s+/g, " ");
  if (!(node instanceof HTMLElement)) return "";
  const tag = node.tagName?.toLowerCase() ?? "";
  if (DROP.has(tag)) return "";
  if (/(^|\s)(cookie|consent|newsletter|modal|popup|sr-only)(\s|$)/i.test(node.getAttribute("class") ?? "")) return "";
  const kids = () => node.childNodes.map((c) => toMarkdown(c, base, listDepth)).join("");
  switch (tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const t = kids().trim();
      return t ? `\n\n${"#".repeat(Number(tag[1]))} ${t}\n\n` : "";
    }
    case "p": case "section": case "article": case "main": case "div": {
      const t = kids();
      return t.trim() ? `\n\n${t.trim()}\n\n` : "";
    }
    case "br": return "\n";
    case "hr": return "\n\n---\n\n";
    case "strong": case "b": { const t = kids().trim(); return t ? `**${t}**` : ""; }
    case "em": case "i": { const t = kids().trim(); return t ? `*${t}*` : ""; }
    case "code": return node.parentNode?.tagName?.toLowerCase() === "pre" ? kids() : `\`${node.text}\``;
    case "pre": return `\n\n\`\`\`\n${node.text.replace(/\n+$/, "")}\n\`\`\`\n\n`;
    case "blockquote": return `\n\n${kids().trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
    case "a": {
      const t = kids().trim();
      const href = abs(node.getAttribute("href"), base);
      return t && href && !href.startsWith("javascript:") ? `[${t}](${href})` : t;
    }
    case "img": {
      const alt = (node.getAttribute("alt") ?? "").trim();
      const src = abs(node.getAttribute("src"), base);
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "ul": case "ol": {
      const items = node.childNodes.filter((c) => c instanceof HTMLElement && c.tagName?.toLowerCase() === "li") as HTMLElement[];
      const lines = items.map((li, i) => {
        const t = li.childNodes.map((c) => toMarkdown(c, base, listDepth + 1)).join("").trim().replace(/\n{2,}/g, "\n");
        return t ? `${"  ".repeat(listDepth)}${tag === "ol" ? `${i + 1}.` : "-"} ${t}` : "";
      }).filter(Boolean);
      return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
    }
    case "table": {
      const rows = node.querySelectorAll("tr").map((tr) => tr.querySelectorAll("th,td").map((c) => c.text.trim().replace(/\|/g, "\\|").replace(/\s+/g, " ")));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const fmt = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
      return `\n\n${fmt(rows[0])}\n| ${Array(width).fill("---").join(" | ")} |\n${rows.slice(1).map(fmt).join("\n")}\n\n`;
    }
    default: return kids();
  }
}

export async function pageMarkdown(_env: Env, url: string, body: Record<string, unknown>) {
  const { root, finalUrl } = await fetchHtml(url);
  const scope = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  let markdown = toMarkdown(scope, finalUrl).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const maxChars = Math.min(Math.max(Number(body.maxChars) || 50_000, 1_000), 200_000);
  const truncated = markdown.length > maxChars;
  if (truncated) markdown = markdown.slice(0, maxChars);
  return {
    url,
    finalUrl,
    title: root.querySelector("title")?.text.trim() || null,
    markdown,
    chars: markdown.length,
    truncated,
  };
}

// ---------- 3. Brand kit ----------

const HEX = /#(?:[0-9a-f]{3}){1,2}\b/gi;
const GENERIC_FONTS = new Set(["sans-serif", "serif", "monospace", "system-ui", "inherit", "initial", "unset", "cursive", "fantasy", "ui-sans-serif", "ui-serif", "ui-monospace", "-apple-system", "blinkmacsystemfont", "segoe ui", "roboto", "helvetica", "helvetica neue", "arial", "apple color emoji", "segoe ui emoji", "segoe ui symbol", "noto color emoji", "var"]);

const normHex = (h: string) => {
  let x = h.toLowerCase();
  if (x.length === 4) x = "#" + x.slice(1).split("").map((c) => c + c).join("");
  return x;
};

function analyzeCss(css: string) {
  const colors = new Map<string, number>();
  for (const m of css.match(HEX) ?? []) {
    const h = normHex(m);
    colors.set(h, (colors.get(h) ?? 0) + 1);
  }
  const fonts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const f of m[1].split(",")) {
      const name = f.trim().replace(/^['"]|['"]$/g, "").replace(/!important/, "").trim();
      if (name && !GENERIC_FONTS.has(name.toLowerCase()) && !name.startsWith("var(") && name.length < 60) fonts.set(name, (fonts.get(name) ?? 0) + 1);
    }
  }
  const fontFaces = [...css.matchAll(/@font-face\s*{[^}]*font-family\s*:\s*['"]?([^;'"}]+)/gi)].map((m) => m[1].trim());
  const vars: Record<string, string> = {};
  for (const m of css.matchAll(/--([a-z0-9-]*(?:primary|secondary|accent|brand|background|foreground|text|muted|border)[a-z0-9-]*)\s*:\s*([^;}]+)/gi)) {
    if (Object.keys(vars).length < 40 && !(m[1] in vars)) vars[m[1]] = m[2].trim();
  }
  return { colors, fonts, fontFaces, vars };
}

export async function brandKit(_env: Env, url: string, _body?: Record<string, unknown>) {
  const { root, html, finalUrl } = await fetchHtml(url);
  const origin = new URL(finalUrl).origin;

  // Logo candidates, best first. Only the site's own header/nav/home link counts:
  // logo walls further down the page show customers' logos, not the site's.
  const logos: { url: string; source: string }[] = [];
  const push = (u: string | null, source: string) => { if (u && !logos.some((l) => l.url === u)) logos.push({ url: u, source }); };
  const headerScopes = root.querySelectorAll("header, nav, [role=banner], a[href='/'], a[href='" + origin + "'], a[href='" + origin + "/']");
  let logoSvg: string | null = null;
  for (const scope of headerScopes.slice(0, 6)) {
    for (const img of scope.querySelectorAll("img").slice(0, 3)) {
      const hint = `${img.getAttribute("class") ?? ""} ${img.getAttribute("alt") ?? ""} ${img.getAttribute("src") ?? ""} ${img.getAttribute("id") ?? ""}`;
      const inHomeLink = scope.tagName?.toLowerCase() === "a" || !!img.closest("a[href='/']");
      if (/logo|brand|wordmark|home/i.test(hint) || inHomeLink) push(abs(img.getAttribute("src"), finalUrl), "header img");
    }
    if (!logoSvg) {
      const svg = (scope.tagName?.toLowerCase() === "a" ? scope : scope.querySelector("a[href='/']") ?? scope).querySelector("svg");
      const markup = svg?.toString();
      if (markup && markup.length < 20_000 && /<path|<use|<g/i.test(markup)) logoSvg = markup;
    }
  }
  const jsonLdLogo = html.match(/"logo"\s*:\s*(?:{[^}]*"url"\s*:\s*)?"([^"]+)"/)?.[1];
  push(abs(jsonLdLogo, finalUrl), "json-ld");
  push(abs(root.querySelector('link[rel~="icon"][type="image/svg+xml"]')?.getAttribute("href"), finalUrl), "svg icon");
  push(abs(root.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"), finalUrl), "apple-touch-icon");
  push(abs(meta(root, "og:image"), finalUrl), "og:image");
  const favicon = abs(root.querySelector('link[rel~="icon"], link[rel="shortcut icon"]')?.getAttribute("href"), finalUrl) ?? `${origin}/favicon.ico`;

  // CSS: inline <style> + up to 4 same-site / CDN stylesheets
  let css = root.querySelectorAll("style").map((s) => s.text).join("\n");
  css += "\n" + root.querySelectorAll("[style]").map((e) => e.getAttribute("style")).join(";\n");
  const sheets = root.querySelectorAll('link[rel="stylesheet"]').map((l) => abs(l.getAttribute("href"), finalUrl)).filter(Boolean).slice(0, 4) as string[];
  const fetched = await Promise.all(sheets.map(async (s) => {
    try {
      if (!validateTargetUrl(s)) return "";
      const r = await fetch(s, { headers: { "User-Agent": UA } });
      return r.ok ? (await r.text()).slice(0, 800_000) : "";
    } catch {
      return "";
    }
  }));
  css += "\n" + fetched.join("\n");
  const { colors, fonts, fontFaces, vars } = analyzeCss(css);

  const googleFonts = root.querySelectorAll('link[href*="fonts.googleapis.com"]').flatMap((l) =>
    [...(l.getAttribute("href") ?? "").matchAll(/family=([^:&]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ")));

  const palette = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex, count]) => ({ hex, count }));
  const fontList = [...new Set([...googleFonts, ...fontFaces, ...[...fonts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)])].slice(0, 6);

  return {
    url,
    finalUrl,
    name: meta(root, "og:site_name") ?? root.querySelector("title")?.text.split(/[|\-–—:]/)[0].trim() ?? new URL(finalUrl).hostname,
    logo: logos[0]?.url ?? null,
    logoSource: logos[0]?.source ?? null,
    logoSvg,
    logoCandidates: logos.slice(0, 5),
    favicon,
    themeColor: meta(root, "theme-color"),
    colors: palette,
    cssVariables: vars,
    fonts: fontList,
    stylesheetsAnalyzed: sheets.length,
    note: palette.length === 0 ? "No CSS colors found (styles may be injected by JavaScript). Use /api/design-tokens for a visual analysis." : undefined,
  };
}
