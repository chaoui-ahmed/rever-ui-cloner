// Remote MCP server (Streamable HTTP, stateless JSON responses) at /mcp.
// One tool per paid service (generated from the catalog) plus a free list_services tool.
// Payment: x402 (PAYMENT-SIGNATURE value in the `payment` argument or in params._meta["x402/payment"]);
// clone_ui also accepts a pack access key or a USDC tx hash.
import { type Env, corsHeaders, validateTargetUrl, UpstreamError } from "./_shared";
import { SERVICES } from "./_services";
import { FREE_RUNNERS, FREE_PER_DAY, takeFreeCall, refundFreeCall } from "./_free";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PAY_TO = "0x4b1965f9d407ce9f032e9e2465afe7ff8bfb7f3d";

const toolName = (path: string) => (path === "/api/generate-prompt" ? "clone_ui" : path.replace("/api/", "").replace(/-/g, "_"));
const PAYMENT_ARG = {
  payment: {
    type: "string",
    description: "x402 payment: the base64 PAYMENT-SIGNATURE value signed for the requirements returned by an unpaid call (USDC on Base, gasless). Omit on the first call to get the price and requirements.",
  },
};

const TOOLS = SERVICES.map((s) => {
  const schema = s.inputSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
  const extra = s.path === "/api/generate-prompt"
    ? {
        access_key: { type: "string", description: "Optional. Access key of a pack bought by card on https://www.aypiai.online (cs_live_...)." },
        payment_tx: { type: "string", description: `Optional. Base tx hash of a direct ${s.priceUsd} USDC transfer to ${PAY_TO} (single use).` },
      }
    : {};
  return {
    name: toolName(s.path),
    title: s.description.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, "").slice(0, 80),
    description: FREE_RUNNERS.has(s.path)
      ? `${s.description} Free: ${FREE_PER_DAY} calls/day per user across free tools, no payment needed. Above that: $${s.priceUsd} per call (x402, USDC on Base).`
      : `${s.description} Price: $${s.priceUsd} per call (x402, USDC on Base). Without payment, returns the payment requirements.`,
    inputSchema: { type: "object", properties: { ...schema.properties, ...extra, ...PAYMENT_ARG }, required: schema.required ?? ["url"] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { path: s.path, priceUsd: s.priceUsd, tags: s.tags, free: FREE_RUNNERS.has(s.path) },
  };
});

const LIST_TOOL = {
  name: "list_services",
  title: "List Rever services and prices",
  description: "Free. Lists all Rever website-intelligence tools with their price, so you can pick the cheapest one for the job.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

type RpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, any> };

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const unb64 = (s: string) => { try { return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch { return null; } };

async function callTool(env: Env, request: Request, tool: (typeof TOOLS)[0], args: Record<string, any>, meta: Record<string, any> | undefined) {
  const path = tool._meta.path;
  const paying = args.payment || meta?.["x402/payment"] || args.access_key || args.payment_tx;
  const freeRun = FREE_RUNNERS.get(path);
  let freeLimitHit = false;
  if (freeRun && !paying) {
    const url = validateTargetUrl(args.url);
    if (!url) return { isError: true, content: [{ type: "text", text: "Valid public http(s) URL required in \"url\"" }] };
    const left = await takeFreeCall(env, request);
    if (left !== null) {
      try {
        const { url: _u, ...rest } = args;
        const data = (await freeRun(env, url, rest)) as Record<string, any>;
        try {
          await env.DB.prepare("CREATE TABLE IF NOT EXISTS free_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT, target TEXT, user_agent TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
          await env.DB.prepare("INSERT INTO free_calls (tool, target, user_agent) VALUES (?, ?, ?)").bind(tool.name, new URL(url).hostname, (request.headers.get("User-Agent") ?? "").slice(0, 200)).run();
        } catch { /* logging only */ }
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) + `\n\n(Free tier: ${left} free calls left today. More: https://www.aypiai.online)` }],
          structuredContent: data,
          isError: false,
          _meta: { freeCallsLeft: left },
        };
      } catch (err) {
        await refundFreeCall(env, request);
        return { isError: true, content: [{ type: "text", text: `${err instanceof UpstreamError ? "Site error" : "Error"}: ${(err as Error).message} (free call not counted)` }] };
      }
    }
    freeLimitHit = true;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const metaPay = meta?.["x402/payment"];
  const payment = args.payment ?? (typeof metaPay === "string" ? metaPay : metaPay ? b64(JSON.stringify(metaPay)) : undefined);
  if (payment) headers["PAYMENT-SIGNATURE"] = String(payment);
  if (args.access_key) headers["X-Access-Key"] = String(args.access_key);
  if (args.payment_tx) headers["X-Payment"] = String(args.payment_tx);
  const { payment: _p, access_key: _a, payment_tx: _t, ...body } = args;

  const res = await fetch(new URL(path, request.url), { method: "POST", headers, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  const receipt = res.headers.get("payment-response");

  if (res.ok) {
    const text = path === "/api/generate-prompt" && data.prompt
      ? data.prompt + (typeof data.remaining === "number" ? `\n\n(${data.remaining} generations left on this key)` : "")
      : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text }], structuredContent: data, isError: false, ...(receipt ? { _meta: { "x402/payment-response": unb64(receipt) ?? receipt } } : {}) };
  }
  if (res.status === 402) {
    const header = res.headers.get("payment-required");
    const requirements = header ? unb64(header) : null;
    const reason = data.reason || data.error || requirements?.error || "";
    const alt = path === "/api/generate-prompt"
      ? `\nAlternatives: buy a pack at https://www.aypiai.online and pass access_key, or send ${tool._meta.priceUsd} USDC on Base to ${PAY_TO} and pass payment_tx.`
      : "";
    return {
      isError: true,
      structuredContent: { x402Version: 2, error: "payment_required", reason, accepts: requirements?.accepts ?? [] },
      _meta: { "x402/error": { error: "payment_required", reason, accepts: requirements?.accepts ?? [], paymentRequired: header } },
      content: [{
        type: "text",
        text:
          (freeLimitHit ? `Free tier used up for today (${FREE_PER_DAY} calls/day, resets at 00:00 UTC). ` : "") +
          `Payment required${reason && !/payment required/i.test(reason) ? ` (${reason})` : ""}: $${tool._meta.priceUsd} in USDC on Base (x402).\n` +
          `Sign one of the accepted requirements below with an x402 client (EIP-3009, no gas needed) and call this tool again with the base64 PAYMENT-SIGNATURE value in "payment". ` +
          `Or POST directly to https://www.aypiai.online${path} with any x402 client.${alt}\n\nPAYMENT-REQUIRED (base64): ${header ?? "n/a"}\n\n` +
          JSON.stringify(requirements?.accepts ?? [], null, 2),
      }],
    };
  }
  return { isError: true, content: [{ type: "text", text: `Rever error ${res.status}: ${data.error ?? "unknown"} (you were not charged)` }] };
}

async function handle(msg: RpcRequest, request: Request, env: Env) {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rever", title: "Rever", version: "2.0.0", websiteUrl: "https://www.aypiai.online" },
        instructions: `Website intelligence tools: give a URL, get JSON (markdown, contacts, socials, SEO, security, DNS, WHOIS, tech stack, crypto project trust check, design). ${FREE_PER_DAY} free calls per day on most tools, no signup; above that or for premium tools, pay per call with x402. Call list_services to see which are free.`,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: [LIST_TOOL, ...TOOLS] });
    case "tools/call": {
      const name = msg.params?.name;
      if (name === LIST_TOOL.name) {
        const list = TOOLS.map((t) => ({ tool: t.name, price: `$${t._meta.priceUsd}`, freeTier: t._meta.free, what: t.title }));
        const header = `${FREE_PER_DAY} free calls per day on tools marked FREE, then pay per call with x402 (USDC on Base).\n\n`;
        return rpcResult(msg.id, { content: [{ type: "text", text: header + list.map((l) => `${l.tool} (${l.freeTier ? "FREE, then " : ""}${l.price}): ${l.what}`).join("\n") }], structuredContent: { services: list }, isError: false });
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      const args = msg.params?.arguments ?? {};
      if (!args.url || typeof args.url !== "string") return rpcError(msg.id, -32602, "Missing required argument: url");
      return rpcResult(msg.id, await callTool(env, request, tool, args, msg.params?._meta));
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let payload: RpcRequest | RpcRequest[];
  try {
    payload = await request.json();
  } catch {
    return out(rpcError(null, -32700, "Parse error"), 400);
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const requests = batch.filter((m) => m && m.id !== undefined && m.id !== null);
  if (requests.length === 0) return out(null, 202); // notifications / responses only
  const results = await Promise.all(requests.map((m) => handle(m, request, env)));
  return out(Array.isArray(payload) ? results : results[0]);
};
