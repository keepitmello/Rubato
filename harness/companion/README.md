# Local companion profiles

The application keeps its existing companion space. Advanced local registration adds
more companions to its picker; it does not create another session engine or a public
persona catalogue. Each profile has its own native conversation, home, records, search
index, dream, scheduled wakes, followed work and optional transports.

The built-in `segno` profile keeps `~/.rubato/companion`, existing conversation metadata
and settings. Old companion sessions without an ID remain Segno. Registering another
profile never enables Telegram or calls for Segno.

## Registration

Use `$HOME/.rubato/companions.json`, or set `RUBATO_COMPANIONS_FILE` for an isolated
profile. The file is private local configuration, not a build input:

```json
{
  "companions": [{
    "id": "personal",
    "title": "Personal companion",
    "home": "/absolute/private/existing-repository",
    "memoryAgent": "personal",
    "promptFiles": {
      "preamble": "/absolute/private/preamble.md",
      "soul": "/absolute/private/SOUL.md",
      "identity": "/absolute/private/IDENTITY.md",
      "user": "/absolute/private/USER.md",
      "companion": "/absolute/private/runtime.md",
      "tools": "/absolute/private/tools.md",
      "memory": "/absolute/private/existing-repository/MEMORY.md",
      "coda": "/absolute/private/coda.md"
    },
    "layout": {
      "resident": "MEMORY.md",
      "status": "memory/current.md",
      "held": "notes/held.md",
      "mood": "state/last-mood.json",
      "searchCases": "tests/search-golden.json"
    },
    "historyPaths": ["MEMORY.md", "docs/"],
    "searchPaths": ["MEMORY.md", "memory/", "notes/", "docs/"],
    "searchExclude": ["docs/private-runtime-state/"],
    "dreamReadPaths": ["MEMORY.md", "notes/", "docs/"],
    "dreamWritePaths": ["MEMORY.md", "notes/"],
    "dreamInstructions": "/absolute/private/dream.md",
    "skillDirs": ["/absolute/private/native-skills"],
    "extensions": ["/absolute/private/native-extension.mjs"],
    "telegram": false,
    "call": { "enabled": false },
    "env": {}
  }]
}
```

IDs and memory agents are unique lowercase identifiers. Homes must be absolute,
distinct, nonoverlapping paths; symlink aliases cannot register a second identity
over the same records. No home migration or forced Git recreation occurs.

Every additional profile needs its own prompt pieces and dream instructions before
those features can run. Missing private pieces fail closed, never borrowing Segno's
identity, art or dream. `layout` maps existing record locations without rearranging
them. Daily records remain `memory/YYYY-MM-DD.md`; diary defaults to `memory/diary/`.
Permanent notes remain ordinary files; native context notes are separate session
working memory. `layout.searchCases` points the weekly search check at an existing
case file instead of the default `memory/search-golden.json`.

Optional `promptFiles` keys `wake`, `recall`, `greet-morning` and `greet-night`
map an existing home's own operational texts. A missing explicitly mapped file
fails instead of silently selecting another profile's text. Without a greeting
mapping, an additional profile gets a short path-free reminder, not the built-in
profile's record-path instructions.

`historyPaths` extends the usual `memory/`, `notes/` and `prompt/` commit allowlist.
Only explicitly named files are committed. `searchPaths` selects a corpus rooted at
the original home; without it search uses `memory/`. The index includes these paths
and uses the same selection when checking freshness. Private runtime state,
credentials and scripts should not be part of that corpus.

`dreamReadPaths` extends readable source material. `dreamWritePaths` extends the
guarded record writeback paths. A linked path out of the home is never a write
destination. The generic coding-memory dream excludes all registered companion
homes and memory agents.

`skillDirs` contains native `SKILL.md` catalogues for this companion only. Additional
profiles use native home records rather than creating a second generic coding-memory
repository. Their archive's project instructions for coding agents are not injected
as the resident companion's role; those files remain unchanged and ordinary coding
sessions still read them. Automatic per-message recall remains off.

## Optional transports

`telegram: true` registers that profile's supervised messenger and native Telegram
tools. Its connection and queue live under its own `messenger/` directory. Configure
the connection using the existing messenger settings contract; do not copy another
profile's credentials. One real bot must have one polling owner. Registration does
not stop an old owner.

Pairing, approval and control replies use the owning profile's title. `/companion`
is the profile-neutral on/off command; `/segno` remains a compatibility alias.
Settings changes require a current user input or a verified user-started completion.
Machine wakes revoke that authority without changing where an explicit reply goes.
Voice settings retain an optional `voice.temperature`; a private
`RUBATO_COMPANION_TTS_PRONUNCIATION_FILE` may point to a JSON `rules` list of
`{ "from", "to" }` substitutions applied to synthesis only, never written text.

A call listener is explicit and loopback only:

```json
{ "enabled": true, "host": "127.0.0.1", "port": 18760 }
```

Every enabled profile needs a distinct port. Optional call settings are `token`
(HTTP bearer token), `stateDir`, `transcriptDir`, `recordTranscripts`,
`turnTimeoutMs`, `briefFile`, `voiceToneFile`, `userLabel` and `companionLabel`.
State and transcript paths are relative to the companion home and cannot escape
it. Prompt/tone files are read privately at call start; they are not bundled.

The bridge does not open a microphone, start synthesis or play sound. A local voice
client owns capture, STT, synthesis and playback, using the retained protocol:

| Endpoint | Purpose |
|---|---|
| `GET /call/health` | Native session/model identity and busy state |
| `GET /call/health?watch=1&callId=…` | Hold call presence, streamed NDJSON heartbeats |
| `POST /call/turn` | Heard words: `text`, stable `turnId` |
| `POST /call/qwen-turn` | Same turn protocol for the alternate audio transport |
| `POST /call/opportunity` | Machine-opened quiet opportunity: `turnId`, optional `reason` |
| `POST /call/cancel` | Interrupt only the matching `turnId` |
| `POST /call/end` | End the matching `callId`, or current call when omitted |

Only explicit `call_say` text leaves as streamed `delta` speech, followed by `done`.
Ordinary assistant text is private monologue, never a speech fallback. During a
machine-opened opportunity, `call_wait` asks for a concrete later opportunity and
`call_pass` yields silently. Heard words enter the same native conversation as voice
user messages; opportunities and call lifecycle lines are system-only context.

Clients must keep `turnId` stable across retries. Durable receipts prevent repeated
user input or repeated audible output after reconnection/restart; an interrupted
turn is not automatically re-spoken. An open watch renews a home-local lease that
suppresses keeper ticks and night sleep. A crashed connection expires automatically.

To opt Segno in deliberately, the registry accepts top-level `default` with only
`telegram` and/or `call`. Omitting it preserves current defaults.

## Private extensions

An explicitly configured module exports:

```js
export function createExtension({ env, runtimeRoot }) {
  return async pi => {
    // Bind every resource to env and keep mutable state in this factory.
    // runtimeRoot identifies this running build, not an independently installed Pi.
  };
}
```

Only the owning companion loads it. Module imports are cached by the engine, so do
not capture `process.env` or create a singleton poller at import time. `env` is the
worker's own environment; its configured private keys are removed from siblings
and ordinary leads. Profile extensions are trusted private code, not sandboxed
plugins. They are outside the generic build and build receipt.

## Isolated build and checks

Build a separate candidate with `harness/pi-runtime/scripts/install-candidate.mjs
--output /absolute/disposable/build`; use `--update` only for that owned output.
Do not use the active-engine restart path for an isolated rehearsal.

The companion tests are `node --test harness/companion/test/*.test.mjs`. The
actual hosted baseline is `harness/pi-server/test/session-link-candidate.test.mjs`
with `RUBATO_TEST_CANDIDATE` set to the disposable build. Set a temporary `HOME`,
short `TMPDIR` and isolated registry; never use production credentials or real
channel endpoints. Generate `harness/prompts/.build/` with `bash
harness/prompts/build.sh` before hosted tests from an archive: these generated files
are ignored by Git. The complete socket path must fit the host's Unix-socket limit.
A fake-endpoint pass is not a live cutover check.
