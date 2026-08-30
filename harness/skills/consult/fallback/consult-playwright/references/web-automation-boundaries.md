# Web Automation Boundaries

This skill is deliberately web-only and uses `agbrowse web-ai` as its browser execution backend.

## Allowed

- First run `scripts/ensure_consult_chrome.py --ensure`, then use `agbrowse web-ai` attached to the shared local headed Chrome endpoint (`BROWSER_AGENT_HOME=$HOME/.codex/browser-profiles/consult-agbrowse`, `CDP_PORT=9222`, `AGBROWSE_WEB_AI_AUTO_START=0`). `scripts/consult_runtime.py` is the runtime SSOT used by both helpers. Bare local `agbrowse` commands must use this same owner and must not launch a second Chrome/profile.
- Use the user's already logged-in ChatGPT web session in the shared profile at `~/.codex/browser-profiles/consult-agbrowse/browser-profile`.
- Keep that single profile and browser instance. Run independent consult queries concurrently with agbrowse `--parallel` in invocation-owned tabs; serialize only calls targeting the same saved provider session. Each helper closes its exact session target and stops the owner when no nonblank task tab remains. Saved sessions recover from `conversationUrl` on follow-up. Do not clone profiles, auto-start Chrome from `agbrowse`, or start parallel headed browsers.
- Submit inline prompts or upload `.consult/consult-packet.md` through `agbrowse`.
- Use GPT-5.6 Pro by default, GPT-5.6 Extra High for difficult lower-latency work, or GPT-5.6 High when Pro latency is disproportionate. Stop before sending if the visible selector cannot verify the requested family/tier.
- Wait for ChatGPT completion through `agbrowse web-ai query`, `send`/`poll`, or `watch`.
- Continue a saved consult conversation through `agbrowse web-ai query --session <sessionId>` when a follow-up is useful.
- Save the answer into `.consult/consult-response.md`.
- Use `agbrowse web-ai code` only for user-requested code artifact drafts, saving generated zip files under `.consult/code-artifacts/`.
- Use `agbrowse web-ai code-extract` to re-retrieve zip artifacts from an existing accessible ChatGPT code-mode conversation.
- Save trace or JSON evidence under `.consult/` when available.
- Require helper correlation validation before treating a saved response as belonging to the submitted packet; preserve mismatches under `MISROUTED-` names and fail nonzero.

## Not allowed

- OpenAI API calls.
- Unofficial/private ChatGPT API endpoints.
- OAuth, access token, cookie, local storage, or session extraction.
- Reverse proxies or third-party ChatGPT API wrappers.
- Direct Playwright, Selenium, Puppeteer, or custom CDP scripts for ChatGPT. Use only the `agbrowse` CLI boundary.
- Applying generated code artifacts without local review and tests.
- Hosted/cloud browsers, remote CDP servers, stealth mode, or residential proxy routing.
- Cloudflare, CAPTCHA, MFA, or rate-limit bypass.
- Developer tools or network-panel scraping.
- Automatic global package updates. Confirm the installed version and release evidence, then obtain authorization before changing a global install.

## Why agbrowse is preferred here

`agbrowse web-ai` preserves the ChatGPT web UI path while giving the agent a deterministic CLI surface for submit, poll, upload, and answer capture. It is still not a bypass mechanism; if the site asks for a human security step, the user must complete it.
