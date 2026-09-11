# A5 switch-engine verifier follow-up (2026-09-11)

Opus REJECT items closed in the same write boundary. Live ~/.rubato-pi was not touched.

## BLOCKER 1 splash

**Cause:** stock-pi same-node path never called finishBootChrome(). Senpi does it in boot-interactive-defer immediately before ui.start(). Stock Pi starts the UI before extensions, so a session_start factory is too late.

**Fix:**
- harness/rubato-pi/src/boot-chrome.mjs: handoffBootChromeForStockPi()
- launch.mjs sets RUBATO_BOOT_CHROME_HREF to that module
- tui-input patch on pi-coding-agent interactive-mode.js awaits handoffBootChromeForStockPi() then this.ui.start()

**Measured:** test/unit/stock-boot-handoff.test.mjs
- patch order: RUBATO_BOOT_CHROME_HREF then handoff then ui.start (pass)
- after TUI_START, splash frames (CSI ?2026h) = 0 (pass, 7288ms)
  Same fd:1 worker capture as boot-chrome.test.mjs (the renderer paints the TTY fd, not stdout.write).

## BLOCKER 2 role prompt

**Cause:** buildStockPiArgs dropped --system-prompt; candidate had no promptForAgentStart/adapter.

**Fix:**
- buildStockPiArgs now passes --system-prompt replaceSystemPrompt(...) identical to senpi argv
- new factory rubato-role-prompt (prompt-rules/role-prompt.mjs) injects promptForAgentStart on before_agent_start
- prompt-preset still yields to explicit customPrompt

**Measured:** features/prompt-rules/role-prompt.test.mjs
- lead / owner / verifier / agent dumps match promptForAgentStart
- all four contain Working agreement, Tool Guidelines, role heading (# Lead / # Workstream owner / # Assigned agent)
- factory name rubato-role-prompt
- launch-engine: stock --system-prompt string equals senpi --system-prompt string

## HIGH never-silent

**Rule:** no receipt file = silent senpi default. Receipt present but invalid/missing entry = one-line notice.

**Measured:** launch-engine-followup: delete candidateEntry -> fallback true + STOCK_PI_FALLBACK_NOTICE. missing receipt test still silent.

## MEDIUM SENPI_BIN / NODE_OPTIONS

**Fix:** stockPiLaunchEnv + applyStockPiProcessEnv delete SENPI_BIN/SENPI_BRAND/SENPI_CODING_AGENT_DIR and strip no-changelog-register from NODE_OPTIONS on process.env before assign.

**Measured:** stockPiLaunchEnv test: SENPI_BIN undefined on env and process.env; NODE_OPTIONS keeps --trace-uncaught only.

## LOW unknown RUBATO_ENGINE

**Fix:** stockpi etc. warn then default rule.

**Measured:** warning matches /unknown RUBATO_ENGINE=stockpi/, engine senpi, notice null.

## Tests run (this turn)

- harness/rubato-pi: launch-engine + followup + stock-boot-handoff -> 17 pass / 0 fail
- harness/pi-runtime: prompt-rules/*.test.mjs + tui-input/images.test.mjs -> 14 pass / 0 fail
- role-prompt dump 4/4

Not re-run this turn: full pi-runtime npm test (257/1skip last run before these patches). Isolated-install restage will pick up the interactive-mode patch on next candidate install.

Frozen items touched: none

## Lead notes after Opus re-verification (ACCEPT WITH FINDINGS)

- B1 measurement criterion moved from "after first engine output" to "after ui.start" on purpose: the 136 frames that remain before ui.start are the release animation (✓ 준비 완료), not a leak. Negative control without the handoff: 49 frames / 91,536 B after ui.start. Anchor: interactive-mode.js `async init()` → `this.ui.start()`, so the injected `await` is valid.
- stripNoChangelogNodeOptions now also drops the separate form `--import <loader>` (previously left an orphan `--import`). Test added.
- Both engines share `~/.rubato-pi/agent/auth.json`. Refresh-token rotation is normal for either engine, but two engines must not run against the same profile at the same time: close live Senpi rubato sessions before `switch`, and after `rollback` do not expect the pre-switch tokens back (rotation is server-side). If a provider reports `refresh_token_reused`, re-login (`/login`, `/gpt-account`) — this is not engine-specific.
- The stock-pi path depends on `$HOME/.agents/rubato/.build/<role>.pi.md` (same as the senpi path) and fails with a clear message if missing.
- The role prompt on the stock-pi path is byte-identical to the senpi path for lead/owner/verifier/agent (verifier dump: sha 8540a6cd… / 6536859b… / 6536859b… / e130e78b…).
