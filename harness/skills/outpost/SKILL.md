---
name: "outpost"
description: "Use when quality depends on deep research, synthesis, architecture, diagnosis, or independent judgment through a packeted GPT-5.6 project-agent run."
---

# Outpost

The local session owns the question, the packet, and verification. `outpost` on
PATH owns the ChatGPT project send. Do not assemble engine flags, and do not
hand the packet to another browser or agent.

## When

Use Outpost when the main quality bottleneck is depth: difficult research,
synthesis, architecture, diagnosis, or independent judgment. It can find and
evaluate public sources while reasoning. When evidence coverage is equally
material, put the evidence collected through Aside in the packet first. Skip it
for code that depends on local services or private repo state the sandbox
cannot reach.

## Quality

`outpost send` requires exactly one explicit `--quality xhigh` or `--quality pro`.
With no flag, both flags, or any other value, stop before writing a packet.

- `xhigh` — ordinary bounded jobs
- `pro` — genuinely heavy questions; it can run for many minutes

## Packet

Write `.outpost/<run>/packet.md`. The first line is one Markdown H1 with only
the subject (`# <title>`). Do not add task framing such as `Outpost`,
`review request`, `검토`, `리뷰 요청`, or `분석 요청`. Include the evidence,
constraints, failed attempts, and acceptance criteria that can change the
answer. Scan for secrets. Ask for a natural Korean report; leave structure
and terms to the consultant.

For a zip artifact, add `--artifact .outpost/<run>/artifact.zip`.

Complex packets: `references/context-checklist.md`.

## Command

```bash
outpost list
outpost send --quality xhigh .outpost/<run>/packet.md
outpost send --quality xhigh .outpost/<run>/packet.md --to <thread-id>
outpost recover .outpost/<run>/result.json
```

`--to` accepts a thread id, `last`, a `/c/` conversation URL, or `result.json`.
List first; `last` is the newest thread that already has a conversation.
Unrelated threads may run in parallel. The same thread serializes.

## After

Read `response.md` and `result.json`. Verify every material claim locally
before acting. Discard an unrelated reply. `references/after-advice.md`
governs that pass.

- Exit `75` — nothing was sent. Report the failure and stop.
- Exit `76` — send is unproven. Do not retry.
- Exit `77` — the turn committed but the reply was not saved. Run
  `outpost recover`. Never resend that packet. A later `--to` is a new turn,
  not a resend.

Engine, Chat surface, recovery, and project config live in
`references/runbook.md`.
