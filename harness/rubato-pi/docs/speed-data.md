# Opt-in Speed data collection

This is a source-checkout tool, separate from the installed engine and live Speed
score. It sends no model requests and does not change or prune local sample files.
Standalone use defaults to dry-run. The maintainer rollout also starts collection
after successful updates/builds, gated by existing write access to the private
`keepitmello/rubato-speed-data` repository.

## Automatic collection on other machines

After pulling this revision with `rubato update`, the updater starts the collector
in a detached background process. A normal no-op update also triggers it.
Read-only `rubato update --check` does not trigger it. The new updater starts it
only after its required update steps succeed.
The freshly pulled builder covers the first update from an older updater; new
updaters own the final trigger to avoid launching twice in the same update.
On that first older-updater run, collection starts after successful engine
installation, before the old updater's remaining steps. A later GUI/skill failure
can therefore coexist with a successful collection attempt; collection is not an
update-completion signal. Failed engine installations do not launch collection.

This rollout was authorized for the maintainer's family/friend/maintainer group.
Installing the public Rubato repository does **not** grant access to its private
data repository. Each machine still needs `gh` installed, a logged-in account,
and write permission to that exact private repository. No shared token is shipped
and the client cannot grant itself access. An inaccessible/public/read-only target
receives no sample data. Authentication or network failure leaves the update
successful and is reported locally in `speed-index/github-sync.log`; startup is
not reported as successful delivery.

No extra OS scheduler is installed on other machines. They send when updating;
the original maintainer Mac additionally has the daily job described below.

To stop **all** upload invocations for a profile, including that daily job, create
`github-sync.disabled` next to its state:

```sh
touch ~/.rubato-pi/agent/speed-index/github-sync.disabled
```

Keep the state file. Remove only the disable marker to resume. With a custom agent
directory, place the marker in that directory's `speed-index/` folder.
`RUBATO_SPEED_DATA_UPLOAD=0 rubato update` disables collection for one update; the
same environment setting also disables explicit standalone `--upload`.

## Connect one consenting machine

Prerequisites: Node 24+, GitHub CLI (`gh`), an existing PRIVATE repository, and a
logged-in GitHub account with write access to it. Run from the Rubato source root:

```sh
gh auth status
node harness/rubato-pi/scripts/sync-speed-data.mjs --repo OWNER/PRIVATE-REPO
# Inspect the local dry-run counts first, then explicitly enable transmission:
node harness/rubato-pi/scripts/sync-speed-data.mjs --repo OWNER/PRIVATE-REPO --upload
```

The standalone command defaults to local dry-run: no network requests or state writes. Optional
`--samples DIR`, `--state FILE`, and `--gh PATH` select explicit paths. The default
source and state are in the selected agent directory's `speed-index/` directory.
The default state filename is `github-sync.json`.

Authentication stays with `gh`; no token is embedded in Rubato or the state file.
Every upload checks the exact repository, its current private visibility, and
authenticated write permission. A public/read-only destination fails closed.
Repository write access is not restricted to the uploader's own data. Use this
only with trusted collaborators, not as a public multi-tenant service.

Each participating machine uses its own login and local state. The automatic
maintainer rollout does not authorize inviting unrelated users or copying one
owner's broad token/state to other machines.

## What leaves the machine

Only capture-v1, main-stream rows from the last 30 days are eligible. Older logs
without delivery timestamps are not backfilled. The exporter reconstructs an
allowlist; it never serializes the original row.

- Provider/model/applied effort and bounded enum classifications.
- Numeric usage, durations, channel counts/lengths, observed checkpoints, network
  classification, stream-observation flags, and terminal status.
- A random persistent device ID, keyed pseudonymous process/record IDs, and UTC
  wall time rounded down to the hour. Within-call millisecond times are unchanged.
- `exportVersion: 1`; capture/scoring versions remain distinct.

No prompts, answers, reasoning text, tool names/arguments, source filenames, file
paths, session/account identifiers, or credentials are included in the payload.
Unknown free-text classification values are not transmitted. This is pseudonymous,
not anonymous: GitHub still knows the authenticated uploader, and commit metadata
can identify the GitHub account. Other collaborators can see the stored data.

The format remains consumable by `scripts/analyze-speed-index.mjs` after download.
Do not concatenate devices into a causal model ranking: device/network, time,
request composition, and task selection remain confounded. The current analyzer's
group averages are descriptive, not a fitted multi-device baseline.

## Batches, limits, and retries

```text
local append-only JSONL
  → complete new lines → allowlist + pseudonyms → gzip
  → samples/YYYY-MM-DD/DEVICE_ID/SHA256.jsonl.gz
```

Each UTC day/device can have several immutable batches. Subsequent runs send only
new rows, not a new snapshot of all previous rows. A batch contains at most 500
rows and at most 750,000 compressed bytes. Each invocation scans at most 64 MiB
and selects at most 2,000 new rows. If `rowLimitReached` is true, run again to drain
the backlog; increase invocation frequency if daily volume consistently exceeds it.

The private, mode-0600 local state contains the random identity/secret, source
cursors, and exact pending compressed bytes. It is flushed and atomically replaced
before remote mutation. File and directory syncing are used on macOS/Linux; Windows
does not have the directory-sync step here. Hard power-loss durability has not been
tested.

On a lost acknowledgement, the next run checks the same content-addressed path
and Git blob hash. A matching blob is acknowledged without uploading it again;
different bytes at the same path are never overwritten. The entire pending batch
set is completed before cursors advance. New source rows are picked up on the next
invocation. There is no retry loop in the chat or model path.

An incomplete final line waits for a newline. Malformed complete JSON lines are
counted and skipped. Future-dated rows defer that source file, without blocking
other files. Truncation of a previously consumed file is an error, not a silent
cursor reset.

**Keep the state file.** Deleting it loses cursor/identity continuity and can upload
previous observations under a new device ID. Back it up privately, never in the
data repository. Do not operate two state files for one device/source.

The uploader takes a local state lock. Normal failures release it and leave pending
data for the next run. After a killed process, a stale `.lock` file may remain:
inspect its PID, confirm that no sync process is running, then remove only that lock
and rerun. Do not remove the state itself.

## Daily execution and stopping

The uploader is a one-shot process. Schedule that exact `--upload` command once a
day using the machine's existing scheduler, outside the engine. Use absolute Node,
script, `gh`, source, and state paths. Do not schedule the no-flag dry-run by mistake.
For a logged-in macOS machine, a per-user LaunchAgent is suitable; Windows can use
Task Scheduler under the user's account. Windows scheduling is not implemented or
verified by this change.

The initial maintainer Mac uses LaunchAgent
`com.keepitmello.rubato.speed-data`, with a daily calendar trigger and RunAtLoad.
The plist points at this source checkout, not `~/.rubato-pi/stock-engine`.
Moving/deleting the checkout requires updating the job. It does not require
rebuilding or restarting the running engine.

Inspect or stop that Mac job:

```sh
launchctl print "gui/$(id -u)/com.keepitmello.rubato.speed-data"
launchctl bootout "gui/$(id -u)/com.keepitmello.rubato.speed-data"
# Remove this plist to prevent it loading again on the next login:
rm ~/Library/LaunchAgents/com.keepitmello.rubato.speed-data.plist
```

Stopping transmission does not delete already-uploaded data. No automatic remote
expiration is enabled. Deleting a file from GitHub leaves it in git history; true
erasure requires repository/history cleanup. Agree on that separately before
promising deletion to additional participants.

## GitHub contracts

- [Contents API](https://docs.github.com/en/rest/repos/contents)
- [Repository size guidance](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- [Personal token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

Fine-grained PAT support for a collaborator on another person's private repository
is not equivalent to `gh` OAuth support. Verify the chosen account's actual access;
do not prescribe an unsupported token flow.
