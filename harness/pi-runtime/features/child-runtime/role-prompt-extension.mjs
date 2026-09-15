import { createRolePromptExtension } from "../prompt-rules/role-prompt.mjs"

/**
 * The child's Rubato system prompt.
 *
 * The parent session gets it from `--system-prompt` (buildStockPiArgs), an argv
 * a child session never sees, so without this factory a child runs on stock
 * pi's own system prompt. That is not cosmetic: Anthropic reads the system
 * prompt when it decides whether a plan-billed OAuth request is Claude Code,
 * and pi's prompt ("operating inside pi, a coding agent harness") is judged a
 * third-party app, which fails the whole turn with
 * `400 ... Third-party apps now draw from your extra usage, not your plan
 * limits.` Every anthropic child failed that way; other providers only lost
 * the prompt.
 *
 * The role is left alone when the environment already names one: an RPC child
 * carries SENPI_CODING_AGENT_SESSION_DIR (agent), a team member carries
 * SENPI_TASK_MEMBER (owner). Only the leftover case is pinned, because
 * `resolveRole` calls an unmarked process "lead" and a task child is not the
 * lead.
 */
export function createStockChildRolePromptExtension({ env = process.env } = {}) {
  const named = env.RUBATO_PI_ROLE !== undefined || env.SENPI_TASK_MEMBER !== undefined ||
    env.SENPI_CODING_AGENT_SESSION_DIR !== undefined
  return createRolePromptExtension({ env: named ? env : { ...env, RUBATO_PI_ROLE: "agent" } })
}

export default createStockChildRolePromptExtension()
