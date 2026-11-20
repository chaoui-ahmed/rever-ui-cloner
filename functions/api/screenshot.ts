import { paidEndpoint } from "../_paid";
import { screenshotService } from "../_services";
export const { onRequest } = paidEndpoint(
  (env, url, body) => screenshotService(env, url, body), '{"url": "https://...", "width": 1280, "fullPage": false}');
