@AGENTS.md

## Claude-specific notes

- If you are the orchestrator, `.agents/ORCHESTRATOR.md` replaces the "Model routing" section of the global `~/.claude/CLAUDE.md` for this project, including its two-subagent cap. All other global preferences still apply.
- Your Claude Pro allowance is the scarcest budget in the hierarchy, and it's the one the orchestrator runs on. Spend it on planning, briefs, integration and verification. Hand off the typing.
- Native Claude subagents (`Explore`, `efficient-helper`, `integrator`, `focused-review`, `hard-problem`) draw from that same Claude Pro pool. Use `delegate_task` to OpenCode, Codex or Antigravity first, as routed in `.agents/ORCHESTRATOR.md`.
