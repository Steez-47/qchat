<img src="assets/icon.svg" width="64" height="64" alt="">

# QChat

A tiny Windows popup for chatting with ChatGPT through your own chatgpt.com session.

- **Alt+Q** toggles the popup. The tray icon has New chat, Sign in and Quit.
- **Sign in:** Settings or the tray -> Sign in. Log in once in the window that opens, and you stay signed in.
- Without signing in it chats as a ChatGPT guest.
- Attach files with the paperclip, paste from the clipboard, or drop them onto the chat. Attachments can be sent with or without text.
- Replies support image previews, audio/video controls, and files saved to Downloads without overwriting existing files. Unsupported previews can be opened in ChatGPT.
- Images show thumbnails before sending and previews in the chat. **Copy image** copies pixels to the Windows clipboard. Image requests show a preparation/generation graphic, with ChatGPT's percentage when the site supplies one.

QChat accepts up to 10 attachments totalling 512 MB. ChatGPT's own account, upload and format limits still apply; audio/video playback also depends on WebView2's codecs. Live voice/camera sessions are not implemented. Files are staged in bounded chunks and reply media is cached on disk, then cleared on New chat or Quit. Normal sign-in stays saved.

## Build and run
```
npm install
npm run build          # regenerates assets/icon.svg icons and writes dist/QChat.exe
# or for development:
cd src-tauri && cargo build && target/debug/qchat.exe
```

## Test

- `cargo test --manifest-path src-tauri/Cargo.toml`: sign-in logic, safe media sources, filenames and byte ranges.
- `node tools/auth-bridge-test.mjs`: signed-in composer detection, session retries, and sending after conversation preparation.
- `node tools/stream-media-test.mjs`: Unicode, interruption recovery, media discovery and attachment cancellation.
- `node tools/media-ui-test.mjs`: uploads, paste/drop, previews, safe rendering and draft retention.
- `node tools/native-media-e2e.mjs`: real WebView2 attachment bytes, local media serving, downloads, audio and video. Requires a debug build; video checks use ffmpeg from PATH.
- `node tools/app-e2e.mjs`: off-screen chat checks against ChatGPT as a guest.
- `node tools/persist-e2e.mjs`: checks that the app's profile survives Quit and a restart.

The runtime harnesses use an isolated profile, terminate only their own process tree, and leave any running QChat alone.

An optional `node tools/live-media-smoke.mjs --run-with-saved-profile` checks the saved account with synthetic emoji prompts, text/image uploads and a generated CSV download. Quit all QChat instances first. This test sends messages to your account and preserves the saved profile.

`node tools/image-live-e2e.mjs --run-with-saved-profile` generates a test image, verifies its preview/progress and native copying, then uploads it to check the sent-image preview. It writes test screenshots under `dist/qa` and copies the test image to the clipboard. Quit QChat first.

Chat tools: click the orb or press Ctrl+K for commands. Ctrl+P opens searchable recent chats; up to 50 chats are kept locally, with full transcripts for the newest eight. Tabs show three recent chats. ArrowUp in an empty composer recalls session prompts; ArrowDown moves forward. Finished replies offer Copy, Retry and Open in ChatGPT. Fenced code is highlighted locally. /model reads the ChatGPT model menu; /temp starts a temporary chat. /keys lists shortcuts. Model selectors still need verification against a signed-in ChatGPT page.

Feature checks: `node tools/feature-ui-test.mjs`.

Press Ctrl+Alt+Q to ask about selected text; configure or disable it in Behavior (Backspace while recording).
