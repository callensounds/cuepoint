// Cuepoint Worker entry point.
// The site is deployed as a Cloudflare Worker with static assets (public/).
// Requests to /api/* run the handlers in functions/api/; everything else is served from public/.
// The handlers keep their Pages-style signature ({ request, env, waitUntil }) so they stay simple.
import * as artist from "../functions/api/artist.js";
import * as tracked from "../functions/api/tracked.js";
import * as collect from "../functions/api/collect.js";
import * as health from "../functions/api/health.js";
import * as charts from "../functions/api/charts.js";
import * as crawl from "../functions/api/crawl.js";
import { crawlStep } from "../functions/_charts.js";
import { json } from "../functions/_lib.js";

const ROUTES = {
  "/api/artist": artist,
  "/api/tracked": tracked,
  "/api/collect": collect,
  "/api/health": health,
  "/api/charts": charts,
  "/api/crawl": crawl,
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

  // Two hourly jobs (see [triggers] in wrangler.toml):
  //   :37 — chart crawl step (Apple Music + Deezer charts, Deezer fans for charting artists)
  //   :07 — daily snapshot for up to 10 searched artists (Wikipedia + Deezer)
  async scheduled(event, env, ctx) {
    if (event.cron === "37 * * * *") {
      ctx.waitUntil(crawlStep(env).catch((e) => console.error("crawl failed", e)));
      return;
    }
    const request = new Request("https://cuepoint.internal/api/collect");
    ctx.waitUntil(collect.onRequestGet({ request, env, waitUntil: (p) => ctx.waitUntil(p) }));
  },
};
