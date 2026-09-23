import { Type, type Static } from "typebox"

import { AGENT_EFFORTS } from "@rubato/agent-core"
import { catalogSlugs } from "@rubato/model-core"

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

type AvailableModels = readonly string[] | (() => readonly string[])

/**
 * The model enum for a tool schema, stable for the life of the tool.
 *
 * Tool schemas head every provider's cached prefix, and the live registry churns: Cursor
 * discovery lands after the first request, the auth pool re-registers `-sub` rows, a reload
 * briefly reports nothing. Each change rewrote the tools and missed the whole cache (sessions
 * 2026-09-16..23: every session's second request, plus ~50 mid-session flips). So the enum
 * starts from the product catalog of every provider the registry has shown, and only grows.
 * Availability is still checked live when the tool runs; a listed model that is gone fails
 * closed there.
 */
export function stableModelEnum(availableModels: () => readonly string[]): () => string[] | undefined {
  const seen = new Set<string>()
  const providers = new Set<string>()
  let snapshot: string[] | undefined
  return () => {
    const before = seen.size
    for (const model of availableModels()) {
      seen.add(model)
      const slash = model.indexOf("/")
      if (slash > 0) providers.add(model.slice(0, slash))
    }
    for (const slug of catalogSlugs()) {
      if (providers.has(slug.slice(0, slug.indexOf("/")))) seen.add(slug)
    }
    if (snapshot === undefined || seen.size !== before) snapshot = seen.size === 0 ? undefined : [...seen].sort()
    return snapshot
  }
}

function modelSchema(availableModels: AvailableModels) {
  const schema = Type.String({
    description:
      "Complete provider/model id from the live host registry. Exactly one of model or preset is required. A missing model fails closed with no fallback.",
  })
  if (typeof availableModels !== "function" && availableModels.length > 0) {
    Object.defineProperty(schema, "enum", { enumerable: true, value: [...availableModels].sort() })
  }
  return schema
}

export function buildTaskToolParams(availableModels: AvailableModels = []) {
  const schema = Type.Object({
    prompt: Type.String({ description: "The instruction for the child agent. MUST be written in English." }),
    model: Type.Optional(modelSchema(availableModels)),
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
    fast: Type.Optional(
      Type.Boolean({
        description:
          "Request the provider priority service tier for this child. Omit normally; the child then keeps today's tier behavior.",
      }),
    ),
  })
  if (typeof availableModels === "function") {
    Object.defineProperty(schema.properties.model, "enum", {
      enumerable: true,
      get: stableModelEnum(availableModels),
    })
  }
  return schema
}

export const TaskToolParams = buildTaskToolParams()

export type TaskToolParamsStatic = Static<typeof TaskToolParams>
