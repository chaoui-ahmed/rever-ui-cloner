import { paidEndpoint } from "../_paid";
import { detectTechStack } from "../_services";
export const { onRequestOptions, onRequestGet, onRequestPost } = paidEndpoint(
  (env, url) => detectTechStack(env, url), '{"url": "https://..."}');
