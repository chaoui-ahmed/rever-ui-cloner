// Factory for x402-only paid endpoints. Not a route.
// The paywall runs before request validation, so unpaid probes always get a 402.
import { type Env, json, corsHeaders, validateTargetUrl } from "./_shared";
import { withX402 } from "./_x402";
import { UpstreamError } from "./_services";

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

export function paidEndpoint(
  run: (env: Env, url: string, body: Record<string, unknown>) => Promise<unknown>,
  docsHint: string,
) {
  const onRequest: PagesFunction<Env> = async ({ request, env }) => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "POST") return methodNotAllowed(docsHint);

    const body = await readJsonBody(request);
    const res = await withX402(env, request, body, async () => {
      // Runs only after payment is verified; a 4xx/5xx here cancels the payment (never charged).
      const url = validateTargetUrl(body.url);
      if (!url) return json({ error: "Valid public http(s) URL required in field \"url\"" }, 400);
      try {
        return json(await run(env, url, body));
      } catch (err) {
        return json({ error: (err as Error).message }, err instanceof UpstreamError ? 502 : 500);
      }
    });
    return withCors(res ?? json({ error: "Payments temporarily unavailable, retry shortly" }, 503));
  };
  return { onRequest };
}
