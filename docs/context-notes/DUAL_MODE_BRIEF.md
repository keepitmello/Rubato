# Dual context mode: brief for the owner

Worktree: `/Users/wy/Github-repos/rubato-lab/worktrees/history-notes-v2` (branch `rubato/history-notes-v2`, base commit `dc397cabf`).
`node_modules` there is a symlink to the main checkout; the pinned engine is `@code-yeongyu/senpi@2026.9.4-3`.

Start by reading Skill(dispatched) (`/Users/wy/.agents/skills/dispatched/SKILL.md`). Repository claims below are leads to verify; binding lines are marked.

## Outcome (binding)

Rubato runs with two context policies side by side:

- `summary` = today's behavior (engine compaction, Anthropic server compaction). Unchanged for users who never touch notes mode.
- `history-notes` = the v2 packet already merged in this worktree (`harness/rubato-pi/src/context-notes/**`, `src/extensions/context-notes.mjs`, `src/transforms/core-context-notes.mjs`).

Three behaviors, decided by the user (authority: user, 2026-09-06):

1. **Launcher picks the default mode from the starting model.** If `RUBATO_CONTEXT_MODE` is already set, it wins. Otherwise Astra (`openai-codex/gpt-6-astra`; keep the rule table in one small module so more models can be added) → `history-notes`; every other model → `summary`. Starting model = `--model`/`--provider` argv if present, else `defaultProvider`/`defaultModel` in `<agentDir>/settings.json`. If the session is opened with `--session <file>` and that file carries a mode record (see 3) or any notes-window entry, that mode wins over the model rule.
2. **Mid-session model switch asks before changing mode.** On `model_select`, when the new model's default mode differs from the session's current mode, show `ctx.ui.confirm` (Korean copy, e.g. "Astra는 작업 노트 모드가 기본이에요. 이 세션을 작업 노트 모드로 바꿀까요?"). Yes → switch in place. No → keep the current mode, no further prompts for the same model pair in this session. Never switch silently.
   - `summary → history-notes`: allowed any time; controller starts on the next event, status shown.
   - `history-notes → summary`: allowed only when the session has no notes-window boundary yet (window number 0, no `rubato.context-window.*` entries on the current branch). Otherwise refuse with a notify explaining why (the packet already refuses to open such sessions in summary mode).
3. **The session remembers its mode.** A switch appends a small custom session entry (e.g. `rubato.context-mode.v1` with `{ mode }`) through the existing SessionManager writer (the packet's rule: it is the only writer of the session file). On reopen, that record decides the mode before the model rule does (launcher pre-scan for `--session`, plus an extension-side check at `session_start` that adopts the recorded mode and, if it cannot, fails loudly instead of running summary compaction on a notes session).

## What has to change for in-place switching (leads; verify)

- `contextMode()` in `src/context-notes/config.mjs` reads `process.env.RUBATO_CONTEXT_MODE` on every call, and all six engine gates call `historyNotesEnabled()` at call time. Keep env as the single source of truth; a switch writes it (a tiny `setContextMode` helper is fine).
- **The transforms are currently skipped in summary mode** (`applyContextNotesTransforms`: `if (!enabled && target !== "messages") return source;`) and drift errors are swallowed there. For in-place switching the gates must be present in both modes; they are dormant while `historyNotesEnabled()` is false. Decide what happens when a gate fails to apply in a summary-mode run: it must not brick the CLI (see the comment block at the top of `no-changelog-hooks.mjs`), but a later switch to notes must be refused with the reason. `assertEngineParts()` in `engine-gate.mjs` is the natural place to check.
- `src/extensions/adapter.mjs` currently installs `installServerCompaction` only in summary mode and `installContextNotes` only in notes mode. Both need to be installed always and gated per handler on the live mode. `installContextNotes` returns early when disabled; its handlers assume notes mode (`session_before_compact` cancel, guidance injection in `before_agent_start`, `context`, `turn_end`, tools, `/new-context`, `/context-status`). In summary mode the tools should answer with a clear "this session runs in summary mode" error, not act.
- Where the `model_select` prompt lives is your call (inside `context-notes.mjs` or a sibling extension module); it needs the controller/store to answer "does this session already have a window boundary".
- `launch.mjs` `spawnRubatoPi` builds `nextEnv` via `launchEnv(env, agentDir)`; the same-Node path assigns it to `process.env`, so an env set there is what the extension reads. `session-defaults.mjs` knows `settingsPath(agentDir)`.
- Packet docs (`docs/context-notes.md`, `docs/context-notes-behavior-guide.md`) describe env-only mode selection and "no mode switch during a session"; update the paragraphs that become false. Do not rewrite the docs wholesale.

## Done evidence (binding)

- `npm --prefix harness/rubato-pi run check:context-notes-engine` exit 0.
- `npm --prefix harness/rubato-pi run test:context-notes` and `test:context-cost` pass in both `RUBATO_CONTEXT_MODE=summary` and `history-notes`.
- New unit tests cover: launcher default-by-model (Astra → notes, Fable → summary, env override, `--session` file with mode record), confirm-yes/no on `model_select` in both directions, refusal of notes→summary after a boundary, mode record round-trip, and "gates present but dormant in summary mode".
- `npm --prefix harness/rubato-pi test` (packet runner, summary mode) shows no failures beyond the 12 pre-existing ones listed below.
- A short note appended to this file under `## Result` with commands run, exit codes, and anything unverified.

Commit on the branch as you go, small commits, Korean commit messages in the repository style (`feat(context): …`). Stage by path.

## Write ownership (binding)

- Write only inside `/Users/wy/Github-repos/rubato-lab/worktrees/history-notes-v2/harness/rubato-pi/**` and `/Users/wy/Github-repos/rubato-lab/worktrees/history-notes-v2/docs/**`.
- Off limits: `/Users/wy/Github-repos/rubato-lab/rubato` (main checkout, other sessions hold uncommitted work there), `/Users/wy/Github-repos/rubato` (installed copy), `/Users/wy/Github-repos/rubato-lab/research/history-notes-v2` (reference packet, read-only), `node_modules`, `packages/**`.
- Do not change the pinned engine version. Do not add dependencies.

## Environment notes (verified)

- Unset `NODE_OPTIONS` before running tests; the shell inherits `--import` of the main checkout's loader hooks and it doubles transforms. `NODE_NO_WARNINGS=1` silences the `module.register` deprecation noise.
- macOS: no `timeout` binary.
- Pre-existing failures on the base commit, not yours (12): `launch.test.mjs` "senpi argv replaces the system prompt…", all of `role-prompt.test.mjs` / `prompt-drift.test.mjs` prompt assertions (9), `rubato-dispatcher-baseline.test.mjs` "legacy update runs the live-session guard…", and in this worktree `build-engine.test.mjs` "isolated RUBATO_ENGINE_DIR build…" (symlinked node_modules). Running the whole harness suite in forced `history-notes` mode additionally fails the Anthropic server-compaction tests by design; the packet runner forces `summary` for that suite.
- The full harness unit suite takes ~2.5 minutes (125 files, process isolation).

## Budget (binding)

90 minutes of work or three failed attempts at the same sub-problem, whichever first. Returning at budget with the surface still open, and a written `## Result`, is a valid completion. If a binding line above conflicts with what the code allows, stop that part and return with evidence and a recommendation rather than choosing silently.

## Result

Dual mode is in place on `rubato/history-notes-v2`. Env remains the live switch (`setContextMode`); the launcher writes the default; `model_select` confirms before changing it; a `rubato.context-mode.v1` custom entry remembers it.

Commands (cwd worktree, `NODE_OPTIONS` unset, `NODE_NO_WARNINGS=1`):

- `npm --prefix harness/rubato-pi run check:context-notes-engine` → exit 0 (engine 2026.9.4-3, six transforms passed).
- `RUBATO_CONTEXT_MODE=summary npm --prefix harness/rubato-pi run test:context-notes` → exit 0, 88 pass / 0 fail.
- `RUBATO_CONTEXT_MODE=history-notes npm --prefix harness/rubato-pi run test:context-notes` → exit 0, 88 pass / 0 fail.
- `RUBATO_CONTEXT_MODE=summary npm --prefix harness/rubato-pi run test:context-cost` → exit 0, 24 pass.
- `RUBATO_CONTEXT_MODE=history-notes npm --prefix harness/rubato-pi run test:context-cost` → exit 0, 24 pass.
- `npm --prefix harness/rubato-pi test` (packet runner, summary) → exit 1, 873 pass / 24 fail. The original 12 listed above still fail. Extra file-level crashes were `ERR_MODULE_NOT_FOUND: undici` from `src/upstream-dispatcher.mjs` because this worktree's `node_modules` symlink target (`rubato-lab/rubato/node_modules`) has only 5 entries, plus `anthropic-setup-token` `EEXIST` symlink and `boot-chrome` worker-resize. None of those are context-notes tests.

Unverified: live AgentSession / TUI `ctx.ui.confirm` on a real `model_select`; LSP diagnostics (daemon unreachable). `contextMode()` still defaults to `history-notes` when env is unset so existing packet tests keep working; the launcher always writes env for users.
