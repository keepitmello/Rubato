# Consult Runbook

Run commands from the repository root. The helper reads `CONSULT_CHATGPT_URL` from the environment, then `~/.codex/consult.env`, and otherwise uses `https://chatgpt.com/`.

## Assemble the packet

The sending agent writes `.consult/<run>/packet.md` directly, in whatever structure fits the question. Include only evidence that can change the answer — the exact question, relevant code or diff excerpts, decisive logs, user/repository constraints, failed attempts, and acceptance criteria — and skip empty template sections or generic follow-up questions. Packets have no size cap; `references/context-checklist.md` has the per-type field lists, including work-consult packets.

Before sending, read the finished packet once for secrets, unnecessary personal data, stale claims, missing evidence, and accidental truncation markers.

## Prepare and submit

```bash
python3 <skill-dir>/scripts/prepare_chatgpt_web_prompt.py \
  --packet .consult/consult-packet.md \
  --output .consult/chatgpt-web-prompt.md \
  --upload-instructions .consult/chatgpt-upload-instructions.md

python3 <skill-dir>/scripts/run_agbrowse_consult.py \
  --packet .consult/consult-packet.md \
  --prompt-file .consult/chatgpt-web-prompt.md \
  --upload-instructions .consult/chatgpt-upload-instructions.md \
  --response-output .consult/consult-response.md
```

Both helpers derive the first-message heading from the packet question so ChatGPT's automatic sidebar title is topic-specific. Use `--title "<short label>"` on either helper to override it. `agbrowse` currently has no explicit ChatGPT conversation-title or rename option; the topic-first initial prompt is therefore the supported title hint.

The helper-owned preamble is Korean. At send time, the runner also recognizes and translates the previous fixed English preamble, so an older generated `chatgpt-upload-instructions.md` cannot silently restore the old wording. Custom instructions are otherwise preserved.

For simultaneous callers, use run-specific paths for `--packet`, `--response-output`, `--json-output`, `--stderr-output`, `--trace-dir`, `--session-file`, and `--turns-output`. Each initial call uses agbrowse `--parallel`, which opens and owns a separate ChatGPT tab in the one shared headed Chrome, so independent consults run concurrently without cloning the profile. Upload mode uses `--packet`; when `--prompt-file` is explicitly passed without `--packet`, the helper uses that file as the upload source instead of silently falling back to `.consult/consult-packet.md`.

### Parallel multi-tab consults

Launch independent questions as separate background processes. Every active call must have distinct artifact paths:

```bash
python3 <skill-dir>/scripts/run_agbrowse_consult.py \
  --packet .consult/a/packet.md \
  --response-output .consult/a/response.md \
  --json-output .consult/a/response.json \
  --stderr-output .consult/a/stderr.log \
  --trace-dir .consult/a/trace \
  --session-file .consult/a/session.json \
  --turns-output .consult/a/turns.jsonl &

python3 <skill-dir>/scripts/run_agbrowse_consult.py \
  --packet .consult/b/packet.md \
  --response-output .consult/b/response.md \
  --json-output .consult/b/response.json \
  --stderr-output .consult/b/stderr.log \
  --trace-dir .consult/b/trace \
  --session-file .consult/b/session.json \
  --turns-output .consult/b/turns.jsonl &

wait
```

This is parallelism across tabs, not across browser profiles. Initial calls receive unique private upload snapshots and agbrowse `--parallel` (the explicit new-tab/bypass-pool route). Follow-ups to different saved sessions can also run concurrently. Calls to the same `sessionId` are target-locked and run sequentially so one conversation cannot receive overlapping turns. The installed agbrowse provider guard still enforces its active-tab capacity; capacity errors remain fail-closed rather than falling back to tab reuse.

The helper has no default tier. Every call must choose exactly one:

```bash
--quality pro    # GPT-5.6 Pro
--quality xhigh  # GPT-5.6 Thinking / Extra High
```

Selection is fail-closed, but the enforcement point is **after submit and before polling**, not before sending. agbrowse itself fails *open* on model selection: when it cannot drive the visible picker it keeps whatever model the tab was showing, records a `warnings` entry such as `requested pro was not enforced, continuing with current ChatGPT model: ...`, and still returns `ok: true` / `status: "sent"`. The helper therefore inspects the submit payload (`warnings`, `usedFallbacks`, `modelSelection.status|verified|normalizedModel`) and, on any sign the requested tier was not applied, exits `4` with history status `model-not-enforced` — it saves the session and refuses to poll, so a lesser model's answer is never returned as the requested tier. The prompt has already been submitted at that point; recover by selecting the model manually in the browser and resuming the reported session id.

> Note when changing this check: a successful selection *also* populates `warnings` (e.g. `model selected: pro (already selected)`), so "warnings is non-empty" is not a usable failure signal — only the explicit not-enforced/not-verified phrasing and the unavailable fallbacks are. (ChatGPT changed its picker markup on 2026-08-07 and broke agbrowse 0.1.18's selectors; that incident is what this guard was built from.) agbrowse 0.2.x then identified the Chat Power shell by `[role="menuitem"][aria-label="Power"]`. A consult overlay that rewrote that root to retired `composer-intelligence-picker-content` testids made open-detection miss, so the helper retried clicks, closed the open menu, and aborted as `model-not-enforced`. The localized simple Chat picker has the opposite shape: the visible simple view owns `[data-model-reasoning-effort-slider]`, while `menuitemradio` rows belong to the advanced model list. The compatibility loader treats that visible slider structure as an open menu, drives its containing menuitem with the same 0..4 keyboard stops as the Power shell, and excludes the `모델 선택` toggle from tier-option matching.
The helpers write agbrowse stdout directly to their JSON evidence files before parsing it, so long answers are preserved independently of terminal or local tool-output limits.

The helper also fails closed on response routing. It snapshots the selected input, adds distinct run and packet receipts, and accepts an answer only when both receipts plus the returned session, conversation URL, and prompt hash match. A mismatch exits `3`, writes the answer and raw JSON under `MISROUTED-` names, records the reason in the response/turn artifacts, and invalidates the saved session file.

Submit and response polling are separate phases. `<json-output stem>.send.json` is written only for the submit phase; a successful submit has an exact provider `sessionId` and conversation URL, and the normal session file is saved immediately. The final JSON remains the poll result. If submit does not become commit-verifiable within two minutes, the helper exits `75` with history status `submit-unknown`; do not blindly retry because the provider may have accepted the turn just before the timeout.

Packet files are always attachment transport. `--packet` and `--follow-up-file` upload the selected file while the composer receives only a short title, instructions, and routing receipt. The dispatcher must not read a packet file and pass its body through `--follow-up`. Only a narrow literal `--follow-up "..."` stays inline; an unusually long literal is automatically converted to a private temporary attachment. This is a transport rule, not a content-size cap.

Every run also appends phase events to the one shared profile history at `~/.codex/browser-profiles/consult-agbrowse/consult-history.jsonl`. Inspect it through the bundled command rather than reading the JSONL by hand:

```bash
python3 <skill-dir>/scripts/consult_history.py recent
python3 <skill-dir>/scripts/consult_history.py show <run-id> --json
python3 <skill-dir>/scripts/consult_history.py recover <run-id> --json
```

`recover` matches an interrupted run's prompt hash against agbrowse's session store and reports candidate session IDs and conversation URLs. An agent must choose an exact run/session before polling or following up; topic substring matches fail on ambiguity.

Calls sharing only the consult profile and CDP port are not globally serialized. The helper target-locks a concrete saved provider session instead: a same-session waiter reports immediately and every 30 seconds, then fails with exit `75` after `--lock-timeout` (3900 seconds by default). Response, JSON, stderr, trace, turns, and saved-session paths are claimed before provider launch, and any overlap exits `75`; this is independent of tab concurrency. Each upload uses a private per-run packet path and deletes only its own snapshot after completion.

## Follow up

Find the intended conversation first:

```bash
python3 <skill-dir>/scripts/consult_history.py recent
```

```bash
python3 <skill-dir>/scripts/run_agbrowse_consult.py \
  --follow-up "<narrow follow-up>" \
  --session <exact-session-id> \
  --response-output .consult/consult-followup-response.md
```

Use `--follow-up-file` for any self-contained follow-up packet; it is always attached and never pasted into the composer. Use `--session <id>` to select a specific saved session. Create a fresh packet when repository facts changed materially.

## Code archive

```bash
python3 <skill-dir>/scripts/run_agbrowse_code.py \
  --quality pro \
  --prompt "Create a focused patch package. Include PLAN.md and tests." \
  --packet .consult/consult-packet.md \
  --output-zip .consult/code-artifacts/consult-code.zip
```

Use `--multi-zip --output-dir .consult/code-artifacts` for several packages. Use `--extract-only --conversation <url>` to recover an archive from an existing code-mode conversation without sending another prompt.

## Manual visible-UI fallback

Use only when login, CAPTCHA, MFA, or verified provider drift blocks the normal helper.

```bash
python3 <skill-dir>/scripts/prepare_chatgpt_web_prompt.py \
  --packet .consult/consult-packet.md \
  --output .consult/chatgpt-web-prompt.md \
  --copy

python3 <skill-dir>/scripts/save_clipboard_response.py \
  --output .consult/consult-response.md
```

Do not replace this fallback with private endpoints, credential extraction, stealth, or hosted browser routing.
