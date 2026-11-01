// GET /download (rewritten here by vercel.json): redirects to the latest installer, or to the
// releases page if GitHub can't be reached, so the button never dead-ends.
import { latestRelease, RELEASES_PAGE } from "../lib/release.js";

export default async function handler(req, res) {
  let location = RELEASES_PAGE;
  try {
    const rel = await latestRelease();
    if (rel.url) location = rel.url;
    res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=86400");
  } catch {
    res.setHeader("cache-control", "public, s-maxage=30");
  }
  res.statusCode = 302;
  res.setHeader("location", location);
  res.end();
}
