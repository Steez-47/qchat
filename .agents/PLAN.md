# QChat plan

## Current milestone: repair normal sign-in connection

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
