# GPT-5.6 selector verification

Verified 2026-07-11 against local `agbrowse` 0.1.16 and the visible ChatGPT Work model picker. Re-checked 2026-08-20 against installed `agbrowse` 0.2.1: the live Chat Power shell is an open `role="menu"` whose root is the Power menuitem, not `composer-intelligence-picker-content`. Outpost may add Korean Power/Model/Effort labels, but it must not rewrite that root to retired content testids. Re-checked 2026-08-29 against the localized simple Chat picker: its visible simple view contains `[data-model-reasoning-effort-slider]`, while `menuitemradio` rows belong to the advanced model list. Menu-open detection accepts that visible slider structure; tier selection focuses its containing menuitem and drives the same 0..4 keyboard stops as the Power shell. The `모델 선택` toggle is never treated as a tier option merely because its descendants contain the selected effort text.

- `--quality high` -> official agbrowse `thinking` + `high` -> visible GPT-5.6 Thinking / High
- `--quality xhigh` -> official agbrowse `thinking` + `xhigh` -> visible GPT-5.6 Thinking / Extra High
- `--quality pro` -> official agbrowse `pro` with no separate effort -> visible GPT-5.6 Pro
- Version-pinned requests require the exact `GPT-5.6` family row. Missing family, model, effort, or post-click verification aborts before send.
- Require agbrowse 0.1.18 or newer; it owns GPT-5.6 picker support, so do not restore the removed local GPT-5.6 model aliases.

Selector probes use `agbrowse web-ai status` attached to the shared headed profile on port 9222 after `scripts/ensure_outpost_chrome.py --ensure`. The live smoke used `scripts/run_agbrowse_outpost.py --quality xhigh` with all outputs isolated under `/tmp`.
