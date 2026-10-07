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
  `{name}의 새 채팅` (older UI: `{name}에서 새 채팅`). Default name is `Work` when unset.
- `--quality` is one of `pro` (ChatGPT's `Pro` tier with `GPT-6`, answers as
  `gpt-6-pro`) or `xhigh` (ChatGPT's `Extra High`, answers as
  `gpt-6-thinking`).
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

```bash
outpost doctor            # check, and heal the screen map if a step broke
outpost doctor --no-heal  # check and report only
outpost doctor --json
```

Doctor checks the send path twice:

1. **Pro rehearsal.** The send's own `build_repl_script(dry_run=True)` with a
   throwaway packet: open the project, select the `Pro` stop and `GPT-6`, fill
   the composer, attach, wait for an enabled send button, then clear the draft
   and stop. No Pro turn is spent.
2. **xhigh send.** A real throwaway packet on `xhigh` (not quota-limited): click,
   commit, and read the answer back through the backend. It passes when the
   answer echoes the ID and the backend reports `gpt-6-thinking`. The
   conversation is hidden afterwards.

It reports the daemon first (`daemon up=… pid=…`). Aside's app restarts every
day or two, and a send that lands in that window dies with `other side closed`,
so a daemon that is not `ready` blocks. `ensure_aside_daemon()` also waits for a
just-restarted daemon to settle before a send starts. Exit `0` when both checks
pass; exit `75` otherwise.

### Screen map and heal

Every selector and accessible name the send path looks up lives in one screen
map: built-in defaults in `scripts/outpost_ui.py` plus what doctor learned in
`~/.codex/outpost-ui.json` (`OUTPOST_UI_MAP_PATH`). Saved names are tried
first and the defaults still work after them. A saved map that does not parse
is ignored.

A pre-submit step that fails prints `OUTPOST_DIAG` with the page at that moment
(interactive snapshot tree and an outline of the composer form, menus and
toggles). Aside drops the whole output of a script that ends in an error once it
passes roughly 16–20 KB, so the report is capped well under that. Doctor hands that page to a heal model — `rubato -p` with
`b-ai/deepseek-v4.1-flash` by default (`OUTPOST_HEAL_MODEL`, `OUTPOST_HEAL_BIN`) —
which may rewrite only the saved map. Each rewrite is rehearsed again and kept
only when the path gets further; otherwise it is undone and the next try is told
what failed. A screen change that breaks several steps is healed one step at a
time. A step is given up after three tries without progress, twelve tries in
all. The map validator refuses a `Pro` stop under `xhigh` and a `Sol` model.

Rate limits, a lost daemon, and anything after the click are not screen
changes and are never healed. A check that failed before any step ran means
Aside was not answering; doctor waits for the daemon and runs it once more.
If the process dies mid-heal, the next read of the map restores the last map
it had verified. A change in the flow itself — a new dialog, a new
step — is beyond the map; doctor then stays red and names the stage, and the
code needs a patch.

## Launch the fast path

Launch `outpost` as a background process. It drives the Aside REPL
engine and fills the output paths from the packet directory. `outpost list`
shows `working` while that process is alive. When the process exits, an idle
parent session is woken:

```bash
outpost send --quality pro .outpost/<run>/packet.md
```

List stored threads, including which are running and which have finished:

```bash
outpost list
outpost show <thread-id>
```

Continue a saved thread. This opens that conversation, not the project home:

```bash
outpost send --quality pro .outpost/<run>/packet.md --to <thread-id>
outpost send --quality pro .outpost/<run>/packet.md --to last
```

The runner's in-browser guard must commit the user turn under 120 seconds and
record `submitElapsedSeconds`; a run that misses it before the click exits `75`.
Never increase or blindly retry the budget. One REPL process keeps the Work page alive through
submission, response completion, and optional download. Never split those
stages across REPL processes: closing the first process can terminate the
generation before the conversation is persisted. Aside may buffer both markers
until the process exits; parse the final transcript to distinguish pre-submit,
committed-without-response, and complete outcomes. Aside REPL does not create a
normal Aside GUI conversation entry.
Aside 1.0.928 (2026-09-29) cuts the `aside repl` connection at 120 seconds with
`fetch failed: other side closed` and drops everything the script printed,
while the script keeps running in the daemon. A send whose answer takes longer
— every Pro turn — ends without markers, and the backend lookup in "Sent or
not is judged by the backend" finds the turn and recovers the answer.

Parallel runners open unique ID-derived `data:` marker tabs and resolve
their `targetId` by exact title and URL before navigating to Work. A
before/after "new tab" set difference is unsafe because simultaneous runners
can both claim the same target. Different `threadId`s may run at the same
time. A second send to the same thread fails closed while that thread is
busy; wait for it to finish or recover, then `--thread` again.

Python reads `--packet` and every `--attach` itself and stages the bytes under
the Aside account directory (`~/.aside/u/<n>/tmp/outpost-staging/<id>/`); the
REPL script carries only those paths. `aside repl` takes the script as one
command-line argument, which macOS caps at 1 MB, so bytes inlined there fail
before the REPL starts. The REPL's `fs` reads only the account and session
directories, so the staging root is asked of the REPL (`fs.resolvePath`), and
the script reads the files first (`load-staged-files`, before anything is
typed). The browser receives an in-memory file payload, never a local path.
The staging directory is removed when the run ends; one left by a killed run
is swept after a day. The composer
starts with the packet H1 topic, then `ID: <hex>`, followed by a short
ID-bound instruction. Packet location, blank lines,
and trailing newlines therefore do not participate in browser input validation.
The runner fills the composer first, then uses the unrestricted `#upload-files`
input with a unique `outpost-<id>.md` name. Work already contains many
`packet.md` uploads, so ChatGPT renames a colliding chip to
`packet(<timestamp>).md` and an exact `packet.md` locator dies after the
upload finishes. The runner waits for the file-tile `group` whose name
contains the outpost ID, or for `outpost-<id>` in the page text, including
after send becomes enabled. A second upload with the same ID (a heal retry) of
`outpost-<id>.md` shows as `outpost-<id>(1).md`, and matching the
full name would upload the packet again and leave send disabled at the click.
A chip can still show an active upload, so submission also waits until the send
button has neither native `disabled`, `aria-disabled="true"`, nor
`data-visually-disabled`; image/video-only inputs and fixed sleeps are not
valid packet transports. The runner opens Aside, pings REPL until it answers,
and if the daemon drops before the submit marker it relaunches Aside and
retries the same send once — only after the backend shows no turn with this ID
(see "Sent or not is judged by the backend"). After a user turn commits, do not retry.
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

Exit `76` is `SUBMIT_UNKNOWN`: the runner could not prove whether the turn
went out — the click occurred but the user turn was not commit-verified before
the deadline, or the run ended without the submit marker and the backend could
not be searched completely. `result.json` says `status: submit_unknown`, and a
second send from that run directory exits `79`. Preserve its evidence and never
retry, invoke the Aside agent, or enter the Playwright fallback;
`outpost recover` settles it.

Exit `77` is `SUBMITTED_RESPONSE_UNAVAILABLE`: the exact user turn committed,
but response tracking ended. Use the saved `conversationUrl` to recover that
conversation only. Do not send the packet again.

## Sent or not is judged by the backend

Aside's `locator.click()` resolves the element once and never waits. A send
button that is disabled for a moment is "not found", and a click can also end
in an error after the turn already went out. On 2026-09-29 two `커리어` sends
exited `75` "nothing was sent" with `Selector "…보내기…" not found at Cn.click`,
and both turns were in the project with finished answers. An error from the
send step is therefore never read as "not sent" by itself:

| What ended the run | Decision |
| --- | --- |
| A step before `fill-composer` failed (the prompt was never typed) | not sent → `75` |
| The page showed the user turn with the ID | sent → answer as usual |
| Anything else without the submit marker (click error, daemon drop, timeout at or after `fill-composer`) | ask the backend for the ID |
| Backend: a user turn with the ID exists | sent → wait for the answer, `0`/`77`/`78` |
| Backend: the project list and every recent conversation were read, and no turn has the ID | not sent → `75` (heal and resend allowed) |
| Backend could not be read completely | unknown → `76` |

Before the click the runner waits for the enabled send button. After a click
error it gives the page 20 seconds to show the turn, then the runner asks the
backend (`locate_outpost_turn`). The lookup reads the project's own list,
`backend-api/gizmos/<g-p-id>/conversations`, because project conversations are
missing from the account-wide `backend-api/conversations` list. It reads only
conversations touched since two minutes before the send, polls for 20 seconds
so a turn that was still committing is found, and calls the search complete
only when the list reaches past that start or has no further page. A heal and
resend runs only after that proof.

## Manual recovery and explicit resend

For exit `77`, the runner first recovers through ChatGPT
`backend-api/conversation` using the Aside session cookie. For exit `76`, or a
`result.json` without a `conversationUrl`, `outpost recover` first finds the
conversation by the run's ID in its project (`projectUrl` in `result.json`, else
`--url`, else the configured project): found → the answer is saved; proven
absent → `status: not_sent`, exit `75`; still unknown → exit `76`. Do not open the
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
model: GPT-6
tier: Pro (N of M)
modelSlug: gpt-6-pro
submitElapsedSeconds: <120
```

For `--quality xhigh`, the same shape with `tier: Extra High (N of M)` and
`modelSlug: gpt-6-thinking`.

Switch to Chat before the picker. Work mode is not a outpost surface. The
current names of the banner toggle, the tier pill, the slider and its stops
live in the screen map. Match the requested stop; do not operate the Work-mode
picker; never select a legacy model.

Reject an unverified model or tier, an empty assistant body, or a
submission at or above 120 seconds. A missing ID echo in the assistant
text is not a reject if the user turn committed and the reply was saved.

Reject an answer that does not address the attached packet.

A send that fails before the click at a screen step heals the screen map the
same way doctor does, then sends once more. It does so only when the run is
proven unsent (see "Sent or not is judged by the backend"), so this cannot
double-send. `OUTPOST_AUTO_HEAL=0` turns it off. If the heal does not get
through, the send exits `75` and `result.json` says `status: not_sent`, so the
same packet may be sent again once the path is fixed. Do not hand the packet to
another sender. Outpost has one continuous Aside REPL path.
Playwright is not part of Outpost, including code artifact generation and
download. A deliberate resend after the click is a new project conversation and never
happens automatically.


## Recover without resend

If the runner exits `77` or the first REPL dies after `OUTPOST_SUBMITTED`, do
not send again. Poll the same conversation:

```bash
outpost recover .outpost/<run>/result.json
```

Backend-api polling is the primary wait after the user turn persists (`/c/` in
the conversation URL). The live ChatGPT page is only a secondary signal.


## Model is judged by the server, not the picker

The picker family is pinned to `GPT-6`, and the tier list is model
specific. Each quality expects exactly one slug, from `QUALITY_MODEL_SLUGS` in
the runner: `pro` -> `gpt-6-pro`, `xhigh` -> `gpt-6-thinking`. After the reply
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
  — the Pro pill (`6 Pro`), the model radios (`GPT-6`) — is invisible to it.

String names go through `waitRole()`. Pattern names and text-named elements go
through `waitNamedRef()`, which reads the computed name off the `snapshot()`
tree (`- button "6 Pro" [ref=e66]`) and returns the ref locator. `doctor` probes
the tier pill with `waitNamedRef()`, the same lookup `send` uses, so its green
light cannot come from a path the send does not have. When a role probe misses,
check the name's type and the element's `aria-label` before calling it a UI
change.

## Nothing is lost after the send

`result.json` is written before the send click with `status:
submitted_pending`, `id`, `packetSha`, `projectUrl`, and `startedAt`. If the
REPL dies, Aside restarts, or the parent is killed, `outpost recover
.outpost/<run>` finds the turn by id in that project through the backend and
saves the answer. A second `send` with the same packet
in the same run directory exits `79` instead of spending another Pro turn;
`OUTPOST_FORCE=1` is the deliberate override. `status: submit_unknown` is
guarded the same way. Only a send proven unsent rewrites the file to `status:
not_sent`, which the guard lets through.

## Input attachments

`--attach <path>` uploads extra files with the packet. Non-ASCII file names -
and non-ASCII names inside a zip - are rewritten to ASCII before upload because
ChatGPT mangles them, and the `safe <- original` mapping is appended to the
packet body and to `FILENAMES.txt` inside the repacked zip. `--artifact` is
the opposite direction: it saves a zip that ChatGPT generates.
