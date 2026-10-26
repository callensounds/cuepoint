// GET /api/collect — refreshes today's Wikipedia and Deezer snapshot for tracked artists
// that haven't been collected yet today (10 per call). Safe to call repeatedly; ping it daily.
import { json, today, getPageviews, getDeezer, saveSnapshot } from "../_lib.js";

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "Database isn't connected to this site." }, 500);
  const day = today();
  const { results } = await env.DB.prepare(
    "SELECT mbid, name, wiki_title, deezer_id FROM artists WHERE last_collected IS NULL OR last_collected < ? LIMIT 10"
  ).bind(day).all();

  const done = [];
  for (const a of results) {
    const [wiki, dz] = await Promise.all([
      getPageviews(a.wiki_title).catch(() => null),
      getDeezer(a.deezer_id).catch(() => null),
    ]);
    if (dz) await saveSnapshot(env, a.mbid, "deezer", { fans: dz.fans });
    if (wiki) await saveSnapshot(env, a.mbid, "wikipedia", { views_30d: wiki.days.slice(-30).reduce((s, x) => s + x.v, 0) });
    await env.DB.prepare("UPDATE artists SET last_collected=? WHERE mbid=?").bind(day, a.mbid).run();
    done.push(a.name);
  }
  const left = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM artists WHERE last_collected IS NULL OR last_collected < ?"
  ).bind(day).first();
  return json({ collected: done, remaining_today: left.n });
}
