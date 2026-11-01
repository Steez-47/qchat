# Agent instructions

QChat is a Windows desktop app (Tauri 2 + vanilla JS) that puts ChatGPT and Gemini in a small glass bar. The landing page lives in `qchat-website/`.

The user talks to one model at a time and tells it what to do. There is no orchestrator, worker hierarchy or delegation setup in this project. Don't create one, and don't add or restore `.agents/` planning or ledger files.

## Working here

- Read neighbouring code before writing and follow its conventions.
- `ui/` is the front end, `src-tauri/` the Rust side and the provider bridges, `tests/` the test suite, `tools/` build scripts.
- Design rules for the app are in `docs/DESIGN.md`. Testing notes are in `docs/TESTING.md`.
- Checks: `npm test` (JS suite) and `npm run test:rust`. Run what covers your change before you call it done. Don't weaken or delete tests to make them pass.
- Never put secrets, API keys or `.env` contents into code, logs or replies.
