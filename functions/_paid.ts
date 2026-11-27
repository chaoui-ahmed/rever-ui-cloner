// Factory for x402-only paid endpoints. Not a route.
// The paywall runs before request validation, so unpaid probes always get a 402.
import { type Env, json, corsHeaders, validateTargetUrl } from "./_shared";
import { withX402 } from "./_x402";
import { UpstreamError, SERVICES } from "./_services";
import { accessKeyFrom, resolveKey, charge, refund, usd, UNITS_PER_USD } from "./_credits";

const withCors = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
  return out;
};

export const methodNotAllowed = (docsHint: string) =>
  withCors(new Response(JSON.stringify({ error: `Use POST with JSON body ${docsHint}. Docs: https://www.aypiai.online/llms.txt` }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST, OPTIONS" },
  }));

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

type Validate = (body: Record<string, unknown>) => { ok: string } | { error: string };
const urlInput: Validate = (body) => {
  const url = validateTargetUrl(body.url);
  return url ? { ok: url } : { error: 'Valid public http(s) URL required in field "url"' };
};

export function paidEndpoint(
  run: (env: Env, input: string, body: Record<string, unknown>) => Promise<unknown>,
  docsHint: string,
  validate: Validate = urlInput,
) {
  const onRequest: PagesFunction<Env> = async ({ request, env }) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") return methodNotAllowed(docsHint);

    const body = await readJsonBody(request);

    // ---- Prepaid card credits (X-Access-Key or Authorization: Bearer cs_...) ----
    const key = accessKeyFrom(request);
    if (key) {
      const path = new URL(request.url).pathname.replace(/\/$/, "");
      const svc = SERVICES.find((s) => s.path === path);
      if (!svc) return withCors(json({ error: "Unknown endpoint" }, 404));
      const state = await resolveKey(env, key);
      if (state.kind === "error") return withCors(json({ error: state.reason }, state.status));
      if (state.kind === "legacy") return withCors(json({ error: "This key is an old pack valid on /api/generate-prompt only. Buy credits for all tools at https://www.aypiai.online/credits" }, 402));
      const v = validate(body);
      if ("error" in v) return withCors(json({ error: v.error }, 400));
      const url = v.ok;
      const units = Math.round(Number(svc.priceUsd) * UNITS_PER_USD);
      const left = await charge(env, key, units);
      if (left === null) return withCors(json({ error: `Not enough credit: this call costs $${svc.priceUsd}, balance $${usd(state.balanceUnits)}. Top up at https://www.aypiai.online/credits` }, 402));
      try {
        const out = json(await run(env, url, body));
        out.headers.set("X-Credits-Remaining-Usd", String(usd(left)));
        out.headers.set("X-Credits-Charged-Usd", svc.priceUsd);
        return withCors(out);
      } catch (err) {
        await refund(env, key, units);
        return withCors(json({ error: (err as Error).message, charged: false }, err instanceof UpstreamError ? 502 : 500));
      }
    }

    const res = await withX402(env, request, body, async () => {
      // Runs only after payment is verified; a 4xx/5xx here cancels the payment (never charged).
      const v = validate(body);
      if ("error" in v) return json({ error: v.error }, 400);
      try {
        return json(await run(env, v.ok, body));
      } catch (err) {
        return json({ error: (err as Error).message }, err instanceof UpstreamError ? 502 : 500);
      }
    });
    return withCors(res ?? json({ error: "Payments temporarily unavailable, retry shortly" }, 503));
  };
  return { onRequest };
}
