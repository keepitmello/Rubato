/** Model-facing tool.description rewrites. Unknown names pass through unchanged. */

export const SLIM_DESCRIPTIONS = Object.freeze({
  todo: "Track phased tasks by verbatim content string — no auto-generated ids (no task-1). One op per call, batched with real work; never a solo todo turn. done/start/drop take the exact task or phase text from the latest todo result (view if lost). A user multi-step plan must init every item as its own task before working. Ops: init, start, done, drop, rm, append, view.",

  Agent:
    "Start one child agent using exactly one of model or preset. Omit effort unless an explicit override is required. model is a complete provider/model id; missing models fail closed (no fallback). Prompt MUST be English. Spawns are async and return agentId immediately. If no independent work remains, end the turn; otherwise keep working. Pass summary (one line, ≤80 chars). AgentSend continues an existing child; Agent always spawns. AgentOutput peeks; AgentCancel ends a child.",

  AgentSend:
    "Send a follow-up to a child, keyed by agentId. A running child is steered immediately. A finished resident child is revived; disposed, evicted, cancelled, and terminal-errored children are not. One-shot agents (momus) always refuse AgentSend — spawn a new momus instead.",

  AgentOutput:
    "Read one child, keyed by agentId. Always returns immediately. mode=status (default) is the host snapshot; tail is recent transcript; full is the whole transcript (capped). Read-only: never revives or steers. Peeking a still-running child ends the parent turn unless this round also did other work.",

  AgentCancel:
    "Cancel a running child and release its resources. Terminal and not resumable. Cancelling a child that is not running is a no-op.",

  team_create:
    "Create a team run from a named spec or an inline spec. The current session is the lead. Before spawning, read agent-taskforce LEAD.md and runtimes/pi.md, then report the smallest roster (outcomes, models, verifier or none) in one message and spawn in the same turn; the user vetoes rather than approves. inline_spec takes precedence over team_name. Members run as background children. Member prompts MUST be in English. Returns invalid_arguments, spec_error, or runtime_error on failure.",

  memory:
    'Write markdown memories in the Rubato memory repo; changes auto-commit. Frontmatter description is required on create; read_only: "true" blocks modification. Ops: str_replace, insert, delete, rename, update_description, create. Paths must be inside the memory repo. Keep [[path]] references consistent when creating or deleting.',

  memory_apply_patch:
    "Apply a codex-style patch to memory files, then auto-commit. Required: reason (commit message), input (*** Begin Patch ... *** End Patch). Paths must be inside the memory repo. read_only files cannot be modified.",

  bash: "PTY-backed shell. Background with run_in_background:true → bash_id; steer bash_input, read bash_output, stop kill_bash. Do not sleep or poll — use monitor. Foreground auto-detaches after ~60s; timeout is the kill deadline.",

  monitor:
    "Subscribe instead of polling. Pass command XOR path, never both. command: PTY output lines matching filter become events; path: one file, fires once (create default; use modify if the file already exists); path takes no filter or persistent. Returns bash_id; peek bash_output, stop kill_bash. Identical consecutive line batches are deduped.",

  tool_search:
    "Search the catalog of available tools by capability; matched tools are activated and are callable immediately after this result.",
});

/**
 * @param {unknown} name
 * @param {unknown} original
 */
export function slimToolDescription(name, original) {
  if (typeof name !== "string") return original;
  const slim = SLIM_DESCRIPTIONS[name];
  return typeof slim === "string" ? slim : original;
}
