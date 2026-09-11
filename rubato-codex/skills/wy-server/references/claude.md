# Claude Code runtime

Use Claude Code's shell and file tools for the current host while following the same shared state and verification contract.

When dispatching Claude inside the Windows WSL worker, verify `claude auth status` before a model call. A binary version check proves installation only. Use a durable `wy-server job` for long work and verify its terminal state and artifacts rather than trusting dispatch acceptance.

Claude must discover this package through a `~/.claude/skills/wy-server` link to the host's Codex copy. Do not maintain a divergent Claude-specific skill directory.
