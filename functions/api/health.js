// GET /api/health — confirms the site's server functions are live.
// Real artist data endpoints (e.g. /api/artist/:id) will live alongside this file.
export function onRequestGet() {
  return Response.json({ ok: true, service: "cuepoint", time: new Date().toISOString() });
}
