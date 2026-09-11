# stock-pi switch proof — 2026-09-11

Focused helper `/root/a5_profile_proof`. Copies only. Live `~/.rubato-pi` was not written (no `engine.json`, no `stock-engine`; no live session jsonl mtime in the last 3h). No git writes. No code edits. Temp HOME deleted after the run.

Worktree: `/Users/wy/Github-repos/rubato-lab/worktrees/pi-adapter-0851` (branch `codex/pi-adapter-0851`).

## Constraints / method

- Disk at start: 7.4Gi free (99%). Real agent 5.0G of which `worktrees/` = 4.2G / 162168 entries.
- Full `cp -R` of agent would not leave room for the 300–600MB install. Copy **excluded `agent/worktrees`**. Everything else under `agent/` plus `node-path` was copied. This is a disk-safety deviation from literal `cp -R`.
- Secrets: never printed. `auth.json`, `models-store.json`, `cursor-*`, tokens not dumped. Report is counts/sizes/ids/error classes only.
- Cleanup: leftover RPC processes killed; `$TMPHOME` removed with `shutil.rmtree`. Disk after: 7.3Gi free.

## Node

- Launcher `select-node.mjs` does **not** read `~/.rubato-pi/node-path`. Copied anyway (47 bytes, path only).
- Candidate engines: `^24.15.0 || >=26.0.0`.
- Used: `/Users/wy/.nvm/versions/node/v24.18.0/bin/node` (`v24.18.0`) — satisfies engines.
- All commands: `env -u NODE_OPTIONS -u NODE_COMPILE_CACHE`.
- macOS `/tmp` → `/private/tmp`: spawning `candidate-main.mjs` via the `/tmp/...` path **exits 0 with empty stdout/stderr** because `resolve(process.argv[1]) !== fileURLToPath(import.meta.url)`. Using `Path.resolve()` / `/private/tmp/...` runs the CLI. Product launcher `import()` path does not hit this guard.

## 1. Temp HOME copy

- TMPHOME: `/tmp/rubato-switch-proof-8bzhadpt` (realpath `/private/tmp/rubato-switch-proof-8bzhadpt`)
- Real agent top-level: 25 entries. Copied 12 dirs + 12 files. Skipped `worktrees`.
- Dest: 2706 entries, 855868017 bytes (~816MiB). Disk after copy: 6.6Gi free.

## 2. install / switch / status

cwd: `harness/pi-runtime`. HOME=TMPHOME. Node v24.18.0.

### install

- Exit 0 in ~10.8s. Install root 530M. Disk after: 5.9Gi free.
- Receipt: `$TMPHOME/.rubato-pi/stock-engine/rubato-install.json` (5951 bytes)
- Receipt sha256: `368c09e7629ace4ea25f57e9eb6b38ec040f11a525156af09184df9b416420a3`
- version=1 state=ready mode=isolated-candidate fullRubatoParity=false stockVersion=0.85.1 featureCount=**33** installedAt=2026-09-11T13:01:24.856Z
- candidateEntry: `rubato-features/rubato-components/candidate-main.mjs`
- hashes: package=`885490e3615ef15ce53c8405735efea839e4859283efc51bc9c414300fa05181` lock=`5201145de576da141b9ea8d3a388aa91c7b8e3de801fddf4d35780e38e8ae7d3` stageReceipt=`25164de86c074bdec44a9e6bdeae81893eafa7389bfd0a3edd9c035a337db694` npmLock=same as lock
- Live `engine.json` / `stock-engine` still absent after install.

### switch marker JSON

```json
{
  "engine": "stock-pi",
  "installedAt": "2026-09-11T13:01:37.965Z",
  "switchedAt": "2026-09-11T13:01:37.966Z",
  "previous": "senpi",
  "installRoot": "/tmp/rubato-switch-proof-8bzhadpt/.rubato-pi/stock-engine"
}
```

### status

home=TMPHOME, installed=true, engine=stock-pi, receipt.stockVersion=0.85.1, featureCount=33. Marker matches switch output.

## 3. Session compatibility (candidate RPC)

Copied session jsonl: 456. Largest on disk **not opened**: 112737223 bytes `2026-08-29T12-57-49-379Z_01a04d99-0643-7d19-90e1-56d6e50c11c9.jsonl` (disk/time). Open set spans oldest / newest / ~22MB large / median.

RPC: realpath `candidate-main.mjs --mode rpc --no-skills --no-prompt-templates --no-themes` with `RUBATO_CANDIDATE_AGENT_DIR=$TMPHOME/.rubato-pi/agent`. Then `switch_session` + `get_messages` (and `get_state.messageCount`). No content dumped.

| # | why | name | size | mtime local | opened | messages | ms |
| --- | --- | --- | ---: | --- | --- | ---: | ---: |
| 1 | oldest | 2026-08-22T08-54-02-228Z_01a028ad-50f4-71d8-97d3-8749e18e2ff9.jsonl | 32493 | 2026-08-22T17:54:43 | ok | 9 | 191 |
| 2 | oldest+1 | 2026-08-22T08-54-53-720Z_01a028ae-1a18-779d-a36e-e27165cf6228.jsonl | 34755 | 2026-08-22T17:55:23 | ok | 16 | 152 |
| 3 | oldest+2 | 2026-08-22T08-56-07-754Z_01a028af-3b4a-7d88-985a-a07b6b699d5d.jsonl | 26111 | 2026-08-22T17:56:39 | ok | 14 | 150 |
| 4 | newest | 2026-09-08T11-52-24-669Z_01a080dc-bb5c-7597-90e2-c742d5574b6f.jsonl | 1198287 | 2026-09-08T22:39:08 | ok | 516 | 175 |
| 5 | newest-1 | 2026-09-08T09-25-49-848Z_01a08056-8898-7d56-a993-6ba31e839204.jsonl | 10837 | 2026-09-08T18:26:59 | ok | 7 | 157 |
| 6 | newest-2 | 2026-09-05T11-40-51-822Z_01a0715f-14ed-71d6-8054-4cfcc8f80bfc.jsonl | 2004156 | 2026-09-08T18:25:15 | ok | 517 | 190 |
| 7 | large | 2026-08-26T04-09-56-444Z_01a03c42-a7dc-7fa7-bc9c-31e40d7b38d6.jsonl | 22211164 | 2026-08-26T21:27:54 | ok | 810 | 329 |
| 8 | large-next | 2026-09-01T05-48-02-170Z_01a05b82-9ef9-77c1-ba67-8a435de44a13.jsonl | 21252211 | 2026-09-01T23:46:16 | ok | 190 | 228 |
| 9 | median | 2026-09-03T08-25-38-469Z_01a0665f-a1a4-7ba7-b993-1a0a45f1d588.jsonl | 462220 | 2026-09-03T20:21:08 | ok | 199 | 149 |
| 10 | mid-recent | 2026-09-05T16-35-00-125Z_01a0726c-5f9d-7907-a114-d77573f0b1be.jsonl | 395627 | 2026-09-08T18:25:07 | ok | 42 | 149 |

All 10: `switchSuccess=true`, `getMessagesSuccess=true`, no error text. No Senpi-specific parse failures observed on this set.

### Launcher route (2 files)

Stock CLI file resume is `--session <path>`, not `--resume <file>`. `--resume` is a boolean TUI picker. `--resume <file> --mode rpc` with empty temp HOME died immediately (`role prompt missing`) same as other launcher starts before prompts were copied.

Current `launch.mjs` `buildStockPiArgs` **does** pass `--system-prompt` via `replaceSystemPrompt` / `loadRolePrompt`. With `HOME=$TMPHOME`, Node `os.homedir()` follows HOME, so it looks for `$TMPHOME/.agents/rubato/.build/lead.pi.md` and exits 1. After copying the three `.pi.md` files from live `~/.agents/rubato/.build/` into the temp HOME (prompt templates only):

- newest-1: launcher `RUBATO_ENGINE=stock-pi --session … --mode rpc` get_state+get_messages **ok**, messageCount=7 (matches candidate RPC).
- oldest: same **ok**, messageCount=9.

Launcher stock-pi RPC **does** work end to end on a copy if the role prompt files exist under that HOME. README claim that stock-pi does not pass `--system-prompt` is **stale vs this uncommitted launch.mjs**.

## 4. One real model call

Inspected via RPC `get_available_models` / `get_state` (not auth.json). 204 models. Providers present: cursor(122), opencode(68), openai-codex(10), xai(3), google-antigravity(1). **No native `openai` provider** in the available snapshot.

Preferred xAI then openai-codex (two providers max). Prompt: `답변은 한 단어로: 준비됐나?`. `--no-tools`. Waited for `agent_end`.

### Attempt 1 — xai / grok-4.3

- set_model ok. prompt accepted. elapsed **15044 ms**. agent_end=true.
- Assistant stopReason=`error`. errorMessage class: **`OAuth refresh failed for xai: Login cancelled`**.
- usage all zeros (input=0 output=0). auth-like RPC event names: none (failure recorded on the assistant message, not a separate event type).
- Session written by candidate (copied then): custom types include `senpi-memory.session-binding`, `senpi-task.usage`, `rubato-memory:accepted-turns`.

### Attempt 2 — openai-codex / gpt-5.4-mini

- set_model ok. prompt accepted. elapsed **327 ms**. agent_end=true.
- Assistant stopReason=`error`. errorMessage class: **`OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed (401) refresh_token_reused`** (token body not copied here).
- usage all zeros.

Stopped (two providers, no further retry). **Copied-profile OAuth refresh can consume a live refresh token.** Live profile files were not written by us; whether the live Codex refresh token was invalidated is **unverified** and should be treated as a risk.

No successful prompt/completion token counts. No native OpenAI route was available to try.

## 5. Double-writer (Senpi opens a candidate-written session)

Candidate-written session from attempt 2 (4 jsonl message/custom entries; assistant is the oauth error turn).

- Product launcher `RUBATO_ENGINE=senpi` from this worktree: **not runnable**. Missing `$WORKTREE/node_modules/@code-yeongyu/senpi/package.json`. Did not install anything into the worktree.
- Senpi RPC equivalent from the **copied** engine plugin (`$TMPHOME/.rubato-pi/engine/plugin/node_modules/@code-yeongyu/senpi/dist/cli-main.js --session <copy> --mode rpc`): **compatible**. get_state+get_messages success, messageCount=4, no error. Exit 143 = our SIGTERM.

So the candidate-written jsonl opened in Senpi RPC. Product `RUBATO_ENGINE=senpi` launcher in this worktree was not proven.

## 6. Cleanup

Killed proof processes. `shutil.rmtree($TMPHOME)`. Removed `/tmp/rubato-switch-proof-rpc`. Live `~/.rubato-pi/engine.json` absent, `stock-engine` absent, no live session jsonl mtime in last 3h.

## Verdict (evidence-limited)

- switch-engine install/switch/status on a temp HOME **works** (33 features, receipt hash above).
- Copied real sessions open in the candidate RPC **10/10** on the selected set (largest 112MB file not opened).
- Product launcher stock-pi RPC **works** with `--session` after role prompts exist in that HOME; `--resume <file>` is the wrong flag; `--system-prompt` injection is a real launcher dependency.
- Real model call **did not complete a paid turn**: xAI oauth refresh cancelled, openai-codex refresh_token_reused. Do not treat this as a successful live completion.
- Candidate→Senpi double-writer: **compatible** via Senpi CLI RPC equivalent. Worktree product senpi launcher: blocked on missing package.
