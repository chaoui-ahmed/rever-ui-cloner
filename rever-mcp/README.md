# Rever MCP server

Gives any MCP client (Claude Desktop, Cursor, Windsurf, …) a `clone_ui` tool: pass a URL, get back a detailed prompt describing the page's layout, components, colors and typography, ready to hand to a code model.

## Install

```bash
git clone https://github.com/chaoui-ahmed/rever-ui-cloner.git
cd rever-ui-cloner/rever-mcp
npm install
```

Add it to your client config (Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rever": {
      "command": "node",
      "args": ["/absolute/path/to/rever-ui-cloner/rever-mcp/index.js"]
    }
  }
}
```

## Paying

Each call costs $0.25 in USDC on Base. The first call without payment returns the address and amount. Pay, then call again with `payment_tx` set to the transaction hash (single use).

Optional environment variables:

- `REVER_ACCESS_KEY` — access key of a pack bought on aypiai.online, instead of paying per call
- `REVER_PAYMENT_TX` — default payment hash
- `REVER_API_URL` — override the endpoint
