import { Type, type Static } from "typebox"

import { AGENT_EFFORTS } from "@rubato/agent-core"

import { TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"

export const TaskToolEffort = Type.Union(
  [
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
    Type.Literal("max"),
  ],
  {
    description:
      "Manual effort override only. Omit normally; the configured model default applies. Set effort only when an explicit manual override is required.",
  },
)

export type TaskToolEffort = (typeof AGENT_EFFORTS)[number]

export const TaskToolParams = Type.Object({
  prompt: Type.String({ description: "The instruction for the child agent. MUST be written in English." }),
  model: Type.Optional(
    Type.String({
      description:
        "Complete provider/model id from the live host registry. Exactly one of model or preset is required. A missing model fails closed with no fallback.",
    }),
  ),
  preset: Type.Optional(
    Type.String({
      description:
        "Named agent persona from the loaded agent set. Exactly one of model or preset is required. Cannot be combined with model.",
    }),
  ),
  effort: Type.Optional(TaskToolEffort),
  summary: Type.Optional(
    Type.String({
      maxLength: TASK_SUMMARY_MAX_LENGTH,
      description:
        "One-line summary of the delegated work, shown to the user in the task footer/widget UI instead of the raw prompt. Keep it within 80 chars; longer values are force-truncated.",
    }),
  ),
})

export type TaskToolParamsStatic = Static<typeof TaskToolParams>
