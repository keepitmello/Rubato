# Local companion profiles

The application keeps its existing companion space. Advanced local registration adds
more companions to its picker; it does not create another session engine or a public
persona catalogue. Each profile has its own native conversation, home, records, search
index, dream, scheduled wakes, followed work and optional transports.

The built-in `segno` profile keeps `~/.rubato/companion`, existing conversation metadata
and settings. Old companion sessions without an ID remain Segno. Registering another
profile never enables Telegram or calls for Segno.

## Made in the app

Settings › Companion and the phone's companion list make a companion without any file editing
(`manage.mjs`, route actions in `harness/t3-integration/src/companion/service.mjs`). The app makes a
home beside the registry (`companions/<id>`), registers it with `madeInApp: true`, and the engine
starts its control tower and dream within seconds, without a restart. It wakes nameless with Segno's
temperament from the new-companion pieces (`harness/prompts/companion/new`) and never Segno's name,
art, memory or records. Its first conversation is the first meeting (`new/onboarding.pi.md`): it
settles a name, how it calls the user, what the user does and what they are to each other; look,
speech and closeness may wait and are left in its resident memory. Those facts fill the pieces'
`{{slots}}` when the prompt is composed, so they are never written into the person's text.

A companion made in the app reads Rubato's own work rules, tools, wake, recall, greetings and dream
like Segno. The app's own records about every companion (picture, profile and cards, proposals) live
in `companion-app/<id>` beside the registry, outside every home, so a registered existing home's
records stay as they are.

A companion changes who it is by proposing (`companion_settings` action `propose`): an exact excerpt
of one piece and its rewrite, shown to the user as a before/after card. Only the user's apply writes
the piece; a declined or superseded proposal writes nothing.

### Model chosen in the Add flow

The route's `create` action takes an optional `modelSelection`: the app's ModelSelection cut to
its routing fields, `{ "instanceId": "<provider instance>", "model": "<model id>" }`. It is stored
trimmed in the new companion's registry entry, so it is on disk before the engine sees the entry and
its control tower first runs. A malformed one (another field such as `options` or the legacy
`provider`, an instance id that is not a provider slug, an empty or overlong model) refuses the
create with 400 and leaves no home and no entry; it is never dropped. `null` or no field means no
choice: the entry has no `modelSelection` and the companion opens exactly as before.

The engine side reads it with `companionModelSelection(id, env)` from `registry.mjs`: the choice, or
`null` for Segno, a hand-registered companion and one made without a choice. Inside a companion's
scoped environment (`companionEnv`) the id may be left out. The `companions` list carries it as
`modelSelection` on every row. It is the choice as made at creation; once the conversation exists,
its model changes are kept in the conversation. The hosted engine applies the initial choice
before the first turn and reapplies the latest explicit choice after a restart. An Antigravity
Gemini choice uses the configured official AGY account via ACP; Hydrogen defaults to Medium.
The conversation still belongs to Rubato, including its wakes, replies and native tool policy.
An unavailable account or Gemini model does not silently switch to a different provider.

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

The dream's document upkeep (`dream/docs.mjs`) reads Rubato's own `dream/docs.md` for
every companion, registered or not, and tends only the roots in that companion's
settings (`dream.docs`); none by default.

`skillDirs` contains native `SKILL.md` catalogues for this companion only. Additional
profiles use native home records rather than creating a second generic coding-memory
repository. Their archive's project instructions for coding agents are not injected
as the resident companion's role; those files remain unchanged and ordinary coding
sessions still read them. Automatic per-message recall remains off.

## Optional transports

`reply` is every companion's only answer tool. Its `files` attach pictures, videos,
documents and HTML pages with or without a messenger: the app draws pictures and videos
in the message and opens other files in the side panel. `telegram: true` registers that
profile's supervised messenger, which also sends those files and adds voice; Telegram
reaction/edit tools act on existing transport messages. There is no separate
`telegram_send` tool. Its connection
and queue live under its own `messenger/` directory. Configure
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
| `POST /call/turn` | Heard words: `text`, stable `turnId`; `cut` when they cut the companion off, what was heard of its reply |
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
suppresses control tower ticks and sleep. A crashed connection expires automatically.

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
