# Provider ledger

Usage and rate-limit log for delegated work. The full log through v1.4.0 is in `.agents/archive/LEDGER-2026-10.md`.

## Budget status

- codex (gpt-6.1-sol, terra): exhausted until 2026-11-07 19:18 local (recorded 2026-11-01).

## Log

2026-11-01 | v1.4.2 public release | parent | done | source/tag 2a0d294c8f2bb4287c3f739c8a76d4e7413b0881; reused 55 passing integration suites, release settings/updater2PASS, Rust39PASS/1ignore, 106syntaxPASS; installer220297926bytes SHA256 ba0f876480cf8d89d0fa1cef36f4842b28601b501496b39aba5b5d6643301501; portable6233088bytes SHA256 687cab55b45050ae889de375de305f82dfc4a5b79ea326e2b606a7c032d0b423; payload/signature/manifest verified; public/latest, five server hashes/sizes and portable/checksum roundtrip PASS; existing dist/QChat.exe preserved. Prior independent updater review reused; no application edits in release preparation.

2026-11-01 | PR14/15/16 merge updater review | codex/gpt-6-luna high | done | read-only; checksum, swap/rollback, relaunch and settings integration; no actionable blockers. Terra budget unavailable.

2026-11-01 | v1.4.1 release review | antigravity/claude-sonnet-5-5 medium | unavailable | usage quota reached, reset in 5 days 2 hours; no review produced or fallback dispatched. Parent performs source/package checks; independent review unavailable.
2026-11-01 | v1.4.1 public release | parent | done | tag/source 040fbce227a0f2c0d4dc23fef7e9ad9125371fac; 54 offline suites PASS, Rust34PASS/1ignore, 99syntaxPASS; installer220273415bytes SHA256 2e63fef43c64aae8ff45d95edd5dc209e8bab5f77e0a8ca8e6d2b7bfee5dd2f0; portable6174720bytes SHA256 73ea650e184d73ea34b72b831ec6716fb965216a30ef63b5a4dcd14947eb1036; public/latest, five server hashes/sizes verified, portable/checksum download matches; PID21480 and dist/QChat.exe preserved; mixedDPI/signed-in/clean-device install unverified.

date | task | provider/model | status | notes
---|---|---|---|---
2026-11-01 | Gemini model label, dragged-orb collapse, repo cleanup | Claude Code cloud session | done | no delegation available in this environment; 54 headless suites PASS; native/Rust unverified
