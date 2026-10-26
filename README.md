# Cuepoint

Music analytics dashboard with a plain-English UI. Runs on Cloudflare Workers (static assets + API).

## Layout

- `src/worker.js` — Worker entry: routes `/api/*` to the handlers below, serves `public/` for everything else, and runs the hourly snapshot cron
- `public/index.html` — the dashboard (sample artists plus live search)
- `functions/api/artist.js` — `/api/artist?q=<name>`: live lookup (MusicBrainz, Wikipedia pageviews, Deezer, Apple Music charts) + daily snapshot
- `functions/api/tracked.js` — `/api/tracked`: artists looked up so far
- `functions/api/collect.js` — `/api/collect`: refreshes today's snapshot for up to 10 tracked artists per call
- `functions/_charts.js` — chart crawler (Apple Music + Deezer charts, daily) and chart queries
- `functions/api/charts.js` — `/api/charts`: today's movers/new entries, or one chart with `?feed=apple:songs:us`
- `functions/api/crawl.js` — `/api/crawl`: runs one crawl step now (the hourly schedule does this automatically)
- `functions/_lib.js` — shared data-source and storage code
- Cloudflare D1 database `cuepoint` (bound as `DB` in `wrangler.toml`)
- `wrangler.toml` — Worker config (assets, D1 binding, cron)

## Deploy

The repo is connected to the `cuepoint` Worker through Cloudflare Workers Builds: every push to `main` runs `npx wrangler deploy`.

From your machine instead:

```
npm install -g wrangler
wrangler login
wrangler deploy
```

Check it's live: `https://cuepoint.<your-subdomain>.workers.dev/api/health`

## Data sources

| Source | What | Terms |
|---|---|---|
| MusicBrainz | identity, genres, official links | CC0, ~1 request/second |
| Wikipedia pageviews | daily page views, 1 year of history | open |
| Deezer | fans (snapshotted daily), top tracks, worldwide + genre Top 100 charts | public API, no key |
| Apple Music charts | Top 100 songs and albums in 10 countries, crawled daily | public RSS feeds, no key |

Spotify, Amazon Music and TIDAL are linked from each artist page but give no public stats:
Spotify removed followers/popularity for new developer apps in Feb 2026, Amazon's music API is
invite-only, and TIDAL reserves popularity for its own apps and forbids storing its data.


## Chart crawl

Every hour at :37 the Worker runs one crawl step: up to 8 chart feeds that haven't been fetched today,
then Deezer fan counts for up to 30 artists charting on Deezer this week. Positions are stored in the
`chart_entries` table, so movement, peaks and days-on-chart build up over time.
