# Aside Outpost Runbook

Operator and engine contract. The main session reads `SKILL.md` and calls
`outpost` on PATH. This file is the configured project path, the same project page
lifecycle, and recovery. There is no automatic alternate sender.

## Preconditions

- `aside --version` succeeds.
- `~/.aside/u/0/skills/user/chatgpt-work-outpost/SKILL.md` exists and validates.
- `OUTPOST_CHATGPT_URL` and `OUTPOST_PROJECT_NAME` in `~/.codex/outpost.env`
  select the ChatGPT project. `~/.codex/consult.env` and `CONSULT_*` still
  load when the new names are absent. The name is the visible project title, used as
  `{name}에서 새 채팅`. Default name is `Work` when unset.
- The invocation contains exactly one `--quality xhigh` or `--quality pro`.
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

## Launch the fast path

Launch `outpost` on PATH as a background process. It drives the Aside REPL
engine and fills the output paths from the packet directory:

```bash
outpost send --quality <xhigh-or-pro> .outpost/<run>/packet.md
```

List stored threads, including which are running and which have finished:

```bash
outpost list
outpost show <thread-id>
```

Continue a saved thread. This opens that conversation, not the project home:

```bash
outpost send --quality <xhigh-or-pro> .outpost/<run>/packet.md --to <thread-id>
outpost send --quality <xhigh-or-pro> .outpost/<run>/packet.md --to last
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
outpost send --quality pro .outpost/<run>/packet.md --artifact .outpost/<run>/artifact.zip
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

For `--quality xhigh` and `--quality pro`, require:

```text
quality: xhigh | pro
surface: Chat
model: GPT-5.6 Sol
tier: 매우 높음 (N of M)   # xhigh
tier: Pro (N of M)         # pro
submitElapsedSeconds: <120
```

The project banner toggle is `button[data-tpp-toggle-value="chatgpt"|"work"]`.
Switch to Chat before the picker. Work mode is not a outpost surface.
The Chat slider stops are `즉시` `중간` `높음` `매우 높음` `Pro`. Match the
requested label; do not operate the Work-mode `5.6 Sol` / Fast picker.

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
outpost recover .outpost/<run>/result.json
```

Backend-api polling is the primary wait after the user turn persists (`/c/` in
the conversation URL). The live ChatGPT page is only a secondary signal.
