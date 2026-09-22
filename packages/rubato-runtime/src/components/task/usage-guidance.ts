// Compact once-per-session usage guidance (codex usage_hint parity) injected on the first
// before_agent_start. Kept short so it never crowds the model's working context.
export const TASK_USAGE_GUIDANCE = [
  "<rubato-runtime-task>",
  "A child's completion arrives as a status pointer plus its result file path, not its body; read that file. Team mail is steered into your running turn. A teammate's normal turn end does not wake you; one aggregate wake arrives when the run's assigned board work is closed. /tasks lists this session's children.",
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
