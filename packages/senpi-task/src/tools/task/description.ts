import type { RubatoConfig } from "@rubato/config-core"

import { PLAN_GATED_AGENT_NAMES, type AgentDefinition } from "../../agents"
import { listTaskAgents } from "./categories"
import type { TaskAgentInfo } from "./types"

export const TASK_PROMPT_SNIPPET = "Start one child agent with exactly one of model or preset; use AgentSend to continue an existing child."

export const TASK_PROMPT_GUIDELINES: readonly string[] = [
  "Start one child agent using exactly one of `model` or `preset`. Omit `effort` normally; the configured model default applies. Set `effort` only when an explicit manual override is required.",
  "Spawns are asynchronous and return an agentId immediately; completion arrives as a notification. Do not wait on the child in this turn.",
  "Continue an existing child with AgentSend(agentId=\"st_...\", message=\"...\"); Agent always spawns.",
  "Use AgentOutput for one midpoint status or transcript peek; use AgentCancel to end a child.",
  "Pass summary (one line, <=80 chars) on every spawn: the user's footer/widget UI shows it instead of the raw prompt, so it should say WHAT was delegated.",
]

type DescriptionInput = {
  readonly rubatoConfig: RubatoConfig
  readonly agents: Readonly<Record<string, AgentDefinition>>
}

export function buildTaskToolDescription(input: DescriptionInput): string {
  const agents = listTaskAgents(input.agents)
  const plainAgents = agents.filter((agent) => !PLAN_GATED_AGENT_NAMES.has(agent.name))
  const gatedAgents = agents.filter((agent) => PLAN_GATED_AGENT_NAMES.has(agent.name))
  const hasPresetRoute = plainAgents.length > 0 || gatedAgents.length > 0
  const contract =
    "Start one child agent using exactly one of `model` or `preset`. Omit `effort` normally; the configured model default applies. Set `effort` only when an explicit manual override is required."
  return `${contract}

${renderTargetSection(hasPresetRoute, plainAgents, gatedAgents)}

Spawns are asynchronous and return an agentId immediately. Completion arrives as a notification.
Pass summary (one line, <=80 chars) so the footer/widget UI shows what was delegated.
AgentSend continues an existing child; Agent always spawns.
Use AgentOutput for status or a transcript peek; AgentCancel to end a child.
Prompts MUST be in English.`
}

function renderTargetSection(
  hasPresetRoute: boolean,
  plainAgents: readonly TaskAgentInfo[],
  gatedAgents: readonly TaskAgentInfo[],
): string {
  const modelLine =
    '`model` is a complete provider/model id from the live host registry. Missing models fail closed with model_unavailable; there is no fallback. CORRECT: Agent(model="xai/grok-4.6", prompt="...")'
  if (!hasPresetRoute) {
    return `${modelLine}
No presets are currently loaded; provide \`model\`.`
  }
  const presetNames = plainAgents.map((agent) => agent.name).join(", ")
  const presetLine =
    plainAgents.length === 0
      ? "`preset` invokes a loaded named agent."
      : `\`preset\` invokes a loaded named agent. Available presets: ${presetNames}. CORRECT: Agent(preset="${plainAgents[0]?.name ?? "explore"}", prompt="...")`
  const gatedLine =
    gatedAgents.length === 0
      ? ""
      : `\nPlan-gated presets (spawnable only after the user explicitly requests the ulw-plan workflow, a .rubato/plans/*.md plan artifact was touched in this session, and start-work was never invoked): ${gatedAgents.map((agent) => agent.name).join(", ")}`
  return `${modelLine}
${presetLine}${gatedLine}`
}
