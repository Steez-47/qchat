# QChat plan

Goal: a compact, glassy Windows popup for chatting with ChatGPT or Gemini through the user's own signed-in sessions. See `docs/DESIGN.md` for the owner's brief, which outranks everything else.

Stack: Tauri 2 (Rust, WebView2) host in `src-tauri/`, plain HTML/CSS/JS front end in `ui/`, provider bridges injected into hidden chatgpt.com and gemini.google.com windows (`src-tauri/bridge/`). Tests are Node scripts in `tests/`; headless suites drive the UI against `ui/mock.js`.

History up to v1.4.0 (milestones, release records, verification logs) is in `.agents/archive/PLAN-2026-10.md`.

## Current state

- Latest release: v1.4.0 (2026-11-01). `main` is the only long-lived branch.
- `npm test` runs the 54 headless suites. CI runs them on every push and pull request.

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

- Run the native suites and `cargo test` on Windows after the window-shift change.
- Signed-in checks still outstanding from earlier releases: Temporary chat, attachments, model switching, clean-device install.
