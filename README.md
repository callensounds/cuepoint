# Cuepoint

Music analytics dashboard with a plain-English UI. Runs on Cloudflare Pages.

## Layout

- `public/index.html` — the dashboard (currently sample data)
- `functions/api/` — server endpoints, served at `/api/*`
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
