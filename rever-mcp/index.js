#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const API_URL =
  process.env.REVER_API_URL ?? "https://www.aypiai.online/api/generate-prompt";

const server = new Server({ name: "rever-ui-cloner", version: "1.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "clone_ui",
      description:
        "Turn a public website URL into a detailed prompt (layout, components, colors, typography, spacing) for recreating its UI with a code model. Returns text, not code. Costs $0.25 in USDC on Base (or one generation from a pack if REVER_ACCESS_KEY is set): call once without payment_tx to get payment details, pay, then call again with payment_tx set to the transaction hash.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Public http(s) URL to recreate, e.g. https://stripe.com" },
          payment_tx: { type: "string", description: "Base transaction hash of a 0.25 USDC payment (single use)." },
        },
        required: ["url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "clone_ui") throw new Error(`Unknown tool: ${request.params.name}`);
  const { url, payment_tx } = request.params.arguments ?? {};

  const headers = { "Content-Type": "application/json" };
  const tx = payment_tx ?? process.env.REVER_PAYMENT_TX;
  if (tx) headers["X-Payment"] = tx;
  if (process.env.REVER_ACCESS_KEY) headers["X-Access-Key"] = process.env.REVER_ACCESS_KEY;

  try {
    const response = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify({ url }) });
    const data = await response.json().catch(() => ({}));

    if (response.status === 402) {
      const a = data.accepts?.[0] ?? {};
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `Payment required${data.reason ? ` (${data.reason})` : ""}. Send ${Number(a.maxAmountRequired ?? a.amount ?? 250000) / 1e6} USDC on Base ` +
            `(asset ${a.asset}) to ${a.payTo}, then call clone_ui again with payment_tx set to the transaction hash.`,
        }],
      };
    }
    if (!response.ok) {
      return { isError: true, content: [{ type: "text", text: `Rever API error ${response.status}: ${data.error ?? "unknown"}` }] };
    }
    return { content: [{ type: "text", text: data.prompt }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `Could not reach Rever API: ${error.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
console.error("Rever MCP server running on stdio");
