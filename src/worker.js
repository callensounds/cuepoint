// Cuepoint Worker entry point.
// The site is deployed as a Cloudflare Worker with static assets (public/).
// Requests to /api/* run the handlers in functions/api/; everything else is served from public/.
// The handlers keep their Pages-style signature ({ request, env, waitUntil }) so they stay simple.
import * as artist from "../functions/api/artist.js";
import * as tracked from "../functions/api/tracked.js";
import * as collect from "../functions/api/collect.js";
import * as health from "../functions/api/health.js";
import { json } from "../functions/_lib.js";

const ROUTES = {
  "/api/artist": artist,
  "/api/tracked": tracked,
  "/api/collect": collect,
  "/api/health": health,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const route = ROUTES[pathname.replace(/\/+$/, "")];
    if (route) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "Method not allowed" }, 405, { Allow: "GET, HEAD" });
      }
      return route.onRequestGet({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }
    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },

  // Hourly cron: refresh today's snapshot for up to 10 tracked artists per run,
  // so every tracked artist gets a daily data point without anyone pinging /api/collect.
  async scheduled(event, env, ctx) {
    const request = new Request("https://cuepoint.internal/api/collect");
    ctx.waitUntil(collect.onRequestGet({ request, env, waitUntil: (p) => ctx.waitUntil(p) }));
  },
};
