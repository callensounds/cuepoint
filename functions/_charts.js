// Chart crawler + chart queries.
// Every day the scheduled job reads public chart feeds and stores each position in D1:
//   - Apple Music: Top 100 songs and albums in APPLE_COUNTRIES (Apple's public marketing RSS feeds)
//   - Deezer: global and genre Top 100 tracks (Deezer's public API)
// Artists seen on Deezer charts also get a daily Deezer fan-count snapshot (auto-discovery).
// Work is split across hourly runs (FEEDS_PER_RUN, FANS_PER_RUN) to stay inside per-run request limits.

import { today, sleep } from "./_lib.js";

const UA = "Cuepoint/0.2 (+https://github.com/callensounds/cuepoint)";
const FEEDS_PER_RUN = 8;
const FANS_PER_RUN = 30;
const DEEZER_GENRES = 10; // genre charts beyond "All"

export const APPLE_COUNTRIES = [
  ["us", "US"], ["gb", "UK"], ["ca", "Canada"], ["au", "Australia"], ["ie", "Ireland"],
  ["de", "Germany"], ["fr", "France"], ["mx", "Mexico"], ["br", "Brazil"], ["jp", "Japan"],
];

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  const d = await r.json();
  if (d && d.error) throw new Error(`Deezer: ${d.error.message || "error"}`);
  return d;
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export const splitCredit = (credit) =>
  String(credit || "").split(/\s*(?:,|&|\sx\s|\bfeat\.?|\bft\.?|\bwith\b)\s*/i).map((p) => p.trim()).filter(Boolean);

// ---------- feed list ----------
async function feedList(env) {
  const feeds = [];
  for (const [cc, name] of APPLE_COUNTRIES) {
    feeds.push({ key: `apple:songs:${cc}`, source: "apple", chart: "songs", region: cc, label: `Apple Music · Top songs · ${name}` });
    feeds.push({ key: `apple:albums:${cc}`, source: "apple", chart: "albums", region: cc, label: `Apple Music · Top albums · ${name}` });
  }
  const { results } = await env.DB.prepare(
    "SELECT region, label FROM chart_feeds WHERE source='deezer' ORDER BY CAST(region AS INTEGER)"
  ).all();
  for (const r of results) {
    feeds.push({ key: `deezer:tracks:${r.region}`, source: "deezer", chart: "tracks", region: r.region, label: r.label });
  }
  return feeds;
}

// Deezer's genre list ("editorial") decides which genre charts exist; refresh it once a day.
async function refreshDeezerGenres(env) {
  const d = await getJSON("https://api.deezer.com/editorial");
  const genres = (d.data || []).filter((g) => g.id !== 0).slice(0, DEEZER_GENRES);
  const stmt = env.DB.prepare(
    "INSERT INTO chart_feeds (source, chart, region, label) VALUES ('deezer', 'tracks', ?, ?) ON CONFLICT(source, chart, region) DO UPDATE SET label=excluded.label"
  );
  await env.DB.batch([
    stmt.bind("0", "Deezer · Top tracks · Worldwide"),
    ...genres.map((g) => stmt.bind(String(g.id), `Deezer · Top tracks · ${g.name}`)),
  ]);
  return genres.length + 1;
}

async function fetchFeed(f) {
  if (f.source === "apple") {
    const d = await getJSON(`https://rss.marketingtools.apple.com/api/v2/${f.region}/music/most-played/100/${f.chart}.json`);
    return ((d.feed && d.feed.results) || []).map((r, i) => ({
      pos: i + 1, title: r.name, artist: r.artistName, artist_id: r.artistId || null, url: r.url || null,
    }));
  }
  const d = await getJSON(`https://api.deezer.com/chart/${f.region}/tracks?limit=100`);
  return (d.data || []).map((t, i) => ({
    pos: t.position || i + 1, title: t.title_short || t.title, artist: (t.artist && t.artist.name) || "",
    artist_id: t.artist ? String(t.artist.id) : null, url: t.link || null,
  }));
}

async function logFeed(env, day, feed, n, error) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO crawl_log (day, feed, n, at, error) VALUES (?, ?, ?, ?, ?)"
  ).bind(day, feed, n, new Date().toISOString(), error).run();
}

// ---------- one crawl step (called hourly; also /api/crawl) ----------
export async function crawlStep(env) {
  if (!env.DB) throw new Error("Database isn't connected to this site.");
  const day = today();
  const { results: doneRows } = await env.DB.prepare(
    "SELECT feed FROM crawl_log WHERE day=? AND error IS NULL"
  ).bind(day).all();
  const done = new Set(doneRows.map((r) => r.feed));
  const out = { day, crawled: [], failed: [], fans: 0 };

  if (!done.has("deezer:genres")) {
    try { await logFeed(env, day, "deezer:genres", await refreshDeezerGenres(env), null); }
    catch (e) { await logFeed(env, day, "deezer:genres", 0, e.message); out.failed.push(`deezer:genres: ${e.message}`); }
  }

  const feeds = (await feedList(env)).filter((f) => !done.has(f.key)).slice(0, FEEDS_PER_RUN);
  const labelStmt = env.DB.prepare(
    "INSERT INTO chart_feeds (source, chart, region, label) VALUES (?, ?, ?, ?) ON CONFLICT(source, chart, region) DO UPDATE SET label=excluded.label"
  );
  const rowStmt = env.DB.prepare(
    "INSERT OR REPLACE INTO chart_entries (day, source, chart, region, pos, title, artist, artist_id, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const f of feeds) {
    try {
      const rows = await fetchFeed(f);
      if (!rows.length) throw new Error("feed was empty");
      await env.DB.batch([
        labelStmt.bind(f.source, f.chart, f.region, f.label),
        env.DB.prepare("DELETE FROM chart_entries WHERE day=? AND source=? AND chart=? AND region=?").bind(day, f.source, f.chart, f.region),
        ...rows.map((r) => rowStmt.bind(day, f.source, f.chart, f.region, r.pos, r.title, r.artist, r.artist_id, r.url)),
      ]);
      await logFeed(env, day, f.key, rows.length, null);
      out.crawled.push(`${f.key} (${rows.length})`);
    } catch (e) {
      await logFeed(env, day, f.key, 0, e.message);
      out.failed.push(`${f.key}: ${e.message}`);
    }
    if (f.source === "deezer") await sleep(150); // Deezer allows ~50 requests per 5 seconds
  }

  // Auto-discovery: daily Deezer fan counts for artists charting on Deezer in the last week.
  const { results: due } = await env.DB.prepare(
    `SELECT DISTINCT artist_id, artist FROM chart_entries
     WHERE source='deezer' AND artist_id IS NOT NULL AND day >= date(?1, '-6 day')
       AND artist_id NOT IN (SELECT deezer_id FROM deezer_fans WHERE day=?1)
     LIMIT ${FANS_PER_RUN}`
  ).bind(day).all();
  const fanStmt = env.DB.prepare("INSERT OR REPLACE INTO deezer_fans (deezer_id, day, name, fans) VALUES (?, ?, ?, ?)");
  const fanRows = [];
  for (const a of due) {
    try {
      const d = await getJSON(`https://api.deezer.com/artist/${a.artist_id}`);
      fanRows.push(fanStmt.bind(a.artist_id, day, d.name || a.artist, +d.nb_fan || 0));
    } catch (e) { /* try again next run */ }
    await sleep(150);
  }
  if (fanRows.length) await env.DB.batch(fanRows);
  out.fans = fanRows.length;

  const left = (await feedList(env)).filter((f) => !done.has(f.key) && !out.crawled.some((c) => c.startsWith(f.key + " "))).length;
  out.feeds_left_today = left;
  return out;
}

// ---------- queries ----------
async function latestDays(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT day FROM chart_entries ORDER BY day DESC LIMIT 2"
  ).all();
  return [results[0] ? results[0].day : null, results[1] ? results[1].day : null];
}

export async function chartsOverview(env) {
  const [day, prev] = await latestDays(env);
  if (!day) return { day: null, feeds: [] };
  const { results: feeds } = await env.DB.prepare(
    `SELECT f.source, f.chart, f.region, f.label, COUNT(e.pos) AS n
     FROM chart_feeds f JOIN chart_entries e ON e.source=f.source AND e.chart=f.chart AND e.region=f.region AND e.day=?
     GROUP BY f.source, f.chart, f.region ORDER BY f.source, f.chart DESC, f.label`
  ).bind(day).all();

  const { results: rows } = await env.DB.prepare(
    `SELECT c.source, c.chart, c.region, c.pos, c.title, c.artist, c.url, p.pos AS prev
     FROM chart_entries c
     LEFT JOIN chart_entries p ON p.day=?2 AND p.source=c.source AND p.chart=c.chart AND p.region=c.region AND p.title=c.title AND p.artist=c.artist
     WHERE c.day=?1`
  ).bind(day, prev || "").all();

  const labels = new Map(feeds.map((f) => [`${f.source}:${f.chart}:${f.region}`, f.label]));
  const withLabel = (r) => ({ ...r, feed: `${r.source}:${r.chart}:${r.region}`, label: labels.get(`${r.source}:${r.chart}:${r.region}`) || "" });

  // Artists on the most charts today (counting each song/album entry once per chart).
  const byArtist = new Map();
  for (const r of rows) {
    for (const name of splitCredit(r.artist)) {
      const k = norm(name);
      const a = byArtist.get(k) || { artist: name, entries: 0, best: 999, feeds: new Set() };
      a.entries++; a.best = Math.min(a.best, r.pos); a.feeds.add(`${r.source}:${r.chart}:${r.region}`);
      byArtist.set(k, a);
    }
  }
  const most = [...byArtist.values()]
    .map((a) => ({ artist: a.artist, entries: a.entries, charts: a.feeds.size, best: a.best }))
    .sort((x, y) => y.entries - x.entries || x.best - y.best).slice(0, 10);

  // One row per song: keep its best chart (highest position / biggest jump) and count the charts it's on.
  const bySong = (list, better) => {
    const m = new Map();
    for (const r of list) {
      const k = `${r.title}\u0000${r.artist}`;
      const cur = m.get(k);
      if (!cur) m.set(k, { ...withLabel(r), charts: 1 });
      else { cur.charts++; if (better(r, cur)) Object.assign(cur, withLabel(r), { charts: cur.charts }); }
    }
    return [...m.values()];
  };
  let fresh = [], climbers = [];
  if (prev) {
    fresh = bySong(rows.filter((r) => r.prev == null), (r, c) => r.pos < c.pos)
      .sort((x, y) => x.pos - y.pos || y.charts - x.charts).slice(0, 10);
    climbers = bySong(rows.filter((r) => r.prev != null && r.prev - r.pos > 0), (r, c) => (r.prev - r.pos) > (c.prev - c.pos))
      .sort((x, y) => (y.prev - y.pos) - (x.prev - x.pos) || x.pos - y.pos).slice(0, 10);
  }
  return { day, prev, feeds, most, fresh, climbers, total_entries: rows.length };
}

export async function chartFeed(env, source, chart, region) {
  const [day, prev] = await latestDays(env);
  if (!day) return { day: null, entries: [] };
  const meta = await env.DB.prepare(
    "SELECT label FROM chart_feeds WHERE source=? AND chart=? AND region=?"
  ).bind(source, chart, region).first();
  const { results } = await env.DB.prepare(
    `SELECT c.pos, c.title, c.artist, c.artist_id, c.url,
       (SELECT p.pos FROM chart_entries p WHERE p.day=?5 AND p.source=c.source AND p.chart=c.chart AND p.region=c.region AND p.title=c.title AND p.artist=c.artist) AS prev,
       (SELECT MIN(h.pos) FROM chart_entries h WHERE h.source=c.source AND h.chart=c.chart AND h.region=c.region AND h.title=c.title AND h.artist=c.artist) AS peak,
       (SELECT COUNT(*) FROM chart_entries h WHERE h.source=c.source AND h.chart=c.chart AND h.region=c.region AND h.title=c.title AND h.artist=c.artist) AS days
     FROM chart_entries c WHERE c.day=?1 AND c.source=?2 AND c.chart=?3 AND c.region=?4 ORDER BY c.pos`
  ).bind(day, source, chart, region, prev || "").all();
  return { day, prev, label: meta ? meta.label : "", entries: results };
}

// Chart history for one artist. Credits like "A & B" or "A, B feat. C" count for each named artist.
export const credits = (credit, name) => {
  const me = norm(name);
  return norm(credit) === me || splitCredit(credit).some((p) => norm(p) === me);
};

export async function artistCharts(env, name, deezerId) {
  if (!env.DB || !name) return null;
  const [day] = await latestDays(env);
  if (!day) return null;
  const like = `%${String(name).replace(/[%_]/g, "")}%`;
  const { results } = await env.DB.prepare(
    `SELECT e.day, e.source, e.chart, e.region, e.pos, e.title, e.artist, e.artist_id, e.url, f.label
     FROM chart_entries e LEFT JOIN chart_feeds f ON f.source=e.source AND f.chart=e.chart AND f.region=e.region
     WHERE (e.artist LIKE ?1 OR (?2 IS NOT NULL AND e.source='deezer' AND e.artist_id=?2))
     ORDER BY e.day DESC LIMIT 5000`
  ).bind(like, deezerId || null).all();
  const mine = results.filter((r) => (deezerId && r.source === "deezer" && r.artist_id === deezerId) || credits(r.artist, name));
  const now = mine.filter((r) => r.day === day).sort((a, b) => a.pos - b.pos)
    .map(({ source, chart, region, pos, title, url, label }) => ({ source, chart, region, pos, title, url, label }));
  const titles = new Map();
  for (const r of mine) {
    const k = `${r.source}:${r.chart}:${r.title}`;
    const t = titles.get(k) || { title: r.title, chart: r.chart, source: r.source, peak: 999, peak_label: "", days: new Set(), feeds: new Set() };
    if (r.pos < t.peak) { t.peak = r.pos; t.peak_label = r.label || ""; }
    t.days.add(r.day); t.feeds.add(r.label || "");
    titles.set(k, t);
  }
  const history = [...titles.values()]
    .map((t) => ({ title: t.title, chart: t.chart, source: t.source, peak: t.peak, peak_label: t.peak_label, days: t.days.size, charts: t.feeds.size }))
    .sort((a, b) => a.peak - b.peak || b.days - a.days).slice(0, 12);
  const daysTracked = (await env.DB.prepare("SELECT COUNT(DISTINCT day) AS n FROM chart_entries").first()).n;
  return { day, now, history, chart_days: new Set(mine.map((r) => r.day)).size, days_tracked: daysTracked };
}

export async function deezerFanHistory(env, deezerId) {
  if (!env.DB || !deezerId) return [];
  const { results } = await env.DB.prepare(
    "SELECT day AS d, fans FROM deezer_fans WHERE deezer_id=? ORDER BY day"
  ).bind(String(deezerId)).all();
  return results;
}
