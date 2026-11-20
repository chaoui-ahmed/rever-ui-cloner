import { paidEndpoint } from "../_paid";
import { extractDesignTokens } from "../_services";
export const { onRequestOptions, onRequestGet, onRequestPost } = paidEndpoint(
  (env, url) => extractDesignTokens(env, url), '{"url": "https://..."}');
