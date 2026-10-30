# QChat plan

## Current milestone: consent-based browser session import

The user authorized importing their own ChatGPT session after an explicit trust warning. Use an optional Edge/Chrome extension and the browser's cookies API, scoped to chatgpt.com. Do not decrypt browser cookie databases. Transfer only session cookies directly to QChat on a temporary, authenticated loopback connection. Keep the existing embedded sign-in and manual import fallbacks.

| id | task | tier/model | owns | deps | status |
|---|---|---|---|---|---|
| H1 | Temporary authenticated import receiver, extension, cookie validation, isolated debug profiles | T2 codex/gpt-6.1-sol medium | src-tauri/** except bridge/, browser-helper/**, tools/browser-helper-test.mjs | none | done |
| H2 | Consent, setup instructions, cancel/expiry/error states in existing native account UI | T4 codex/gpt-6-luna medium | ui/app.js, ui/index.html, ui/app.css | shared IPC contract | done |
| H3 | Integrate, focused runtime/security checks, full build, cross-family review, local commit | T0 + review | tools/app-e2e.mjs, tools/signin-e2e.mjs, README.md, .agents/** | H1,H2 | done |

IPC contract: begin_browser_signin { consent: true } -> { id, url, expiresAt } (Unix milliseconds); cancel_browser_signin; open_browser_helper; disconnect_chatgpt. begin returns without opening a browser; UI calls existing open_external only after consent. Event qchat://browser-signin: { id, state: "imported" | "error" | "expired" | "cancelled", message?: string }. Ignore events for other attempt ids. Imported means cookies installed, not verified account authentication; confirm with bridge ready + loggedIn. No tokens in IPC events, logs, screenshots, or test output. Disconnect deletes only QChat's saved browser session and cancels pending import.

Testing must preserve the currently running release app. Debug-only QCHAT_TEST_MODE=1 + QCHAT_TEST_PROFILE=<temporary absolute path> isolates WebView data, disables single-instance forwarding and hotkeys, and never displays a window. Harnesses terminate only their own process tree. Do not import the user's real browser cookie during unattended checks.

Verification: 19 runtime sign-in checks pass with synthetic cookies, including consent, bridge ACL, Origin/Host/secret checks, cancellation during an incomplete request, replay rejection, cookie attributes/expiry, and removal. Rust 4/4 tests and synthetic extension checks pass; guest chat 7/7 passes. Gemini cross-family review found missing resume/off-host navigation and preconnect delay; both fixed. Its user-gesture concern does not reproduce in code: permissions.request is called synchronously before the first await. Popup closure retains optional permissions until browser revocation, documented in README. Actual installed-extension permission prompt, live authenticated import, and Mica behind the native window remain interactive checks.

Release built successfully with four compiler jobs at `src-tauri/target/session-import/release/qchat.exe`, using a separate target directory because the old release is still running. User must quit the old tray app before launching the new binary (same app identifier). Current release process was preserved throughout. Helper assets are embedded and extracted by Open helper folder, so the exe does not need a separate extension-resource directory.

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

Status (M1+M2 done): `node tools/app-e2e.mjs` 7/7 PASS (guest). Removed 2026-10-30: all cookie import and browser helper code (user decision). Unverified live: real login in the sign-in window, logged-in chat path, hotkey focus over other apps.
Testing rule: the user may be gaming. Use only the headless tools/app-e2e.mjs; never send keys or show windows.

## Design direction (UI)
Dark graphite "instrument panel", Swiss grid, one signal-red accent (#E5484D / icon #dc2626). System fonts: Segoe UI Variable (text), Cascadia Mono (labels and code). No bubbles: each turn is a row with a mono uppercase gutter label (YOU / GPT) and hairline dividers. Flat composer slab docked at the bottom with a red focus rule and key hints. Subtle motion (≤160ms), reduced-motion respected, SVG icons, no gradients, glass or emoji. Light variant via prefers-color-scheme (warm paper #F4F1EC).

## Next candidates
Verify logged-in path after the user signs in; unload the chatgpt page after long idle (saves ~300MB, costs a 2-4s cold start); model picker; temporary-chat toggle; autostart; release installer.

## Future (not now)
Global "prompt on selection" hotkey (UIAutomation / clipboard capture → popup near caret → replace or insert), model picker, temporary-chat toggle, history list, autostart.
