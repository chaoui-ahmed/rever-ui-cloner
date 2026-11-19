# Rever

[![Live](https://img.shields.io/badge/Live-aypiai.online-green?style=for-the-badge)](https://www.aypiai.online)

Paste a website URL, get a detailed prompt to recreate its UI with an AI code generator (Lovable, v0, Bolt, Claude, Cursor).

Rever takes a full-page screenshot of the URL and has Claude Haiku describe the layout, sections, components, colors, typography and spacing as build instructions. The output is a prompt, not code, so it works with any stack.

## Three ways to use it

| Who | How | Pays with |
|---|---|---|
| People | Web app at [aypiai.online](https://www.aypiai.online) | Credits (300 free on signup) |
| AI agents | `POST /functions/v1/generate-prompt` | 1 USDC on Base per call |
| MCP clients | [`rever-mcp`](./rever-mcp) (`clone_ui` tool) | 1 USDC on Base, or your account credits |

### Agent payment flow

1. Call the API without payment → `402` with network, asset, amount and `payTo`.
2. Send 1 USDC on Base to `payTo`.
3. Retry with `X-Payment: <tx hash>`. The edge function checks the receipt on-chain (USDC `Transfer` log to the right address, enough amount, 2 confirmations) and stores the hash so it can only be used once. If generation fails, the hash is released.

Agent-facing docs are served at [`/llms.txt`](https://www.aypiai.online/llms.txt), [`/llms-full.txt`](https://www.aypiai.online/llms-full.txt), [`/openapi.json`](https://www.aypiai.online/openapi.json) and [`/.well-known/mcp.json`](https://www.aypiai.online/.well-known/mcp.json).

## Stack

React + TypeScript + Vite + Tailwind/shadcn, Supabase (auth, Postgres, edge functions), ScreenshotAPI, Claude Haiku 4.5, deployed on Vercel.

## Repository structure

```
├── src/                         # Web app (Dashboard, Auth, Showcase, Site Time Machine)
├── public/                      # robots.txt, sitemap.xml, llms.txt, openapi.json, .well-known/
├── supabase/
│   ├── functions/generate-prompt/   # Screenshot → Claude → prompt, credits + on-chain payment check
│   └── migrations/                  # Profiles, credit functions, RLS, agent_payments
└── rever-mcp/                   # MCP server
```

## Run locally

```bash
git clone https://github.com/chaoui-ahmed/rever-ui-cloner.git
cd rever-ui-cloner
npm install
cp .env.example .env   # fill in VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev
```

Edge function secrets (set in Supabase): `SCREENSHOT_API_KEY`, `ANTHROPIC_API_KEY`, optional `AGENT_PAYMENT_ADDRESS` and `BASE_RPC_URL`.

## Author

Ahmed Chaoui — [ahmedchaoui.com](https://ahmedchaoui.com)

MIT license.
