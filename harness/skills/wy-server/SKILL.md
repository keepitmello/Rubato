---
name: wy-server
description: "맥-윈도우 공유환경. SSH, wy-desktop, 원격 작업."

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

For substantive work on the other computer, invoke `codex-peer` and let that computer's Codex perform the work. Never automate Jump Desktop or another remote-display client through Computer Use.
