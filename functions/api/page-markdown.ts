import { paidEndpoint } from "../_paid";
import { pageMarkdown } from "../_web";
export const { onRequest } = paidEndpoint((env, url, body) => pageMarkdown(env, url, body), '{"url": "https://..."}');
