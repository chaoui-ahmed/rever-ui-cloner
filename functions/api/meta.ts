import { paidEndpoint } from "../_paid";
import { pageMeta } from "../_web";
export const { onRequest } = paidEndpoint((env, url, body) => pageMeta(env, url, body), '{"url": "https://..."}');
