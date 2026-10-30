<img src="assets/icon.svg" width="64" height="64" alt="">

# QChat

A tiny Windows popup for chatting with ChatGPT through your own chatgpt.com session.

- **Alt+Q** toggles the popup. The tray icon has New chat, Sign in and Quit.
- **Sign in:** use Settings or the tray's "Sign in to ChatGPT…", log in once, then close that window. Cookies persist. Or paste your `__Secure-next-auth.session-token` under Settings → Import session cookie.
- Without signing in it chats as a ChatGPT guest.

## Build and run
```
npm install
npm run build          # installer + exe in src-tauri/target/release
# or for development:
cd src-tauri && cargo build && target/debug/qchat.exe
```

## Test
`node tools/app-e2e.mjs`: drives the real app headlessly over WebView2 CDP (debug build).
