<p align="center">
  <img src="assets/icon.svg" width="88" height="88" alt="QChat icon">
</p>

<h1 align="center">QChat</h1>

<p align="center">
  A tiny, glassy Windows popup for chatting with ChatGPT or Gemini through your own signed-in sessions.
</p>

<p align="center">
  <a href="https://github.com/Steez-47/qchat/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Steez-47/qchat?label=release"></a>
  <a href="https://github.com/Steez-47/qchat/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Steez-47/qchat/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20x64-0078d4">
  <img alt="Built with Tauri" src="https://img.shields.io/badge/built%20with-Tauri%202-24c8db">
</p>

---

QChat sits over whatever you're doing as one small bar with a bubble or two, and no background window. Press **Alt+Q**, ask, and get back to work. It talks to chatgpt.com and gemini.google.com in hidden windows using your own sessions, so you get your account's models and history without opening a browser tab.

- [Install](#install)
- [Using QChat](#using-qchat)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Limits](#limits)
- [Building from source](#building-from-source)
- [Testing](#testing)
- [Project layout](#project-layout)

## Install

Download `QChat_1.4.2_x64-setup.exe` from the [latest release](https://github.com/Steez-47/qchat/releases/latest) and run it.

- It installs for your Windows user, adds a Start menu shortcut, and includes the WebView2 runtime. Nothing else needs installing.
- Quit any running QChat from its tray menu first. Your settings, chats and sign-in carry over.
- The build is unsigned, so Windows may show an unknown-publisher or SmartScreen warning. Each release has SHA256 checksums you can verify.
- Supported: Windows 11 x64 (recommended) and Windows 10 22H2 x64.

See [packaging/INSTALL.txt](packaging/INSTALL.txt) for upgrade, uninstall and testing notes.

## Using QChat

**Getting started**
- **Alt+Q** shows or hides the popup. The tray icon has New chat, Sign in and Quit.
- **Sign in** from Settings or the tray. Log in once in the window that opens and you stay signed in. Without signing in, QChat chats as a ChatGPT guest.
- Type `/` for commands, or press **Ctrl+K** for the menu. `/keys` lists every shortcut.
- Drag the orb to move QChat.

**Providers and models**
- Switch between ChatGPT and Gemini with `/chatgpt` and `/gemini`, or from the last row of the picker beside the prompt.
- That picker sets reasoning on ChatGPT and the model on Gemini. `/model` picks a ChatGPT model on a signed-in account.
- Each chat stays with the provider it started on, and tabs show its logo. Settings has a default provider and a sign-in for each. Gemini only loads once you first use it.

**Chats**
- Up to 3 recent chats sit as tabs on the bar. **Ctrl+P** or `/chats` searches every saved chat. Up to 50 chats are kept locally, with full transcripts for the newest eight.
- New chats are named from the first line of the first prompt. `/rename` renames the current chat.
- Unsent drafts survive a reload or restart when local history is on. Switching chats keeps them, and remembers where you were reading.
- **Ctrl+Shift+N** or `/temp` starts a temporary chat that stays out of QChat's saved history. Sending waits until the provider confirms its Temporary mode. If it refuses, your draft and files are kept.
- Removing chats, `/clear` and `/discard` can each be undone for six seconds.

**Replies**
- Code is highlighted and maths is rendered. Replies appear block by block as they finish, so formatting doesn't jump around.
- Hover a reply to copy it, retry it or open it in ChatGPT. Your own prompts have Copy and Edit.
- `/copy` copies the conversation as Markdown. `/export` saves it as a Markdown file in Downloads, up to 4 MiB.
- **Ctrl+F** or `/find` searches the whole conversation.

**Files and media**
- Attach with the paperclip, paste, or drop files onto the chat. Pasting outside a text field still goes to the composer.
- Images show thumbnails before sending and previews in the chat. **Copy image** puts the pixels on the clipboard.
- Replies support image previews, audio/video controls, and downloads that never overwrite existing files.
- A failed attachment message offers Retry for ten minutes. A file that failed to prepare has its own Retry.

**Window**
- The desktop really is blurred behind the glass, and clicks pass through the empty space around it. Desktop blur can be turned off in Settings.
- Click away, and after 5 seconds QChat folds into its orb. Click the orb or bring QChat back with Alt+Q to open it again, or drag it to move QChat while folded. It opens toward the middle of whichever screen you leave it on. Settings > Window sets the delay, and 0 turns folding off.
- **Open at startup** (Settings, the tray or `/startup`) starts QChat quietly in the tray at login. Turn on *Show the bar at startup* to see it straight away.
- When a new release is out on GitHub, a small arrow appears on the orb. Hover the orb and press **Update**: QChat downloads the new version, checks its checksum, and restarts into it. `/update` checks by hand; Settings > General turns checking off. QChat only asks GitHub for its latest release, about every six hours.
- A connection error retries by itself when the network returns or QChat regains focus, keeping your draft and files.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| **Alt+Q** | Show or hide QChat (change it in Settings) |
| **Ctrl+Alt+Q** | Open QChat with the text selected in the current app quoted (change or turn off in Settings > Shortcuts) |
| **Ctrl+K** | Command menu; press again to close |
| **Ctrl+P** | Search saved chats; press again to close |
| **Ctrl+F** | Find in conversation; Enter/F3 next, Shift for previous |
| **Ctrl+Shift+N** | New temporary chat |
| **Ctrl+Shift+C** | Copy the latest reply, or the selected text |
| **Ctrl+Shift+X** | Copy the reply's last code block |
| **Ctrl+Home** / **Ctrl+End** | Jump to the start of the conversation / the latest message |
| **Up** / **Down** | Recall earlier prompts in an empty composer |
| **Left/Right**, **Home/End** | Move between focused recent tabs; Enter opens, Escape returns |
| **Ctrl+Z** | Recover a draft replaced by an edit |

## Limits

- Up to 10 attachments, 512 MB in total. ChatGPT's and Gemini's own account, upload and format limits still apply. Audio and video playback depends on WebView2's codecs.
- Live voice and camera sessions are not implemented.
- Temporary mode can be refused on guest accounts, non-English or changed provider interfaces, and Gemini secondary-account routes such as `/u/1/app`. Refusing is the safe failure.
- Staged files and cached reply media are cleared on New chat or Quit. Your normal sign-in stays saved.

QChat is an independent app and is not affiliated with OpenAI or Google.

## Building from source

Requirements: Windows 10/11 x64, [Node.js](https://nodejs.org/) 22+, and a [Rust](https://rustup.rs/) toolchain with the MSVC target.

```bash
npm install
```

```bash
npm run build            # regenerates icons from assets/icon.svg and writes dist/QChat.exe
```

```bash
npm run build:installer  # NSIS installer, portable exe, notices and checksums in dist/v<version>/
```

For development:

```bash
node tools/third-party-notices.mjs   # prepares the native build input in a fresh checkout
```

```bash
cd src-tauri && cargo build && target/debug/qchat.exe
```

## Testing

```bash
npm test
```

This runs the offline suites: plain Node unit and bridge tests, and headless UI suites that drive `ui/` against a mock backend in an isolated, invisible Edge profile. No account, network or real window is involved. `npm test -- collapse` runs only the matching suites. On Linux or macOS, set `QCHAT_TEST_EDGE` to a Chromium-based browser. CI runs `npm test` on every push and pull request.

Rust unit tests run with `npm run test:rust`. Native suites need a debug build, and live checks use a real provider. Both are listed in [docs/TESTING.md](docs/TESTING.md).

## Project layout

```
ui/                 Front end: chat window (index.html, app.js), settings, idle fold, renderers
src-tauri/
  src/              Rust host: windows, blur surfaces, hotkeys, media, snapshots, export
  bridge/           Scripts injected into the hidden ChatGPT and Gemini windows
  capabilities/     Tauri permission sets per window
tests/              Unit, bridge and headless UI suites; native and live checks (tests/live/)
tools/              Build, icon and third-party notice scripts
packaging/          Installer notes and bundled licences
docs/               Design brief, testing guide and provider research notes
assets/             Source icon
```

The design brief and visual rules live in [docs/DESIGN.md](docs/DESIGN.md). Release history is in [CHANGELOG.md](CHANGELOG.md).
