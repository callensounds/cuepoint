// GET /api/artist?q=<name>   or   /api/artist?mbid=<MusicBrainz ID>
// Looks the artist up, records today's snapshot, and returns everything the dashboard needs.
import {
  json, sleep, searchArtists, getArtist, getWikiTitle, getPageviews, getStreaming,
  saveArtist, saveSnapshot, saveDeezerId, getHistory,
} from "../_lib.js";

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestGet({ request, env, waitUntil }) {
  const u = new URL(request.url);
  const q = (u.searchParams.get("q") || "").trim().slice(0, 120);
  let mbid = (u.searchParams.get("mbid") || "").trim();
  if (!q && !mbid) return json({ error: "Type an artist name to look them up." }, 400);
  if (mbid && !MBID.test(mbid)) return json({ error: "That artist link is broken. Search by name instead." }, 400);

  const cache = caches.default;
  const cacheKey = new Request(
    `${u.origin}/api/artist?${mbid ? "mbid=" + mbid.toLowerCase() : "q=" + encodeURIComponent(q.toLowerCase())}`
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    let matches = [];
    if (!mbid) {
      matches = await searchArtists(q);
      if (!matches.length) return json({ error: `No artist called “${q}” on MusicBrainz. Check the spelling.` }, 404);
      mbid = matches[0].mbid;
      await sleep(1100); // MusicBrainz allows about one request per second
    }

    const artist = await getArtist(mbid);
    const wikiTitle = await getWikiTitle(artist.wikidata).catch(() => null);
    const [wiki, streaming] = await Promise.all([
      getPageviews(wikiTitle).catch(() => null),
      getStreaming(artist, waitUntil).catch(() => null),
    ]);

    const firstSeen = await saveArtist(env, artist, wikiTitle);
    if (wiki) {
      const last30 = wiki.days.slice(-30).reduce((s, x) => s + x.v, 0);
      await saveSnapshot(env, artist.mbid, "wikipedia", { views_30d: last30 });
    }
    const dz = streaming && streaming.deezer;
    if (dz) {
      await saveDeezerId(env, artist.mbid, dz.id);
      await saveSnapshot(env, artist.mbid, "deezer", { fans: dz.fans });
      dz.history = await getHistory(env, artist.mbid, "deezer");
    }

    const body = {
      artist,
      matches: matches.slice(1),
      wiki,
      streaming,
      tracked_since: firstSeen,
      storage_enabled: !!env.DB,
      fetched_at: new Date().toISOString(),
    };
    const resp = json(body, 200, { "Cache-Control": "public, max-age=21600" });
    waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    const busy = e.status === 503 || e.status === 429;
    return json(
      { error: busy ? "MusicBrainz is busy right now. Try again in a few seconds." : `Lookup failed: ${e.message}. Try again in a minute.` },
      502
    );
  }
}
