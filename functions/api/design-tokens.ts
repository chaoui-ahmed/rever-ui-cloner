import { paidEndpoint } from "../_paid";
import { extractDesignTokens } from "../_services";
export const { onRequest } = paidEndpoint(
  (env, url) => extractDesignTokens(env, url), '{"url": "https://..."}');
