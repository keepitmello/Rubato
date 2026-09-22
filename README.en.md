# Rubato

**A multi-model agent harness for every day. So that you are not the bottleneck.**

Run several agents and you become the manager. You read piles of text, judge it, set
direction, push back when it goes wrong, and ask again. That cognitive load is the
bottleneck.

Rubato hands that chair to a lead. You talk about what you want and which choices matter.
The lead turns it into a concrete goal, builds a taskforce only when one pays, and hands
back what the team learned in terms you can judge.

At the same time the harness is **obsessive about protecting the prompt cache.** It aims
for a 98–99% prefix hit rate and keeps noise out of the context. That is what makes it
fast, cheap, and still sharp after a long session.

The name comes from *tempo rubato* — "stolen time". Instead of forcing a tempo, the harness
lets the model choose how much time a problem deserves.

[한국어](README.md)

## Why it exists — the human is the bottleneck

Run several agents and one more job lands on you: splitting the work, remembering what each
session knows, reading the results and reconciling them, deciding what to ask for next. The
smarter the models, the more you get pushed into the manager's chair — with more text to
read and more calls to make.

So Rubato puts a **lead** in that chair and forms a **taskforce** when one is worth it. You
agree on direction with the lead; the lead holds the goal and the still-open choices while
the owners move their own work forward. Writing a brief per worker and reading their
reports to decide the next move moves from you to the lead.

What comes back to you is not progress. It is **the things that need a decision**.

## A harness that protects the cache

This is most of why Rubato is fast and cheap.

Input cost on model APIs is mostly decided by the **prefix cache**. If the front of a
request is byte-identical to the previous one, that part is not billed at full input price.
Change one character near the front and everything after it is recomputed. So everything
that touches the prefix becomes a design target.

```
previous  [ system prompt | tool defs | turn 1 … turn N ]
next      [ system prompt | tool defs | turn 1 … turn N | new turn ]  → prefix intact, cache hit
other     [ system prompt | tool defs | a summary | new turn ]        → prefix changed, all recomputed
```

- **The hit rate is visible.** The status line shows `(CH: 98%)`, and a finished run records
  its whole-run hit rate next to its spend. What you cannot see, you cannot protect.
- **Crossing a window does not rewrite the prefix with a summary.** The model writes working
  notes and moves to a new window instead. The new window carries only a window id and a
  note listing; note bodies and past originals are read back with tools when the model needs
  them. No generated summary is substituted for that. Today this mode is the default when
  the starting model is Astra; other models default to a summary.
- **What was already sent is never edited later.** Guidance is recorded once per window and
  is not changed when token counts move. If its position cannot be restored, Rubato
  **stops rather than move it and break the cache.**
- **Tool output cannot push the context around.** A tool result over 16 KB is shown as 8 KB
  with the rest left as a file path; originals are read back by range when needed. It is
  never summarized — there is a rule against summarizing source code or inferring success.

Hit rates differ by provider. Prefix reuse is confirmed on the Anthropic direct path and
the OpenAI Codex path, and on the Cursor path the same 53 KB fixture gives 98.7–99.1%
prefix hits across turns 2–6. Some paths are still under investigation.

## Context is performance

Today's frontier models treat tight rules as constraints, and noise in the context is a
direct performance loss. So Rubato keeps what is always read small, states the goal clearly,
and loads the rest only when the moment calls for it.

- **The always-on role prompt is about 6 KB.** It carries the goal, responsibilities and the
  boundaries of a decision. It says which problem you own and how far you decide alone; it
  does not say how to do the work.
- **Skills load when they are needed.** The list shows only names and descriptions; a body
  enters the context when that judgement is required. Discoverability and always-on weight
  are tuned together.
- **Knowledge worth keeping lives outside the conversation.** Instead of piling it into the
  session, it goes to searchable memory (`msearch`) and is pulled back when needed. The
  conversation keeps only what changes the next move.
- **Judgement is not replaced by structure.** Gates and procedures are added only after an
  observed failure of "was told to judge and did not". Absence never carries meaning.

## A taskforce is not a subagent

An ordinary subagent is spawned by a parent and returns a summary into the parent's context.
The parent ends up reading every report — the bottleneck survives.

Rubato's lead, owners and verifier are independent sessions, and they talk to each other
directly.

- **Peers talk to each other.** Owner and verifier exchange reproduction conditions,
  observed results, fixes and re-verification directly, without routing through the lead.
  When someone is stuck, the session that understands the problem best carries on.
- **The lead wakes only when needed.** Only the lead's process raises team-wide
  notifications, and those are batched. The lead is not woken per message, so the context it
  reads and the number of replies are both saved.
- **Verification comes from a different model family.** The verifier talks to the owner and
  still judges independently. It does not just read the code — it **runs the thing**. An
  absent finding is a valid result.
- **A session that already understands is reused.** The owner who found the cause carries it
  through the fix and the check. You do not buy the cost of understanding it twice.
- **Not forming a team is a valid answer.** Small work ends with the lead alone, or with a
  single plain session. A team appears only when splitting pays more than the explaining,
  handover and integration it costs.

## Product judgement stays in the room

The deeper the implementation goes, the easier it is to lose why you are building it. So
product judgement is available as skills too.

- **product-framing** — before building, check users, today's alternatives, comparative
  value, the outcome and the scope of the experiment, and freeze the frame. Check for value
  drift while building.
- **product-reframing** — when the frame has hardened and every candidate looks alike, build
  candidates outside the frame through research.
- **metaframe** — hold the first reading as provisional and look for a more useful
  perspective that would change the next move.

## How a session goes

```
you ──conversation──▶ lead
                      │  holds the goal and the still-open choices, investigates what it can
                      │  shows you "here is how I read this, and the direction I recommend"
                      │
                      │  builds a team only when it pays
                      ├──▶ owner      one result, end to end: investigate → build → debug → self-check
                      ├──▶ owner      another result that can advance independently
                      └──▶ verifier   judges the agreed criteria and the real result independently
                      │
you ◀──only what needs a decision──┘   (running work passes directly between owner and verifier)
```

## How it differs from other harnesses

| | Center | What you do |
|---|---|---|
| Chat app | one conversation | Talk. Repo and tool access are limited |
| Single-session CLI (Claude Code, Codex CLI, …) | everything in one conversation | Talk, and spawn subagents yourself to read their reports back |
| Agent framework (LangGraph, CrewAI, …) | a graph you assemble | Define roles, flow and state in code, and operate and observe it yourself |
| **Rubato** | **a lead that talks with you** | Talk about the goal and priorities. The lead and the team take the rest |

It runs in a terminal, uses skills and tools, and lets you pick models — like the others.
What differs is **where the responsibility for splitting work and stitching it back
together sits.** A framework puts it in your code, a single session puts it in your hands,
and Rubato puts it in a lead that holds the conversation.

## Install

Assumes **macOS**. Requires Node 24+ and bun 1.4+.

```bash
git clone --branch rubato/base https://github.com/keepitmello/Rubato.git
cd Rubato

./install.sh                # show the plan only; not a single file is touched
./install.sh --apply        # install, then verify a model round-trip
./install.sh --apply --gui  # also install the official GUI (desktop app)
```

Read the plan first. `--apply` applies it without asking per item; only the GUI is asked
about separately. When it finishes, open a new shell or re-read the rc file it names.

### Official GUI

**Without `--gui`, the GUI is not installed.** In an interactive shell, plain `--apply` will
ask. Where stdin is not a terminal — an agent, a script — it does not ask and skips the GUI,
and records that fact under "remaining work" in the install summary.

The GUI takes [T3 Code](https://github.com/pingdotgg/t3code) at a pinned commit, applies the
Rubato overlay, and makes the provider shown on screen read **Rubato**. The desktop bundle
lands in `~/.rubato/t3-source`; on macOS the app is `/Applications/Rubato.app`. The build
takes a few minutes and needs network access to fetch the T3 sources.

Off macOS you get the desktop bundle instead of an app bundle; start it from a terminal with
`sh harness/t3-integration/start-gui.sh`.

### Credentials

The installer never copies or creates credentials. Check connections with `rubato auth` and
add the accounts you need there. Accounts may be shared, but tokens must be your own on each
machine — two machines holding the same refresh token will silently kill one.

## Everyday commands

The terminal runner is the **Rubato CLI** (`rubato`). The official GUI is T3.

```bash
rubato                # Rubato CLI session
rubato-gui            # official GUI (if installed with --gui)
rubato auth           # connection status, login and accounts, arrow keys only
rubato update         # review changes, then update
rubato update --check # just report whether an update exists
rubato restart        # bring running pieces onto new code (engine, remote hub, GUI)
rubato build          # rebuild system prompts and engine artifacts
rubato dispatch <name> grok < brief.md   # non-interactive worker: grokfast|fast|sol|fable
msearch "<query>"     # search memory
```

## Surfaces

| | What you use |
|---|---|
| Terminal | Rubato CLI (`rubato`). Conversations start here |
| Desktop | **Rubato.app** (macOS). Launches the same thing as `rubato-gui` |
| iPhone | The [T3 Code](https://github.com/pingdotgg/t3code) app over T3 Connect, against a Mac environment opened with `rubato-gui` |

The app periodically checks for new commits, tells you in-window, and running the update
lets a one-off job outside the app reopen it and confirm the new window actually came up.
That path exists on the desktop app only; on Windows, the web and mobile, use the terminal
commands above.

## Going deeper

- [What Rubato pursues](docs/philosophy/README.md) — priorities, and the reference to return to when changing the design
- [Harness guide](harness/README.md) — day-to-day operation
- [Carrying context forward](docs/context-notes.md) — working notes and originals across windows
- [Memory search](harness/msearch/README.md) — per-project memory
- [iPhone remote use](scripts/remote-release/USER-TEST.md) — host hub install and doctor
- [한국어 README](README.md)

## Changing this repository

Philosophy owns the direction we pursue, skills own the current operating promises, and the
harness owns the machinery that makes those promises executable. Check a doc change against
the [philosophy](docs/philosophy/README.md) first, and change operating rules at their
source in `harness/skills/`. Verify real behaviour from code and run records, and settle
changes in values and priorities with the user.
