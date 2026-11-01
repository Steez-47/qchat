// GET /api/release: the latest version, installer URL and size, for the download buttons.
import { latestRelease } from "../lib/release.js";

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  try {
    const rel = await latestRelease();
    res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=86400");
    res.statusCode = 200;
    res.end(JSON.stringify(rel));
  } catch {
    res.setHeader("cache-control", "public, s-maxage=30");
    res.statusCode = 502;
    res.end(JSON.stringify({ error: "release lookup failed" }));
  }
}
