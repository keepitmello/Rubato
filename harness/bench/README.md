# Benches

What a long-used Rubato costs, measured where it hurts. Every slow path found in the engine so far
redid work over the whole history on every event; a fresh profile or a small test fixture hides
that, three months of daily use shows it. These tools build such a profile and run the engine's
user flows on it, without touching the person's own profile, homes or providers.

## Build an aged profile

```
node harness/bench/aged-profile.mjs --out /tmp/rubato-aged            # full size, ~5 GB, ~2 min
node harness/bench/aged-profile.mjs --out /tmp/rubato-aged-q --size-scale 0.25   # same shape, a quarter of the bytes
```

The defaults are the person's profile as measured on 2026-11-21: 2,140 conversations by the real size
curve (a quarter in Pi's older per-folder directories), 1,500 `-artifacts` folders, the largest
conversations at 143 and 113 MB, the companion's (Segno) at 100 MB with 8 context-window changes and
~800 note entries, a notes archive for every conversation of the last 14 days, 1,760 speed-index
sample files and the session index. `--help` lists the options; the same options (and `--now`) give
the same profile. `manifest.json` names the conversations a bench opens.

```
/tmp/rubato-aged/agent   the profile: pass as --agent-dir
/tmp/rubato-aged/home    HOME for the engine (the companion's home is here)
/tmp/rubato-aged/work    the folders the conversations ran in
```

The profile's only model provider is `bench` (`scripted-model.mjs`, an OpenAI-compatible endpoint on
127.0.0.1:47811 that answers from a script): one tool call, then a streamed 2,000-character reply; a
prompt carrying `[bench:new_context]` saves `now.md` and changes the context window.

## Run the engine flows

```
node harness/bench/engine-flows.mjs --profile /tmp/rubato-aged [--flows "open large,turn"] [--repeat 3] [--json out.json]
```

It starts this checkout's engine (`harness/pi-server/src/cli.mjs`) on the profile with its own socket,
`HOME` set to the profile's home, no resident services, `PI_OFFLINE=1`, and the installed engine build
(`--runtime-root` picks another, e.g. a candidate built from a branch). It prints one row per flow:

| column | what |
|---|---|
| held | main-thread ms the flow kept the engine's event loop busy (event-loop utilization, read inside the engine). Every other conversation and app request waited this long. The budget applies to it. |
| longest | the longest single stretch the loop could not turn |
| wall | ms the client waited |
| cpu | process CPU ms, all threads |
| bytes | what the socket carried both ways |

Budgets are `BUDGETS` in `engine-flows.mjs`. One heavy job at a time: the full profile and a bench
each keep the Mac busy for minutes.

## An isolated engine for an app

A desktop or phone bench can talk to the same isolated engine:

```
node harness/bench/scripted-model.mjs &      # or import startScriptedModel
HOME=/tmp/rubato-aged/home RUBATO_COMPANIONS_FILE=/tmp/rubato-aged/home/.rubato/companions.json \
  RUBATO_PROMPTS_DIR=$PWD/harness/prompts PI_OFFLINE=1 \
  node harness/pi-server/src/cli.mjs --agent-dir /tmp/rubato-aged/agent --socket /tmp/rubato-aged.sock \
  --idle-ms never --runtime-root ~/.rubato-pi/pi
```

The engine prints its descriptor (`serverId`, `socketPath`) as its first stdout line and writes it to
`/tmp/rubato-aged/agent/server/connection.json`; a client of that profile finds it there. Do not
unset `HOME`: the engine's companion, memory and settings come from it, and the person's must not
be reached. `isolatedEnv()` in `engine-flows.mjs` is the full environment.
