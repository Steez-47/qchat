<img src="assets/icon.svg" width="64" height="64" alt="">

# QChat

A tiny Windows popup for chatting with ChatGPT or Gemini through your own signed-in sessions.

- **Alt+Q** toggles the popup. The tray icon has New chat, Sign in and Quit.
- Type `/` for commands, or press **Ctrl+K** for the menu. Drag the orb to move QChat.
- **Ctrl+P** or `/chats` searches every saved chat. Up to 3 recent chats sit as tabs on the bar.
- Focus a recent tab and use Left/Right or Home/End to move between tabs, Enter or Space to open one, and Escape to return to the composer.
- Switching chats remembers your reading position for the current app session, including in History.
- `/copy` copies the current conversation as Markdown, including quoted selections and source links. Ctrl+K opens commands while keeping your draft.
- `/export` saves the conversation as a Markdown file in Downloads, with a new filename if one already exists. It includes text received so far and also works when you explicitly export a temporary chat. Exports support up to 4 MiB of text.
- **Ctrl+Shift+C** copies the latest reply or selected composer/reply text. **Ctrl+Shift+X** copies its last code block.
- **Ctrl+F** or `/find` searches the whole open conversation. Enter or F3 moves to the next match; add Shift to move back. Escape closes search and keeps the conversation open.
- Unsent drafts recover after a reload or restart when local history is enabled. Starting or switching chats also keeps meaningful ordinary drafts in local chat history, even before the first message. Temporary chats keep their drafts out of saved history.
- `/rename` changes the current chat's name in QChat, including a meaningful unsent draft or quoted context. Use Ctrl+K to rename without replacing a draft. Enter saves and Escape cancels.
- A connection error retries when the network returns or QChat regains focus, keeping the draft, staged files and current conversation. Try again is available for manual recovery.
- `/model` picks a ChatGPT model on a signed-in account. **Ctrl+Shift+N** or `/temp` starts a temporary chat kept out of QChat's saved history. Sending requires confirmation of the provider's Temporary mode; a refusal preserves the draft and files.
- Hover a reply to copy it, retry it or open it in ChatGPT. Up arrow recalls earlier prompts.
- Your prompts have Copy and Edit in composer actions. Editing loads the prompt and quoted selections so you can revise and send it; reattach files when needed. Ctrl+Z recovers a draft replaced by an edit.
- Removing recent chats or clearing local chats offers Undo for six seconds.
- **Ctrl+Alt+Q** opens QChat with the text selected in the current app quoted in the box.
- The desktop is really blurred behind the glass, and clicks pass through the empty space around it. Desktop blur can be turned off in Settings.
- Code is highlighted and maths is rendered.
- **Ctrl+Home** jumps to the start of the visible conversation.
- **Ctrl+End** jumps to the latest message and resumes following the reply.
- `/keys` lists the shortcuts. Settings has the global shortcut.
- **Open at startup:** turn it on in Settings, the tray or with `/startup`. QChat then starts quietly in the tray at login, ready for your shortcut. Turn on *Show the bar at startup* to see it straight away. Opening QChat yourself always shows the bar.
- **Gemini:** `/gemini` and `/chatgpt`, or the last row of the picker beside the prompt, switch provider. That picker sets reasoning on ChatGPT and the model on Gemini. Tabs show each chat's provider logo. Each chat stays with the provider it started on, and Settings has a default provider and a sign-in for each. Gemini loads only once you first use it.
- **Sign in:** Settings or the tray -> Sign in. Log in once in the window that opens, and you stay signed in.
- Without signing in it chats as a ChatGPT guest.
- Attach files with the paperclip, paste from the clipboard, or drop them onto the chat. Pasting text or files outside an editing field sends them to the composer. Attachments can be sent with or without text.
- Failed attachment messages offer Retry for ten minutes, keeping newer drafts and files intact. If a staged file expires, Retry on its chip prepares the selected file again without sending it.
- If a file fails to prepare, Retry on its chip reuses the selected file. Provider switches preserve the latest draft, caret, quoted context, files and temporary-chat mode, including edits made while the switch is loading.
- Replies support image previews, audio/video controls, and files saved to Downloads without overwriting existing files. Unsupported previews can be opened in ChatGPT.
- Images show thumbnails before sending and previews in the chat. **Copy image** copies pixels to the Windows clipboard. Image requests show a preparation/generation graphic, with ChatGPT's percentage when the site supplies one.

QChat accepts up to 10 attachments totalling 512 MB. ChatGPT's own account, upload and format limits still apply; audio/video playback also depends on WebView2's codecs. Live voice/camera sessions are not implemented. Files are staged in bounded chunks and reply media is cached on disk, then cleared on New chat or Quit. Normal sign-in stays saved.

Temporary mode can be refused on guest, localized or changed provider interfaces. ChatGPT currently requires its English active control; readonly indicators are not yet supported. Gemini's fresh-chat checks currently expect `/app`; secondary-account routes such as `/u/1/app` may refuse. Signed-in live Temporary chats and uploads have not been verified by these tests.

## Install

Download `QChat_1.2.0_x64-setup.exe` from the [v1.2.0 release](https://github.com/Steez-47/qchat/releases/tag/v1.2.0). The Windows x64 installer includes WebView2, installs for your current user, and creates a Start menu shortcut. Quit any existing QChat tray instance first. This release is unsigned; Windows may show an unknown-publisher warning. See [installation and testing notes](packaging/INSTALL.txt).

## Build and run
```
npm install
npm run build          # regenerates assets/icon.svg icons and writes dist/QChat.exe
npm run build:installer # NSIS setup, portable exe, notices and checksums in dist/v<version>/
# or for development:
node tools/third-party-notices.mjs # prepares the native build input in a fresh checkout
cd src-tauri && cargo build && target/debug/qchat.exe
```

## Test

- `cargo test --manifest-path src-tauri/Cargo.toml`: sign-in logic, safe media sources, filenames and byte ranges.
- `node tools/auth-bridge-test.mjs`: signed-in composer detection, session retries, and sending after conversation preparation.
- `node tools/stream-media-test.mjs`: Unicode, interruption recovery, media discovery and attachment cancellation.
- `node tools/ux-regress-test.mjs`: streaming, dismiss and stop, retries, per-chat drafts, history and storage limits.
- `node tools/settings-presets-test.mjs`: opacity, presets, migration, saved presets and settings search.
- `node tools/drag-sync-native-test.mjs`: the blur stays up and aligned while the real window moves (skips while a fullscreen app is in front).
- `node tools/feature-ui-test.mjs`: menus, model picker, chat search, tabs, the shortcuts card and temporary chats.
- `node tools/conversation-copy-ui-test.mjs`: conversation copying, clipboard failures, draft selection, streaming and provider isolation.
- `node tools/conversation-export-ui-test.mjs`: shared Copy formatting, export limits, pending requests, privacy and draft preservation.
- `node tools/conversation-export-native-test.mjs`: real UTF-8 saves in an isolated profile, concurrent filenames, size bounds, failure recovery, window permissions and staged-file Undo. Requires a debug build.
- `node tools/keyboard-copy-ui-test.mjs`: reply/code shortcuts, selected text, streamed snapshots, clipboard failures and embedded editors.
- `node tools/draft-ui-test.mjs`: draft recovery, send failures, privacy and pending writes across chat/provider changes.
- `node tools/provider-draft-ui-test.mjs`: edits, clears, quoted context, files and privacy while a provider change or startup fallback is pending.
- `node tools/provider-draft-native-test.mjs`: the same provider-change lifecycle in an isolated hidden WebView, including real image bytes and reload persistence. Requires a debug build.
- `node tools/temporary-chat-ui-test.mjs` and `node tools/temporary-chat-bridge-test.mjs`: provider privacy confirmation, refusal recovery and guarded file staging on local fixtures.
- `node tools/temporary-chat-native-test.mjs`: native preflight, explicit privacy intent, retained bytes and stale-send races with provider submission stubbed.
- `node tools/temporary-attachment-native-test.mjs`: real WebView reloads and exact-byte guarded handoffs for both providers; all provider requests are fulfilled locally. Both native suites require a debug build.
- `node tools/edit-prompt-ui-test.mjs`, `node tools/paste-anywhere-ui-test.mjs` and `node tools/chat-undo-ui-test.mjs`: prompt reuse, pasting around the popup and reversible local chat removal.
- `node tools/find-text-test.mjs` and `node tools/find-ui-test.mjs`: literal Unicode search, inline/code ranges, keyboard navigation, streaming and menu/undo interactions.
- `node tools/find-native-test.mjs`: search, highlight rendering and native prompt-edit undo in an isolated hidden app. Requires a debug build.
- `node tools/navigation-native-test.mjs`: reading-position restore, history backfill and keyboard tab navigation in an isolated hidden app. Add `--reading-only` for reading checks. Requires a debug build.
- `node tools/math-ui-test.mjs`: maths rendering in replies.
- `node tools/highlight-test.mjs`: code highlighting round trip, token typing and speed. Plain Node, no browser.
- `node tools/surfaces-native-test.mjs`: blur and click-through surfaces, shortcut validation and autostart. Requires a debug build.
- `node tools/selection-native-test.mjs`: selection hotkey and clipboard preference. Requires a debug build.
- `node tools/media-ui-test.mjs`: uploads, paste/drop, previews, safe rendering and draft retention.
- `node tools/attachment-retry-ui-test.mjs`: attachment retry, matching draft consumption, blocked retries, expiry and early terminal races.
- `node tools/attachment-stage-retry-ui-test.mjs`: file-preparation failures, cleanup races, queued retries, provider portability, previews and narrow keyboard controls.
- `node tools/attachment-stage-retry-native-test.mjs`: real partial upload cleanup, fresh-ID byte replay, cancellation, Stop and provider switching in an isolated hidden app. Requires a debug build.
- `node tools/rename-chat-ui-test.mjs`: local titles, Unicode, persistence, privacy, keyboard undo and editor lifecycle.
- `node tools/native-media-e2e.mjs`: real WebView2 attachment bytes, local media serving, downloads, audio and video. Requires a debug build; video checks use ffmpeg from PATH.
- `node tools/app-e2e.mjs`: off-screen chat checks against ChatGPT as a guest.
- `node tools/gemini-bridge-test.mjs`: Gemini sending, streaming and Markdown conversion on synthetic pages.
- `node tools/provider-ui-test.mjs`: provider picker, switching, per-chat providers and startup settings.
- `node tools/provider-native-test.mjs`: Gemini window creation, provider routing and the startup flag, without writing the real startup entry. Requires a debug build.
- `node tools/reconnect-native-test.mjs`: hidden provider reload and simulated offline recovery, retained draft files and native busy/provider guards. Uses a disposable guest profile and sends no messages.
- `node tools/live/gemini-guest-check.mjs`: off-screen chat checks against Gemini as a guest. Requires a debug build.
- `node tools/persist-e2e.mjs`: checks native profile, settings and multiline draft recovery after Quit and restart.

The runtime harnesses use an isolated profile, terminate only their own process tree, and leave any running QChat alone.

An optional `node tools/live-media-smoke.mjs --run-with-saved-profile` checks the saved account with synthetic emoji prompts, text/image uploads and a generated CSV download. Quit all QChat instances first. This test sends messages to your account and preserves the saved profile.

`node tools/image-live-e2e.mjs --run-with-saved-profile` generates a test image, verifies its preview/progress and native copying, then uploads it to check the sent-image preview. It writes test screenshots under `dist/qa` and copies the test image to the clipboard. Quit QChat first.

Chat tools: type `/` or press Ctrl+K for commands. Ctrl+P opens searchable recent chats; up to 50 chats are kept locally, with full transcripts for the newest eight. Tabs show three recent chats. ArrowUp in an empty composer recalls session prompts; ArrowDown moves forward. Finished replies offer Copy, Retry and Open in ChatGPT. Fenced code is highlighted locally. /model reads the ChatGPT model menu; /temp starts a temporary chat. /keys lists shortcuts. Model selectors still need verification against a signed-in ChatGPT page.

Feature checks: `node tools/feature-ui-test.mjs`.

Press Ctrl+Alt+Q to ask about selected text; configure or disable it in Behavior (Backspace while recording).
