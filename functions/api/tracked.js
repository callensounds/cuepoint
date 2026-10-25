// GET /api/tracked — artists Cuepoint has looked up, most recent first.
import { json } from "../_lib.js";

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ artists: [] });
  const { results } = await env.DB.prepare(
    "SELECT mbid, name, last_collected FROM artists ORDER BY last_collected DESC, name LIMIT 100"
  ).all();
  return json({ artists: results }, 200, { "Cache-Control": "public, max-age=300" });
}
