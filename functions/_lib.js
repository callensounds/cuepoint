// Shared data-collection code. Files starting with "_" are not routes.
// Sources: MusicBrainz (CC0 identity + links), Wikidata/Wikipedia pageviews (open),
// Deezer public API (fans, top tracks), Apple Music public chart feeds (Top 100 songs by country).

const UA = "Cuepoint/0.1 (+https://github.com/callensounds/cuepoint)";
const HEADERS = { "User-Agent": UA, Accept: "application/json" };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const today = () => new Date().toISOString().slice(0, 10);

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

async function getJSON(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) {
    const err = new Error(`${new URL(url).hostname} answered ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ---------- MusicBrainz ----------
export async function searchArtists(q) {
  const query = `artist:"${q.replace(/"/g, "")}"`;
  const s = await getJSON(
    `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(query)}&limit=5&fmt=json`
  );
  return (s.artists || []).map((a) => ({
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation || "",
    country: a.country || "",
    score: a.score,
  }));
}

const LINK_KINDS = [
  ["open.spotify.com", "Spotify"], ["music.apple.com", "Apple Music"], ["itunes.apple.com", "Apple Music"],
  ["music.amazon.", "Amazon Music"], ["tidal.com", "TIDAL"], ["deezer.com", "Deezer"],
  ["youtube.com", "YouTube"], ["instagram.com", "Instagram"], ["tiktok.com", "TikTok"],
  ["bandcamp.com", "Bandcamp"], ["soundcloud.com", "SoundCloud"],
  ["//twitter.com", "X"], ["//x.com", "X"], ["//www.x.com", "X"], ["facebook.com", "Facebook"],
];

export async function getArtist(mbid) {
  const a = await getJSON(
    `https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+tags+genres&fmt=json`
  );
  const byCount = (list) => (list || []).slice().sort((x, y) => (y.count || 0) - (x.count || 0)).map((t) => t.name);
  const genres = byCount(a.genres);
  const tags = (genres.length ? genres : byCount(a.tags)).slice(0, 4);
  let wikidata = null;
  const links = [];
  for (const rel of a.relations || []) {
    const url = rel.url && rel.url.resource;
    if (!url) continue;
    if (rel.type === "wikidata") wikidata = url.split("/").pop();
    else if (rel.type === "official homepage") links.push({ kind: "Website", url });
    else {
      const k = LINK_KINDS.find(([host]) => url.includes(host));
      if (k && !links.some((l) => l.kind === k[1])) links.push({ kind: k[1], url });
    }
  }
  return {
    mbid: a.id,
    name: a.name,
    type: a.type || "",
    country: a.country || "",
    area: (a.area && a.area.name) || "",
    disambiguation: a.disambiguation || "",
    began: (a["life-span"] && a["life-span"].begin) || "",
    tags,
    wikidata,
    links,
  };
}

// ---------- Wikipedia ----------
export async function getWikiTitle(qid) {
  if (!qid) return null;
  const d = await getJSON(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`
  );
  const e = d.entities && d.entities[qid];
  return (e && e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title) || null;
}

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

export async function getPageviews(title) {
  if (!title) return null;
  const end = new Date(Date.now() - 86400000);
  const start = new Date(end.getTime() - 364 * 86400000);
  const article = encodeURIComponent(title.replace(/ /g, "_"));
  let items = [];
  try {
    const d = await getJSON(
      `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${article}/daily/${ymd(start)}00/${ymd(end)}00`
    );
    items = d.items || [];
  } catch (e) {
    if (e.status !== 404) throw e; // 404 = no views recorded yet
  }
  const byDay = new Map(items.map((i) => [i.timestamp.slice(0, 8), i.views]));
  const days = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    days.push({ d: d.toISOString().slice(0, 10), v: byDay.get(ymd(d)) || 0 });
  }
  return {
    title,
    url: `https://en.wikipedia.org/wiki/${article}`,
    days,
  };
}

// ---------- streaming services ----------
// Only Deezer and Apple's public chart feeds expose anything without special access.
// Spotify (since Feb 2026), TIDAL and Amazon Music don't give third parties artist stats,
// so for those we only surface the artist's profile link (from MusicBrainz).

const linkFor = (artist, kind) => (artist.links.find((l) => l.kind === kind) || {}).url || null;
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

async function deezer(path) {
  const d = await getJSON(`https://api.deezer.com/${path}`);
  if (d && d.error) {
    const err = new Error(`Deezer: ${d.error.message || "error"}`);
    err.status = d.error.code === 4 ? 429 : 502; // code 4 = quota exceeded
    throw err;
  }
  return d;
}

export async function findDeezerId(artist) {
  const url = linkFor(artist, "Deezer");
  const m = url && url.match(/artist\/(\d+)/);
  if (m) return m[1];
  // No link on MusicBrainz: only accept an exact name match, so we never show the wrong artist.
  const s = await deezer(`search/artist?q=${encodeURIComponent(artist.name)}&limit=5`);
  const hit = (s.data || []).find((a) => norm(a.name) === norm(artist.name));
  return hit ? String(hit.id) : null;
}

export async function getDeezer(id) {
  if (!id) return null;
  const [a, top] = await Promise.all([
    deezer(`artist/${id}`),
    deezer(`artist/${id}/top?limit=5`).catch(() => ({ data: [] })),
  ]);
  return {
    id: String(a.id),
    url: a.link,
    picture: a.picture_medium || null,
    fans: +a.nb_fan || 0,
    albums: +a.nb_album || 0,
    top: (top.data || []).map((t) => ({
      title: t.title_short || t.title,
      album: (t.album && t.album.title) || "",
      rank: +t.rank || 0,
      url: t.link,
    })),
  };
}

export const CHART_COUNTRIES = [
  ["us", "US"], ["gb", "UK"], ["ca", "Canada"], ["au", "Australia"], ["de", "Germany"], ["mx", "Mexico"],
];

async function appleTop100(country, waitUntil) {
  const url = `https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/songs.json`;
  const cache = caches.default;
  const key = new Request(`https://cuepoint.cache/apple/${country}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const d = await getJSON(url);
  const results = ((d.feed && d.feed.results) || []).map((r, i) => ({
    pos: i + 1, song: r.name, artist: r.artistName, artistId: r.artistId, url: r.url,
  }));
  const resp = new Response(JSON.stringify(results), { headers: { "Cache-Control": "public, max-age=10800" } });
  const put = cache.put(key, resp);
  if (waitUntil) waitUntil(put); else await put;
  return results;
}

export async function getAppleCharts(artist, waitUntil) {
  const url = linkFor(artist, "Apple Music");
  const m = url && url.match(/(?:\/|id)(\d{5,})(?:[/?#]|$)/);
  const appleId = m ? m[1] : null;
  const me = norm(artist.name);
  // Credits like "Artist A & Artist B" or "A, B": count the artist if they're one of the named artists.
  const credited = (s) => norm(s) === me || String(s).split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bwith\b)\s*/i).some((p) => norm(p) === me);
  const lists = await Promise.all(
    CHART_COUNTRIES.map(([c]) => appleTop100(c, waitUntil).catch(() => null))
  );
  const entries = [];
  lists.forEach((list, i) => {
    if (!list) return;
    const [code, label] = CHART_COUNTRIES[i];
    for (const r of list) {
      if ((appleId && r.artistId === appleId) || credited(r.artist)) {
        entries.push({ country: code, label, pos: r.pos, song: r.song, url: r.url });
      }
    }
  });
  entries.sort((a, b) => a.pos - b.pos);
  return {
    checked: CHART_COUNTRIES.filter((_, i) => lists[i]).map(([, l]) => l),
    entries,
    url,
  };
}

export async function getStreaming(artist, waitUntil) {
  const deezerId = await findDeezerId(artist).catch(() => null);
  const [dz, apple] = await Promise.all([
    getDeezer(deezerId).catch(() => null),
    getAppleCharts(artist, waitUntil).catch(() => null),
  ]);
  return {
    deezer: dz,
    apple,
    spotify: { url: linkFor(artist, "Spotify") },
    amazon: { url: linkFor(artist, "Amazon Music") },
    tidal: { url: linkFor(artist, "TIDAL") },
  };
}

// ---------- storage ----------
export async function saveDeezerId(env, mbid, id) {
  if (!env.DB || !id) return;
  await env.DB.prepare("UPDATE artists SET deezer_id=? WHERE mbid=?").bind(String(id), mbid).run();
}

export async function saveArtist(env, a, wikiTitle) {
  if (!env.DB) return null;
  const now = today();
  await env.DB.prepare(
    `INSERT INTO artists (mbid, name, country, area, type, tags, wiki_title, first_seen, last_collected)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(mbid) DO UPDATE SET name=?2, country=?3, area=?4, type=?5, tags=?6, wiki_title=?7, last_collected=?8`
  ).bind(a.mbid, a.name, a.country, a.area, a.type, JSON.stringify(a.tags), wikiTitle, now).run();
  const row = await env.DB.prepare("SELECT first_seen FROM artists WHERE mbid=?").bind(a.mbid).first();
  return row ? row.first_seen : now;
}

export async function saveSnapshot(env, mbid, source, metrics) {
  if (!env.DB) return;
  const day = today();
  const stmt = env.DB.prepare(
    "INSERT OR REPLACE INTO snapshots (mbid, day, source, metric, value) VALUES (?, ?, ?, ?, ?)"
  );
  await env.DB.batch(
    Object.entries(metrics).map(([metric, value]) => stmt.bind(mbid, day, source, metric, value))
  );
}

export async function getHistory(env, mbid, source) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare(
    "SELECT day, metric, value FROM snapshots WHERE mbid=? AND source=? ORDER BY day"
  ).bind(mbid, source).all();
  const byDay = new Map();
  for (const r of results) {
    if (!byDay.has(r.day)) byDay.set(r.day, { d: r.day });
    byDay.get(r.day)[r.metric] = r.value;
  }
  return [...byDay.values()];
}
