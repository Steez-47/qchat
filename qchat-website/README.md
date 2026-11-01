# qchat-website

The QChat landing page. Static HTML, CSS and vanilla JS with no build step, plus two small Vercel Functions that keep the download button pointed at the newest release.

## Deploy on Vercel

1. Import the `Steez-47/qchat` repository in Vercel.
2. Set **Root Directory** to `qchat-website`. Leave the framework preset as **Other**; `vercel.json` already sets the output directory and turns off the build.
3. Deploy. Optionally add a `GITHUB_TOKEN` environment variable (any token with public read access) to lift GitHub's anonymous API rate limit. The responses are edge-cached for five minutes either way, so it's rarely needed.

To deploy only when the site changes, set **Ignored Build Step** to `git diff --quiet HEAD^ HEAD -- .`

## Local preview

```bash
npm run dev
```

Serves `public/` and the `api/` handlers on http://localhost:3000 with no dependencies. `vercel dev` also works.

## How it fits together

```
public/
  index.html     The page
  styles.css     All styles. The demos' glass, geometry and timings follow docs/DESIGN.md
  motion.js      Motion core: Lenis smooth scroll, the scrub engine, reveals, demo helpers
  story.js       The hero scroll story (orb → bar → reply → tabs → fold)
  scenes.js      The pinned feature tour: selected text, snapshots, commands, files, search
  site.js        Release info, the look picker and the closing bar
  lenis.min.js   Lenis 1.3.26 smooth scrolling, vendored (MIT, see lenis.LICENSE.txt)
  icon.svg       Favicon (copy of assets/icon.svg)
  og.png         Share image
api/
  download.js    /download → 302 to the latest *_x64-setup.exe, or the releases page
  release.js     /api/release → { version, url, size, publishedAt, page }
lib/release.js   GitHub latest-release lookup shared by both
vercel.json      Output dir, the /download rewrite, caching and security headers
```

The download buttons link to `/download`. Once `/api/release` answers, `site.js` swaps in the direct installer URL and shows the version and size. If GitHub can't be reached, `/download` falls back to the releases page, so the button always goes somewhere useful.

Every demo frame is a pure function of scroll progress, so all of it scrubs backwards as well as forwards. `QS.scrub(section, { paint, measure })` in `motion.js` is the one engine behind the story and every scene; to add a scene, add a `<section class="scene" data-scene="name">` and a matching builder in `scenes.js`. With *reduce motion* on, smooth scrolling, zooms and parallax are off and reveals become plain fades.

The look picker's colours are copied from `ui/settings-core.js`. Update `LOOKS` in `site.js` if those change.

Once the site has a domain, make `og:image` in `index.html` an absolute URL (for example `https://qchat.example/og.png`). Some social networks ignore relative image URLs.
