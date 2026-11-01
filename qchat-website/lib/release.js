// Looks up QChat's latest GitHub release. Responses are cached at Vercel's edge (see the
// Cache-Control headers in api/), so GitHub sees a request every few minutes at most.
// Set GITHUB_TOKEN in the Vercel project to lift GitHub's anonymous rate limit.

export const REPO = "Steez-47/qchat";
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export async function latestRelease() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "qchat-website",
    "x-github-api-version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const rel = await res.json();

  // The NSIS installer, e.g. QChat_1.4.1_x64-setup.exe.
  const asset = rel.assets?.find((a) => /_x64-setup\.exe$/i.test(a.name))
    ?? rel.assets?.find((a) => /\.exe$/i.test(a.name));

  return {
    version: String(rel.tag_name || "").replace(/^v/, ""),
    publishedAt: rel.published_at ?? null,
    page: rel.html_url || RELEASES_PAGE,
    url: asset?.browser_download_url ?? null,
    name: asset?.name ?? null,
    size: asset?.size ?? null
  };
}
