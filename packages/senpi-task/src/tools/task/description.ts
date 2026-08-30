import type { RubatoConfig } from "@rubato/config-core"

import { PLAN_GATED_AGENT_NAMES, type AgentDefinition } from "../../agents"
import { CATEGORY_CALLER_GUIDANCE } from "../../category"
import { listTaskAgents, listTaskCategories } from "./categories"
import type { TaskCategoryInfo } from "./types"

export const TASK_PROMPT_SNIPPET = "Spawn one child or fan out a batch; use task_send to continue an existing child."

export const TASK_PROMPT_GUIDELINES: readonly string[] = [
  "Spawns run in the background by default and return a task id immediately; pass run_in_background=false for a short synchronous dependency that blocks every useful action in the current turn.",
  "Prefer a semantic category when one matches the work; the harness resolves its live provider, admission, and fallback chain. Use an exact model when provider/model identity itself is the requirement.",
  "Continue an existing child with task_send(to=\"st_...\", message=\"...\"); task always spawns.",
  "Use task_output for one midpoint status or transcript peek; use task_cancel to end a child.",
  "Pass task_summary (one line, <=80 chars) on every spawn: the user's footer/widget UI shows it instead of the raw prompt, so it should say WHAT was delegated.",
]

type DescriptionInput = {
  readonly rubatoConfig: RubatoConfig
  readonly agents: Readonly<Record<string, AgentDefinition>>
}

function renderCategoryList(entries: readonly TaskCategoryInfo[]): string {
  if (entries.length === 0) return "  (none configured)"
  return entries.map((entry) => {
    const categoryLine = entry.description ? `  - ${entry.name}: ${entry.description}` : `  - ${entry.name}`
    const callerGuidance = CATEGORY_CALLER_GUIDANCE[entry.name]?.replaceAll("\n", "\n    ")
    return callerGuidance ? `${categoryLine}\n    ${callerGuidance}` : categoryLine
  }).join("\n")
}

export function buildTaskToolDescription(input: DescriptionInput): string {
  const categories = listTaskCategories(input.rubatoConfig)
  const agents = listTaskAgents(input.agents)
  const plainAgents = agents.filter((agent) => !PLAN_GATED_AGENT_NAMES.has(agent.name))
  const gatedAgents = agents.filter((agent) => PLAN_GATED_AGENT_NAMES.has(agent.name))
  // With zero loaded agents, subagent_type is a dead rail: every spawn naming one fails at
  // validateTaskTarget. Advertising the parameter in that state invites the model to invent an
  // agent name, so the whole route is omitted instead of being rendered with a placeholder.
  const hasAgentRoute = plainAgents.length > 0 || gatedAgents.length > 0
  const agentNames = plainAgents.map((agent) => agent.name).join(", ")
  const plainAgentLine =
    plainAgents.length === 0
      ? ""
      : `\n- subagent_type invokes a loaded agent directly. Available agents: ${agentNames}`
  const gatedLine =
    gatedAgents.length === 0
      ? ""
      : `${plainAgents.length === 0 ? "\n- subagent_type invokes a loaded agent directly." : ""}\n  Plan-gated agents (spawnable only after the user explicitly requests the ulw-plan workflow, a .rubato/plans/*.md plan artifact was touched in this session, and start-work was never invoked): ${gatedAgents.map((agent) => agent.name).join(", ")}`
  const targetRule = hasAgentRoute
    ? "Each spawn MUST provide a model, category, or subagent_type after inheritance. category and subagent_type are mutually exclusive."
    : "Each spawn MUST provide a model or category after inheritance."
  const modelNote = `category is the default semantic target when one matches the work; the harness resolves its live provider and runtime fallback chain.
  CORRECT: task(category="grok", prompt="...")
  model is an explicit override for work that requires a specific provider/model identity: task(model="kiro/claude-opus-5", prompt="...").${hasAgentRoute ? "\n  subagent_type invokes a loaded agent persona and is separate from semantic category routing." : ""}`
  const batchLine = "- Batch: tasks (1-16 items); top-level category, model, subagent type, and skills are inherited when an item omits them."
  return `Spawn one child task or fan out a batch.

Choose exactly one input form:
- Single: prompt
${batchLine}

${targetRule}

- category is a semantic routing target. Available categories:
${renderCategoryList(categories)}${plainAgentLine}${gatedLine}

Blank provider padding is normalized automatically; do not add filler values.
load_skills prepends named skills. run_in_background defaults to true: the spawn returns task ids immediately and completion arrives as a notification. Pass run_in_background=false to block this turn until the child finishes.
${modelNote}
task_send continues an existing child; task always spawns.
Prompts MUST be in English.`
}
