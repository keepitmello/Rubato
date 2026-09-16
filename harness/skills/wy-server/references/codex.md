# Codex runtime

Use Codex's local shell and file tools for the current host. For work on the other computer, use a destination-side agent only when the current runtime exposes an authorized destination tool or an existing authorized peer session. Invoke `codex-peer` only when it is enabled and callable; if disabled or unavailable, do not invoke its scripts or re-enable it as a workaround. The destination Codex owns its local actions and verification. The destination task may use its local Computer Use tools when available; the source task must not control a remote-display client through Computer Use. Local native collaboration is not a remote execution path.

When an enabled, callable `codex-peer` path and explicit authorization for a new destination task both exist, prefer `codex-peer create` because desktop-loaded tasks can hold an active-writer lock; never interrupt or bypass that lock. Follow the destination runtime's currently exposed model/effort policy and user approval conditions rather than fixed defaults; preserve explicit higher-cost or Sol approval requirements. Wait for `turn/completed`, and inspect the returned assistant text.

When dispatching Codex inside the Windows WSL worker, verify `codex login status` before a model call. A binary version check proves installation only. Use a durable `wy-server job` for long work and verify its terminal state and artifacts rather than trusting dispatch acceptance.

Use the skill's `agents/openai.yaml` as Codex UI metadata. Do not create a second Codex-specific copy of this package.
