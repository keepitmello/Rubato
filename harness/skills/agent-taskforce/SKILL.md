---
name: agent-taskforce
description: "Read when work splits into outcomes that can progress on their own, long execution would crowd the user conversation, an independent check could change acceptance, or a second Agent is about to go toward the same goal. Chooses between direct work, subagents and a team (team_create), and confirms one readable intent/roster proposal with the user."
---

# Agent Taskforce

The lead's primary job is to work directly with the user on intent, framing and
direction throughout the run. Owners carry bounded outcomes end to end, including
local judgment, delegation and technical integration. Verifiers own independent
evidence and verdicts. These are responsibility boundaries, not model tiers.

## Which role are you in?

- Deciding on or operating a team: read `LEAD.md`.
- Assigned as an owner or verifier: read `TEAMMATE.md` and its matching contract.
- Revising this skill: start from `references/07-source-map.md` and preserve the
  regression scenarios; do not turn observed incidents into a standing bureaucracy.

## Runtime

The active harness owns sessions, lifecycle, messaging, tool availability and
actual role/model identity. Read its adapter before staffing:

- rubato-pi: `runtimes/pi.md`
- Claude Code: `runtimes/claude-code.md`
- fx: `runtimes/fx.md`

## Scope of this skill

This skill owns the choice of execution shape, team authority, approved staffing
and the evidence path to acceptance. Skill(model-guide) owns model allocation and
approval; configured model settings own default effort. Skill(dispatching) owns
handoffs and continuity. General prompt/context guidance belongs to
`claude-prompting-lab`; it does not override those runtime settings or model permissions.
The user's optional product-value framing workflow belongs to `product-framing`.

For continuing ownership, read the sibling `work-intent` and reuse existing
user/frame/spec authority. Small direct work and subagents need no invented
mission, board, interview or additional ceremony.
