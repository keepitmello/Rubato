# Aside Outpost Runbook

Operator and engine contract. The main session reads `SKILL.md` and calls
`outpost`, which the skills bundle installs. The configured project path, the
same project page lifecycle, and recovery live here.
There is no automatic alternate sender.

## Preconditions

- `aside --version` succeeds.
- `~/.aside/u/0/skills/user/chatgpt-work-outpost/SKILL.md` exists and validates.
- `OUTPOST_CHATGPT_URL` and `OUTPOST_PROJECT_NAME` in `~/.codex/outpost.env`
  select the ChatGPT project. `~/.codex/consult.env` and `CONSULT_*` still
  load when the new names are absent. The name is the visible project title, used as
  `{name}에서 새 채팅`. Default name is `Work` when unset.
- `--quality` is one of `pro` (ChatGPT's `Pro` tier with `최신`, answers as
  `gpt-6-pro`) or `xhigh` (ChatGPT's `매우 높음`, answers as
  `gpt-5-6-thinking`).
- The packet is self-contained and safe to disclose to Aside and ChatGPT.
- The packet's first line is one concise Markdown H1 containing only the subject
  title (`# <title>`). The calling main session owns it; the runner extracts it
  without inventing one. Do not prefix or suffix task framing such as
  `Outpost`, `review request`, `검토`, `리뷰 요청`, or `분석 요청`.

If the Aside account skill is missing, run:

```bash
bash <outpost-skill-dir>/scripts/install-aside-skill.sh
```

Fail before the REPL runner unless the URL matches:

```text
https://chatgpt.com/g/g-p-.../project
```

Global `/`, global `/c/...`, temporary chat, a non-HTTPS URL, or another host is
not a recoverable default.

## Doctor

Rehearse the whole send path without spending a turn:

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" doctor
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" doctor --json
```

Doctor runs the send's own `build_repl_script(dry_run=True)` with a throwaway
packet: it opens the configured project, picks the tier and model, fills the
composer, attaches the packet, and waits for the send button — then clears the
draft, closes the tab, and stops. It never clicks send, so no turn is spent and
no conversation is created. A green doctor therefore means the send reaches the
click; a red one names the stage that failed.

It reports the daemon first (`daemon up=… pid=…`). Aside's app restarts every
day or two, and a send that lands in that window dies with `other side closed`,
so a daemon that is not `ready` blocks. `ensure_aside_daemon()` also waits for a
just-restarted daemon to settle before a send starts.

The rehearsal also reports the live picker names, and doctor writes
`~/.codex/outpost-picker.json` from them so the next send follows the UI instead
of waiting for a code patch. Exit `0` when the rehearsal reached the click or
the contract was refreshed; exit `75` otherwise.

A renamed picker is the one drift the contract absorbs on its own. When the
rehearsal fails at `select-tier` or `verify-model`, doctor runs the older
locator-only probe to read the names the live page actually uses.

## Launch the fast path

Launch `outpost` as a background process. It drives the Aside REPL
engine and fills the output paths from the packet directory. `outpost list`
shows `working` while that process is alive. When the process exits, an idle
parent session is woken:

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md
```

List stored threads, including which are running and which have finished:

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" list
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" show <thread-id>
```

Continue a saved thread. This opens that conversation, not the project home:

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md --to <thread-id>
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md --to last
```

The runner's in-browser guard must commit the user turn under 120 seconds and
record `submitElapsedSeconds`; it exits `75` at that boundary. Never increase
or blindly retry the budget. One REPL process keeps the Work page alive through
submission, response completion, and optional download. Never split those
stages across REPL processes: closing the first process can terminate the
generation before the conversation is persisted. Aside may buffer both markers
until the process exits; parse the final transcript to distinguish pre-submit,
committed-without-response, and complete outcomes. Aside REPL does not create a
normal Aside GUI conversation entry.

Parallel runners open unique ID-derived `data:` marker tabs and resolve
their `targetId` by exact title and URL before navigating to Work. A
before/after "new tab" set difference is unsafe because simultaneous runners
can both claim the same target. Different `threadId`s may run at the same
time. A second send to the same thread fails closed while that thread is
busy; wait for it to finish or recover, then `--thread` again.

Python reads `--packet` itself and embeds the bytes in the REPL script
argument. The browser receives an in-memory file payload, never the local
packet path. The composer
starts with the packet H1 topic, then `ID: <hex>`, followed by a short
ID-bound instruction. Packet location, blank lines,
and trailing newlines therefore do not participate in browser input validation.
The runner fills the composer first, then uses the unrestricted `#upload-files`
input with a unique `outpost-<id>.md` name. Work already contains many
`packet.md` uploads, so ChatGPT renames a colliding chip to
`packet(<timestamp>).md` and an exact `packet.md` locator dies after the
upload finishes. The runner waits for the file-tile `group` whose name
contains the outpost ID, including after send becomes enabled.
A chip can still show an active upload, so submission also waits until the send
button has neither native `disabled`, `aria-disabled="true"`, nor
`data-visually-disabled`; image/video-only inputs and fixed sleeps are not
valid packet transports. The runner opens Aside, pings REPL until it answers,
and if the daemon drops before the submit marker it relaunches Aside and
retries the same send once. After a user turn commits, do not retry.
Aside confines `download.saveAs()` to its session directory. The browser returns
`download.path()` instead, and the Python runner copies that verified local file
to `--artifact-output`. Threads are stored in `~/.codex/outpost-sessions.json`
with `threadId`, a canonical `https://chatgpt.com/c/<id>` `conversationUrl`, and `targetId`.
The runner never replaces a saved `/c/` URL with the project home.

For a code artifact, use the same command:

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md --artifact .outpost/<run>/artifact.zip
```

Aside waits for the ChatGPT download event, saves the zip directly, and the
runner requires a nonempty zip with a valid CRC.

Exit `76` is `SUBMIT_UNKNOWN`: the click occurred but the user turn was not
commit-verified before the deadline. Preserve its evidence and never retry,
invoke the Aside agent, or enter the Playwright fallback.

Exit `77` is `SUBMITTED_RESPONSE_UNAVAILABLE`: the exact user turn committed,
but response tracking ended. Use the saved `conversationUrl` to recover that
conversation only. Do not send the packet again.

## Manual recovery and explicit resend

For exit `77`, the runner first recovers through ChatGPT
`backend-api/conversation` using the Aside session cookie. Do not open the
Work project chat list or acknowledge `요청이 너무 많습니다`; that modal is
conversation-history throttling and more project-page snapshots extend it.

If the automatic backend recover is not enough, use a `https://chatgpt.com/`
tab (not the project URL) and fetch the committed conversation:

```bash
aside repl "var p = await openTab('https://chatgpt.com/'); var sess = await (await fetch('https://chatgpt.com/api/auth/session')).json(); var r = await fetch('https://chatgpt.com/backend-api/conversation/<id>', { headers: { Authorization: 'Bearer ' + sess.accessToken } }); console.log(await r.json())"
```

Attach the existing tab only when it is still open and the rate-limit modal
is absent:

```bash
aside repl "var p = await attachBrowserTab('<targetId>'); await p.snapshot()"
```

This is recovery of the existing turn, not a resend.

If the operator deliberately chooses to resend, rerun the original
`run_aside_repl_outpost.py` command with the same packet and a new run directory
for every output path. That creates a new Work conversation. Never overwrite
the first run's evidence and never trigger this automatically. A follow-up
turn is not a resend: pass `--thread` or `--conversation-url` so the runner
opens the saved `/c/` conversation instead of the project home.

## Accept or reject

For `--quality pro`, require:

```text
quality: pro
surface: Chat
model: 최신
tier: Pro (N of M)
modelSlug: gpt-6-pro
submitElapsedSeconds: <120
```

For `--quality xhigh`, the same shape with `tier: 매우 높음 (N of M)` and
`modelSlug: gpt-5-6-thinking`.

The project banner toggle is `button[data-tpp-toggle-value="chatgpt"|"work"]`.
Switch to Chat before the picker. Work mode is not a outpost surface.
The Chat slider stops are `즉시` `중간` `높음` `매우 높음` `Pro`. The closed
composer pill may expose Pro as `NPro` (quota digits plus label, no space in
the accessible name). Match the requested label; do not operate the Work-mode
`최신` Chat picker; never `GPT-5.6 Sol`.

Reject an unverified model or tier, an empty assistant body, or a
submission at or above 120 seconds. A missing ID echo in the assistant
text is not a reject if the user turn committed and the reply was saved.

Reject an answer that does not address the attached packet.

On exit `75` caused by pre-send UI drift, preserve evidence and stop. Do not
hand the packet to another sender. Outpost has one continuous Aside REPL path.
Playwright is not part of Outpost, including code artifact generation and
download. A deliberate resend is a new project conversation and must never
happen automatically.


## Recover without resend

If the runner exits `77` or the first REPL dies after `OUTPOST_SUBMITTED`, do
not send again. Poll the same conversation:

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" recover .outpost/<run>/result.json
```

Backend-api polling is the primary wait after the user turn persists (`/c/` in
the conversation URL). The live ChatGPT page is only a secondary signal.


## Model is judged by the server, not the picker

The picker label (`최신`) is a moving alias, and the tier list is model
specific. Each quality expects exactly one slug, from `QUALITY_MODEL_SLUGS` in
the runner: `pro` -> `gpt-6-pro`, `xhigh` -> `gpt-5-6-thinking`. After the reply
is read, the runner takes `metadata.model_slug` from the ChatGPT backend and
stores it as `modelSlug` in `result.json`. A different slug still saves
`response.md` but exits `78`; the answer is not what the quality asked for.

## Aside role lookups: snapshot first, string name only

`getByRole` resolves against the index Aside builds inside `snapshot()`. On a
page that was never snapshotted in the current REPL session it returns zero
matches, including for elements that have an explicit `aria-label`.

Two more limits sit on top of that, and both fail silently:

- **The `name` must be a string.** Hand it a `RegExp` and it returns zero
  matches with no error. The tier pill and the model radio were both probed
  this way, so every send died at `select-tier` while `doctor` stayed green.
- **Only the `aria-label` counts as a name.** An element named by its own text
  — the Pro pill (`6 Pro`), the model radios (`최신`) — is invisible to it.

String names go through `waitRole()`. Pattern names and text-named elements go
through `waitNamedRef()`, which reads the computed name off the `snapshot()`
tree (`- button "6 Pro" [ref=e66]`) and returns the ref locator. `doctor` probes
the tier pill with `waitNamedRef()`, the same lookup `send` uses, so its green
light cannot come from a path the send does not have. When a role probe misses,
check the name's type and the element's `aria-label` before calling it a UI
change.

## Nothing is lost after the send

`result.json` is written before the send click with `status:
submitted_pending`, `id`, and `packetSha`. If the REPL dies, Aside restarts,
or the parent is killed, `outpost recover .outpost/<run>` finds the turn by id
through the backend and saves the answer. A second `send` with the same packet
in the same run directory exits `79` instead of spending another Pro turn;
`OUTPOST_FORCE=1` is the deliberate override.

## Input attachments

`--attach <path>` uploads extra files with the packet. Non-ASCII file names -
and non-ASCII names inside a zip - are rewritten to ASCII before upload because
ChatGPT mangles them, and the `safe <- original` mapping is appended to the
packet body and to `FILENAMES.txt` inside the repacked zip. `--artifact` is
the opposite direction: it saves a zip that ChatGPT generates.
