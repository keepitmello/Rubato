# Codex runtime

Use Codex's local shell and file tools for the current host. For work on the other computer, invoke `codex-peer` and let the destination Codex own its local actions and verification. The destination task may use its local Computer Use tools when available; the source task must not control a remote-display client through Computer Use.

Prefer `codex-peer create` because desktop-loaded tasks can hold an active-writer lock. New peer tasks default to `gpt-5.6-terra` with `medium` effort; use Luna for simple bounded work and Sol only for difficult, ambiguous, cross-boundary, or repeatedly failing work. Use `models` before an explicit override, wait for `turn/completed`, and inspect the returned assistant text.

When dispatching Codex inside the Windows WSL worker, verify `codex login status` before a model call. A binary version check proves installation only. Use a durable `wy-server job` for long work and verify its terminal state and artifacts rather than trusting dispatch acceptance.

Use the skill's `agents/openai.yaml` as Codex UI metadata. Do not create a second Codex-specific copy of this package.
