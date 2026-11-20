# Rever

[![Live](https://img.shields.io/badge/Live-aypiai.online-green?style=for-the-badge)](https://www.aypiai.online)

Paste a website URL, get a detailed prompt to recreate its UI with an AI code generator (Lovable, v0, Bolt, Claude, Cursor).

Rever takes a full-page screenshot of the URL and has Claude Haiku describe the layout, sections, components, colors, typography and spacing as build instructions. The output is a prompt, not code, so it works with any stack.

## Services

39 pay-per-call endpoints ($0.001 to $0.05), all `POST {"url": "..."}`, paid with x402. Full list: [llms.txt](https://www.aypiai.online/llms.txt) and [x402.json](https://www.aypiai.online/.well-known/x402.json).

- **Read a page:** page-markdown, page-text, meta, links, images, headings, structured-data, og-image, favicon, forms, feeds, key-pages, language, text-stats
- **Companies and leads:** company-info, contacts, social-links, tech-stack, trackers
- **SEO and audits:** seo-audit, ai-readiness, broken-links, sitemap, robots, page-weight, redirects
- **Security, domain, network:** security-headers, https-check, dns, email-security, domain-whois, wayback, headers, status
- **Crypto:** crypto-site-check ($0.02)
- **Design:** generate-prompt ($0.05), design-tokens, brand-kit, screenshot

Services live in `functions/_services.ts` (AI/screenshot) and `functions/_micro.ts` (HTML/DNS based, served by `functions/api/[service].ts`). After adding or repricing one, run `npx tsx scripts/gen-discovery.ts` to regenerate openapi.json, x402.json and llms*.txt.

## Three ways to use it

| Who | How | Pays with |
|---|---|---|
| People | Web app at [aypiai.online](https://www.aypiai.online), no account | Card via Stripe: 10 / 25 / 70 generations for 9,99 / 19,99 / 49,99 € |
| AI agents | `POST /api/generate-prompt` (x402) | $0.001-$0.05 in USDC on Base per call |
| MCP clients | `https://www.aypiai.online/mcp` (remote) or [`rever-mcp`](./rever-mcp) (local), tool `clone_ui` | $0.05 in USDC on Base, or a pack's access key |

### Agent payment flow (x402)

The endpoint speaks [x402](https://x402.org) v2: an unpaid call returns `402` with a `PAYMENT-REQUIRED` header, an x402 client signs a USDC authorization and retries with `PAYMENT-SIGNATURE`. The facilitator (Coinbase CDP when `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` are set, PayAI's public facilitator otherwise) verifies the payment, the prompt is generated, and only then is the payment settled. The route declares Bazaar discovery metadata so it gets indexed in x402 catalogs after its first payment.

Fallback: send USDC directly and retry with `X-Payment: <tx hash>` (verified on-chain, single use).

### Pack payment flow

There are no accounts. A Stripe Payment Link redirects back to `/?session_id={CHECKOUT_SESSION_ID}`. That session id becomes the buyer's access key: the first time it's used, the function asks Stripe whether it was paid and stores the number of generations bought (by amount, configurable with `PACKS`). Each generation is deducted atomically and refunded if it fails.

Agent-facing docs are served at [`/llms.txt`](https://www.aypiai.online/llms.txt), [`/llms-full.txt`](https://www.aypiai.online/llms-full.txt), [`/openapi.json`](https://www.aypiai.online/openapi.json) and [`/.well-known/mcp.json`](https://www.aypiai.online/.well-known/mcp.json).

## Stack

React + TypeScript + Vite + Tailwind/shadcn on Cloudflare Pages, Pages Functions + D1 (SQLite) for the API, Stripe, ScreenshotAPI, Claude Haiku 4.5.

## Repository structure

```
├── src/                         # Web app (Dashboard, Auth, Showcase, Site Time Machine)
├── functions/api/               # Cloudflare Pages Functions: generate-prompt, balance
├── public/                      # showcase.json, robots.txt, sitemap.xml, llms.txt, openapi.json, _headers, .well-known/
├── schema.sql                   # D1 tables: access_keys, agent_payments
├── wrangler.toml
└── rever-mcp/                   # MCP server
```

## Run locally

```bash
git clone https://github.com/chaoui-ahmed/rever-ui-cloner.git
cd rever-ui-cloner
npm install
cp .dev.vars.example .dev.vars        # fill in the keys
npx wrangler d1 execute DB --local --file=schema.sql
npm run build && npx wrangler pages dev dist
```

## Deploy (Cloudflare Pages)

1. `npx wrangler d1 create rever`, put the returned id in `wrangler.toml`, then `npx wrangler d1 execute rever --remote --file=schema.sql`.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → connect this repo. Build `npm run build`, output `dist`.
3. Settings → Bindings: D1 database, variable `DB` → `rever`. Settings → Variables and Secrets: the keys from `.dev.vars.example`.
4. Stripe: in each Payment Link, set the confirmation page to redirect to `https://www.aypiai.online/?session_id={CHECKOUT_SESSION_ID}`.

## Author

Ahmed Chaoui — [ahmedchaoui.com](https://ahmedchaoui.com)

MIT license.
