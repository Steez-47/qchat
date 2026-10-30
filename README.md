<img src="assets/icon.svg" width="64" height="64" alt="">

# QChat

A tiny Windows popup for chatting with ChatGPT through your own chatgpt.com session.

- **Alt+Q** toggles the popup. The tray icon has New chat, Sign in and Quit.
- **Sign in:** Settings → Account → Sign in with your browser. Read the trust warning and explicitly consent before starting an import.
- Without signing in it chats as a ChatGPT guest.
- Uses your ChatGPT account and its normal usage limits.

## Connect your existing browser session

1. In QChat, choose **Sign in with your browser**, tick the trust checkbox, and Continue. A connection tab opens in your default browser. The connection expires after five minutes.
2. Install the helper once: choose **Open helper folder** in QChat, then open `edge://extensions` or `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select that folder.
3. Make sure you are signed into `https://chatgpt.com` in the same browser profile. Return to the QChat connection tab, open **QChat session helper** from the browser's Extensions menu, and confirm **Copy session to QChat**. Approve the browser's permission request.

The helper copies only ChatGPT session cookies to this PC's temporary QChat connection. It uses the browser's cookies API and never decrypts the browser cookie database. It has no background worker, storage, telemetry, or remote scripts. It requests cookie and site permissions on confirmation, then removes them after the transfer completes or fails.

A session cookie grants account access. Only connect a copy of QChat and helper you trust. QChat stores its copy in its local WebView2 profile until the cookie expires or you choose **Remove QChat’s saved session**. This removes QChat's cookies and leaves your external browser signed in. Closing the helper popup mid-transfer may leave its optional permissions granted; remove the helper in the browser's Extensions page if you no longer need it.

Embedded sign-in and **Advanced: paste a session cookie** remain available. A successful cookie transfer is followed by an account check; QChat does not report signed in until ChatGPT confirms it.

## Build and run
```
npm install
npm run build          # installer + exe in src-tauri/target/release
# or for development:
cd src-tauri && cargo build && target/debug/qchat.exe
```

## Test

- `cargo test --manifest-path src-tauri/Cargo.toml`: receiver validation and request framing.
- `node tools/browser-helper-test.mjs`: synthetic extension API checks.
- `node tools/signin-e2e.mjs`: off-screen consent, loopback protections, synthetic cookie import, and removal in an isolated WebView profile.
- `node tools/app-e2e.mjs`: off-screen chat checks against ChatGPT as a guest.

Both runtime harnesses isolate their profiles and terminate only their own process tree. They preserve any running QChat instance. Real browser installation and authenticated account access need an interactive check with your own account.
