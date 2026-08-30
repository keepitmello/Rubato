# Consult Playwright fallback package

This directory contains the legacy strict Playwright/agbrowse fallback. Normal
consults use the sibling Aside-based `consult` skill.

Runtime contract:

- one headed Google Chrome instance
- one profile at `~/.codex/browser-profiles/consult-agbrowse/browser-profile`
- one local CDP endpoint at `127.0.0.1:9222`
- one bootstrap `about:blank` tab so macOS app termination can close the owner
- `agbrowse` auto-start disabled
- independent initial consults in separate tabs through `--parallel`
- saved `sessionId` reuse for follow-ups
- commit-verified `send` followed by separately recoverable `poll`
- append-only recent-topic and recovery history in the shared browser home
- same-session target locking and run-specific output ownership
- verbatim first-message transport: the derived title is the first line, with no generic `[USER]` or `## Question` wrapper

External prerequisites intentionally not vendored into the package:

- macOS with Google Chrome
- Python 3
- `agbrowse` 0.1.18 or a compatibility-verified newer release

After extracting, run from the skill directory:

```bash
python3 scripts/check_consult_runtime.py
python3 scripts/ensure_consult_chrome.py --ensure
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
```

The query and code helpers close their own provider tab and call
`scripts/ensure_consult_chrome.py --hide-if-idle` on completion. A later
follow-up recovers its saved conversation URL into a new owned tab.

Do not install this fallback in a normal Agent Skills root. The main `consult`
skill reads it from the sibling repository path only after Aside fails.
