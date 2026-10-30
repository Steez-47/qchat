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
