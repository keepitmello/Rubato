---
name: browser-cli
description: "브라우저 작업 진입점. 탐색, 폼, 캡처, 로그인 사이트는 여기서 시작."

---

# Browser CLI

## Hierarchy

- This skill is the entry router. Choose the browser backend here first.
- After choosing Aside (`aside exec` or `aside repl`), read the `aside-browser` skill before using the CLI. That skill owns Aside session, tab, snapshot, download, and REPL details.
- Do not load `aside-browser` for agent-browser/Cloak, the built-in Browser, or chrome-devtools.

## Route

- Default to the Mac-local Aside browser agent through `aside exec`. Give it the complete outcome, relevant context, constraints, approval boundaries, and evidence required.
- Treat the Aside CLI process as the delegated workstream: keep it attached, poll it, surface a short user update at least every 60 seconds, and recover its final output and exit status. Starting the command is not completion.
- Use `aside --session <id> "..."` only to continue a session whose exact ID the CLI returned. Never guess a session ID.
- Use `aside repl` only when the task explicitly needs direct page inspection, deterministic low-level interaction, screenshots, downloads, or exact browser-state evidence that whole-task delegation cannot provide.
- Use `agent-browser` with shared Cloak only as a manual fallback when the user explicitly requests it or Aside cannot perform the required low-level step.
- Use the built-in Browser only when the user names it or needs a visible/live in-app tab.
- Use `chrome-devtools` only for Lighthouse, performance insights, heap, or memory analysis. Use ordinary Chrome `9222` for reproducible performance baselines.
- Do not use `browser-use` or `chrome-use`.

## Default workflow: delegate and recover

Before relying on remembered flags, inspect the installed CLI:

```bash
command -v aside
aside --version
aside exec --help
```

Then read `aside-browser` and run Aside in an interactive PTY with one self-contained task:

```bash
aside exec "<complete browser task, constraints, approval boundaries, and required evidence>"
```

Wait for the process to finish, then use the returned final answer, artifacts, and exit status as the handoff result. If the result is incomplete, continue only with the exact session ID returned by Aside:

```bash
aside --session <session-id> "<focused follow-up>"
```

Do not duplicate the same task in another browser agent while Aside is still running. Do not replace a failed primary path with a manual fallback until the failure or missing evidence is clear.

## Manual alternatives

For direct Aside control, read `aside-browser` and inspect `aside repl --help`. Do not duplicate Aside REPL APIs here.

For the explicit `agent-browser` fallback, use the shared headless Cloak process on `9333`; use the separate shared headed process on `9334` only when necessary. Separate tasks with unique `--session` values and tab labels, reuse a suitable owned tab, and never launch another browser for the same mode.

```bash
codex-cloak-cdp start --port 9333
agent-browser --cdp 9333 --session my-task tab list
agent-browser --cdp 9333 --session my-task tab new --label my-task "https://example.com"
agent-browser --cdp 9333 --session my-task tab my-task
agent-browser --cdp 9333 --session my-task snapshot -i
agent-browser --cdp 9333 --session my-task click @e1
agent-browser --cdp 9333 --session my-task tab close my-task
```

For headed fallback, run `codex-cloak-cdp start --headed`, use `--cdp 9334`, close the exact task tab, then run `codex-cloak-cdp stop --headed`. Stop refuses while another non-blank task tab remains.

Run `agent-browser skills get core --full` or `chrome-devtools --help` for current command details instead of duplicating their references here.

Never navigate or close unrelated tabs. Hand CAPTCHA or security challenges to the user, and ask before live production mutations, payments, posts, messages, or other consequential external actions.
