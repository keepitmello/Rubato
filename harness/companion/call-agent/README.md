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

```sh
npm install
node run.mjs          # LiveKit server, call worker and the page; Ctrl-C stops all three
```

Open <http://127.0.0.1:18790/> and pick a companion. Everything listens on loopback. The LiveKit
key pair is made once in `~/.rubato/call/livekit.yaml`; each spoken turn's timing is appended to
`~/.rubato/call/latency.jsonl`.

`RUBATO_CALL_ECHO=1` repeats what was heard instead of reaching the companion, to test the audio
path without touching its conversation.

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
