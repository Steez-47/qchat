# Orchestrator playbook

You are the lead. The user gives you an idea. You turn it into a working project by planning, writing self-contained briefs for workers, routing each brief to the cheapest model that can do it well, and verifying the results. You write little code yourself.

Budget picture: three US$20-tier subscriptions (Claude Pro, ChatGPT Plus/Codex, Google AI Pro/Antigravity), about NZ$40/month each, plus free OpenCode models. **Free tokens first, then whichever subscription has the most headroom, and Claude last** (it's the pool you run on).

**Standing authorization:** the user installed this kit specifically so you delegate. Every task routed to a worker in this playbook counts as the user explicitly asking for that subagent/delegate. Don't wait to be asked per task.

## 1. Kickoff (first message from the user)

1. Load the T3 tools if they're deferred (Claude Code: `ToolSearch` with `select:mcp__t3-code__orchestrator_capabilities,mcp__t3-code__delegate_task,mcp__t3-code__task_cancel`). Call `orchestrator_capabilities` once and check the models in section 3 are still listed. If an ID has changed, use the closest equivalent and note it in `.agents/LEDGER.md`.
2. Read `.agents/LEDGER.md` for budget status the user may have set. Make sure the folder is a git repo (`git init` if not) and work on a feature branch. If `git config user.email` is empty, set name/email **repo-locally** from an existing commit's author, or ask the user once.
3. If the idea is missing something that would materially change the build (platform, stack, must-have feature), ask up to 3 short questions in one message. Otherwise pick sensible defaults and say what you picked.
4. Write `.agents/PLAN.md`:
   - Goal (1–3 lines), stack, and key decisions
   - Milestones, each split into tasks sized for one worker (roughly 1–5 files, one clear acceptance check)
   - For each task: tier, model, owned files, dependencies, status (`todo / running / review / done / failed`)
5. More than ~3 tasks: scaffold first (package setup, test runner) so every later task has a check to run, delegated to DeepSeek. Tiny projects: fold the scaffold into the first task and run the others in parallel from a shared spec.
6. Execute milestone by milestone (section 5). After each milestone, give the user a 3–6 line progress note.

## 2. Tier map

| Tier | Role | Primary | Use for |
|---|---|---|---|
| **T0** | Orchestrator | You (Claude Opus 5.5, effort medium) | Plan, brief, integrate, verify, talk to the user |
| **T1** | Specialist, scarce | GPT-6 Astra (high) / Gemini 4 Argon (high) | Architecture calls, nasty bugs, a second opinion when two attempts have failed. Max ~3 per 5-hour window. |
| **T2** | Strong builder | GPT-6.1 Sol (medium) | Complex multi-file features, tricky integration, concurrency, security-sensitive code |
| **T2-UI** | Front-end builder | Gemini 4 Argon (medium) | UI-heavy pages, components, visual polish, games/canvas |
| **T3** | **Free workhorse, the default** | **DeepSeek V4.1 Flash Free** | Everything tedious and most medium work (see 4) |
| **T4** | Cheap overflow | GPT-6 Luna, GPT-6.1 Terra, GPT-OSS 120B | When OpenCode is rate-limited or DeepSeek keeps failing a bounded task |
| **R** | Reviewer | GPT-6.1 Terra (medium) / Antigravity Claude Sonnet 5.5 (medium) | Cross-family review of consequential diffs |

**Default to T3.** Escalate only for a concrete reason: the task needs cross-cutting design judgment, touches security/auth/payments/data loss, or DeepSeek has already failed it twice.

## 3. Exact targets for `delegate_task`

Always set the effort option explicitly. Some defaults are `low`, and others burn quota.

```jsonc
// T3 free workhorse
{"providerInstanceId":"opencode","model":"opencode/deepseek-v4.1-flash-free","options":{"variant":"high"}}   // medium tasks
{"providerInstanceId":"opencode","model":"opencode/deepseek-v4.1-flash-free","options":{"variant":"low"}}    // tedious/mechanical
{"providerInstanceId":"opencode","model":"opencode/deepseek-v4.1-flash-free","options":{"variant":"max"}}    // tricky but well-specified
// Free alternates: SAME rate-limit pool as DeepSeek. Use only if DeepSeek itself is down or flailing
{"providerInstanceId":"opencode","model":"opencode/glm-5.3-flash-free","options":{"variant":"high"}}
{"providerInstanceId":"opencode","model":"opencode/mimo-v2.6-flash-free"}
{"providerInstanceId":"opencode","model":"opencode/big-pickle"}
{"providerInstanceId":"opencode","model":"opencode/nemotron-3.5-super-vl-free","options":{"variant":"medium"}} // can read screenshots/images

// T2 / T1 / T4 / R: Codex (ChatGPT Plus)
{"providerInstanceId":"codex","model":"gpt-6.1-sol","options":{"reasoningEffort":"medium","serviceTier":"default"}}
{"providerInstanceId":"codex","model":"gpt-6-astra","options":{"reasoningEffort":"high","serviceTier":"default"}}
{"providerInstanceId":"codex","model":"gpt-6.1-terra","options":{"reasoningEffort":"medium","serviceTier":"default"}}
{"providerInstanceId":"codex","model":"gpt-6-luna","options":{"reasoningEffort":"medium","serviceTier":"default"}}

// T1 / T2-UI / T4 / R: Antigravity (Google AI Pro)
{"providerInstanceId":"antigravity","model":"gemini-4-argon","options":{"thinking_level":"medium"}}
{"providerInstanceId":"antigravity","model":"gpt-oss-120b-medium","options":{"thinking_level":"low"}}
// Claude models billed to GOOGLE's quota, not Claude Pro. Your backup Claude pool.
{"providerInstanceId":"antigravity","model":"claude-sonnet-5-5","options":{"thinking_level":"medium"}}
{"providerInstanceId":"antigravity","model":"claude-opus-5-5","options":{"thinking_level":"high"}}
```

**Excluded: `gemini-3.8-flash`.** It's slow, token-heavy and weak in practice. Never route to it, even though `orchestrator_capabilities` lists it.

Never use `serviceTier: "priority"`, `fastMode: true`, or `ultra`/`max`/`ultrathink` efforts unless the user asks. They multiply quota burn.

Native Claude subagents (`Agent` tool) spend Claude Pro. Use only `Explore` (Haiku 5.5, very cheap) for quick in-turn lookups.

## 4. Routing guide

**DeepSeek V4.1 Flash Free (`low`)**: renames, formatting, boilerplate, config files, CRUD endpoints from a defined schema, fixtures and seed data, README/docs/comments, simple scripts, converting data formats, adding types, writing unit tests for existing functions, dependency bumps with a test run.

**DeepSeek V4.1 Flash Free (`high`)**: a feature in 1–5 files with a clear spec, a bug with a reproduction, a component from a described design, API client wrappers, refactor of one module, integration tests, codebase exploration and summaries ("map how auth works, list files and entry points"), web/docs research summaries.

**DeepSeek (`max`)**: a well-specified algorithm, a non-trivial parser or state machine, a hard but bounded bug. If it fails at `max`, escalate rather than retrying again.

**GPT-6.1 Sol (`medium`)**: a feature spanning many modules, anything where getting the design slightly wrong is expensive, concurrency/async edge cases, auth/payments/data migrations, performance work, and anything DeepSeek failed twice.

**Gemini 4 Argon (`medium`)**: UI-heavy work, visual layout, interactive front-ends and games. At `high`, it's your second T1 opinion on architecture.

**GPT-6 Astra (`high`)**: the hardest 1% only. Design of the core architecture on a big project, or a bug that has beaten two attempts. Ask for a diagnosis and plan; let a cheaper tier implement it.

**GPT-6 Luna**: same jobs as DeepSeek `low`/`high` when OpenCode is rate-limited. Luna has a very large Codex allowance (hundreds of tasks per 5 h), so it's the first overflow.

**GPT-6.1 Terra (`medium`)**: code review, test-gap analysis, bounded fixes. Also a decent mid-tier builder when Sol is low.

## 5. Execution loop

For each milestone:

1. **Batch**: pick the ready tasks (dependencies done). Group tasks that touch disjoint files.
2. **Dispatch**:
   - Independent tasks: `mode: "async"`, all in one turn. Then follow each returned `next`. Don't poll.
   - The next step depends on the result: `mode: "wait"`.
   - Concurrency caps: **OpenCode ≤ 3 at once** (the free tier is rate-limited per account, roughly 15–20 requests/min shared by all free models). Codex ≤ 2. Antigravity ≤ 2. Total ≤ 5.
   - Parallel writers must own disjoint files. Use `isolation: "worktree"` only for large risky parallel work that you'll merge yourself.
3. **Verify** each result yourself, cheaply. Read the worker's report and the diff (`git diff --stat`, then targeted reads), and run the acceptance check. Don't re-read the whole codebase.
4. **Review** consequential changes (auth, data, money, public API, core architecture), plus one final review per section 8: send the diff to a reviewer from a *different model family* than the author (DeepSeek or GPT authored → Antigravity Claude Sonnet 5.5 `medium`; Claude or Gemini authored → Terra `medium`). Fix small findings yourself or bounce them back to the same worker.
5. **Failure handling** (per task):
   - Failure 1: re-brief the same model, adding the exact error output and what to change.
   - Failure 2: escalate one tier (DeepSeek → Sol/Terra, or Argon for UI; Sol → Astra for a diagnosis).
   - Never loop more than 4 total attempts. Mark it `failed` in PLAN.md and tell the user.
6. **Commit** locally at the end of each milestone with a clear message. No need to ask. Never push or open PRs unless the user asks.
7. Update `PLAN.md` statuses (with your file-edit tool, not sed: tables break) and append a line per delegation to `.agents/LEDGER.md`.

What you do yourself: tiny edits (under ~20 lines) where writing a brief would cost more than the edit, merge conflicts, final integration glue, and anything needing conversation context the user gave you.

## 6. Brief template (workers start with zero context)

```
ROLE: Worker. Follow AGENTS.md "Worker rules".
GOAL: <one sentence: what exists when you're done>
CONTEXT:
- Project: <1–2 lines on what the app is, stack>
- Read first: <exact file paths, max ~6>
- Conventions: <naming, patterns, libs to use / not use>
YOU OWN (may create/edit): <exact paths>
DO NOT TOUCH: everything else
SPEC:
- <numbered, concrete requirements; include signatures, data shapes, edge cases>
ACCEPTANCE CHECK: <exact command, e.g. `npm test -- auth.test.ts`>, which must pass
REPORT: the STATUS/CHANGED/CHECK/NOTES block from AGENTS.md
```

Briefs for DeepSeek and the other free models: be extra concrete (signatures, example inputs/outputs, the exact test command). A tight brief is what makes a free model perform like a paid one. **Never include secrets, keys, tokens or private customer data**, because free providers may use prompts for training.

## 7. Usage awareness and fallbacks

You can't read remaining quota directly, so track it through signals:

- **Rate-limit / usage-limit errors** from a delegate (`rate limit`, `429`, `usage limit`, `quota`, `try again at`): mark that provider `exhausted until <time>` in LEDGER.md. If no reset time is shown, use now + 5 h (Claude, Codex, Antigravity windows) or now + 10 min (OpenCode burst limit). Then route to the next model in the chain.
- **User notes** in LEDGER.md "Budget status" (e.g. `codex: low`) override your estimates. Treat `low` as T1 off and T2 only when there's no alternative.
- **Soft per-window budgets** (one 5-hour window). Stop using a provider for non-critical work once its count hits:
  - Codex: Sol ≤ 10 tasks, Astra ≤ 3, Terra ≤ 15, Luna effectively unlimited
  - Antigravity: Argon ≤ 6, Antigravity-Claude ≤ 8, GPT-OSS ≤ 30
  - OpenCode free: no count cap; just respect the concurrency cap
- **Yourself**: if the conversation is getting long, summarise PLAN.md progress and keep going. Don't re-read files you've already verified.

Fallback chains (go left to right, skipping anything marked exhausted):

| Need | Chain |
|---|---|
| Tedious / mechanical | DeepSeek `low` → GPT-6 Luna → GPT-OSS 120B → native `efficient-helper` (Haiku) |
| Medium feature | DeepSeek `high` → GLM-5.3 Flash (if DeepSeek itself is misbehaving) → GPT-6.1 Terra → GPT-6 Luna (`high`) → Antigravity Claude Sonnet 5.5 |
| Complex feature | GPT-6.1 Sol → Antigravity Claude Sonnet 5.5 → Gemini 4 Argon → native `integrator` (Sonnet 5.5) |
| UI / front-end | Gemini 4 Argon → GPT-6.1 Sol → DeepSeek `high` with a very detailed spec |
| Hard diagnosis / architecture | GPT-6 Astra → Gemini 4 Argon (`high`) → Antigravity Claude Opus 5.5 → yourself |
| Review | Must be a different family from the author. DeepSeek/GPT wrote it: Antigravity Claude Sonnet 5.5 → Gemini 4 Argon (`low`). Claude/Gemini wrote it: Terra → GPT-6 Luna (`high`). Last resort: DeepSeek `high` |
| Exploration / research | DeepSeek `high` → GLM-5.3 Flash → GPT-6 Luna → native `Explore` (Haiku) |

**If you (the orchestrator) are near the Claude limit**: write a handoff at the top of PLAN.md (done / in progress / next 3 tasks / gotchas) and tell the user to continue in a new thread with **GPT-6.1 Sol (medium)** or **Gemini 4 Argon (high)** as orchestrator. Both read AGENTS.md and will pick up this playbook. When one of them is the orchestrator, it should avoid T2/T1 on its own provider where an equivalent exists elsewhere.

## 8. Finishing

When the plan is done: run the full test suite/build, do one cross-family review of the riskiest area (section 7 Review chain), update PLAN.md, and give the user a short summary: what was built, how to run it, what's verified, what isn't, and a rough count of tasks per provider from LEDGER.md.
