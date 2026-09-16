---
name: wy-server
description: "Mac-Windows shared environment. SSH, wy-desktop, remote work."

---

# WY Server

Use this directory as the single shared skill package on Windows and macOS and from Codex and Claude. Do not maintain agent-specific copies.

## Route the current request

1. Read [references/shared.md](references/shared.md).
2. Detect the host OS from the current runtime and read exactly one host file:
   - Windows: [references/windows.md](references/windows.md)
   - macOS: [references/macos.md](references/macos.md)
3. Detect the active agent from its system/runtime identity and read exactly one agent file:
   - Codex: [references/codex.md](references/codex.md)
   - Claude Code: [references/claude.md](references/claude.md)
4. For Krea2 or ComfyUI work, also read [krea/KREA2.md](krea/KREA2.md). From macOS, use `krea/invoke-krea2.sh` for ordinary generation.

Do not infer the agent from the shell process name when the runtime identity is already explicit. If an unfamiliar agent consumes the skill, use only the shared and host references.

## Completion rule

Report the direction of control, the command or transfer result, and the authoritative final state. A reachable host, accepted dispatch, or created file is not completion unless it proves the requested outcome.

For substantive work on the other computer, use a destination-side agent only when the current runtime exposes an authorized destination tool or an existing authorized peer session. Use `codex-peer` only when that skill is enabled and callable in the current runtime; if it is disabled or unavailable, do not invoke its scripts or re-enable it as a workaround. Local native collaboration runs on the current host and must not be described as remote execution. Create an App task only when the user explicitly asks for a new task. Never automate Jump Desktop or another remote-display client through Computer Use.
