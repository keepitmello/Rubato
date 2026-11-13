# Companion calls

A live voice call with a companion. LiveKit carries the audio and decides when the caller has
finished a turn; the companion's own session decides every word through its call bridge
(`harness/pi-runtime/features/companion-home/call.mjs`). Nothing in this package composes speech,
so a call sounds like the companion and says only what it said.

```
caller ─ audio ─▶ LiveKit server (this Mac)
                     │
                     ▼
               call worker (agent.mjs)
               ├ end of turn: VAD + turn detector v1-mini, both local, Korean included
               ├ transcription: OpenAI gpt-live-transcribe (key from ~/.rubato/voice.json)
               ├ words: the companion's session, sentence by sentence (bridge.mjs)
               └ voice: Fish Audio with the companion's voice-reply settings
```

## Run

The engine runs it as the resident service `call` whenever a companion has `call.enabled`
(`service.mjs`, listed in `pi-server/src/resident-services.mjs`); the engine's main thread owns
LiveKit and the worker. Without LiveKit or `npm install` here the service stays idle and says why
in the engine log. `node run.mjs` runs the same stack in a terminal.

The control surface (`control.mjs`) listens on <http://127.0.0.1:18790/> with a test page. The app
reaches it through its own authenticated route. The LiveKit key pair is made once in
`~/.rubato/call/livekit.yaml`; each call is a file under `~/.rubato/call/calls/`; process logs are in
`~/.rubato/call/logs/`; each spoken turn's timing is appended to `~/.rubato/call/latency.jsonl`.

## Calls both ways

- The person dials (`POST /dial`): the call is live at once.
- A companion calls with its `call_user` tool (`POST /ring`): every device of the person rings
  (`GET /live`), the first to answer (`POST /answer`) takes the call and any later answer is refused
  as answered elsewhere. Unanswered after 40 s it is missed; `POST /decline` declines. The tool
  returns which, and on a pickup the companion speaks first.
- The worker reports what each side said and the end (`POST /event`), so every call keeps its
  transcript for the room's call card (`GET /calls`).

`RUBATO_CALL_ECHO=1` repeats what was heard instead of reaching the companion, to test the audio
path without touching its conversation.

## Voice engines

The page offers each companion's voice-reply setting first, then other engines to compare by ear,
all in the companion's own voice: Fish `s2.1-pro` and `drama-3`, and ElevenLabs `eleven_v4_turbo`
and `eleven_v4`. ElevenLabs needs a key (`ELEVENLABS_API_KEY` or `~/.config/elevenlabs/api_key`)
and a voice chosen there for that companion (`call.elevenlabsVoiceId` in its profile). Picking an
engine changes that call only.

## Which companions can be called

A companion needs both, and the page says which is missing:

- `call.enabled` with a port in its `~/.rubato/companions.json` profile (for Segno, the file's
  `default.call`). The bridge starts with the companion's session.
- A voice chosen for its voice replies (messenger settings `voice.voiceId`). No voice is picked for
  it here.

## Behaviour worth knowing

- Turns are sent once, never speculatively: a speculative turn would land in the companion's real
  conversation.
- A new turn while the companion is still answering cancels that answer on both sides.
- The worker does not refuse calls when the Mac is busy (`loadFunc` is 0): one person, one call.
