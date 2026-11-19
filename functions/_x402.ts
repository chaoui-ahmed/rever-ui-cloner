// Standard x402 (v2) payments through the Coinbase CDP facilitator, with Bazaar discovery.
// Not a route (no onRequest export).
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  HTTPFacilitatorClient,
  prepareHttpServer,
  withPrivateCacheControl,
  type HTTPAdapter,
  type HTTPRequestContext,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { type Env, payTo, AGENT_PRICE_USD } from "./_shared";

export const ROUTE = "POST /api/generate-prompt";

class PagesAdapter implements HTTPAdapter {
  constructor(private req: Request, private body: unknown) {}
  getHeader(name: string) { return this.req.headers.get(name) ?? undefined; }
  getMethod() { return this.req.method; }
  getPath() { return new URL(this.req.url).pathname; }
  getUrl() { return this.req.url; }
  getAcceptHeader() { return this.req.headers.get("Accept") ?? ""; }
  getUserAgent() { return this.req.headers.get("User-Agent") ?? ""; }
  getQueryParams() { return Object.fromEntries(new URL(this.req.url).searchParams); }
  getQueryParam(name: string) { return new URL(this.req.url).searchParams.get(name) ?? undefined; }
  getBody() { return this.body; }
}

let cached: { key: string; http: x402HTTPResourceServer; init: () => Promise<void> } | null = null;

// Coinbase CDP facilitator when a CDP key is configured (indexes into Coinbase Bazaar / Agentic.Market),
// otherwise PayAI's public facilitator (no key needed, Base mainnet, own Bazaar catalog).
const PAYAI_FACILITATOR = "https://facilitator.payai.network";
const hasCdpKey = (env: Env) => Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
export const x402Enabled = (_env: Env) => true;

function getServer(env: Env, origin: string) {
  const key = `${env.CDP_API_KEY_ID ?? "payai"}|${payTo(env)}|${origin}`;
  if (cached?.key === key) return cached;

  const facilitator = new HTTPFacilitatorClient(
    hasCdpKey(env) ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) : { url: PAYAI_FACILITATOR },
  );
  const server = new x402ResourceServer(facilitator);
  server.register("eip155:8453", new ExactEvmScheme());
  server.registerExtension(bazaarResourceServerExtension);

  const routes = {
    [ROUTE]: {
      accepts: { scheme: "exact", price: `$${AGENT_PRICE_USD}`, network: "eip155:8453" as const, payTo: payTo(env) },
      resource: `${origin}/api/generate-prompt`,
      description:
        "Turn any public website URL into a detailed prompt (layout, components, colors, typography, spacing) for recreating its UI with a code model such as Lovable, v0, Claude or Cursor. Returns text, not code. Takes 10-30 s.",
      mimeType: "application/json",
      serviceName: "Rever",
      tags: ["ui", "design", "website", "clone", "prompt", "screenshot", "frontend"],
      iconUrl: `${origin}/favicon.ico`,
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "Payment Required",
          howToPay:
            `Pay $${AGENT_PRICE_USD} in USDC on Base with any x402 client (read the PAYMENT-REQUIRED header, retry with PAYMENT-SIGNATURE). ` +
            `Alternatives: send USDC to ${payTo(env)} and retry with "X-Payment: <tx hash>", or buy a pack at ${origin} and send "X-Access-Key". ` +
            `Docs: ${origin}/llms-full.txt`,
        },
      }),
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          input: { url: "https://stripe.com" },
          inputSchema: {
            type: "object",
            properties: { url: { type: "string", description: "Public http(s) URL of the page to recreate" } },
            required: ["url"],
          },
          output: {
            example: { prompt: "Build a landing page with a sticky dark header, ...", url: "https://stripe.com/" },
            schema: {
              type: "object",
              properties: {
                prompt: { type: "string", description: "Design brief to give to a code-generation model" },
                url: { type: "string" },
              },
              required: ["prompt", "url"],
            },
          },
        }),
      },
    },
  };

  const http = new x402HTTPResourceServer(server, routes);
  const { init } = prepareHttpServer(http, undefined, true);
  cached = { key, http, init };
  return cached;
}

/**
 * Runs an x402-protected handler. Returns null when x402 is unavailable. `handler` returns the paid response; if it throws or
 * returns status >= 400, the payment is cancelled (never settled).
 */
export async function withX402(
  env: Env,
  request: Request,
  body: unknown,
  handler: () => Promise<Response>,
): Promise<Response | null> {
  const origin = new URL(request.url).origin;
  const { http, init } = getServer(env, origin);
  const adapter = new PagesAdapter(request, body);
  const context: HTTPRequestContext = {
    adapter,
    path: adapter.getPath(),
    decodedPath: adapter.getPath(),
    method: request.method,
    paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
  };

  // If the facilitator is unreachable or the keys are wrong, return null so the caller
  // can fall back to the tx-hash flow instead of failing.
  let result;
  try {
    await init();
    result = await http.processHTTPRequest(context);
  } catch (err) {
    console.error("x402 unavailable:", err);
    cached = null;
    return null;
  }

  if (result.type === "no-payment-required") return handler();
  if (result.type === "payment-error") {
    const { status, headers, body: resBody } = result.response;
    return new Response(JSON.stringify(resBody ?? {}), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  // payment-verified
  const { cancellationDispatcher, beforeHandlerSettlement, paymentPayload, paymentRequirements, declaredExtensions } = result;
  let res: Response;
  try {
    res = await handler();
  } catch (error) {
    await cancellationDispatcher.cancel({ reason: "handler_threw", error });
    throw error;
  }
  if (res.status >= 400) {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: res.status });
    return res;
  }

  const responseBody = new Uint8Array(await res.arrayBuffer());
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { responseHeaders[k] = v; });

  const settle = await http.processSettlement(
    paymentPayload,
    paymentRequirements,
    declaredExtensions,
    { request: context, // eslint-disable-next-line @typescript-eslint/no-explicit-any
      responseBody: responseBody as any, responseHeaders },
    undefined,
    beforeHandlerSettlement,
  );
  if (!settle.success) {
    const r = settle.response;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  }
  const out = new Response(responseBody, { status: res.status, headers: res.headers });
  for (const [k, v] of Object.entries(settle.headers)) out.headers.set(k, v);
  out.headers.set("Cache-Control", withPrivateCacheControl(out.headers.get("Cache-Control")));
  return out;
}
