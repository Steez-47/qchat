<img src="assets/icon.svg" width="64" height="64" alt="">

# QChat

A tiny Windows popup for chatting with ChatGPT through your own chatgpt.com session.

- **Alt+Q** toggles the popup. The tray icon has New chat, Sign in and Quit.
- **Sign in:** Settings or the tray -> Sign in. Log in once in the window that opens, and you stay signed in.
- Without signing in it chats as a ChatGPT guest.
- Attach files with the paperclip, paste from the clipboard, or drop them onto the chat. Attachments can be sent with or without text.
- Replies support image previews, audio/video controls, and files saved to Downloads without overwriting existing files. Unsupported previews can be opened in ChatGPT.

QChat accepts up to 10 attachments totalling 512 MB. ChatGPT's own account, upload and format limits still apply; audio/video playback also depends on WebView2's codecs. Live voice/camera sessions are not implemented. Files are staged in bounded chunks and reply media is cached on disk, then cleared on New chat or Quit. Normal sign-in stays saved.

## Build and run
```
npm install
npm run build          # installer + exe in src-tauri/target/release
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
