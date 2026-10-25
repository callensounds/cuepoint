# Cuepoint

Music analytics dashboard with a plain-English UI. Runs on Cloudflare Pages.

## Layout

- `public/index.html` — the dashboard (currently sample data)
- `functions/api/artist.js` — `/api/artist?q=<name>`: live lookup (MusicBrainz, Wikipedia pageviews, Last.fm) + daily snapshot
- `functions/api/tracked.js` — `/api/tracked`: artists looked up so far
- `functions/api/collect.js` — `/api/collect`: refreshes today's snapshot for up to 10 tracked artists per call
- `functions/_lib.js` — shared data-source and storage code
- Cloudflare D1 database `cuepoint` (bound as `DB` in `wrangler.toml`)
- `wrangler.toml` — Cloudflare Pages config

## Deploy (Git integration — recommended)

1. Push this folder to a GitHub repo (e.g. `cuepoint`).
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build command: *(leave empty)*. Build output directory: `public`.
4. Save and deploy. Every push to `main` redeploys automatically.

## Deploy from your machine

```
npm install -g wrangler
wrangler login
wrangler pages deploy public --project-name cuepoint
```

Check it's live: `https://<your-project>.pages.dev/api/health`

## Data sources

| Source | What | Terms |
|---|---|---|
| MusicBrainz | identity, genres, official links | CC0, ~1 request/second |
| Wikipedia pageviews | daily page views, 1 year of history | open |
| Last.fm | listeners, plays (snapshotted daily) | non-commercial unless you sign a Last.fm agreement |

Last.fm is optional: add a secret named `LASTFM_KEY` in the Pages project settings.
