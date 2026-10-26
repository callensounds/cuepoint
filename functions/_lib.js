// Shared data-collection code. Files starting with "_" are not routes.
// Sources: MusicBrainz (CC0 identity + links), Wikidata/Wikipedia pageviews (open).

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
  ["spotify.com", "Spotify"], ["youtube.com", "YouTube"], ["instagram.com", "Instagram"],
  ["tiktok.com", "TikTok"], ["bandcamp.com", "Bandcamp"], ["soundcloud.com", "SoundCloud"],
  ["music.apple.com", "Apple Music"], ["twitter.com", "X"], ["x.com", "X"], ["facebook.com", "Facebook"],
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

// ---------- storage ----------
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
