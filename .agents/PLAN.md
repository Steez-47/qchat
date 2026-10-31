## Rich replies and the real jitter cause (2026-10-31)

Rich replies are stored as a layout language (box, row, grid, grid-item, text, title, divider, icon, Entity, Cite, AsyncImage, AsyncImageGroup). Images exist only as search queries in the text; metadata.model_dil_v2.appData.opGenui.componentResults[*].state.images[] holds each image, matched by image_search_query (19 of 19 in the sample). Citations resolve through metadata.search_result_groups. fallbackMarkdown drops the images, so the bridge converts the layout itself. Generated images are on tool messages and go above the reply text. After a rich live reply finishes, the reply is rebuilt from the saved record, which is the only source of its images.
Jitter: press animations were already clean; a real-cursor frame capture (tools/live/button-jitter-check.mjs) showed the window resizing on 19 of 50 frames when history opened, because the webview follows the window a frame late. The window now keeps a reserved height and only moves when content cannot fit; the empty part is click-through (stale-surface guard widened from 2s to 15s, since a stalled page would otherwise block clicks over that larger area). Measured after: repeat open and close of history moved the window 0 times.
Live: real rich reply 20 of 20 images, 0 raw tags, 0 tokens, 18 links, screenshots reviewed. Live streaming of a rich reply into this flow not run on the account.

## Owner's test bugs after the overhaul (2026-10-31)

1. Garbled stream with raw `<Entity .../>`: only named layout tags switched the bridge to rendered text. Any JSX-style component now does, Entity tags become their value everywhere, and the new default stream style `paragraph` shows only finished blocks. Could not reproduce the garble on demand (it needs a rich reply), so that exact reply is unverified live.
2. Button jitter: colour-only press and hover, no per-surface CSS blur, and blur sprites are moved in place instead of replacing the composition tree. Headless proves nothing moves or refits on press; the feel needs the owner's eye.
3. Old chats: replies lost and "View attachments" came from local records that were misfiled or lost their text, and merge kept the local list when longer. The account record now always wins, chats refresh on open and at startup, an empty final snapshot cannot erase a reply, tool-authored images attach to the reply, and files load by id (`stored:<file>:<conversation>`). Live: 2 of 2 images rendered at 1254x1254, no placeholders (tools/live/old-image-check.mjs).
Also: focus no longer lands on the off-screen page at launch (verified live, Brave kept focus). Account list hit HTTP 429 from repeated probing: it is cached 2 minutes and paged slowly; bridge reads retry while the session settles. Use tools/live/history-live-check.mjs sparingly.

## UI overhaul (2026-10-31, branch overnight-polish)

Owner asked for easier reading, better animation, calmer streaming, real history, a usable scroll while streaming, far more customization and presets, and for the window's transparency to stop changing while it moves. Sol built the settings and presets; T0 did the rest.

Root causes found: the blur companion was deliberately hidden during a drag (surfaces.rs), so the fill sat over the sharp desktop; the opacity slider was silently clamped to a legibility floor and the blur slider only drove a CSS blur that cannot reach the desktop; a following reply reset scrollTop every frame unless the reader was more than 28px from the end, which cancelled each smooth wheel notch; history rows could stay at opacity 0 in the spring system, and history relied on what the hidden page rendered.

Done: blur stays up during moves through a subclass hook on the main window; blur strength is real (sprite opacity); fit_window sizes and positions in one call; reply opacity and width are separate from the bar; word-paced reveal with paint-only fade; Markdown stabilizer and settled-block parsing (ui/stream-text.js); intent-based following; history without springs; full conversation and chat list read from the account (/backend-api, session token, rendered page as fallback); All chats tab. Sol: settings v3, 14 presets, saved presets with import and export, settings search, about 30 new settings. Review fixed Sol's invalid UTF-8, gave the 12 new looks real palettes, and held accent contrast on the fallback fill.
Verified: animation 46, history 47, glass 160, media 48, feature 46, ux 48, math 28, highlight 11, presets 15, stream-media 71, auth 17, Rust 14, and hidden native settings, selection, surfaces, app-e2e, persist and native media all PASS. Real-window drag test: 0 hides in 60 moves, within one 37px step. Blur strength seen at 0 and 100 on the real desktop. Headless screenshots reviewed.
Live (owner approved closing the old build; tools/live/history-live-check.mjs, read-only on a deleted disposable copy, counts only): signed-in list returned 100 of 101 on the first page, whole conversation read as complete with hidden context and reasoning excluded, All chats listed 199 rows and opening an account-only chat showed 8 of 8 messages visible.
Live guest stream in the real window with real wheel events (tools/live/stream-scroll-live.mjs): one notch moved up 92px and held while 1262px of text arrived, Latest resumed following, the reply finished clean. Following lagged 44 to 110px behind fast bursts; tune the 90ms easing if that reads as late.
Real mouse drag with owner's consent (tools/live/mouse-drag-check.mjs): sharpness through the glass 1.08 at rest, 1.11 mid-drag, 0 hides in 68 samples; blur-off control 24.31. Signed-in streamed reply in a temporary chat (stream-scroll-live.mjs --account): one notch held position, Latest resumed, nothing added to the account list, saved chats intact (4 recent, 3 tabs).
Not verified: 150% display scaling (geometry unit tests only). Launching the app can leave its off-screen page as the foreground window until the hotkey is pressed; seen after a manual launch, cause and whether it predates this work not investigated.

## Overnight polish (2026-10-31, branch overnight-polish)

Owner asleep, asked for a full refinement: "janky, doesn't look like the app I want, hard to use". Authority: DESIGN.md. Orchestrator playbook recovered from git (37b5396:.agents/ORCHESTRATOR.md); deleted from the tree earlier, not restored.

| id | task | model | status |
|---|---|---|---|
| N1 | Audits: app UX, settings, design critique | DeepSeek, GLM, Argon | done (.tmp/audit-*.md, critique-a.md) |
| N2 | Native: click-through, blur companion, hotkey, autostart | Sol | done, blur unverified |
| N3 | Blur: accent/region failed, real rounded blur via Windows.UI.Composition host backdrop | Sol | done, visually verified |
| N4 | Visual rebuild per DESIGN.md + settings | Sol | done |
| N5 | 20 UX bug fixes + tools/ux-regress-test.mjs | DeepSeek max | done |
| N6 | ui/highlight.js code highlighter | GLM | done |
| N7 | Orb menu, /chats, /model, /temp, reply tools, recall, /keys, first run, list polish, KaTeX, ask-about-selection | Sol, GLM, DeepSeek | done |
| N8 | Cross-family review (15 findings, all fixed), real-window checks, signed-in checks, release | Antigravity Sonnet, Sol, T0 | done |

Verified live (2026-10-31) on a disposable copy of the signed-in profile: model list, switch and restore (real switcher is `button[aria-label="Select ChatGPT model"]`, opens on keydown ArrowDown only, models are `menuitemradio`), temporary chat send/reply, normal send, reopen from tab + send, restart + send. Real window at 100% scale: blur inside objects, untouched gutter, click-through by WindowFromPoint, idle CPU 0.31% of a core.
Not verified: dragging and drops with a real mouse, 150% display, real Ctrl+Alt+Q capture and SendInput, real hotkey press, Launch at login after a real reboot. Tests are headless or hidden; the release exe itself was only smoke-started.
Left in the account: one test chat titled "QChat automated check, safe to delete".
Known gotcha: the site's mobile layout appears below some window width; the hidden page is 1000x760, which gets desktop layout when signed in.

## Settings window fix (2026-10-31)

Follow-up: user was still running the original consolidated executable, so the separately named fix never loaded. Found a second native bug: `fit_geometry` truncated height to the space above a saved bar position. It now preserves content height and shifts the bar down when required. Settings command errors show inline feedback. Native test now exercises show (offscreen by default); `--visible` checks normal on-screen placement, document visibility and focus. Rust 9/9, full glass UI suite and native settings 10 checks PASS, including all five menu rows inside the real fitted window. Desktop computer-use helper unavailable; direct application runtime checks verify focus and bounds. Release built and copied to smooth/consolidated/settings-fix paths; originals backed up in `dist/backup-settings-20261031-010400`. Running app had switched to smooth during work; restarted that exact path and verified its binary hash matches the final build (current PID31188; initial replacement process exited, subsequent launch is responsive with no stderr). Saved profile preserved.

Fixed Windows WebView2 deadlock caused by constructing the settings window inside a synchronous command/event handler. Both `/settings` and the tray now use an asynchronous command with window creation on a blocking worker. Creation is serialized to retain a single settings window. Isolated debug mode now creates a real hidden settings webview instead of bypassing the command.

Verification: Rust tests 8/8, glass UI suite ALL PASS, and `node tools/settings-e2e.mjs` 7 checks ALL PASS (real native creation, reuse, close/reopen and Escape). No visible windows, OS input or saved-account access; visible positioning/focus remain unverified. Release build passed; `dist/QChat-settings-fix.exe` matches the compiled executable. Existing running `dist/QChat-consolidated.exe` preserved. Concurrent composer UI changes are outside this task and left intact.

## Consolidated baseline (2026-10-31)

All completed chat, media, bubble UI, settings and icon work is consolidated on local `main`; `feat/core-chat` and a pre-consolidation backup branch are retained. The GitHub repository has no branches; no push or publication is part of this local consolidation.

Pre-merge review found that lazy conversation navigation removed staged draft attachments. Page synchronization now preserves uploads, while explicit New chat still clears them. Native regression checks cover both open and new synchronization paths. Verification: Rust tests 8/8, auth bridge 14/14, stream/media 49/49, media UI, glass UI, native media and real-app guest e2e all pass. Release executable rebuilt; saved-account tests were not run.

## Current milestone: compact bubble UI (v2 redesign)

User feedback on the glass sheet: too bulky, one rectangle, doesn't remember position. New design: bar-only compact pill; sent message = bubble rising above the bar; once streaming only the model response bubble is shown (grows); no background; `/settings` opens a separate settings window (many customisations: corner weight, opacity, motion, text, layout, behaviour); 3 recent-chat tabs with clock + time-since (left-most = most recent; click swaps). Window: content-fitted, bottom/centre anchored (`fit_window`), position persisted (`window-state.json`).

| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| M1 | Bubble UI, slash commands, tabs, settings window UI, tests | claudeAgent opus-5-5 high (user-requested) | ui/**, tools/media-ui-test.mjs, tools/glass-ui-test.mjs | contract | done |
| M2 | Native: fit_window, position memory, settings window, chat_open, bridge openConversation | codex gpt-6.1-sol medium | src-tauri/**, tools/auth-bridge-test.mjs | contract | done |
| M3 | Integrate: cargo build, app-e2e, release build, review | T0 | any | M1,M2 | done (dist/QChat-bubble.exe) |

## Current milestone: liquid-glass floating UI

User asked for a liquid-glass, transparent, themed, floating chat box (not a corner block). Window: transparent, no Mica, no OS shadow, 680px wide, bottom-center, compact (248px, pill only) / expanded (680px) via `set_layout` + `html[data-layout]`. Themes via `html[data-look]` + `ui/look.js` (localStorage `qchat.look`).

| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| L1 | Glass CSS/HTML, themes, look.js | T2-UI antigravity gemini-4-argon medium | ui/index.html, ui/app.css, ui/look.js | none | done |
| L2 | Window/Rust (`set_layout`, transparent, positioning), app.js layout hook | T0 | src-tauri/**, ui/app.js | none | done (cargo check ok) |
| L3 | Integrate, run media-ui-test, release build | T0 | any | L1,L2 | done (dist/QChat-glass.exe) |

# QChat plan

## Current milestone: reliable responses and media

User reports an interrupted reply and wants both uploads and media replies. Test Unicode/emoji independently of the network interruption. Keep normal saved sign-in and preserve the running app. Use ChatGPT's own file input and download resources; do not reimplement its private upload API.

| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| K1 | Resilient stream lifecycle, Unicode/multimodal parsing, media registry and attachment readiness | native Sol medium | src-tauri/bridge/chatgpt-bridge.js, tools/stream-media-test.mjs | shared contract | done |
| K2 | Attachment picker/paste/drop chips and image/audio/video/file reply UI | native Sol medium | ui/**, tools/media-ui-test.mjs | shared contract | done |
| K3 | Chunked staging, WebView2 file input, media cache/downloads, runtime integration/review/build | T0 | src-tauri/** excluding bridge, tools runtime, docs | K1,K2 | done |

Upload IPC: attachment_begin {name,mime,size} -> {id,name,mime,size,kind}; attachment_chunk {id,offset,data} (base64 <=512KiB decoded); attachment_finish {id}; attachment_remove {id}. chat_send adds attachmentIds:string[] (optional), prompt may be empty with attachments. Native stages bounded chunks and sets only approved staged paths on ChatGPT's input using WebView2 CDP. Bridge attachmentInput() returns a selector for a real file input (or error); send({id,prompt,attachmentCount}) waits for actual upload processing before Send.

Media IPC: media_load {mediaId} -> {id,kind,name,mime,src}; src is an opaque qchat-media local URL. media_save {mediaId} -> saved filename (unique path in Downloads, no overwrite or auto-open). Bridge events add {type:'media',id,items:[{id,kind,name,mime?}]} where kind=image|audio|video|file; raw signed URLs remain in the bridge/native broker. Bridge resolveMedia(mediaId) returns {url,kind,name,mime?} to native only. UI loads through media_load, never injects raw HTML, never auto-plays. Unsupported items retain View in ChatGPT fallback. Features supported by the current ChatGPT account/site govern accepted file formats; no claim that every codec or file format is accepted.

Integration evidence: live Unicode 12-line reply now completes (initial truncation was stale parsed prefix plus missing signed-in DIL DOM selectors); real TXT and PNG uploads/readback and actual generated CSV download pass with saved login. Scoped DIL output is [data-dil-source-message-id][data-markdown-copy], body [data-dil-message-id]. Native tests verify exact staged File bytes, terminal cleanup/quota, safe sources, byte ranges, HTTPS image, same-page blob via IO.resolveBlob, normal site-download interception, unique saves, silent WAV and VP9 WebM playback metadata with no autoplay. Final checks: stream/media47, auth11, UI20, Rust5, native media, guest chat7 and persistence3 pass. Two Gemini cross-family reviews completed; fixed scoped cancellation, download cleanup, hit-testing, HTTP status validation and semantic Markdown fallback. Exploratory files/traces removed; opt-in live smoke retained. A final full saved-profile rerun was blocked because dist/QChat-glass.exe was opened in another session and owns the profile; leave it running. Earlier live checks remain valid, and all final isolated tests pass. The current glass UI from the concurrent work is preserved and included in the integrated build.

Integrated release: dist/QChat.exe, 4,698,112 bytes; cargo release build passed. Original dist/QChat.exe backed up as dist/QChat.before-media-20261030.exe. The running dist/QChat-glass.exe remains untouched. Quit it from the tray and launch dist/QChat.exe to use the final media build with the same saved profile. ChatGPT format/account limits and WebView2 codecs still apply; live voice/camera sessions remain outside this media-attachment feature.

## Previous milestone: repair normal sign-in connection

The user has removed browser cookie import/helper functionality and signed into QChat's own sign-in window. Keep that normal sign-in flow. Live diagnostics confirmed their session was authenticated, but the current signed-in composer is a semantic ProseMirror textbox without the legacy guest ID. The conversation preparation request also incorrectly ended the Send-button wait. Both issues are fixed and a real authenticated prompt/reply completed successfully.

| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| J1 | Read-only sign-in diagnosis | T3 DeepSeek high | none | none | done |
| J2 | Reliable session probing and synthetic auth regressions | T2 native Sol medium | bridge/chatgpt-bridge.js, tools/auth-bridge-test.mjs | J1 | done |
| J3 | Diagnose composer/loading, fix return-to-chat state, integrate and verify | T0 | main.rs, ui/app.js, docs | live diagnostics,J2 | done |

Verification: real authenticated send and expected reply, 11 synthetic auth/lifecycle regressions, 2 Rust tests, 7 guest chat checks, and 3 persistence checks pass. Gemini cross-family review completed; loading retries now take priority over background throttling, auth route matching is consistent, and signed-in/loading UI uses Manage account. Temporary diagnostic source was removed. Desktop automation unavailable; real app-profile diagnostics printed only booleans/element structure and never credentials or conversation content. A mistaken extra guest diagnostic profile at `%LOCALAPPDATA%/com.qchat.app/EBWebView/EBWebView` remains because automatic approval review blocked its cleanup. It is distinct from the real profile and has no signed-in session. The original release process remains running and will need a tray Quit/relaunch to load the new build.

The fixed portable release is `dist/QChat.exe` (4,510,208 bytes), built with cached dependencies in the alternate target directory and copied into dist. The running `src-tauri/target/release/qchat.exe` was preserved and remains the old binary. Launch dist/QChat.exe after quitting the old tray instance; both use the existing app profile and app identifier.

## Goal
A tiny always-resident Windows popup (hotkey Alt+Q) for chatting with ChatGPT models through the user's own chatgpt.com session (cookie-based sign-in). Distinct look, minimal resources. Later: Windows-native hooks (prompt from any text box / selection).

## Stack and key decisions
- **Tauri 2 (Rust) + WebView2**, vanilla HTML/CSS/JS UI in `ui/` (no bundler, `withGlobalTauri`). Smallest practical footprint.
- **Transport = hidden chatgpt.com webview ("bridge")**: we don't reimplement ChatGPT's private API (Cloudflare, sentinel, proof-of-work and Turnstile break that constantly). A hidden WebView2 window loads chatgpt.com with a persistent profile. An injected script types into the real composer, clicks send, and **tees the page's own `fetch` SSE stream** to get structured deltas. ChatGPT's frontend handles all the anti-bot work.
- **Sign-in**: the "Sign in" action shows the chatgpt.com window at /auth/login, the user logs in normally, and the window returns to the background on login. The login persists in the WebView2 profile across restarts.
- **Resources**: the chatgpt webview is suspended (`TrySuspend` + low memory target) after 3 min idle with the UI hidden, and resumed on hotkey.
- UI window: frameless, `shadow: true` (native Win11 rounded corners and shadow), not transparent, always-on-top, skip taskbar, appears bottom-right of the cursor's monitor work area.

## Contract (all tasks code to this)
UI → Rust commands (`window.__TAURI__.core.invoke`):
- `chat_send {id: string, prompt: string}`, `chat_stop`, `chat_new`, `chat_status`
- `show_signin`, `hide_main`, `open_external {url: string}`, `get_theme`, `quit_app`

Rust → chatgpt webview: `eval("window.__qchat.send({...})")` etc. Bridge API:
- `window.__qchat.send({id, prompt})`, `.stop()`, `.newChat()`, `.status()`

Bridge → Rust: `window.__QCHAT_EMIT__(evt)` (defined by the Rust init script, calls `invoke('bridge_event', {event})`). Rust re-emits to UI window `main` as the Tauri event **`bridge`** with payload `evt` unchanged.
Events:
- `{type:"status", ready, loggedIn, url}`
- `{type:"start", id}`
- `{type:"delta", id, text}` (text = FULL accumulated assistant text so far, throttled to ≤20/s)
- `{type:"done", id, text, conversationId}`
- `{type:"error", id?, code, message}` with codes `not_ready|busy|rate_limited|auth|send_failed|stream_failed|timeout`

Other Rust → UI events: `qchat://shown` (focus the input), `qchat://new-chat` (from the tray).

## M1: core (parallel)
| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| A | Tauri shell: windows, tray, hotkey, IPC relay, cookie import, suspend | T2 codex/gpt-6.1-sol medium | package.json, src-tauri/** (not bridge/) | none | done |
| B | chatgpt.com bridge script + CDP test harness | T2 codex/gpt-6.1-sol medium | src-tauri/bridge/chatgpt-bridge.js, tools/bridge-test.mjs | none | done |
| C | Popup UI (design direction below) + mock backend | T2-UI antigravity/gemini-4-argon medium | ui/** | none | done |

## M2: integration
| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| D | End-to-end run via WebView2 CDP, glue fixes | T0 (me) | any | A,B,C | done |
| E | Cross-family review of shell + bridge | R antigravity/claude-sonnet-5-5 medium | none | D | done |

| F | Fix review findings (11) | T2 codex/gpt-6.1-sol medium | main.rs, tauri.conf.json, bridge | E | done |

Status (M1+M2 done): `node tools/app-e2e.mjs` 7/7 PASS (guest). Removed 2026-10-30: all cookie import and browser helper code (user decision). Confirmed live: persisted real login, signed-in composer, actual authenticated send/reply. Unverified: visible auto-return timing and hotkey focus over other apps.
Testing rule: the user may be gaming. Use only the headless tools/app-e2e.mjs; never send keys or show windows.

## Design direction (UI)
Dark graphite "instrument panel", Swiss grid, one signal-red accent (#E5484D / icon #dc2626). System fonts: Segoe UI Variable (text), Cascadia Mono (labels and code). No bubbles: each turn is a row with a mono uppercase gutter label (YOU / GPT) and hairline dividers. Flat composer slab docked at the bottom with a red focus rule and key hints. Subtle motion (≤160ms), reduced-motion respected, SVG icons, no gradients, glass or emoji. Light variant via prefers-color-scheme (warm paper #F4F1EC).

## Next candidates
Verify logged-in path after the user signs in; unload the chatgpt page after long idle (saves ~300MB, costs a 2-4s cold start); model picker; temporary-chat toggle; autostart; release installer.

## Future (not now)
Global "prompt on selection" hotkey (UIAutomation / clipboard capture → popup near caret → replace or insert), model picker, temporary-chat toggle, history list, autostart.

## Animation polish (2026-10-31)

Completed: composer grows and shrinks with a measured height transition and reserves native window space before animating. Streaming updates preserve Markdown nodes, coalesce on animation frames, cancel obsolete renders, and ignore late deltas after completion/Stop. Verification: glass UI suite ALL PASS (including frame samples, cap/caret, stable streamed nodes, corrected final Unicode/Markdown and reduced motion), media UI ALL PASS, stream/media 49/49, syntax and diff checks pass. Release build passed; dist/QChat-smooth.exe matches compiled release. Existing running QChat-consolidated.exe preserved; visible desktop animation and signed-in streaming remain unverified. Concurrent settings/menu changes preserved.

## Character streaming follow-up (2026-10-31)

Completed: response text reveals in paced graphemes independently of backend chunks, including the final DONE tail; canonical full snapshots remain available for persistence. Streaming uses a stable text column and outer width, linear height transitions, and pre-reserved native viewport space so new lines do not resize the OS window. Stop/error cancel pacing, late terminal snapshots are ignored, and reduced motion flushes immediately. Verification: focused animation UI, full glass UI, media UI, and stream/media 49/49 pass; release build passes. Artifact: dist/QChat-smooth-streaming.exe, hash matches compiled release. Existing running QChat-smooth.exe preserved. Desktop motion and signed-in streaming remain unverified.

## Restart history and media isolation (2026-10-31)

Completed: startup restores the saved previous reply immediately as completed context without replay. History stores sanitized prose and a media hint, with View in ChatGPT opening the saved conversation before displaying it. Image-only history has a completed fallback and never uses expired broker handles. Bridge DOM/media/progress are scoped to the submitted user turn and response IDs; known historical stream packets are rejected. Verification: full glass UI (including restart/view action checks), animation UI, media UI, stream/media 59/59 and auth 14/14 pass. Native guest app e2e ALL PASS. Release build passed and dist/QChat-history-fix.exe matches compiled release; existing running QChat-smooth-streaming.exe preserved. Saved-account restart/image scenario is covered synthetically, not live. Concurrent citation/settings changes preserved.

## Source links and citations (2026-10-31)

Implemented: web thumbnails/search references stay ordinary links rather than generated-media cards. Bridge resolves native citation tokens and Cite tags using structured source metadata (including indexed news refs); UI provides a Sources dropdown closed by default, validates external links, and persists source metadata for restored replies. Actual generated images and attachments retain their preview/download controls. Checks: media UI 37 checks including restart/source links PASS; glass UI ALL PASS; auth bridge 14/14; stream/media 59/59; JavaScript syntax and diff checks PASS. Release build pending. Existing running session preserved.
Release verification: cargo build --release PASS; dist/QChat-source-links.exe SHA256 matches compiled executable. Headless screenshot reviewed: compact inline citation plus closed Sources dropdown, no image card. Signed-in live source response remains unverified. Existing running QChat session was preserved.

## Continuous message history (2026-10-31)

History rebuilt after user rejected square cards: past messages use the normal live bubble markup in one continuous viewport that opens at the latest message, with the latest bubble in place; scroll-linked pop in/out and soft edges, single History/Latest pill. Older messages are backfilled once per chat from the rendered ChatGPT page via chat_read_transcript/readConversation (prefix merge anchored on oldest local prompt). history 32, glass 152, media 48, animation 16, stream-media 70 PASS; release build PASS (dist/QChat-history-bubbles.exe). Not exercised against a live signed-in ChatGPT page or in the native window. Follow-up: backfill was silently denied because chat_read_transcript was missing from build.rs and capabilities/main.json; fixed, with an allow-list check in history-ui-test and visible loading/failure status. History control fades away below the top of a long reply; opening keeps the reading position; Latest glides to the end; JS spring motion gives scroll lag, edge pops and overscroll stretch. history 43, glass 152, media 48, animation 16, stream-media 70 PASS; hidden native debug instance accepts the command and renders seeded rows; release PASS (dist/QChat-history-springs.exe). Reading a real signed-in conversation and the feel of the motion remain unverified.

## Live tool and search activity (2026-10-31)

Implemented: deduplicated activity events from assistant tool recipients/tool completion and exact visible current-turn status surfaces. UI displays a compact accessible animated bar for searching, reading sources, code execution and other tools before/between reply text. Tool arguments/results and analysis do not enter the status label. Completion, Stop, errors and late events clear/ignore activity; reduced motion uses a static indicator. Verified: media UI including motion/lifecycle checks ALL PASS, stream/media 66/66, Rust 9/9, syntax and diff checks pass. Headless search-bar screenshot reviewed. Release build and full glass UI rerun pending; saved account not used, existing running session preserved.
Release verification: full glass UI rerun ALL PASS; cargo build --release PASS; dist/QChat-tool-streaming.exe hash matches compiled release. Headless runtime confirms activity transitions, animation, reduced motion, and terminal cleanup. Live signed-in tool/search response remains unverified. Running app/session preserved.

## Rich response corruption fix (2026-10-31)

Reproduced layout markup leakage and stale/revised prose mixing with DIL packets. Bridge now treats fallbackMarkdown as a complete canonical snapshot, including empty corrections, instead of preferring accumulated layout fragments. Raw row/box/text/AsyncImage layout payloads switch to the current scoped rendered reply; shorter corrected DOM replaces longer raw source. Canonical fallback cannot be overwritten by a stale longer DOM at completion. Fenced/inline code examples are preserved. Checks: stream/media 70/70; actual emitted DIL events replayed through paced UI with exactly one heading, corrected paragraph, working source link and no layout tags; full media UI PASS. Read-only reviewer found no concrete issues. Final release build pending; live saved-account case remains unverified and running session preserved.
Final release build PASS; dist/QChat-rich-content-fix.exe SHA256 matches compiled release. Existing running tool-streaming executable/session left intact. Previously saved malformed replies are preserved; the parser correction applies to newly received responses.

## Response typography and long-form readability (2026-10-31)

Updated shared response CSS: stronger heading size/weight hierarchy, ruled section headings and accent subheadings; prominent underlined links; slightly larger body text and more line/paragraph spacing; spaced lists with accent markers; inset blockquotes; distinct inline code, roomier code blocks, shaded table headers and alternating rows. Applies to current replies and history through existing content classes. Real headless app screenshots reviewed in Aurora dark and Frost light, including top and scrolled code/table portions. Existing media UI PASS; history/full glass suites and release build pending. Running session preserved.
Verification complete: full glass UI, media UI and history UI suites ALL PASS; cargo build --release PASS. dist/QChat-readable.exe SHA256 matches compiled release. Dark/light long-form screenshots inspected in the running headless UI. Current running session preserved.

## Single release and new icon (2026-10-31)

Consolidated the current source into dist/QChat.exe; removed 20 older release EXEs (including backup copies) and the stale NSIS/MSI installers. Regenerated native executable/window/tray icons from assets/icon.svg. npm run build now regenerates icons, builds without installers and atomically publishes the same dist/QChat.exe path. README build command updated. Existing source edits and saved profile preserved. Release SHA256 matches src-tauri/target/release/qchat.exe; extracted executable icon checked. npm run build, Rust 9/9, auth14, stream/media70, glass/history/media/animation UI suites and real hidden native settings lifecycle ALL PASS. No QChat process remained at cleanup time, so no user session was stopped. Signed-in chat behavior on this final release remains unverified.

## Recent chat tabs (2026-10-31)

In progress: move recent chats to the left, attach them visibly above the composer in normal flow, and show a title capped at 24 characters followed by the existing elapsed timestamp. Preserve chat switching, busy states and the running session. Focused real-browser layout and narrow-width checks added to the glass UI suite; release validation pending.

Completed: left-aligned, in-flow tabs share a 2px overlap with the composer; one row keeps every tab attached, with CSS ellipsis when narrow. Titles cap at 24 Unicode characters, followed by relative timestamps; full stored titles remain accessible. Glass UI suite ALL PASS, including title order, truncation, attachment/hit-testing, 340px layout and chat switching. Rendered screenshot inspected. Native release build PASS; build script could not overwrite the running EXE, so the mapped old binary was safely renamed to a timestamped .bak and the new build copied into dist/QChat.exe (matching SHA256). PID21892 remains responsive; restart required to load the update. Saved session preserved.

## Signed-in streaming hang (2026-10-31)

Reproduced live: a sent prompt showed thinking indefinitely or completed empty while ChatGPT's page rendered OK. The current signed-in markup puts the submitted user's ID on an ancestor data-chatgpt-search-message-ids unit; messageIds omitted this owner, so currentAssistants rejected the fresh rendered reply despite matching network request IDs. Added the owner selector and a regression covering an ID-less nested user bubble, historical reply exclusion, incremental DIL deltas and final completion. Stream/media 71/71, auth14 and animation UI ALL PASS. Real signed-in 20-line response streamed visibly in the actual UI and completed with the expected marker using a disposable profile copy. Original current chat and all three recent-chat entries restored exactly after diagnosis. npm run build PASS, dist/QChat.exe hash matches compiled release. Recent-tab UI preserved.

## Response replay on completion (2026-10-31)

In progress: completed signed-in DOM replies replace plain streamed text with Markdown. paceTurn rolls back its visible common prefix and retypes the final snapshot. Keep append-only tail pacing; apply corrections to already displayed content immediately, including final delta before DONE. Add real-browser regression for list formatting, saved final Markdown and subsequent appended text. Preserve running QChat session.

Completed: corrections touching visible graphemes replace the displayed snapshot once and cancel its pending reveal callback. Append-only snapshots still pace only their unseen tails. Animation UI ALL PASS including final list formatting via delta + DONE with no disappeared content/replay, exact saved Markdown, combining/ZWJ extensions, subsequent append pacing, Stop and reduced motion. Full glass UI ALL PASS; release build PASS, dist/QChat.exe matches compiled SHA256. Running PID19748 preserved; user must quit from tray and reopen to load updated UI. Signed-in retest skipped because the active profile's Cookies database is locked; existing session kept intact.
