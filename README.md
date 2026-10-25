# Cuepoint

Music analytics dashboard with a plain-English UI. Runs on Cloudflare Workers (static assets + API).

## Layout

- `src/worker.js` — Worker entry: routes `/api/*` to the handlers below, serves `public/` for everything else, and runs the hourly snapshot cron
- `public/index.html` — the dashboard (sample artists plus live search)
- `functions/api/artist.js` — `/api/artist?q=<name>`: live lookup (MusicBrainz, Wikipedia pageviews, Last.fm) + daily snapshot
- `functions/api/tracked.js` — `/api/tracked`: artists looked up so far
- `functions/api/collect.js` — `/api/collect`: refreshes today's snapshot for up to 10 tracked artists per call
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
| Last.fm | listeners, plays (snapshotted daily) | non-commercial unless you sign a Last.fm agreement |

Last.fm is optional: add a secret named `LASTFM_KEY` in the Worker's Settings → Variables and Secrets.
