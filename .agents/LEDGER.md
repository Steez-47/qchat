# Usage ledger

## Budget status (user-editable: ok | low | out)

Edit these anytime. The orchestrator reads them at kickoff and before each milestone.

- claude: ok
- codex: ok
- antigravity: ok (Claude models exhausted until ~2026-10-31 02:00)
- opencode: ok

## Exhausted providers

<!-- orchestrator: `- <provider/model> exhausted until <YYYY-MM-DD HH:MM> (<error snippet>)` -->

## Delegations

- 2026-10-30 | J1 normal sign-in diagnosis | opencode/deepseek-v4.1-flash-free/high | done | read-only bridge/state analysis
- 2026-10-30 | J2 auth and prepare lifecycle fix | native codex/gpt-6.1-sol/medium | done | synthetic failing-then-passing prepare regression; parent verified real signed-in reply
- 2026-10-30 | J3 cross-family review | antigravity/gemini-4-argon/low | done | fixed loading polling, matching auth routes and loading UI; kept safe probe identity guard

- 2026-10-30 | H1 consented browser helper + secure receiver | codex/gpt-6.1-sol/medium | done | parent verified 19 synthetic runtime checks and 4 Rust tests
- 2026-10-30 | H2 consent and import UI | native codex/gpt-6-luna/medium | done | parent checked narrow UI, async cancellation, disconnect, and consent
- 2026-10-30 | H3 auth review | antigravity/gemini-4-argon/low | done | Claude quota exhausted; fixed resume/off-host reload and initial socket timeout; no secret leakage findings
- 2026-10-30 | H3 integration | T0 codex/gpt-6.1-sol/xhigh | done | 19/19 synthetic sign-in, 4/4 Rust, extension checks and 7/7 guest chat pass; alternate release build preserves running app

<!-- orchestrator: one line per delegation -->
<!-- `- <YYYY-MM-DD HH:MM> | <task id> | <provider/model/effort> | <done/failed/escalated> | <note>` -->
- 2026-10-30 19:20 | A shell | codex/gpt-6.1-sol/medium | running | Tauri shell, tray, hotkey, relay, suspend
- 2026-10-30 19:20 | B bridge | codex/gpt-6.1-sol/medium | running | chatgpt.com fetch-tee bridge + CDP harness
- 2026-10-30 19:20 | C ui | antigravity/gemini-4-argon/medium | running | popup UI + mock mode
- 2026-10-30 19:55 | A shell | codex/gpt-6.1-sol/medium | done | off-screen toolwindow bg mode; suspend/cookie untested
- 2026-10-30 19:55 | B bridge | codex/gpt-6.1-sol/medium | failed(1) | guest uses /unauth-mweb NDJSON v2; 0 deltas
- 2026-10-30 19:56 | B2 bridge | codex/gpt-6.1-sol/medium | running | re-brief: NDJSON parser + streaming DOM fallback
- 2026-10-30 20:10 | C ui | antigravity/gemini-4-argon/medium | done | verified mock mode via CDP; XSS payloads escaped (checked by T0)
- 2026-10-30 20:40 | B2 bridge | codex/gpt-6.1-sol/medium | done | 4/4 live guest steps x2, dom-only pass
- 2026-10-30 20:50 | D e2e | T0 | done | real app via CDP: guest chat, recall, new chat, markdown OK; qchat.exe 6MB, webview2 ~413MB private
- 2026-10-30 20:55 | E review | antigravity/claude-sonnet-5-5/medium | running | shell + bridge security/correctness
- 2026-10-30 21:10 | E review | antigravity/claude-sonnet-5-5/medium | done | 10 findings (0 high); finding 3 reproduced by tools/app-e2e.mjs
- 2026-10-30 21:15 | F fixes | codex/gpt-6.1-sol/medium | running | all review findings; acceptance app-e2e ALL PASS
- 2026-10-30 21:45 | F fixes | codex/gpt-6.1-sol/medium | done | 11 findings fixed; e2e 7/7 verified by T0; release exe 4.3MB
- 2026-10-30 22:05 | G native UI + browser sign-in | antigravity/claude-opus-5-5/high | running | user-requested Opus; fallback antigravity Sonnet 5.5
- 2026-10-30 22:10 | G native UI | antigravity/claude-opus-5-5/high | cancelled | user re-split the work
- 2026-10-30 22:12 | G1 Fluent UI (ui/ only) | antigravity/claude-opus-5-5/high | running | fallback antigravity Sonnet 5.5
- 2026-10-30 22:12 | G2 Mica + get_theme + tray hook | antigravity/gemini-4-argon/medium | running | Rust side
- 2026-10-30 22:20 | G1 Fluent UI | antigravity/claude-opus-5-5/high | failed | usage limit (Antigravity Claude), no edits
- 2026-10-30 22:21 | G1b Fluent UI (ui/ only) | claudeAgent/claude-opus-5-5/high | running | user asked for Claude-plan Opus
- 2026-10-30 22:50 | G1b Fluent UI | claudeAgent/claude-opus-5-5/high | done | mock checks 16/16; real-app e2e pending G2
- 2026-10-30 23:05 | G2 Mica/get_theme/tray | antigravity/gemini-4-argon/medium | done | e2e 7/7 re-verified by T0 with new UI; release 4.3MB
- 2026-10-30 21:30 | H remove cookie flow, normal sign-in | T0 (delegate_task unavailable: parent_not_active) | done | e2e 7/7, persist 3/3, unit 1/1; release 4.3MB
