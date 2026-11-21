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
LiveKit and the worker. An engine that crashes cannot stop them, so each stack writes their pids to
`~/.rubato/call/processes.json` and the next one stops what is still running there before it takes
the ports (`leftovers.mjs`). Without LiveKit or `npm install` here the service stays idle and says
why in the engine log. `node run.mjs` runs the same stack in a terminal.

The control surface (`control.mjs`) listens on <http://127.0.0.1:18790/> with a test page. The app
reaches it through its own authenticated route. The LiveKit key pair is made once in
`~/.rubato/call/livekit.yaml`; each call is a file under `~/.rubato/call/calls/`; process logs are in
`~/.rubato/call/logs/`; each spoken turn's timing is appended to `~/.rubato/call/latency.jsonl`, and each pause the turn detector
judged (its end-of-turn probability, the language threshold, the words so far) to `turn-ends.jsonl`.

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

## Calls from the phone

LiveKit's signalling listens on loopback. For a phone or another Mac on the person's tailnet the
service maps one Tailscale Serve HTTPS port, `https://<mac>.<tailnet>.ts.net:7443` → `127.0.0.1:7880`
(`remote.mjs`; `RUBATO_CALL_REMOTE_PORT` moves it). Serve answers only inside the tailnet, never
through Funnel, and a port another tool already serves is left alone with the reason in the engine
log. The mapping is retried every 15 s until Tailscale runs, checked every minute after (a stopped
Tailscale withdraws the URL, a removed mapping is made again) and stays when the service stops.

A join (`/dial`, `/answer`) carries both addresses; the app's route (`t3-integration` `src/call/service.mjs`)
hands this Mac's own app the loopback one and a device that came through Tailscale the tailnet one,
and refuses a remote dial or answer with the reason (`GET /reach`) before the call starts when there
is none. Media goes to the Mac's interface addresses, the Tailscale one included.

Each call record carries `uuid` (the phone's CallKit id), `title` (the companion's name) and, for a
companion's ring, `ringUntil`. Every change goes to the push relay's Mac sender
(`harness/push-relay/mac/sender.mjs`), which sends the phone's VoIP push for a ring; without it calls
still ring every open app.

## Words the transcription expects

The companion's title and labels (`call.companionLabel`, `call.userLabel`) plus `call.keywords`, a
list of names and terms the person says often, go to transcription as hints.

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
- A heard line steers into whatever the companion is doing, as a chat message does. Cutting in stops
  its voice and that answer's unspoken words, never its run or its tools; hanging up does not stop
  them either.
- A reply the person cut off reads back to the companion only as far as it was heard, ending in `—`;
  nothing is added to the person's words. The worker sends how long the reply played and replies of
  this call that played in full (`cutFrom`); the bridge cuts the call_say there on a word boundary and
  rewrites it the same way in every request, kept on disk so the cached prompt breaks once.
- The companion speaks whenever the call is open. Its first `call_say` after a heard line answers
  that line; any later one, while it keeps working, comes over the open call stream as `say` /
  `say_end` and plays once the person is not talking (`createSpeechBetween` in `bridge.mjs`).
- The worker does not refuse calls when the Mac is busy (`loadFunc` is 0): one person, one call.
