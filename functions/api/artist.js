// GET /api/artist?q=<name>   or   /api/artist?mbid=<MusicBrainz ID>
// Looks the artist up, records today's snapshot, and returns everything the dashboard needs.
import {
  json, sleep, searchArtists, getArtist, getWikiTitle, getPageviews, getStreaming,
  saveArtist, saveSnapshot, saveDeezerId,
} from "../_lib.js";
import { artistCharts, deezerFanHistory } from "../_charts.js";

const CACHE_V = 5;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestGet({ request, env, waitUntil }) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim().slice(0, 120);
  let mbid = (u.searchParams.get("mbid") || "").trim();
  if (!q && !mbid) return json({ error: "Type an artist name to look them up." }, 400);
  if (mbid && !MBID.test(mbid)) return json({ error: "That artist link is broken. Search by name instead." }, 400);

  const cache = caches.default;
  const cacheKey = new Request(
    // Bump CACHE_V whenever the response shape changes, so stale cached lookups aren't served.
    `${u.origin}/api/artist?v=${CACHE_V}&${mbid ? "mbid=" + mbid.toLowerCase() : "q=" + encodeURIComponent(q.toLowerCase())}`
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // Per-step timings, returned in the Server-Timing header to spot slow sources.
  const marks = [];
  let last = Date.now();
  const mark = (name) => { const now = Date.now(); marks.push(`${name};dur=${now - last}`); last = now; };

  try {
    let matches = [];
    // Artists Cuepoint already knows skip the MusicBrainz search (it's often rate-limited).
    if (!mbid && env.DB) {
      const known = await env.DB.prepare("SELECT mbid FROM artists WHERE name = ? COLLATE NOCASE LIMIT 1").bind(q).first().catch(() => null);
      if (known) { mbid = known.mbid; mark("known"); }
    }
    if (!mbid) {
      matches = await searchArtists(q);
      mark("mb-search");
      if (!matches.length) return json({ error: `No artist called “${q}” on MusicBrainz. Check the spelling.` }, 404);
      mbid = matches[0].mbid;
      await sleep(1100); // MusicBrainz allows about one request per second
      mark("mb-wait");
    }

    const artist = await getArtist(mbid);
    mark("mb-artist");
    const [wiki, streaming] = await Promise.all([
      getWikiTitle(artist.wikidata).catch(() => null)
        .then((t) => getPageviews(t).catch(() => null)),
      getStreaming(artist, waitUntil).catch(() => null),
    ]);
    const wikiTitle = wiki ? wiki.title : null;
    mark("sources");

    const firstSeen = await saveArtist(env, artist, wikiTitle);
    if (wiki) {
      const last30 = wiki.days.slice(-30).reduce((s, x) => s + x.v, 0);
      await saveSnapshot(env, artist.mbid, "wikipedia", { views_30d: last30 });
    }
    const dz = streaming && streaming.deezer;
    if (dz) {
      await saveDeezerId(env, artist.mbid, dz.id);
      if (env.DB) {
        await env.DB.prepare("INSERT OR REPLACE INTO deezer_fans (deezer_id, day, name, fans) VALUES (?, date('now'), ?, ?)")
          .bind(dz.id, artist.name, dz.fans).run();
      }
      dz.history = await deezerFanHistory(env, dz.id);
    }
    mark("save");
    const charts = await artistCharts(env, artist.name, dz ? dz.id : null).catch(() => null);
    mark("charts");

    const body = {
      artist,
      matches: matches.slice(1),
      wiki,
      streaming,
      charts,
      tracked_since: firstSeen,
      storage_enabled: !!env.DB,
      fetched_at: new Date().toISOString(),
    };
    // Browsers keep it 5 minutes; Cloudflare's edge cache keeps it 6 hours.
    const resp = json(body, 200, { "Cache-Control": "public, max-age=300, s-maxage=21600", "Server-Timing": marks.join(", ") });
    waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    const busy = e.status === 503 || e.status === 429 || e.status === 504;
    return json(
      { error: busy ? "MusicBrainz is slow or busy right now. Try again in a few seconds." : `Lookup failed: ${e.message}. Try again in a minute.` },
      502,
      { "Server-Timing": marks.join(", ") }
    );
  }
}
