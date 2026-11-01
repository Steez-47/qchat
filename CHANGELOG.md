# Changelog

Notable changes to QChat. Downloads, checksums and full verification notes for each version are on the [releases page](https://github.com/Steez-47/qchat/releases).

## [Unreleased]

### Changed
- QChat sizes itself for your screen. On first start it measures the screen in logical pixels, so Windows display scaling counts. On 1080p screens it uses slightly smaller text, bar and reply sizes. On 768p and 720p screens, and on 1080p at 125% scaling or more, it uses compact sizes. Big screens keep the current sizes. If you're upgrading, any size you never changed gets the fitted value. Sizes you set yourself stay as they are.
- The settings and sign-in windows shrink to fit the screen instead of running off the bottom of 720p and 768p displays.
### Added
- Settings > Chat > *Fit to this screen* measures the screen again and resets only the size settings. Use it after moving QChat to a different monitor.

## [1.4.2] - 2026-11-01

### Changed
- Settings overhaul. The sidebar groups 13 pages under Basics, Look & feel and Account, and only one page shows at a time. Each page has a one-line description and titled groups, and every option has a plain-English name ("Shaded" quotes, "From theme" accent, "Clock icon on tabs").
- A dot in the sidebar marks pages you've changed, and each page has its own "Reset page" button.
- Search (Ctrl+F) looks across every page and opens Fine-tune when a match is inside it. The custom colour pickers only appear once you choose Custom. Preset save, import and export sit behind a disclosure. Settings reopens on the page you last used.
### Added
- QChat website with a scroll-driven demo, theme previews and links to the latest installer.
- Updates from GitHub. When a newer release is out, an arrow badge appears on the orb. Hover the orb (or the folded circle) and an **Update** button pops up above it. QChat downloads the new `QChat.exe`, checks its SHA-256, swaps it in and restarts. `/update` checks on demand, the × skips that version, and Settings > General > *Check GitHub for updates* turns checking off.

## [1.4.1] - 2026-11-01

### Fixed
- Idle folding follows the screen edge and keeps a bar with a draft open.
- The model picker names the current Gemini model at launch instead of reading "Model" while Gemini's page loads. QChat also remembers the last model between launches.
- A folded orb that was dragged to the other side of the screen now opens toward the middle of the screen instead of off the monitor edge.

## [1.4.0] - 2026-11-01

### Added
- Idle fold: after five seconds out of focus, the bar folds into its orb. Click or focus it to reopen, or drag the folded orb to move it. Settings > Behavior sets the delay, and 0 turns it off. Replies, drafts and scroll position stay in place.

### Changed
- Recent tabs share space more fairly. Chat titles keep whole emoji and use readable first-line summaries.
- Busy chat or provider switches, and Enter while connecting, now say what's happening and keep the draft. Ctrl+K and Ctrl+P toggle their menus, Ctrl+F starts from selected conversation text, and selected replies stay visible.

## [1.3.1] - 2026-11-01

### Fixed
- Snapshot screenshots and their prompt are sent together. Both providers wait for every attachment and keep the prompt if the provider's composer remounts.
- Gemini model selection responds faster, handles overlapping menu actions one at a time, and waits for a pending pick before sending.
- Replies appear as completed Markdown or tag blocks, so formatting stays stable as they arrive. Tool and image activity stays live.

### Removed
- Legacy typing-speed controls in Settings. Existing saved settings stay compatible.

## [1.3.0] - 2026-11-01

### Added
- Find in conversation (`Ctrl+F`, with `F3` / `Shift+F3` between matches).
- `/export` saves the chat as Markdown in Downloads, and `/copy` copies all of it. `Ctrl+Shift+C` copies the reply or selection, and `Ctrl+Shift+X` copies the last code block.
- Drafts survive a restart, New chat keeps a draft as its own tab, and `/rename` renames chats.
- Undo for six seconds after removing a chat, `/clear` or the new `/discard`.
- Edit a past prompt from its tools, or recall prompts with Up arrow.
- Paste text and images anywhere in the popup.
- Retry for failed attachment messages (ten minutes, same files) and for files that failed to prepare.
- Automatic reconnect when the network returns or the popup regains focus. It never resends a prompt.
- Arrow keys on recent tabs, `Ctrl+Home` / `Ctrl+End` jumps, `Ctrl+Shift+N` for a Temporary chat, and per-chat reading position.

### Fixed
- Temporary chats refuse to send unless the provider confirms Temporary mode. Your draft and files are kept.
- A failed selection capture no longer loses the clipboard.
- Holding Enter can no longer resend a message or confirm `/clear`.
- A failed send no longer leaves a duplicate attachment in the provider's composer.
- Slow replies that are still thinking no longer time out.
- Text typed during a provider switch is kept, and the draft moves rather than being copied.
- `$$`, `\(` and `[` inside inline code no longer hide text while streaming.

## [1.2.0] - 2026-10-31

Includes the v1.1 work, which was not released separately.

### Added
- Gemini, signed in or as a guest. Switch with `/gemini` and `/chatgpt` or from the picker beside the prompt. Each chat stays with its provider.
- One picker: it sets reasoning on ChatGPT and the model on Gemini.
- Provider logos on recent chat tabs.
- Images in Gemini replies.
- Open at startup, from Settings, the tray or `/startup`.

### Changed
- QChat keeps retrying if the network is down at login.
- Arrow keys in Settings apply the choice, and Ctrl+K lists every command.
- `/model` can no longer get stuck loading.

## [1.0.0] - 2026-10-31

First public release, with a Windows x64 installer that includes the WebView2 runtime. Application behaviour matches 0.1.3.

## [0.1.3] - 2026-10-31

### Added
- Formatted paragraph streaming that keeps your reading position.
- Supported interactive replies render with local controls.
- Separate glass appearance controls for the chat panel.
- A compact `/ commands` hint in the empty message box.

### Fixed
- Selected-text capture, clipboard preservation, and matching saved conversations when storage is capped.

## [0.1.2] - 2026-10-31

### Added
- Safe rendering for ChatGPT response tags: richer replies, nested formatting, citations, images, code and maths.

### Fixed
- The reasoning picker no longer flashes open again when toggled, and it animates closed.

## [0.1.1] - 2026-10-31

First beta: Snapshot attachments, per-chat reasoning, file attachments and media previews, searchable history, recent-chat tabs, source links and appearance settings.

[1.4.0]: https://github.com/Steez-47/qchat/releases/tag/v1.4.0
[1.3.1]: https://github.com/Steez-47/qchat/releases/tag/v1.3.1
[1.3.0]: https://github.com/Steez-47/qchat/releases/tag/v1.3.0
[1.2.0]: https://github.com/Steez-47/qchat/releases/tag/v1.2.0
[1.0.0]: https://github.com/Steez-47/qchat/releases/tag/v1.0.0
[0.1.3]: https://github.com/Steez-47/qchat/releases/tag/v0.1.3
[0.1.2]: https://github.com/Steez-47/qchat/releases/tag/v0.1.2
[0.1.1]: https://github.com/Steez-47/qchat/releases/tag/v0.1.1

[1.4.2]: https://github.com/Steez-47/qchat/releases/tag/v1.4.2
[1.4.1]: https://github.com/Steez-47/qchat/releases/tag/v1.4.1
