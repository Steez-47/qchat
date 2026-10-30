<img src="assets/icon.svg" width="64" height="64" alt="">

# QChat

A tiny Windows popup for chatting with ChatGPT through your own chatgpt.com session.

- **Alt+Q** toggles the popup. The tray icon has New chat, Sign in and Quit.
- **Sign in:** Settings or the tray -> Sign in. Log in once in the window that opens, and you stay signed in.
- Without signing in it chats as a ChatGPT guest.

## Build and run
```
npm install
npm run build          # installer + exe in src-tauri/target/release
# or for development:
cd src-tauri && cargo build && target/debug/qchat.exe
```

## Test

- `cargo test --manifest-path src-tauri/Cargo.toml`: sign-in window return logic.
- `node tools/app-e2e.mjs`: off-screen chat checks against ChatGPT as a guest.
- `node tools/persist-e2e.mjs`: checks that the app's profile survives Quit and a restart.

The runtime harnesses use an isolated profile, terminate only their own process tree, and leave any running QChat alone.
