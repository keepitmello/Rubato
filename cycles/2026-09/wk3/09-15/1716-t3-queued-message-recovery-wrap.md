# T3 queued-message recovery

## Outcome

Rubato desktop now adopts T3's client-side queued-message behavior from upstream commit
`cc839c42b1adfddd059142bb6d7151719080c4ea` (pingdotgg/t3code#11673). Messages entered
while a turn is running stay in the desktop client, leave one at a tool boundary, and return
to the composer on Stop instead of becoming an opaque provider queue.

Rubato's Pi bridge also detects the legacy stranded state:

```text
isStreaming = false
isCompacting = false
pendingMessageCount > 0
```

It leaves the provider queue intact until the user chooses **Resume in order** or **Discard**.
Resume clears the stale queue once, reconstructs the original cross-queue order from the
request timeline, and submits the full recovered text. A failed replay keeps the unsent
messages and recovery question available for retry.

## Journey and evidence

### Initial failure

- Existing desktop sessions could accept a message but remain indefinitely busy.
- The failing Maplog session had `isStreaming=false` with three queued provider messages.
- Closing cmux did not change the state, so terminal ownership was not the remaining cause.
- Manually reading `clear_queue` proved that the queued text still existed and could be
  recovered before deletion.

### Direction change

An unconditional queue deletion would make the session usable but could silently discard
intent. Automatically running old input on attach could execute stale commands without a
fresh user choice. The bridge therefore exposes an explicit recovery decision and does not
clear anything during detection.

Separately, the upstream client queue prevents recurrence without adding a Rubato overlay to
T3's queue UI. Advancing the pin keeps that behavior owned by upstream.

### Verification

- `node --test harness/t3-integration/test/bridge.test.mjs`: 27 passed.
- `node --test harness/t3-integration/test/*.test.mjs`: 33 passed, 5 T3-source-dependent
  tests skipped when no exact source tree was supplied.
- Exact pinned source overlay apply succeeded at `cc839c42...`.
- Exact-source overlay idempotence, dirty-file refusal, and removal test passed.
- `git diff --check` passed.
- Live Maplog recovery cleared the stranded queue from three messages to zero and restarted
  the intended turn. A separate disk-full failure was then diagnosed; only regenerable caches
  were removed before restarting that work.

## Constraints and residual risk

- Legacy Pi `clear_queue` returns complete text but not queued image payloads. The new T3
  client queue retains attachments before they reach Pi, so this limitation applies only to
  a stale queue created by an older client or another direct controller.
- Installing and relaunching the newly pinned desktop app must wait for the active Maplog
  task to settle so its live process is not interrupted.
