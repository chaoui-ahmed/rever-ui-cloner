# Rever

[![Live](https://img.shields.io/badge/Live-aypiai.online-green?style=for-the-badge)](https://www.aypiai.online)

Paste a website URL, get a detailed prompt to recreate its UI with an AI code generator (Lovable, v0, Bolt, Claude, Cursor).

Rever takes a full-page screenshot of the URL and has Claude Haiku describe the layout, sections, components, colors, typography and spacing as build instructions. The output is a prompt, not code, so it works with any stack.

## Three ways to use it

| Who | How | Pays with |
|---|---|---|
| People | Web app at [aypiai.online](https://www.aypiai.online), no account | Card via Stripe: 10 generations for 9,99 € |
| AI agents | `POST /functions/v1/generate-prompt` | 1 USDC on Base per call |
| MCP clients | [`rever-mcp`](./rever-mcp) (`clone_ui` tool) | 1 USDC on Base, or a pack's access key |

### Agent payment flow

1. Call the API without payment → `402` with network, asset, amount and `payTo`.
2. Send 1 USDC on Base to `payTo`.
3. Retry with `X-Payment: <tx hash>`. The function checks the receipt on-chain (USDC `Transfer` log to the right address, enough amount, 2 confirmations) and stores the hash so it can only be used once. If generation fails, the hash is released.

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
