# ChatGPT response tag families — evidence inventory

Research note for the response-tag work on `feat/response-tags`. Fetched and written
2026-10-31. Companion probe: `tools/tag-site-inventory.mjs` (bounded, public site only).

## Purpose and honest scope

The user request was "research every tag (like `<something></something>`) that ChatGPT
models can use, then add support for each one." That request cannot be satisfied as a
closed list, and this note does not pretend otherwise:

- OpenAI documents that prompt authors may use **arbitrary XML tags** as delimiters. There
  was no complete response-tag registry in the official sources checked here.
- ChatGPT's own rich-reply layout language is **undocumented private application
  behaviour**, observed through the site's stream/record payloads, not an API contract.
- A model can therefore emit standard Markdown, standard HTML, arbitrary XML-ish tags, and
  (in the ChatGPT app) private layout components. The only robust goal is: render the
  known families well and degrade every unknown family to readable text.

So the deliverable is a **tiered inventory plus a fallback contract**, not "all N tags".

## Sources

All links below were fetched on 2026-10-31. Tier meanings are in the next section.

| Tier | Source | What it actually establishes |
| --- | --- | --- |
| A | [Prompt engineering — Message formatting with Markdown and XML](https://developers.openai.com/api/docs/guides/prompt-engineering) | Arbitrary XML delimiters are allowed in prompts (`<user_query>`, `<assistant_response>`, `<product_review id=...>`). Input-side guidance, not an output schema. No list of tags. |
| A | [Citation formatting](https://developers.openai.com/api/docs/guides/citation-formatting) | The only officially specified response-token format found: `\uE200` + family + `\uE202` + source id(s) + optional locator `L8-L13` + `\uE201`. Multiple ids allowed. Helper code takes a `families` array but defaults to `["cite"]`. Source ids are caller-defined (`turn0file1`, `block5`, arbitrary stable ids). |
| A | [OpenAI harmony response format](https://developers.openai.com/cookbook/articles/openai-harmony) | `gpt-oss` transport uses `<|start|>`, `<|message|>`, `<|channel|>`, `<|end|>`, `<|return|>`, `<|call|>`, `<|constrain|>` as **special tokens**, not paired content markup. Also shows the browser-tool citation spelling `【{cursor}†L9-L11】`. Neither is a UI tag family. |
| A | [ChatKit widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets) | A **separate product** with a JSON widget schema (`Card`, `Box`, `Row`, `Col`, `Text`, `Title`, `Caption`, `Divider`, `Icon`, `Image`, `Markdown`, `Button`, `ListView`, ...). It is not evidence of ChatGPT's private in-message registry; do not conflate the two. |
| A | [API docs index](https://developers.openai.com/api/docs/llms.txt), [developer docs index](https://developers.openai.com/llms.txt), [ChatGPT product docs index](https://learn.chatgpt.com/llms.txt) | These official indexes were searched; no complete registry of ChatGPT's private rich-reply markup was found. |
| B | QChat bridge + prior live observations (`src-tauri/bridge/chatgpt-bridge.js`, `.agents/PLAN.md` §"Rich replies") | The ChatGPT app emits a private layout language in message text, with images and citations resolved from message metadata. Recorded from real replies during this project; **not** re-verified against the live site in this research pass. |
| C | QChat test fixtures (`tools/*-test.mjs`, `.agents/PLAN.md`) | Synthetic fixtures shaped like observed payloads. Useful as regression input, not independent proof that a tag exists. |

### Search limitation (runtime probe)

Attempted public-runtime inventory on 2026-10-31T04:45Z with a disposable headless Edge
profile (no account, no model messages) at `https://chatgpt.com/`:

- Page title returned was `Just a moment...` (Cloudflare interstitial). One script entry was
  observed, none from `oaistatic.com`; no bundles could be scanned.
- A plain unauthenticated HTTP request returned **403** with the same challenge shell.

Therefore **no current bundle/component names could be recorded**, and this note makes no
claim about the site build. `tools/tag-site-inventory.mjs` reproduces the attempt, is capped
at 12 scripts / 30 MiB / 100 s, prints JSON only (no bundle dumps, no files written), and
reports the limitation instead of failing the run. Anyone with legitimate guest access can
re-run it later; treat any output as Tier B, dated.

## Inventory

### 1. Observed ChatGPT private layout components (Tier B)

Paired container tags and void/self-closing components seen in stored `parts` text. These are
JSX-like, not HTML: attributes may be quoted strings, `{...}` expressions, booleans, or
arrays, and self-closing forms are common.

| Tag | Shape / meaning | Notes |
| --- | --- | --- |
| `box` | container | layout grouping; no text of its own |
| `row` | container | observed horizontal arrangement; `col`, `column`, `stack` are compatibility aliases, not independently confirmed in this pass |
| `grid` | container | holds `grid-item` children |
| `grid-item` | container | often an `AsyncImage` plus caption text |
| `text` | inline/block text | carries prose; must not be dropped |
| `title` | emphasised text | renders as a heading/strong label |
| `caption` | small supporting text | render as italic/secondary |
| `divider` | void | horizontal rule |
| `icon` | void | named icon; not reconstructable without the site's icon set |
| `Entity` | void, `value="..."` (also `category`, `disambig`) | the attribute value **is** the visible text |
| `Cite` | void, `refs=["turn1search5", ...]` or `ref="..."` | resolves through source metadata; ids may carry `:L1-L3` locators |
| `Link` | void or paired, `url`/`href` + `title` | becomes a normal link |
| `AsyncImage` | void, `query="..."` (+ `aspectRatio`, `layout`) | the text holds only a **search query**; the image comes from metadata |
| `AsyncImageGroup` | void, `query={["a","b"]}` | multiple queries, carousel/grid presentation |

Image resolution (Tier B, from the bridge): `metadata.model_dil_v2.appData.opGenui
.componentResults[*].state.images[]`, matched by `image_search_query`. Without that metadata
the image cannot be shown, so dropping the tag (rather than printing a query) is correct.
Citations resolve through `metadata.search_result_groups[*].entries[*]` keyed by `ref_id`
(`turn{turn_index}{ref_type}{ref_index}`).

### 2. Non-HTML token families (Tier A for `cite`, Tier B for the rest)

Private-use characters are not tags and must never be shown raw.

| Token | Status |
| --- | --- |
| `\uE200cite\uE202<id>[\uE202<id>...][\uE202L1-L3]\uE201` | **Documented** (citation-formatting). Multiple refs, optional line locator. |
| `\uE200navlist\uE202...\uE201`, `\uE200image\uE202...\uE201` | Observed in this project's code paths only; not in official docs. Treat as citation-like references with graceful fallback. |
| `\uE203`–`\uE206` | Observed control characters; strip from visible text. |

Because the citation doc takes a `families` parameter, new families are plausible. Unknown
`\uE200<family>\uE202...\uE201` should be removed from prose, not printed.

### 3. Standard HTML / Markdown compatibility families (implementation choices)

Models routinely emit ordinary Markdown and HTML. This is a **compatibility surface**, not a
ChatGPT registry. Support, at minimum, the families QChat already renders:

- Headings `h1`–`h6`, paragraphs, `br`, `hr`, `divider`.
- `strong`/`b`, `em`/`i`, `s`/`del`/`strike`, `u`, `mark`, `sub`, `sup`.
- `ul`/`ol`/`li`, `blockquote`, `pre`/`code` (with language fences), tables
  (`table`/`thead`/`tbody`/`tr`/`th`/`td`), `dl`/`dt`/`dd`.
- `details`/`summary`, `figure`/`figcaption`.
- `a`/`Link` with `https:`, `http:`, `mailto:` only; `img` with safe `src`.
- Deliberately inert/escaped: `script`, `style`, `iframe`, `svg`, `object`, `template`.

### 4. Arbitrary / unknown fallback (required, not optional)

Any tag name may appear (prompt-injected XML, a future ChatGPT component, a model
hallucination). Required contract:

1. Preserve the element's readable text content; never leak raw `<tag ...>` into prose.
2. Use `value`/`title`/`label`/`children` attributes as display text when the body is empty.
3. Never evaluate `{...}` expressions; parse them only as literals or ignore them.
4. Drop dangerous elements and their content (`script`, `style`, `iframe`, `svg`, `object`,
   `template`) and reject non-http(s)/mailto URLs.
5. Keep code spans/fences literal, including tag-like text inside them.
6. Leave genuinely inert HTML tags (e.g. `mark`, `details`, `table`) as sanitized literal
   markup only where the renderer supports them; otherwise flatten to text.
7. Survive partial tags at a stream boundary: hide the incomplete tail until it resolves.

## Behaviours the implementation must have

- Nested containers render in document order; unbalanced closers must not corrupt later text.
- Attribute parsing handles quoted strings, escaped quotes, balanced `{}`, arrays, booleans,
  self-closing `/>`, and `>` inside quoted values.
- `Entity` value survives inside bold/italic and adjacent punctuation.
- `Cite` with one ref, many refs, locators, unknown refs, and a partial ref at stream end.
- `AsyncImage`/`AsyncImageGroup` map queries to metadata images; unmatched queries disappear
  cleanly; `grid-item` keeps its caption with its image.
- Streaming: no raw tag or token may be visible in any intermediate delta; final text is
  stable and not duplicated when a canonical snapshot arrives.
- Sources and images must survive history reload from the stored record.
- Hidden channels (`analysis`, `commentary`, tool recipients) never render as reply text.

## Explicit limitations

- **No complete registry was found in the official sources checked.** Future or A/B-tested ChatGPT components can appear
  without notice; the fallback path is the only durable guarantee.
- **Interactive/private widgets cannot be reconstructed from text.** Canvas/artifact documents,
  Apps SDK widget payloads, DIL interactive components, maps, and charts need their own data
  channels; a tag name alone is not enough. Rendering their text label is the correct fallback.
- **ChatKit widget JSON is a different product surface** and should not be parsed as ChatGPT
  response markup.
- **Harmony `<|...|>` tokens are transport**, not paired content tags. QChat receives already-decoded message envelopes; this parser does not interpret raw Harmony conversations.
- **Metadata is required** for web images and citation links; without it, degrade to text.
- **Runtime evidence is currently blocked** (Cloudflare), so Tier B entries are historical
  observations, not a fresh build snapshot.

## Tests the implementation ought to have

Primary checks: `tools/response-tags-test.mjs` (unit parser),
`tools/response-tags-ui-test.mjs` (actual Edge rendering/streaming) and
`tools/stream-media-test.mjs` (native bridge snapshots). Coverage includes:

1. Unit: nesting, attributes with `>`/quotes/braces, self-closing, unbalanced close, deep
   nesting bound, partial tag at EOF.
2. Unit: code shielding — inline spans, fences with backticks/tildes, tag text inside code.
3. Unit: unknown tag preserves text, drops attributes, and never evaluates expressions.
4. Unit: XSS — `script`/`style`/`svg`/`iframe` stripped, `javascript:` and `data:` URLs rejected.
5. Unit: `Entity`, `Cite` (single/multi/locator/unknown/partial), `Link`, `AsyncImage(Group)`,
   `grid-item` caption pairing, `title`/`caption`/`divider`/`icon`.
6. Unit: citation tokens `cite`, `navlist`, `image`, unknown families, stray `\uE203`–`\uE206`.
7. Bridge: stored-record conversion of a rich reply — images resolved by `image_search_query`,
   sources from `search_result_groups`, no raw tags/tokens, hidden channels excluded.
8. UI: paced streaming shows no raw markup at any delta; canonical fallback replaces rather
   than appends; history reload keeps images and source links.
9. The history suite's layout/metadata fixture follows prior real rich replies; the inputs
   in this change remain synthetic, and no new signed-in model messages were sent.

Cross-family review found and fixed inline whitespace loss, TeX inequalities, raw HTML
code shielding, unclosed-tag/prose truncation, citation/autolink prefix misclassification,
and repeated conversion of quoted/list-nested fences. Unit cases cover the reproductions;
the Edge check renders four inequalities through KaTeX and checks quoted code, inline
spacing and generic `Array<object>` prose. Source titles escape tag-like text before
becoming citation labels. Native guest smoke checks verify the shared parser loads in both
WebViews and renders saved rich replies without touching the existing profile.

## Implementation scope

Support the observed layout components, the documented `cite` token, ordinary Markdown/HTML,
and a strict unknown-tag fallback. Do not claim "all ChatGPT tags": the set is private,
unpublished, and open-ended, and the public runtime could not be inventoried in this pass.
