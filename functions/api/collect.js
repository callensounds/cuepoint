// GET /api/collect — refreshes today's Last.fm and Wikipedia snapshot for tracked artists
// that haven't been collected yet today (10 per call). Safe to call repeatedly; ping it daily.
import { json, today, getLastfm, getPageviews, saveSnapshot } from "../_lib.js";

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "Database isn't connected to this site." }, 500);
  const day = today();
  const { results } = await env.DB.prepare(
    "SELECT mbid, name, wiki_title FROM artists WHERE last_collected IS NULL OR last_collected < ? LIMIT 10"
  ).bind(day).all();

  const done = [];
  for (const a of results) {
    const [lf, wiki] = await Promise.all([
      getLastfm(env, a.mbid, a.name).catch(() => null),
      getPageviews(a.wiki_title).catch(() => null),
    ]);
    if (lf) await saveSnapshot(env, a.mbid, "lastfm", { listeners: lf.listeners, playcount: lf.playcount });
    if (wiki) await saveSnapshot(env, a.mbid, "wikipedia", { views_30d: wiki.days.slice(-30).reduce((s, x) => s + x.v, 0) });
    await env.DB.prepare("UPDATE artists SET last_collected=? WHERE mbid=?").bind(day, a.mbid).run();
    done.push(a.name);
  }
  const left = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM artists WHERE last_collected IS NULL OR last_collected < ?"
  ).bind(day).first();
  return json({ collected: done, remaining_today: left.n });
}
