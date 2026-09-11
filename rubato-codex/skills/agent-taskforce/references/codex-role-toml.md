# Codex role TOML: what a role file actually controls

Verified against Codex CLI 0.153.4 source (`codex-rs/core/src/agent/role.rs`,
`AgentRoleOverrides`) on 2026-09-11, with an Outpost (GPT-6 Pro) source review.
Re-check the struct when Codex changes; the official subagents page has shown
fields (`sandbox_mode`, `mcp_servers`) that this version does not apply.

## Applied per role

| Field | Effect |
|---|---|
| `developer_instructions` | Replaces the parent's configured developer instructions. Base instructions, permission notes and the applicable AGENTS.md still load for the child. |
| `model` | Wins over `spawn_agent.model`. |
| `model_reasoning_effort` | Wins over `spawn_agent.reasoning_effort`. Independent of `model`: a role may pin effort and leave the model to the spawn. |
| `model_reasoning_summary`, `model_verbosity`, `personality` | Applied when the model supports them. |
| `service_tier` | Read, then re-resolved from the root session; not a per-role pin. |
| `features.<name> = false`, `skills.config[].enabled = false`, `skills.bundled.enabled = false` | Can only disable; not an allowlist. |

Precedence: role file > spawn argument > `[agents].default_subagent_*` > parent.
A role that changes only `model` keeps the effort already resolved, so an
unsupported combination fails at spawn.

## Not applied per role

`sandbox_mode`, `approval_policy`, permission profiles, `mcp_servers` and
their tool filters, `tools`, `model_provider`, `instructions` /
`model_instructions_file`, `agents.*` limits. A role file is not a permission
file: a verifier's "do not modify" is an instruction, and a genuinely read-only
verification needs a separately started read-only session.

## Rubato choices that follow

- Roles omit `model` and `model_reasoning_effort`; the lead selects both per
  task through the model-guide. Pinning effort per role is available if every
  selectable model supports the value.
- Verifiers spawn with `fork_turns: "none"`. `"none"` isolates the
  conversation, not tools, files or permissions.
- `fork_turns: "all"` with a model override is forbidden by the session
  instructions even where the code would accept it; use `"none"` or a turn count.
- Registration uses `[agents.<name>] config_file` written by the installer.
  Automatic discovery of a plugin-bundled `agents/` directory is not a
  confirmed rule; keep the explicit registration.
- `taskforce_owner/verifier/helper` are user roles on Codex's role mechanism,
  not OpenAI built-ins. The built-in `explorer.toml` is empty in this version.
