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
import { type Env, payTo } from "./_shared";
import { SERVICES } from "./_services";


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

let cached: { key: string; http: x402HTTPResourceServer; init: () => Promise<void>; facilitator: "cdp" | "payai" } | null = null;
let cdpBrokenUntil = 0;
export let lastCdpError = ""; // after a CDP init failure, use PayAI for a while

// Coinbase CDP facilitator when a CDP key is configured (indexes into Coinbase Bazaar / Agentic.Market),
// otherwise PayAI's public facilitator (no key needed, Base mainnet, own Bazaar catalog).
const PAYAI_FACILITATOR = "https://facilitator.payai.network";
const hasCdpKey = (env: Env) => Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);
export const x402Enabled = (_env: Env) => true;

function getServer(env: Env, origin: string) {
  const useCdp = hasCdpKey(env) && Date.now() > cdpBrokenUntil;
  const key = `${useCdp ? env.CDP_API_KEY_ID : "payai"}|${payTo(env)}|${origin}`;
  if (cached?.key === key) return cached;

  const facilitator = new HTTPFacilitatorClient(
    useCdp ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) : { url: PAYAI_FACILITATOR },
  );
  const server = new x402ResourceServer(facilitator);
  server.register("eip155:8453", new ExactEvmScheme());
  server.registerExtension(bazaarResourceServerExtension);

  const routes = Object.fromEntries(SERVICES.map((svc) => [
    `POST ${svc.path}`,
    {
      accepts: { scheme: "exact", price: `$${svc.priceUsd}`, network: "eip155:8453" as const, payTo: payTo(env) },
      resource: `${origin}${svc.path}`,
      description: svc.description,
      mimeType: "application/json",
      serviceName: "Rever",
      tags: svc.tags,
      iconUrl: `${origin}/favicon.ico`,
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "Payment Required",
          price: `$${svc.priceUsd}`,
          howToPay:
            `Pay $${svc.priceUsd} in USDC on Base with any x402 client (read the PAYMENT-REQUIRED header, retry with PAYMENT-SIGNATURE). ` +
            `Docs: ${origin}/llms-full.txt`,
        },
      }),
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          input: svc.inputExample,
          inputSchema: svc.inputSchema,
          output: { example: svc.outputExample, schema: svc.outputSchema },
        }),
      },
    },
  ]));

  const http = new x402HTTPResourceServer(server, routes);
  const { init } = prepareHttpServer(http, undefined, true);
  cached = { key, http, init, facilitator: useCdp ? "cdp" : "payai" };
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
  let server = getServer(env, origin);
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
    await server.init();
    result = await server.http.processHTTPRequest(context);
  } catch (err) {
    console.error(`x402 (${server.facilitator}) unavailable:`, err);
    cached = null;
    if (server.facilitator !== "cdp") return null;
    // CDP failed: retry with PayAI, and keep using PayAI for 10 minutes
    cdpBrokenUntil = Date.now() + 10 * 60 * 1000;
    lastCdpError = String((err as Error)?.message ?? err).slice(0, 150);
    try {
      await new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)).getSupported();
    } catch (detail) {
      lastCdpError = String((detail as Error)?.message ?? detail).slice(0, 300);
    }
    server = getServer(env, origin);
    try {
      await server.init();
      result = await server.http.processHTTPRequest(context);
    } catch (err2) {
      console.error("x402 (payai) unavailable:", err2);
      cached = null;
      return null;
    }
  }
  const http = server.http;

  if (result.type === "no-payment-required") return handler();
  const facilitatorName = server.facilitator;
  if (result.type === "payment-error") {
    const { status, headers, body: resBody } = result.response;
    return new Response(JSON.stringify(resBody ?? {}), {
      status,
      headers: { "Content-Type": "application/json", "X-Facilitator": facilitatorName, ...(lastCdpError ? { "X-Facilitator-Note": "cdp init failed: " + lastCdpError.replace(/[^\x20-\x7e]/g, "") } : {}), ...headers },
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
  try {
    const pr = Object.entries(settle.headers).find(([k]) => k.toLowerCase() === "payment-response")?.[1];
    const receipt = pr ? JSON.parse(atob(pr)) : {};
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS x402_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, tx TEXT, payer TEXT, amount_units TEXT, path TEXT, network TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))").run();
    await env.DB.prepare("INSERT INTO x402_payments (tx, payer, amount_units, path, network) VALUES (?, ?, ?, ?, ?)")
      .bind(receipt.transaction ?? null, receipt.payer ?? null, String((paymentRequirements as any).amount ?? ""), new URL(request.url).pathname, receipt.network ?? null).run();
  } catch { /* logging must never break a paid call */ }
  out.headers.set("Cache-Control", withPrivateCacheControl(out.headers.get("Cache-Control")));
  return out;
}
