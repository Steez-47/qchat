# Agent instructions

This project uses a multi-model hierarchy in T3 Code. One **orchestrator** thread plans and verifies; cheaper **worker** models do most of the hands-on work.

## Which one are you?

- **Worker**: you were started by `delegate_task` or a native subagent call, and your prompt is a task brief. Follow "Worker rules" below and ignore the rest of the hierarchy docs.
- **Orchestrator**: the user is talking to you directly in a top-level thread. Read `.agents/ORCHESTRATOR.md` now and follow it for the whole project. It overrides any generic model-routing guidance in your global instructions for this project.

## Worker rules

1. Do exactly the briefed task. Stay inside the files the brief says you own; touch nothing else.
2. Do not start subagents, delegate, or open new threads.
3. Follow the project's existing conventions (read neighbouring code before writing).
4. Run the acceptance check named in the brief. If it fails, fix the cause and rerun it. Do not weaken or delete tests to make them pass.
5. If the brief is ambiguous or the task is harder than described, stop and report the gap. Do not guess at architecture.
6. Never put secrets, API keys or `.env` contents into code, logs or your reply.
7. End with a short report in this shape:

```
STATUS: done | partial | blocked
CHANGED: <file list>
CHECK: <command run> -> <pass/fail + key output line>
NOTES: <anything the orchestrator must know, max 5 lines>
```

## Project state

- Plan and task list: `.agents/PLAN.md` (orchestrator keeps it current).
- Provider usage and rate-limit log: `.agents/LEDGER.md`.
