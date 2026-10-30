# Usage ledger

## Budget status (user-editable: ok | low | out)

Edit these anytime. The orchestrator reads them at kickoff and before each milestone.

- claude: ok
- codex: ok
- antigravity: ok
- opencode: ok

## Exhausted providers

<!-- orchestrator: `- <provider/model> exhausted until <YYYY-MM-DD HH:MM> (<error snippet>)` -->

## Delegations

<!-- orchestrator: one line per delegation -->
<!-- `- <YYYY-MM-DD HH:MM> | <task id> | <provider/model/effort> | <done/failed/escalated> | <note>` -->
- 2026-10-30 19:20 | A shell | codex/gpt-6.1-sol/medium | running | Tauri shell, tray, hotkey, relay, suspend
- 2026-10-30 19:20 | B bridge | codex/gpt-6.1-sol/medium | running | chatgpt.com fetch-tee bridge + CDP harness
- 2026-10-30 19:20 | C ui | antigravity/gemini-4-argon/medium | running | popup UI + mock mode
- 2026-10-30 19:55 | A shell | codex/gpt-6.1-sol/medium | done | off-screen toolwindow bg mode; suspend/cookie untested
- 2026-10-30 19:55 | B bridge | codex/gpt-6.1-sol/medium | failed(1) | guest uses /unauth-mweb NDJSON v2; 0 deltas
- 2026-10-30 19:56 | B2 bridge | codex/gpt-6.1-sol/medium | running | re-brief: NDJSON parser + streaming DOM fallback
- 2026-10-30 20:10 | C ui | antigravity/gemini-4-argon/medium | done | verified mock mode via CDP; XSS payloads escaped (checked by T0)
