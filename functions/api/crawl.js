// GET /api/crawl — runs one crawl step now (the hourly schedule does this automatically).
// Safe to call repeatedly: each chart is fetched at most once per day.
import { json } from "../_lib.js";
import { crawlStep } from "../_charts.js";

export async function onRequestGet({ env }) {
  try {
    return json(await crawlStep(env));
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
