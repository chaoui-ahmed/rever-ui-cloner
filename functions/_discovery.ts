// Machine-readable "signposts" that agents and crawlers look for at well-known paths,
// generated from the service catalog so they never go stale. Served by _middleware.ts. Not a route.
import { SERVICES, type ServiceDef } from "./_services";
import { FREE_RUNNERS, FREE_PER_DAY } from "./_free";

const SITE = "https://www.aypiai.online";
const NAME = "Rever";
const TAGLINE = "Website intelligence for AI agents";
const SUMMARY =
  `${SERVICES.length} pay-per-call tools that take a URL and return JSON: page to markdown, contacts, social links, SEO, security, DNS, WHOIS, tech stack, crypto project trust check, design tokens, screenshots and UI-recreation prompts. ` +
  `$0.001 to $0.05 per call. Pay with x402 (USDC on Base), prepaid card credits, or ${FREE_PER_DAY} free MCP calls/day.`;

export const slug = (s: ServiceDef) => s.path.replace("/api/", "");
export const toolName = (s: ServiceDef) => (s.path === "/api/generate-prompt" ? "clone_ui" : slug(s).replace(/-/g, "_"));
export const shortTitle = (s: ServiceDef) => s.description.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, "");

const x402Doc = () => ({
  version: 1,
  name: NAME,
  description: SUMMARY,
  // Plain list of paid resource URLs (what most x402 crawlers read)...
  resources: SERVICES.map((s) => `${SITE}${s.path}`),
  // ...plus details for crawlers that want them.
  items: SERVICES.map((s) => ({
    resource: `${SITE}${s.path}`,
    method: "POST",
    scheme: "exact",
    network: "eip155:8453",
    asset: "USDC",
    price: `$${s.priceUsd}`,
    amount: String(Math.round(Number(s.priceUsd) * 1_000_000)),
    description: s.description,
    tags: s.tags,
    input: s.inputExample,
    docs: `${SITE}/tools/${slug(s)}`,
  })),
  openapi: `${SITE}/openapi.json`,
  mcp: `${SITE}/mcp`,
  llms: `${SITE}/llms.txt`,
  contact: "tahachaoui5@gmail.com",
});

// A2A Agent Card (https://a2a-protocol.org) — skills = our tools.
const agentCard = () => ({
  protocolVersion: "0.3.0",
  name: NAME,
  description: `${TAGLINE}. ${SUMMARY}`,
  url: `${SITE}/mcp`,
  preferredTransport: "JSONRPC",
  version: "2.0.0",
  provider: { organization: NAME, url: SITE },
  iconUrl: `${SITE}/favicon.ico`,
  documentationUrl: `${SITE}/llms.txt`,
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["application/json", "text/plain"],
  defaultOutputModes: ["application/json"],
  additionalInterfaces: [
    { url: `${SITE}/mcp`, transport: "MCP-StreamableHTTP" },
    { url: `${SITE}/openapi.json`, transport: "HTTP+JSON" },
  ],
  skills: SERVICES.map((s) => ({
    id: toolName(s),
    name: shortTitle(s),
    description: `${s.description} Price: $${s.priceUsd}.`,
    tags: s.tags,
    examples: [JSON.stringify(s.inputExample)],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  })),
});

// agents.json (wildcard-ai style) and a generic catalog: name, description, entry points.
const agentsJson = () => ({
  agentsJson: "0.1.0",
  info: { title: NAME, description: SUMMARY, version: "2.0.0", url: SITE },
  sources: [{ id: "rever", path: `${SITE}/openapi.json` }],
  interfaces: { mcp: `${SITE}/mcp`, openapi: `${SITE}/openapi.json`, x402: `${SITE}/.well-known/x402`, a2a: `${SITE}/.well-known/agent-card.json`, llms: `${SITE}/llms.txt` },
  flows: SERVICES.map((s) => ({
    id: toolName(s),
    title: shortTitle(s),
    description: `${s.description} $${s.priceUsd}/call.`,
    actions: [{ id: slug(s), sourceId: "rever", operationId: s.path, method: "POST", path: s.path }],
  })),
  payment: { protocols: ["x402", "card-credits"], x402: { network: "eip155:8453", asset: "USDC" }, credits: `${SITE}/credits`, freeTier: `${FREE_PER_DAY} MCP calls/day` },
});

// MCP Server Card (SEP-1649 draft): lets clients learn the server before connecting.
const mcpServerCard = () => ({
  $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
  version: "1.0",
  protocolVersion: "2025-06-18",
  serverInfo: { name: "online.aypiai.www/rever", title: `${NAME}: ${TAGLINE}`, version: "2.0.0" },
  description: SUMMARY,
  iconUrl: `${SITE}/favicon.ico`,
  documentationUrl: `${SITE}/llms.txt`,
  transport: { type: "streamable-http", endpoint: `${SITE}/mcp` },
  remotes: [{ type: "streamable-http", url: `${SITE}/mcp` }],
  authentication: { required: false, schemes: [] },
  capabilities: { tools: { listChanged: false } },
  tools: [
    { name: "list_services", description: "Free. Lists all tools with prices." },
    ...SERVICES.map((s) => ({ name: toolName(s), description: `${shortTitle(s)} ($${s.priceUsd}${FREE_RUNNERS.has(s.path) ? `, ${FREE_PER_DAY} free/day` : ""})`, inputSchema: s.inputSchema })),
  ],
});

const DOCS: Record<string, () => unknown> = {
  "/.well-known/x402": x402Doc,
  "/x402.json": x402Doc,
  "/discovery/resources": x402Doc,
  "/.well-known/agent-card.json": agentCard,
  "/.well-known/agent-card": agentCard,
  "/.well-known/agent.json": agentCard,
  "/well_known/agent_json": agentCard,
  "/agents.json": agentsJson,
  "/.well-known/agents.json": agentsJson,
  "/.well-known/ai-catalog.json": agentsJson,
  "/.well-known/mcp/server-card.json": mcpServerCard,
  "/.well-known/mcp/server-cards.json": () => [mcpServerCard()],
  "/.well-known/mcp-server-card": mcpServerCard,
  "/.well-known/mcp": mcpServerCard,
  "/mcp/server-card": mcpServerCard,
};

// No auth anywhere: answer OAuth discovery with a clean 404 (an HTML page here confuses MCP clients).
const NO_AUTH = /^\/(\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)|mcp\/\.well-known\/)/;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" },
  });

/** Returns a response for discovery paths, or null to continue. */
export function discoveryResponse(pathname: string): Response | null {
  const doc = DOCS[pathname];
  if (doc) return jsonRes(doc());
  if (NO_AUTH.test(pathname)) return jsonRes({ error: "not_found", detail: "No authentication required. Connect to https://www.aypiai.online/mcp directly." }, 404);
  return null;
}

/** True for paths that must never get the SPA page (dotfiles, files with an extension, well-known). */
export const isFileLike = (p: string) => p !== "/" && (/\/\./.test(p) || /\.[a-z0-9]{1,8}$/i.test(p) || p.startsWith("/well_known"));
