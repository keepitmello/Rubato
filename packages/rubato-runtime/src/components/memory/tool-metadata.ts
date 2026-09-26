// Shared memory tool identity + description metadata. The senpi ToolDefinition layer (tools.ts) and the
// standalone MCP server (src/mcp/memory-server.ts) both consume this module, so it must stay free of
// TypeBox and harness imports: the MCP bundle runs under plain Node with no senpi runtime present.

export const MEMORY_TOOL_NAME = "memory"
export const MEMORY_APPLY_PATCH_TOOL_NAME = "memory_apply_patch"

// MCP surface identity. Rubato's Claude-compatible MCP adapter names catalog tools
// `mcp__<server>_<tool>` with non-alphanumerics (except dash/underscore) sanitized, so the
// rubato-memory server exposes these exact tool names in tool_call/tool_result events.
export const MEMORY_MCP_SERVER_NAME = "rubato-memory"
export const MEMORY_MCP_TOOL_NAME = `mcp__${MEMORY_MCP_SERVER_NAME}_${MEMORY_TOOL_NAME}`
export const MEMORY_MCP_APPLY_PATCH_TOOL_NAME = `mcp__${MEMORY_MCP_SERVER_NAME}_${MEMORY_APPLY_PATCH_TOOL_NAME}`

/** What a memory tool says in a folder that has no store, and how to turn memory on there. */
export const MEMORY_UNBOUND_MESSAGE =
  "memory is off in this folder: it is not inside a git repository or the home directory, and its config names no memory store. To turn it on, run the session inside a git repository, or set `memory.agent` in `<folder>/.rubato/rubato.jsonc` (for example `{ \"memory\": { \"agent\": \"<store-name>\" } }`), then start a new session."

export const MEMORY_TOOL_DESCRIPTION = [
  "Edits this project's Rubato memory store and commits each change with the reason you give.",
  "",
  "Before writing, read Skill(memory-discipline): it decides whether something is worth keeping and which file owns it. In short: write when a thread of work closes, only the why git cannot answer, and keep one current answer per file (overwrite or delete; never append corrections beside it).",
  "",
  "Memory files are markdown documents with YAML frontmatter. Frontmatter carries a `description` (required on create; it is what search shows) and may set `read_only: \"true\"` to block modification. Edits preserve existing frontmatter.",
  "",
  "Supported operations on memory files:",
  "- `str_replace`",
  "- `insert`",
  "- `delete` (files, or directories recursively)",
  "- `rename` (path rename only)",
  "- `update_description`",
  "- `create`",
  "For larger reorganizations, use memory_apply_patch instead.",
  "",
  "Path formats accepted:",
  "- relative memory file paths (e.g. `decisions/cache-key.md`, `reference/release-steps.md`)",
  "- absolute paths only when they are inside the memory repo",
  "",
  "Note: absolute paths outside the memory repo are rejected.",
  "",
  "On success the tool returns `Memory <command> committed locally (<sha>).`, or `Memory <command> committed (<sha>); harness will sync after the turn.` when a mirror is configured.",
  "",
  "Examples:",
  "",
  "```python",
  "# Overwrite a conclusion that changed",
  'memory(command="str_replace", reason="Cache key now includes the model id", file_path="decisions/cache-key.md", old_string="- Key is the prompt hash", new_string="- Key is the prompt hash plus the model id")',
  "",
  "# Delete a file whose question no longer matters",
  'memory(command="delete", reason="Retired with the old launcher", file_path="decisions/launcher-retry.md")',
  "",
  "# Rename a file to the question it answers",
  'memory(command="rename", reason="Name the question", old_path="decisions/cache.md", new_path="decisions/cache-key.md")',
  "",
  "# Update a file description",
  'memory(command="update_description", reason="Clarify scope", file_path="decisions/cache-key.md", description="What the prompt cache key is made of, and why")',
  "",
  "# Create a file for a new question",
  'memory(command="create", reason="Record why the cache key includes the model", file_path="decisions/cache-key.md", description="What the prompt cache key is made of, and why", file_text="## 결론\\n- Key is the prompt hash plus the model id\\n\\n## 근거\\n- Rejected: prompt hash alone (two models shared one entry)")',
  "```",
].join("\n")

export const MEMORY_APPLY_PATCH_DESCRIPTION = [
  "Apply a codex-style patch to files in this project's Rubato memory store, then commit the change. Use it to merge two files that answer one question, or to fix several files a finding invalidated.",
  "",
  "This is similar to `apply_patch`, but scoped to the memory repo and with memory-aware guardrails.",
  "",
  "- Required args:",
  "  - `reason` — git commit message for the memory change",
  "  - `input` — patch text using the standard apply_patch format",
  "",
  "Patch format:",
  "- `*** Begin Patch`",
  "- `*** Add File: <path>`",
  "- `*** Update File: <path>`",
  "  - optional `*** Move to: <path>`",
  "  - one or more `@@` hunks with ` `, `-`, `+` lines",
  "- `*** Delete File: <path>`",
  "- `*** End Patch`",
  "",
  "Path rules:",
  "- Relative paths are interpreted inside the memory repo",
  "- Absolute paths are allowed only when under the memory repo",
  "- Paths outside the memory repo are rejected",
  "",
  "Memory rules:",
  "- Operates on markdown memory files (`.md`) with YAML frontmatter",
  "- Updated/deleted files must be valid memory files with frontmatter",
  "- `read_only: \"true\"` files cannot be modified",
  "- If adding a file without frontmatter, frontmatter is created automatically",
  "",
  "Git behavior:",
  "- Stages changed memory paths",
  "- Commits with `reason`",
  "",
  "On success the tool returns `memory_apply_patch committed locally (<sha>).`, or `memory_apply_patch committed (<sha>); harness will sync after the turn.` when a mirror is configured.",
  "",
  "Example:",
  "```python",
  "memory_apply_patch(",
  '  reason="Merge the two cache files into one answer",',
  '  input="""*** Begin Patch',
  "*** Update File: decisions/cache-key.md",
  "@@",
  "-- Key is the prompt hash",
  "+- Key is the prompt hash plus the model id",
  "*** Delete File: decisions/cache-model.md",
  '*** End Patch"""',
  ")",
  "```",
].join("\n")
