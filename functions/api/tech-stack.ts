import { paidEndpoint } from "../_paid";
import { detectTechStack } from "../_services";
export const { onRequest } = paidEndpoint(
  (env, url) => detectTechStack(env, url), '{"url": "https://..."}');
