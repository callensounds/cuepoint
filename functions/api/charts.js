// GET /api/charts                              — overview: latest crawl day, available charts, movers, new entries
// GET /api/charts?feed=apple:songs:us          — one chart with movement, peak and days on chart
import { json } from "../_lib.js";
import { chartsOverview, chartFeed } from "../_charts.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: "Database isn't connected to this site." }, 500);
  const feed = new URL(request.url).searchParams.get("feed");
  try {
    if (feed) {
      const [source, chart, region] = feed.split(":");
      if (!source || !chart || !region) return json({ error: "Unknown chart." }, 400);
      return json(await chartFeed(env, source, chart, region), 200, { "Cache-Control": "public, max-age=300" });
    }
    return json(await chartsOverview(env), 200, { "Cache-Control": "public, max-age=300" });
  } catch (e) {
    return json({ error: `Couldn't load charts: ${e.message}` }, 500);
  }
}
