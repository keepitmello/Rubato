---
name: "outpost"
description: "Use when quality depends on deep research, synthesis, architecture, diagnosis, or independent judgment through a packeted ChatGPT GPT-6 Pro project-agent run."
---

# Outpost

The local session owns the question, the packet, and verification. `${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost` owns the ChatGPT project send. Do not assemble engine flags, and do not
hand the packet to another browser or agent.

## When

Use Outpost when the main quality bottleneck is depth: difficult research,
synthesis, architecture, diagnosis, or independent judgment. It can find and
evaluate public sources while reasoning. When evidence coverage is equally
material, put the evidence collected through Aside in the packet first. Skip it
for code that depends on local services or private repo state the sandbox
cannot reach.

## Quality

`outpost send` takes exactly one quality: `--quality pro`. There is no other
value. `xhigh` was removed because ChatGPT's `매우 높음` tier silently runs
GPT-5.6 (`gpt-5-6-thinking`), not GPT-6.

Every turn must answer as `gpt-6-pro`. The run reads the model slug ChatGPT
reports for the answer and fails with exit `78` when it is anything else, so a
picker or tier change can no longer pass unnoticed. A Pro turn can run for
15–20 minutes and each send spends weekly Pro quota: send once, never re-send.

## Packet

Write `.outpost/<run>/packet.md`. The first line is one Markdown H1 with only
the subject (`# <title>`). Do not add task framing such as `Outpost`,
`review request`, `검토`, `리뷰 요청`, or `분석 요청`. Include the evidence,
constraints, failed attempts, and acceptance criteria that can change the
answer. Scan for secrets. Ask for a natural Korean report; leave structure
and terms to the consultant.

To receive a generated zip back, add `--artifact .outpost/<run>/artifact.zip`.
To upload extra input files with the packet, add `--attach <path>` (repeatable).
Non-ASCII upload names, including names inside a zip, are renamed to ASCII
because ChatGPT mangles them; the mapping is appended to the packet.

Complex packets: `references/context-checklist.md`.

## Command

```bash
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" list
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" doctor
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md --attach .outpost/<run>/evidence.zip
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" send --quality pro .outpost/<run>/packet.md --to <thread-id>
"${CODEX_HOME:-$HOME/.codex}/rubato-codex/bin/outpost" recover .outpost/<run>/result.json
```

`--to` accepts a thread id, `last`, a `/c/` conversation URL, or `result.json`.
List first; `last` is the newest thread that already has a conversation.
Unrelated threads may run in parallel. The same thread serializes.
While a send is in flight, `outpost list` shows `working`. Background the
process; when it exits, an idle parent session is woken.

## After

Read `response.md` and `result.json`. Verify every material claim locally
before acting. Discard an unrelated reply. `references/after-advice.md`
governs that pass.

- Exit `75` — nothing was sent. Report the failure and stop.
- Exit `76` — send is unproven. Do not retry.
- Exit `77` — the turn committed but the reply was not saved. Run
  `outpost recover`. Never resend that packet. A later `--to` is a new turn,
  not a resend.
- Exit `78` — the answer was saved but a model other than `gpt-6-pro` produced
  it. Do not act on it as a Pro answer; run `outpost doctor` and fix the picker.
- Exit `79` — this run directory already sent this packet. Recover it instead
  of sending again; `OUTPOST_FORCE=1` overrides only when you mean to spend
  another Pro turn.

`result.json` is written before the send with `status: submitted_pending`, so a
dead REPL, an Aside restart, or a killed parent never loses the turn:
`outpost recover .outpost/<run>` picks the answer up without resending.

Engine, Chat surface, recovery, and project config live in
`references/runbook.md`.
