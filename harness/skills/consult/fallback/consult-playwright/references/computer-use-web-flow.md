# Manual Web UI Fallback

Use this only when the normal `agbrowse web-ai` path is blocked by login, MFA, CAPTCHA, provider UI drift, or an explicit user-approved exception.

## Preconditions

- `.consult/consult-packet.md` exists and has been reviewed for secrets.
- `.consult/chatgpt-web-prompt.md` or `.consult/chatgpt-upload-instructions.md` exists.
- The user is available to complete login, MFA, CAPTCHA, or other security prompts.

## Allowed

- Operate the visible ChatGPT web UI with user-approved manual browser control.
- Paste the prepared prompt or upload `.consult/consult-packet.md`.
- Ask the user to complete security challenges.
- Copy the final answer through the visible UI and save it with `scripts/save_clipboard_response.py`.

## Not Allowed

- OpenAI API calls.
- Private or unofficial ChatGPT endpoints.
- Token, cookie, local storage, or browser profile extraction.
- Hosted browsers, stealth, reverse proxies, CAPTCHA bypass, or rate-limit bypass.
- Developer tools or network-panel scraping.

## Steps

1. Explain why `agbrowse` could not complete the workflow.
2. Open ChatGPT in a normal visible browser session.
3. Enter the Work project and verify its project marker and composer. If Work is not visible or cannot be verified, stop before sending.
4. Select GPT-5.6 High, Extra High, or Pro according to the main session's chosen quality tier. If the exact selection is unavailable, stop; do not fall back to Instant.
5. Paste `.consult/chatgpt-web-prompt.md` or upload `.consult/consult-packet.md` and paste `.consult/chatgpt-upload-instructions.md`.
6. Wait until the response is complete.
7. Copy the final answer with the visible copy control.
8. Save it:

```bash
python3 <skill-dir>/scripts/save_clipboard_response.py \
  --output .consult/consult-response.md
```

After saving, follow `references/after-advice.md`.
