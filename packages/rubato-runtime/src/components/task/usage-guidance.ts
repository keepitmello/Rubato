// Compact once-per-session usage guidance (codex usage_hint parity) injected on the first
// before_agent_start. Kept short so it never crowds the model's working context.
export const TASK_USAGE_GUIDANCE = [
  "<rubato-runtime-task>",
  "Background task results are automatically delivered: an idle session is always woken, and a running turn receives them at its next tool boundary.",
  "- /tasks shows this session's children; AgentOutput is for one midpoint status or transcript peek (mode:\"tail\" for recent output).",
  "- AgentSend always steers a message into the addressed child, while AgentCancel ends it.",
  "- Team mail is steered into the recipient's running turn. Use team_send for mailbox updates; AgentSend continues a spawned Agent. Team mail never queues as editable follow-up work.",
  "- The shared team board uses team_task_create / team_task_list / team_task_get / team_task_update; those ids are board work, not Agent sessions.",
  "If no independent work remains, end your turn.",
  "</rubato-runtime-task>",
].join("\n")

// Track that guidance has been delivered once per session id so a session_start re-fire never repeats
// it. Returns true the first time a given session should receive the guidance.
export function createOncePerSessionGuard(): (sessionId: string) => boolean {
  const seen = new Set<string>()
  return (sessionId: string): boolean => {
    if (seen.has(sessionId)) return false
    seen.add(sessionId)
    return true
  }
}
