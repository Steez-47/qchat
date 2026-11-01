# Testing

QChat's tests are plain Node scripts in `tests/`. None of them install dependencies.

## Offline suites (`npm test`)

`npm test` runs every suite below, one after another, and prints the tail of any that fail. Pass part of a file name to run a subset, for example `npm test -- collapse provider`.

The UI suites start an isolated, invisible Edge profile and load `ui/` against the mock backend in `ui/mock.js`. They use Edge at its default Windows path. Elsewhere, set `QCHAT_TEST_EDGE` to a Chromium-based browser. On Linux as root, point it at a small wrapper that adds `--no-sandbox`:

```bash
printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox "$@"\n' > /tmp/edge.sh && chmod +x /tmp/edge.sh
```

```bash
QCHAT_TEST_EDGE=/tmp/edge.sh npm test
```

Highlights:

- `node tests/auth-bridge-test.mjs`: signed-in composer detection, session retries, and sending after conversation preparation.
- `node tests/stream-media-test.mjs`: Unicode, interruption recovery, media discovery and attachment cancellation.
- `node tests/ux-regress-test.mjs`: streaming, dismiss and stop, retries, per-chat drafts, history and storage limits.
- `node tests/settings-presets-test.mjs`: opacity, presets, migration, saved presets and settings search.
- `node tests/feature-ui-test.mjs`: menus, model picker, chat search, tabs, the shortcuts card and temporary chats.
- `node tests/smoothness-ui-test.mjs`: fair tab widths, grapheme-safe and word-boundary titles, busy and connecting feedback, shortcut toggles and Find from a selection.
- `node tests/conversation-copy-ui-test.mjs`: conversation copying, clipboard failures, draft selection, streaming and provider isolation.
- `node tests/conversation-export-ui-test.mjs`: shared Copy formatting, export limits, pending requests, privacy and draft preservation.
- `node tests/keyboard-copy-ui-test.mjs`: reply/code shortcuts, selected text, streamed snapshots, clipboard failures and embedded editors.
- `node tests/draft-ui-test.mjs`: draft recovery, send failures, privacy and pending writes across chat/provider changes.
- `node tests/provider-draft-ui-test.mjs`: edits, clears, quoted context, files and privacy while a provider change or startup fallback is pending.
- `node tests/temporary-chat-ui-test.mjs` and `node tests/temporary-chat-bridge-test.mjs`: provider privacy confirmation, refusal recovery and guarded file staging on local fixtures.
- `node tests/edit-prompt-ui-test.mjs`, `node tests/paste-anywhere-ui-test.mjs` and `node tests/chat-undo-ui-test.mjs`: prompt reuse, pasting around the popup and reversible local chat removal.
- `node tests/find-text-test.mjs` and `node tests/find-ui-test.mjs`: literal Unicode search, inline/code ranges, keyboard navigation, streaming and menu/undo interactions.
- `node tests/math-ui-test.mjs`: maths rendering in replies.
- `node tests/highlight-test.mjs`: code highlighting round trip, token typing and speed. Plain Node, no browser.
- `node tests/media-ui-test.mjs`: uploads, paste/drop, previews, safe rendering and draft retention.
- `node tests/attachment-retry-ui-test.mjs`: attachment retry, matching draft consumption, blocked retries, expiry and early terminal races.
- `node tests/attachment-stage-retry-ui-test.mjs`: file-preparation failures, cleanup races, queued retries, provider portability, previews and narrow keyboard controls.
- `node tests/rename-chat-ui-test.mjs`: local titles, Unicode, persistence, privacy, keyboard undo and editor lifecycle.
- `node tests/gemini-bridge-test.mjs`: Gemini sending, streaming and Markdown conversion on synthetic pages.
- `node tests/provider-ui-test.mjs`: provider picker, switching, per-chat providers and startup settings.
- `node tests/picker-ui-test.mjs`: the compact picker's rows, modes, keyboard use, dismissal and layout stability.
- `node tests/popover-motion-ui-test.mjs`: popover, chip and notice entrances, ghost exits that never delay state (including while the bar folds), copy feedback, Settings page motion and motion off.
- `node tests/stream-perf-ui-test.mjs`: delta bursts coalesce into one pass per frame without flashing unfinished text, finished code blocks keep their nodes, and cached highlighting matches a fresh one, and the surface list still follows structure changes at once.
- `node tests/reply-format-ui-test.mjs`: no raw Markdown, shrinking text or shrinking bubble on any frame in every stream style, table column alignment, task lists and keyboard keys.
- `node tests/orb-task-ui-test.mjs`: minimizing during a reply, and the orb's working, ready and attention states.
- `node tests/mode-bridge-test.mjs`: Work and Task detection, switching and safe refusal on synthetic pages.

Every other `tests/*-test.mjs` that isn't native or live is also part of the run: animation, glass, history, reasoning, response tags, snapshot, collapse, smoothness and more.

## Rust

```bash
npm run test:rust
```

Covers sign-in logic, safe media sources, filenames and byte ranges.

## Native suites (Windows, debug build)

Run `cd src-tauri && cargo build` first. Each suite starts the real app with an isolated profile, kills only its own process tree, and leaves any running QChat alone.

- `node tests/drag-sync-native-test.mjs`: the blur stays up and aligned while the real window moves (skips while a fullscreen app is in front).
- `node tests/conversation-export-native-test.mjs`: real UTF-8 saves in an isolated profile, concurrent filenames, size bounds, failure recovery, window permissions and staged-file Undo. Requires a debug build.
- `node tests/provider-draft-native-test.mjs`: the same provider-change lifecycle in an isolated hidden WebView, including real image bytes and reload persistence. Requires a debug build.
- `node tests/temporary-chat-native-test.mjs`: native preflight, explicit privacy intent, retained bytes and stale-send races with provider submission stubbed.
- `node tests/temporary-attachment-native-test.mjs`: real WebView reloads and exact-byte guarded handoffs for both providers; all provider requests are fulfilled locally. Both native suites require a debug build.
- `node tests/find-native-test.mjs`: search, highlight rendering and native prompt-edit undo in an isolated hidden app. Requires a debug build.
- `node tests/navigation-native-test.mjs`: reading-position restore, history backfill and keyboard tab navigation in an isolated hidden app. Add `--reading-only` for reading checks. Requires a debug build.
- `node tests/surfaces-native-test.mjs`: blur and click-through surfaces, shortcut validation and autostart. Requires a debug build.
- `node tests/selection-native-test.mjs`: selection hotkey and clipboard preference. Requires a debug build.
- `node tests/attachment-stage-retry-native-test.mjs`: real partial upload cleanup, fresh-ID byte replay, cancellation, Stop and provider switching in an isolated hidden app. Requires a debug build.
- `node tests/native-media-e2e.mjs`: real WebView2 attachment bytes, local media serving, downloads, audio and video. Requires a debug build; video checks use ffmpeg from PATH.
- `node tests/provider-native-test.mjs`: Gemini window creation, provider routing and the startup flag, without writing the real startup entry. Requires a debug build.
- `node tests/reconnect-native-test.mjs`: hidden provider reload and simulated offline recovery, retained draft files and native busy/provider guards. Uses a disposable guest profile and sends no messages.
- `node tests/persist-e2e.mjs`: checks native profile, settings and multiline draft recovery after Quit and restart.

## Live checks (real providers)

These reach chatgpt.com or gemini.google.com. Guest checks send a few harmless prompts. The `--run-with-saved-profile` checks use your signed-in account, so quit QChat first.

- `node tests/app-e2e.mjs`: off-screen chat checks against ChatGPT as a guest.
- `node tests/live/gemini-guest-check.mjs`: off-screen chat checks against Gemini as a guest. Requires a debug build.
- `node tests/bridge-test.mjs`: the ChatGPT bridge against the live guest page in Edge.
- `node tests/live-media-smoke.mjs --run-with-saved-profile`: synthetic emoji prompts, text/image uploads and a generated CSV download on your saved account. Sends real messages.
- `node tests/image-live-e2e.mjs --run-with-saved-profile`: generates a test image, checks its preview, progress and native copying, then uploads it. Writes screenshots under `dist/qa` and copies the test image to the clipboard.
- `tests/live/`: one-off diagnostics for window regions, drag behaviour, history and streaming against the live sites.
