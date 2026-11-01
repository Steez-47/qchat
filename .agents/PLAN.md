# QChat plan

Goal: a compact, glassy Windows popup for chatting with ChatGPT or Gemini through the user's own signed-in sessions. See `docs/DESIGN.md` for the owner's brief, which outranks everything else.

Stack: Tauri 2 (Rust, WebView2) host in `src-tauri/`, plain HTML/CSS/JS front end in `ui/`, provider bridges injected into hidden chatgpt.com and gemini.google.com windows (`src-tauri/bridge/`). Tests are Node scripts in `tests/`; headless suites drive the UI against `ui/mock.js`.

History up to v1.4.0 (milestones, release records, verification logs) is in `.agents/archive/PLAN-2026-10.md`.

## Current state

## v1.4.3 public release (2026-11-01)

- Goal: merge PR17 screen sizing and PR18 website feature tour, then publish v1.4.3 publicly.
- Parent owns integration, small review fixes, version metadata, package verification and publication.
- Review: Luna high found a high-scaling window-fit minimum exceeding available height; parent removed the minimum and added a 200% regression case. Rust 40 pass / 1 intentional ignore.
- Status: running. Full offline suites, release build and publication pending. Preserve running app and saved profile.

## v1.4.2 public release (2026-11-01)

- Goal: publish the merged settings overhaul, website and GitHub updater as v1.4.2.
- Parent owns version metadata, packaging, asset verification and publication. Existing application verification is reused from the PR14/15/16 integration; updater received an independent Luna review.
- Status: done. v1.4.2 is public/latest at https://github.com/Steez-47/qchat/releases/tag/v1.4.2; source/tag 2a0d294c8f2bb4287c3f739c8a76d4e7413b0881. Windows installer and portable executable report 1.4.2; extracted payload, install notes/notices, Microsoft WebView2 signature, asInvoker manifest and four checksum entries verified. All five server asset sizes/SHA256 match; downloaded portable/checksum roundtrip and website latest-release lookup pass. Rust: 39 pass / 1 intentional ignore; release settings/updater suites: 2/2 pass; 106 JavaScript syntax checks pass. All 55 integration suites passed before the version bump. Existing dist/QChat.exe preserved. Native settings appearance, real updater restart, signed-in sending and clean-device installation remain unverified.

## Merge PRs 14, 15 and 16 (2026-11-01)

- Goal: merge the settings overhaul, website and GitHub updater into main, preserving all three features.
- Parent owns integration and verification. Settings conflict resolved by keeping the grouped pages and placing checkUpdates on General; both plan and changelog entries retained.
- Review: Codex Luna high read-only updater review found no actionable blockers (Terra budget unavailable).
- Status: integration verified, ready for main. All 55 offline suites pass across the full run and focused rerun of six settings-dependent suites after correcting the merged checkUpdates key. Windows Rust tests: 39 pass / 1 intentional ignore; cargo build passes with one existing dead-code warning. JavaScript syntax and diff checks pass. Website live release lookup, both API handlers and offline fallbacks pass.
- Vercel deployment checks are failing; deployment configuration is outside this merge. Native settings appearance and a real updater download/swap/relaunch remain unverified; running app and saved profile preserved.

## v1.4.1 public release (2026-11-01)

- Goal: publish the current build with synchronized v1.4.1 metadata, installer, portable executable, notices and checksums.
- Parent owns release metadata and packaging; one cross-family reviewer checks the post-v1.4.0 orb/model changes read-only.
- Status: done. v1.4.1 public/latest at https://github.com/Steez-47/qchat/releases/tag/v1.4.1; tag/source 040fbce227a0f2c0d4dc23fef7e9ad9125371fac. All 54 offline suites, Rust 34 PASS/1 intentional ignore and 99 syntax checks PASS. Installer payload/version, offline WebView2 signature, asInvoker manifest and checksums verified. All five published asset sizes/server SHA256 match; downloaded portable/checksum roundtrip PASS.
- Review: requested Antigravity Sonnet medium; provider quota prevented review. Parent source/package checks complete, no application edits. Native mixed-DPI behavior, signed-in sending and clean-device installation remain unverified. Running app/profile preserved.

- Latest release: v1.4.2 (2026-11-01). `main` is the only long-lived branch.
- `npm test` runs the 54 headless suites. CI runs them on every push and pull request.

## Settings overhaul (2026-11-01)

| task | owns | status |
|---|---|---|
| Rebuild settings as one declared layout: 13 pages in 3 sidebar groups, one page at a time, titled groups, written option labels, per-page reset, changed dots, cross-page search, remembered page | ui/settings.js, ui/settings.css, ui/settings.html | done |
| Update suites for new section names/count; add navigation checks | tests/glass-ui-test.mjs, tests/settings-presets-test.mjs, tests/reasoning-ui-test.mjs, tests/ui-bugfix-test.mjs, tests/settings-e2e.mjs | done: 54/54 headless suites pass |

Done in a cloud session without T3 delegation tools, so no workers were used. Verified headless only (Linux Chromium; Segoe Fluent icons don't render there). Not verified: native settings window on Windows (settings-e2e count updated to 13 but not run).
## Update from GitHub releases (2026-11-01)

| task | owns | status |
|---|---|---|
| Check the latest GitHub release over WinHTTP; download QChat.exe, verify SHA-256 (asset digest or SHA256SUMS.txt), swap the running exe aside and relaunch | src-tauri/src/update.rs, main.rs, build.rs, Cargo.toml, capabilities/main.json | done |
| Orb badge, hover chip with Update / skip, `/update`, "Updated to vX" after relaunch, Behavior setting | ui/update.js, ui/app.js, ui/index.html, ui/app.css, ui/settings*.js, ui/mock.js | done |
| Regression checks | tests/update-ui-test.mjs, Rust unit tests in update.rs | done |

Verified: `cargo check --target x86_64-pc-windows-msvc --all-targets` clean; update.rs pure-logic tests pass on Linux; headless UI suite passes. Not verified: a real download/swap/relaunch on Windows (needs a published release newer than the build), installed copies under a non-writable folder (falls back to "Get it on GitHub"). An exe swap does not update the uninstaller's recorded version.

## Gemini model label and dragged-orb collapse (2026-11-01)

| task | owns | status |
|---|---|---|
| Report the Gemini mode as soon as its switcher draws; keep and remember the last known mode | src-tauri/bridge/gemini-bridge.js, ui/app.js | done |
| Reopen a folded orb dragged onto the other screen half toward the middle of the screen | ui/collapse.js, ui/app.js, src-tauri/capabilities/main.json | done |
| Regression checks (collapse, provider, Gemini bridge) | tests/ | done: new checks fail on the old code and pass now |

Verified headless only. Not verified: the native window shift on Windows (mixed-DPI especially), Rust build, signed-in Gemini.

## Repository cleanup (2026-11-01)

| task | status |
|---|---|
| Tests moved from `tools/` to `tests/`; research notes and DESIGN.md moved to `docs/` | done |
| README rewritten; CHANGELOG, CI, issue/PR templates, `npm test` runner added | done |
| Restored `.agents/ORCHESTRATOR.md` (deleted by accident in 3f7cb3f); archived the old plan and ledger | done |
| t3/main merged into main; other branches deleted | done, except anything GitHub refuses until the default branch is main |

## Open follow-ups

- Run native window-shift checks on Windows, especially mixed DPI. Rust tests/build passed for v1.4.1.
- Signed-in checks still outstanding from earlier releases: Temporary chat, attachments, model switching, clean-device install.
