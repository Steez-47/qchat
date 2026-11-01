# Provider ledger

Usage and rate-limit log for delegated work. The full log through v1.4.0 is in `.agents/archive/LEDGER-2026-10.md`.

## Budget status

- codex (gpt-6.1-sol, terra): exhausted until 2026-11-07 19:18 local (recorded 2026-11-01).
- antigravity (gemini-4-argon): usage limit reached, resets in 4 days 23 hours (recorded 2026-11-01).
- opencode free: usage limit reached 2026-11-01, no reset time shown.
- opencode go: the owner has a subscription and approved `opencode-go/deepseek-v4.1-flash` (2026-11-01). Blocked until Global regions is selected in the OpenCode workspace Privacy settings; only the owner can change that.

## Log

2026-11-01 | Picker and orb completion | native integrator (Sonnet 5.5) | done | two runs after the 40-turn limit; 58/58 suites. codex/gpt-6.1-terra medium also ran: build task made no changes, review delivered 4 valid findings, so Terra is usable despite the note above. Parent fixed the findings and integrated.

2026-11-01 | Finish picker and orb | codex/gpt-6-luna high | partial | two runs, minor provider fix only. opencode-go/deepseek-v4.1-flash max | unavailable | requires Global regions, no work produced. Finishing on codex/gpt-6.1-terra medium.

2026-11-01 | Compact picker and orb states | opencode/deepseek-v4.1-flash-free max | limit hit | UI code partly landed, no tests or report; finishing on codex/gpt-6-luna high (Argon, Sol and OpenCode free all out).

2026-11-01 | Bridge Work/Spark modes | opencode/deepseek-v4.1-flash-free max | limit hit at end | code landed without a report; parent ran acceptance: mode-bridge 30PASS, reasoning/gemini/temporary bridges PASS, validate_mode PASS.

2026-11-01 | Compact picker and orb states | antigravity/gemini-4-argon medium | unavailable | usage limit, no work produced; Sol exhausted, so rerouted to DeepSeek per the UI fallback chain.

2026-11-01 | v1.4.3 public release | parent | done | PR17/18 merged; tag13fafd1f0457680c8a686c69c9771b49cbc9f64d; 55offlinePASS, Rust40PASS/1ignore, 109syntaxPASS; desktop/phone/reduced-motion website smokePASS; installer220297480bytes SHA256 ea0cbf01ab12f1bdf6999499f4ff2d4f1e260ba46297748475cbe51134328720; portable6234112bytes SHA256 44251034457976cbd97b29234e1f7c3ef2bcd5fd7bf241e5307d2eda17b98dfa; public/latest, extracted payload/resources/manifest/runtime signature and five server hashes/sizesPASS. One Luna review; parent fixed high-scale bounds and mobile glow overflow. Native mixedDPI, signed-in, updater restart and clean install unverified.

2026-11-01 | PR17 screen sizing review | codex/gpt-6-luna high | done | Terra budget unavailable; found minimum side-window height could exceed highly scaled work area. Parent fixed and added 200% regression; Rust40PASS/1ignore.

2026-11-01 | v1.4.2 public release | parent | done | source/tag 2a0d294c8f2bb4287c3f739c8a76d4e7413b0881; reused 55 passing integration suites, release settings/updater2PASS, Rust39PASS/1ignore, 106syntaxPASS; installer220297926bytes SHA256 ba0f876480cf8d89d0fa1cef36f4842b28601b501496b39aba5b5d6643301501; portable6233088bytes SHA256 687cab55b45050ae889de375de305f82dfc4a5b79ea326e2b606a7c032d0b423; payload/signature/manifest verified; public/latest, five server hashes/sizes and portable/checksum roundtrip PASS; existing dist/QChat.exe preserved. Prior independent updater review reused; no application edits in release preparation.

2026-11-01 | PR14/15/16 merge updater review | codex/gpt-6-luna high | done | read-only; checksum, swap/rollback, relaunch and settings integration; no actionable blockers. Terra budget unavailable.

2026-11-01 | v1.4.1 release review | antigravity/claude-sonnet-5-5 medium | unavailable | usage quota reached, reset in 5 days 2 hours; no review produced or fallback dispatched. Parent performs source/package checks; independent review unavailable.
2026-11-01 | v1.4.1 public release | parent | done | tag/source 040fbce227a0f2c0d4dc23fef7e9ad9125371fac; 54 offline suites PASS, Rust34PASS/1ignore, 99syntaxPASS; installer220273415bytes SHA256 2e63fef43c64aae8ff45d95edd5dc209e8bab5f77e0a8ca8e6d2b7bfee5dd2f0; portable6174720bytes SHA256 73ea650e184d73ea34b72b831ec6716fb965216a30ef63b5a4dcd14947eb1036; public/latest, five server hashes/sizes verified, portable/checksum download matches; PID21480 and dist/QChat.exe preserved; mixedDPI/signed-in/clean-device install unverified.

date | task | provider/model | status | notes
---|---|---|---|---
2026-11-01 | Gemini model label, dragged-orb collapse, repo cleanup | Claude Code cloud session | done | no delegation available in this environment; 54 headless suites PASS; native/Rust unverified

2026-11-01 | Selected-text quote preview | opencode-go/deepseek-v4.1-flash high | unavailable | upstream region policy requires Global regions; no work produced, privacy settings unchanged; requested owner routing preference per T3 instructions.
2026-11-01 | Selected-text quote preview | codex/gpt-6.1-terra medium | partial | owner explicitly selected Terra; quote render landed; existing stale showReasoningPicker handler blocked startup, parent corrected it to openPicker; follow-up Terra task completing layout checks/screenshots.
2026-11-01 | Selected-text quote follow-up and review | codex/gpt-6.1-terra medium, 2 tasks | done with parent integration | owner choice overrides recorded Terra budget; parent fixed hidden-row geometry fixture and prompt line-limit finding, updated two obsolete quote fixtures. Final selection33PASS, selection/Find/provider-draft3/3PASS, rendered screenshots reviewed, release buildPASS. Full run50/56 before fixture updates; remaining4 failures reproduced on pre-change picker/mode UI. Total: 3 Terra tasks, 1 unavailable DeepSeek task; privacy unchanged.
