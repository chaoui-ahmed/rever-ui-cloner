import { paidEndpoint } from "../_paid";
import { brandKit } from "../_web";
export const { onRequest } = paidEndpoint((env, url, body) => brandKit(env, url, body), '{"url": "https://..."}');
