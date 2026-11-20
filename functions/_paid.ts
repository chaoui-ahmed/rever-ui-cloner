// Factory for x402-only paid endpoints. Not a route.
import { type Env, json, corsHeaders, validateTargetUrl } from "./_shared";
import { withX402 } from "./_x402";
import { UpstreamError } from "./_services";

const withCors = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
  return out;
};

export function paidEndpoint(
  run: (env: Env, url: string, body: Record<string, unknown>) => Promise<unknown>,
  docsHint: string,
) {
  const onRequestOptions: PagesFunction<Env> = () => new Response(null, { headers: corsHeaders });
  const onRequestGet: PagesFunction<Env> = () =>
    json({ error: `Use POST with JSON body ${docsHint}. Docs: https://www.aypiai.online/llms.txt` }, 405);
  const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return withCors(json({ error: "Body must be valid JSON" }, 400));
    }
    const url = validateTargetUrl(body?.url);
    if (!url) return withCors(json({ error: "Valid public http(s) URL required in field \"url\"" }, 400));

    const res = await withX402(env, request, body, async () => {
      try {
        return json(await run(env, url, body));
      } catch (err) {
        return json({ error: (err as Error).message }, err instanceof UpstreamError ? 502 : 500);
      }
    });
    return withCors(res ?? json({ error: "Payments temporarily unavailable, retry shortly" }, 503));
  };
  return { onRequestOptions, onRequestGet, onRequestPost };
}
