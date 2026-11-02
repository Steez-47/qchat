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
  index.html     The landing page
  help.html      /help: every shortcut, slash command, feature and setting, with a filter and a
                 shortcut tester
  styles.css     All styles for both pages. Paper and ink for the page; the demos use the app's glass
                 from docs/DESIGN.md
  main.js        Landing page: Lenis smooth scroll, demo canvas fitting, the pinned story, the feature
                 tour, reveals, the stat count-up, the picker and slash-menu demos, the look picker and
                 live release info
  help.js        Help page: table of contents, filter (press /), shortcut tester, bar diagram, release info
  lenis.min.js   Lenis 1.3.26 smooth scrolling, vendored (MIT, see lenis.LICENSE.txt)
  icon.svg       Favicon (copy of assets/icon.svg)
  og.png         Share image
api/
  download.js    /download → 302 to the latest *_x64-setup.exe, or the releases page
  release.js     /api/release → { version, url, size, publishedAt, page }
lib/release.js   GitHub latest-release lookup shared by both
vercel.json      Output dir, the /download rewrite, caching and security headers
```

The download buttons link to `/download`. Once `/api/release` answers, `main.js` swaps in the direct installer URL and shows the version and size. If GitHub can't be reached, `/download` falls back to the releases page, so the button always goes somewhere useful.

### Demos

Every demo is laid out on a fixed-size canvas (`--cw` × `--ch` on its `.screen`) and scaled as a whole to fit, so nothing inside can reflow or spill out at odd widths. Phones get a narrower canvas with its own positions.

- **Story** (`#story`): a tall section with a sticky stage. Scroll progress sets state classes on `#story-canvas` (`is-open`, `is-typing`, `is-sent`, `is-reply`, `is-tabs`, `is-fold`), and CSS transitions animate between them, so scrolling back reverses smoothly.
- **Tour** (`#tour`): on wide screens the five `.layer`s share one sticky screen and the step nearest the middle of the viewport plays. Below 900px each layer moves into its own screen under its step. Each scene is a short CSS keyframe sequence started by `.play`.

With *reduce motion* on, smooth scrolling is off and every sequence jumps to its end state.

The look picker's colours are copied from `ui/settings-core.js`. Update `LOOKS` in `main.js` if those change.

### Keeping it in step with the app

Some content mirrors the app and needs a touch when the app changes:

- Shortcuts and slash commands: `help.html` (`#shortcuts`, `#commands`), the keys list in `index.html`, and `SLASH` in `main.js`. The source of truth is `COMMANDS` and the keydown handlers in `ui/app.js`.
- Settings pages: `#settings` in `help.html`, from `PAGES` in `ui/settings.js`.
- The "Recently shipped" cards in `index.html`, from `CHANGELOG.md`.

Once the site has a domain, make `og:image` in `index.html` an absolute URL (for example `https://qchat.example/og.png`). Some social networks ignore relative image URLs.
