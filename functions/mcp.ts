// Remote MCP server (Streamable HTTP, stateless JSON responses) at /mcp.
// One tool: clone_ui. Payment: a pack access key, a USDC tx hash, or instructions to pay.
import { type Env, corsHeaders } from "./_shared";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL = {
  name: "clone_ui",
  title: "Clone a website's UI as a prompt",
  description:
    "Turn a public website URL into a detailed prompt (layout, components, colors, typography, spacing) for recreating its UI with a code model such as Lovable, v0, Claude or Cursor. Returns text, not code. Takes 10-30 s. Costs $0.05: pass access_key (pack bought on https://www.aypiai.online) or payment_tx (hash of a 0.05 USDC transfer on Base to the address returned when called without payment). x402-capable agents can instead call https://www.aypiai.online/api/generate-prompt directly.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http(s) URL to recreate, e.g. https://stripe.com" },
      access_key: { type: "string", description: "Optional. Access key of a pack (cs_live_...)." },
      payment_tx: { type: "string", description: "Optional. Base tx hash of a 0.05 USDC payment (single use)." },
    },
    required: ["url"],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, any> };

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(request: Request, args: Record<string, any>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.access_key) headers["X-Access-Key"] = String(args.access_key);
  if (args.payment_tx) headers["X-Payment"] = String(args.payment_tx);

  const res = await fetch(new URL("/api/generate-prompt", request.url), {
    method: "POST",
    headers,
    body: JSON.stringify({ url: args.url }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;

  if (res.ok && data.prompt) {
    const note = typeof data.remaining === "number" ? `\n\n(${data.remaining} generations left on this key)` : "";
    return { content: [{ type: "text", text: data.prompt + note }], isError: false };
  }
  if (res.status === 402) {
    const reason = data.reason || data.error || "";
    return {
      isError: true,
      content: [{
        type: "text",
        text:
          `Payment required${reason && reason !== "Payment Required" ? ` (${reason})` : ""}. Price: $0.05 per call. Options:\n` +
          `1. Buy a pack by card at https://www.aypiai.online and call again with access_key.\n` +
          `2. Send 0.05 USDC on Base to 0x4b1965f9d407ce9f032e9e2465afe7ff8bfb7f3d, then call again with payment_tx set to the transaction hash.\n` +
          `3. If you have an x402 client, POST {"url": ...} to https://www.aypiai.online/api/generate-prompt directly.`,
      }],
    };
  }
  return { isError: true, content: [{ type: "text", text: `Rever error ${res.status}: ${data.error ?? "unknown"}` }] };
}

async function handle(msg: RpcRequest, request: Request) {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rever", title: "Rever", version: "1.0.0", websiteUrl: "https://www.aypiai.online" },
        instructions: "Use clone_ui when the user wants to clone, copy or recreate the design of an existing website.",
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: [TOOL] });
    case "tools/call": {
      if (msg.params?.name !== TOOL.name) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      const args = msg.params?.arguments ?? {};
      if (!args.url || typeof args.url !== "string") return rpcError(msg.id, -32602, "Missing required argument: url");
      return rpcResult(msg.id, await callTool(request, args));
    }
    case "resources/list":
      return rpcResult(msg.id, { resources: [] });
    case "prompts/list":
      return rpcResult(msg.id, { prompts: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const out = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, authorization", "Content-Type": "application/json" },
  });

export const onRequestOptions: PagesFunction<Env> = () => out(null, 204);

// No server-initiated stream: GET is not supported (spec allows 405).
export const onRequestGet: PagesFunction<Env> = () =>
  new Response("Rever MCP server. Use POST (Streamable HTTP). Docs: https://www.aypiai.online/llms.txt", {
    status: 405,
    headers: { ...corsHeaders, Allow: "POST, OPTIONS", "Content-Type": "text/plain" },
  });

export const onRequestDelete: PagesFunction<Env> = () => out(null, 405);

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  let payload: RpcRequest | RpcRequest[];
  try {
    payload = await request.json();
  } catch {
    return out(rpcError(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const requests = batch.filter((m) => m && m.id !== undefined && m.id !== null);
  if (requests.length === 0) return out(null, 202); // notifications / responses only
  const results = await Promise.all(requests.map((m) => handle(m, request)));
  return out(Array.isArray(payload) ? results : results[0]);
};
