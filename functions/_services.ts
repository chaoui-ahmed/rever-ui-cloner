// The paid services and their x402 route definitions. Not a route (no onRequest export).
import { type Env, arrayBufferToBase64 } from "./_shared";

export class UpstreamError extends Error {}

type Shot = { imageUrl: string; base64: string; bytes: number };

/** Viewport screenshot via ScreenshotAPI, capped so Claude accepts it (≤8000 px, ≤5 MB). */
export async function takeScreenshot(env: Env, url: string, opts: { width?: number; height?: number; fullPage?: boolean } = {}): Promise<Shot> {
  const params = new URLSearchParams({
    token: env.SCREENSHOT_API_KEY, url, output: "json", file_type: "jpeg", wait_for_event: "load",
    full_page: opts.fullPage ? "true" : "false",
    width: String(opts.width ?? 1280),
    height: String(opts.height ?? 3200),
  });
  const shotRes = await fetch(`https://shot.screenshotapi.net/screenshot?${params}`);
  const shot = shotRes.ok ? ((await shotRes.json()) as { screenshot?: string }) : null;
  if (!shot?.screenshot) throw new UpstreamError("Screenshot failed");

  const imgRes = await fetch(shot.screenshot);
  if (!imgRes.ok) throw new UpstreamError("Screenshot download failed");
  const buf = await imgRes.arrayBuffer();
  if (buf.byteLength > 5 * 1024 * 1024) throw new UpstreamError("Screenshot too large");
  return { imageUrl: shot.screenshot, base64: arrayBufferToBase64(buf), bytes: buf.byteLength };
}

async function askClaude(env: Env, system: string, imageBase64: string, text: string, maxTokens = 4096) {
  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: maxTokens,
      system,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
          { type: "text", text },
        ],
      }],
    }),
  });
  const ai = (await aiRes.json()) as { content?: { text?: string }[]; error?: { message?: string } };
  const out = ai?.content?.[0]?.text;
  if (!aiRes.ok || !out) throw new UpstreamError(`Model error: ${ai?.error?.message ?? aiRes.status}`);
  return out;
}

// ---------- 1. UI prompt ----------

export async function generateUiPrompt(env: Env, url: string) {
  const shot = await takeScreenshot(env, url);
  const prompt = await askClaude(
    env,
    "You are an expert UI/UX reverse-engineer. Given a screenshot of a website, produce a detailed, actionable prompt that a developer could paste into Lovable or v0 to recreate the UI faithfully. Return ONLY the prompt text.",
    shot.base64,
    "Reverse-engineer this UI.",
  );
  return { prompt, url };
}

// ---------- 2. Design tokens ----------

const TOKENS_SYSTEM = `You extract design tokens from a website screenshot. Reply with ONLY a JSON object, no prose, no code fences, matching:
{"colors":[{"hex":"#RRGGBB","role":"background|surface|text|muted-text|primary|secondary|accent|border|success|warning|danger","usage":"short note"}],
 "typography":{"headingFont":"best guess family + generic fallback","bodyFont":"...","monoFont":"... or null","scale":[{"element":"h1|h2|h3|body|small|button","sizePx":0,"weight":0,"lineHeight":0}]},
 "spacing":{"baseUnitPx":0,"scalePx":[0]},
 "radii":{"smallPx":0,"mediumPx":0,"largePx":0,"pill":true},
 "shadows":["css box-shadow values"],
 "mode":"light|dark",
 "style":"3-8 word description of the visual style",
 "tailwind":{"theme":{"extend":{"colors":{},"fontFamily":{},"borderRadius":{}}}}}
Use the actual colors you see (sample them carefully). 6-12 colors. Numbers are estimates from the screenshot.`;

export async function extractDesignTokens(env: Env, url: string) {
  const shot = await takeScreenshot(env, url, { height: 2400 });
  const raw = await askClaude(env, TOKENS_SYSTEM, shot.base64, "Extract the design tokens of this website.", 2500);
  const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let tokens: unknown;
  try {
    tokens = JSON.parse(jsonText);
  } catch {
    throw new UpstreamError("Model returned invalid JSON");
  }
  return { url, tokens };
}

// ---------- 3. Screenshot ----------

export async function screenshotService(env: Env, url: string, body: Record<string, unknown>) {
  const width = Math.min(Math.max(Number(body.width) || 1280, 320), 2560);
  const fullPage = body.fullPage === true;
  const height = Math.min(Math.max(Number(body.height) || 900, 300), 8000);
  const shot = await takeScreenshot(env, url, { width, height, fullPage });
  return {
    url,
    image: `data:image/jpeg;base64,${shot.base64}`,
    imageUrl: shot.imageUrl,
    format: "jpeg",
    width,
    fullPage,
    bytes: shot.bytes,
  };
}

// ---------- 4. Tech stack (no AI: headers + HTML fingerprints) ----------

type Sig = { name: string; category: string; html?: RegExp; header?: [string, RegExp]; cookie?: RegExp };
const SIGNATURES: Sig[] = [
  // Frameworks
  { name: "Next.js", category: "framework", html: /\/_next\/static|__NEXT_DATA__|next-route-announcer/ },
  { name: "Nuxt", category: "framework", html: /\/_nuxt\/|__NUXT__|window\.__NUXT/ },
  { name: "Remix", category: "framework", html: /__remixContext|__remixManifest/ },
  { name: "Astro", category: "framework", html: /astro-island|\/_astro\// },
  { name: "SvelteKit", category: "framework", html: /__sveltekit|\/_app\/immutable\// },
  { name: "Gatsby", category: "framework", html: /___gatsby|\/page-data\// },
  { name: "Angular", category: "framework", html: /ng-version=|ng-app/ },
  { name: "Vue", category: "framework", html: /data-v-[0-9a-f]{8}|__vue_app__/ },
  { name: "React", category: "framework", html: /data-reactroot|react-dom|__REACT_DEVTOOLS|_reactListening/ },
  { name: "Vite", category: "build", html: /\/assets\/index-[A-Za-z0-9_-]{8}\.js|type="module" crossorigin src="\/assets\// },
  { name: "WordPress", category: "cms", html: /wp-content\/|wp-includes\// },
  { name: "Shopify", category: "ecommerce", html: /cdn\.shopify\.com|Shopify\.theme/ },
  { name: "Webflow", category: "site-builder", html: /webflow\.com|data-wf-page/ },
  { name: "Framer", category: "site-builder", html: /framerusercontent\.com|__framer/ },
  { name: "Wix", category: "site-builder", html: /static\.wixstatic\.com|wix-bolt/ },
  { name: "Squarespace", category: "site-builder", html: /static1\.squarespace\.com|Squarespace\./ },
  { name: "Lovable", category: "site-builder", html: /lovable\.app|gptengineer|lovable-tagger/ },
  { name: "Ghost", category: "cms", html: /ghost-(?:portal|sdk)|content="Ghost/ },
  // Styling
  { name: "Bootstrap", category: "css", html: /bootstrap(?:\.min)?\.(?:css|js)|class="[^"]*\b(?:container-fluid|col-md-\d|btn-primary)\b/ },
  // Hosting / CDN
  { name: "Vercel", category: "hosting", header: ["x-vercel-id", /./] },
  { name: "Netlify", category: "hosting", header: ["x-nf-request-id", /./] },
  { name: "Cloudflare", category: "cdn", header: ["cf-ray", /./] },
  { name: "Fastly", category: "cdn", header: ["x-served-by", /cache-/] },
  { name: "Amazon CloudFront", category: "cdn", header: ["x-amz-cf-id", /./] },
  { name: "GitHub Pages", category: "hosting", header: ["server", /GitHub\.com/i] },
  { name: "Nginx", category: "server", header: ["server", /nginx/i] },
  { name: "Apache", category: "server", header: ["server", /apache/i] },
  // Analytics & tools
  { name: "Google Analytics", category: "analytics", html: /googletagmanager\.com\/gtag|google-analytics\.com\/(?:analytics|ga)\.js/ },
  { name: "Google Tag Manager", category: "analytics", html: /googletagmanager\.com\/gtm\.js/ },
  { name: "Plausible", category: "analytics", html: /plausible\.io\/js/ },
  { name: "PostHog", category: "analytics", html: /posthog/ },
  { name: "Segment", category: "analytics", html: /cdn\.segment\.com/ },
  { name: "Mixpanel", category: "analytics", html: /cdn\.mxpnl\.com|mixpanel/ },
  { name: "Hotjar", category: "analytics", html: /static\.hotjar\.com/ },
  { name: "Vercel Analytics", category: "analytics", html: /\/_vercel\/insights|va\.vercel-scripts\.com/ },
  { name: "Intercom", category: "support", html: /widget\.intercom\.io|intercomSettings/ },
  { name: "Crisp", category: "support", html: /client\.crisp\.chat/ },
  { name: "Stripe", category: "payments", html: /js\.stripe\.com/ },
  { name: "Paddle", category: "payments", html: /cdn\.paddle\.com/ },
  { name: "Sentry", category: "monitoring", html: /browser\.sentry-cdn\.com|sentry\.io/ },
  { name: "Cloudflare Turnstile", category: "security", html: /challenges\.cloudflare\.com\/turnstile/ },
  { name: "reCAPTCHA", category: "security", html: /google\.com\/recaptcha/ },
  { name: "Supabase", category: "backend", html: /supabase\.co/ },
  { name: "Firebase", category: "backend", html: /firebaseapp\.com|firebase(?:-app)?\.js/ },
  { name: "Clerk", category: "auth", html: /clerk\.(?:com|dev|accounts)/ },
  { name: "Auth0", category: "auth", html: /auth0\.com/ },
];

export async function detectTechStack(_env: Env, url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ReverBot/1.0; +https://www.aypiai.online)", Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok && res.status !== 403) throw new UpstreamError(`Site answered ${res.status}`);
  const html = (await res.text()).slice(0, 1_500_000);
  const found: { name: string; category: string; evidence: string }[] = [];
  for (const s of SIGNATURES) {
    if (s.header) {
      const v = res.headers.get(s.header[0]);
      if (v && s.header[1].test(v)) found.push({ name: s.name, category: s.category, evidence: `header ${s.header[0]}` });
    } else if (s.html?.test(html)) {
      found.push({ name: s.name, category: s.category, evidence: "html" });
    }
  }
  // Tailwind: many distinct utility classes, including palette shades and spacing scale
  const tw = new Set(html.match(/\b(?:(?:bg|text|border|from|to|ring)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|(?:p|px|py|pt|pb|m|mx|my|mt|mb|gap|space-[xy])-\d{1,2}(?:\.5)?|(?:sm|md|lg|xl):[a-z-]+-?\w*)\b/g) ?? []);
  if (tw.size >= 12) found.push({ name: "Tailwind CSS", category: "css", evidence: `${tw.size} utility classes` });

  const generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1];
  const title = html.match(/<title[^>]*>([^<]{0,200})/i)?.[1]?.trim();
  return {
    url,
    finalUrl: res.url,
    status: res.status,
    title: title ?? null,
    generator: generator ?? null,
    technologies: found,
    note: res.status === 403 ? "Site blocked automated access; results may be partial." : undefined,
  };
}

// ---------- x402 route catalog ----------

const urlInputSchema = {
  type: "object",
  properties: { url: { type: "string", description: "Public http(s) URL" } },
  required: ["url"],
};

export type ServiceDef = {
  path: string;
  priceUsd: string;
  description: string;
  tags: string[];
  inputExample: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputExample: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
};

export const SERVICES: ServiceDef[] = [
  {
    path: "/api/generate-prompt",
    priceUsd: "0.25",
    description:
      "Turn any public website URL into a detailed prompt (layout, components, colors, typography, spacing) for recreating its UI with a code model such as Lovable, v0, Claude or Cursor. Returns text, not code. Takes 10-30 s.",
    tags: ["ui", "design", "website", "clone", "prompt", "screenshot", "frontend"],
    inputExample: { url: "https://stripe.com" },
    inputSchema: urlInputSchema,
    outputExample: { prompt: "Build a landing page with a sticky dark header, ...", url: "https://stripe.com/" },
    outputSchema: { type: "object", properties: { prompt: { type: "string" }, url: { type: "string" } }, required: ["prompt", "url"] },
  },
  {
    path: "/api/design-tokens",
    priceUsd: "0.05",
    description:
      "Extract a website's design tokens as JSON: color palette with roles (hex), fonts and type scale, spacing, border radii, shadows, light/dark mode, and a ready-to-use Tailwind theme extension. Takes 5-20 s.",
    tags: ["design-tokens", "colors", "palette", "fonts", "typography", "tailwind", "branding", "design"],
    inputExample: { url: "https://linear.app" },
    inputSchema: urlInputSchema,
    outputExample: { url: "https://linear.app/", tokens: { colors: [{ hex: "#08090A", role: "background", usage: "page" }], typography: { headingFont: "Inter, sans-serif" }, mode: "dark" } },
    outputSchema: { type: "object", properties: { url: { type: "string" }, tokens: { type: "object" } }, required: ["url", "tokens"] },
  },
  {
    path: "/api/screenshot",
    priceUsd: "0.02",
    description:
      "Screenshot any public web page. Returns a JPEG (base64 data URL plus a hosted URL). Options: width (320-2560, default 1280), height (300-8000, default 900), fullPage (boolean). Takes 3-15 s.",
    tags: ["screenshot", "browser", "render", "image", "webpage", "capture"],
    inputExample: { url: "https://example.com", width: 1280, fullPage: false },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL" },
        width: { type: "number", description: "Viewport width in px (320-2560)" },
        height: { type: "number", description: "Viewport height in px (300-8000)" },
        fullPage: { type: "boolean", description: "Capture the whole page" },
      },
      required: ["url"],
    },
    outputExample: { url: "https://example.com/", image: "data:image/jpeg;base64,...", imageUrl: "https://storage.screenshotapi.net/...", format: "jpeg", width: 1280, fullPage: false, bytes: 54321 },
    outputSchema: { type: "object", properties: { image: { type: "string" }, imageUrl: { type: "string" } }, required: ["image"] },
  },
  {
    path: "/api/tech-stack",
    priceUsd: "0.02",
    description:
      "Detect the technologies behind a website: framework (Next.js, Nuxt, Astro, React...), site builder (Webflow, Framer, Lovable, Shopify, WordPress...), hosting/CDN (Vercel, Netlify, Cloudflare...), CSS (Tailwind, Bootstrap), analytics, payments, auth and support tools, with evidence. Fast (1-3 s).",
    tags: ["tech-stack", "technology", "framework", "detection", "wappalyzer", "builtwith", "website", "lead-research"],
    inputExample: { url: "https://vercel.com" },
    inputSchema: urlInputSchema,
    outputExample: { url: "https://vercel.com/", title: "Vercel", technologies: [{ name: "Next.js", category: "framework", evidence: "html" }, { name: "Vercel", category: "hosting", evidence: "header x-vercel-id" }] },
    outputSchema: { type: "object", properties: { technologies: { type: "array" } }, required: ["technologies"] },
  },
];
