---
name: consult
description: "Send a packet through `consult` on PATH to a web-strong ChatGPT project agent. Use for deep research, public-repo work, and reviews the checkout cannot settle."
---

# Consult

The local session owns the question, the packet, and verification. `consult` on
PATH owns the ChatGPT project send. Do not assemble engine flags, and do not
hand the packet to another browser or agent.

## When

Use this when the checkout cannot settle the work: current web facts, public
repos, deep research, or a sandbox build. Skip it for code that depends on
local services or private repo state the sandbox cannot reach.

## Quality

`consult send` requires exactly one explicit `--quality xhigh` or `--quality pro`.
With no flag, both flags, or any other value, stop before writing a packet.

- `xhigh` — ordinary bounded consults
- `pro` — genuinely heavy questions; it can run for many minutes

## Packet

Write `.consult/<run>/packet.md`. The first line is one Markdown H1 with only
the subject (`# <title>`). Do not add task framing such as `Consult`,
`review request`, `검토`, `리뷰 요청`, or `분석 요청`. Include the evidence,
constraints, failed attempts, and acceptance criteria that can change the
answer. Scan for secrets. Ask for a natural Korean report; leave structure
and terms to the consultant.

For a zip artifact, add `--artifact .consult/<run>/artifact.zip`.

Complex packets: `references/context-checklist.md`.

## Command

```bash
consult list
consult send --quality xhigh .consult/<run>/packet.md
consult send --quality xhigh .consult/<run>/packet.md --to <thread-id>
consult recover .consult/<run>/result.json
```

`--to` accepts a thread id, `conversationUrl`, or a previous `result.json`.
List first; do not guess the thread from a nearby `.consult/` directory.
Unrelated threads may run in parallel. The same thread serializes.

## After

Read `response.md` and `result.json`. Verify every material claim locally
before acting. Discard an unrelated reply. `references/after-advice.md`
governs that pass.

- Exit `75` — nothing was sent. Report the failure and stop.
- Exit `76` — send is unproven. Do not retry.
- Exit `77` — the turn committed but the reply was not saved. Run
  `consult recover`. Never resend that packet. A later `--to` is a new turn,
  not a resend.

Engine, Chat surface, recovery, and project config live in
`references/runbook.md`.
