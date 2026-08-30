import { Type, type Static } from "typebox"

import { TASK_SUMMARY_MAX_LENGTH } from "../../task-summary"

export const MAX_TASK_BATCH_ITEMS = 16

export const TaskToolParams = Type.Object({
  prompt: Type.Optional(
    Type.String({ description: "The instruction for the child task. MUST be written in English. Mutually exclusive with tasks; provide exactly one of prompt or tasks." }),
  ),
  task_summary: Type.Optional(
    Type.String({
      maxLength: TASK_SUMMARY_MAX_LENGTH,
      description: "One-line summary of the delegated work, shown to the user in the task footer/widget UI instead of the raw prompt. Keep it within 80 chars; longer values are force-truncated.",
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "Short human label for this task, shown in status views." }),
  ),
  category: Type.Optional(
    Type.String({ description: "Optional category preset. Mutually exclusive with subagent_type; omit when model directly selects the child." }),
  ),
  subagent_type: Type.Optional(
    Type.String({ description: "Optional named agent persona. Mutually exclusive with category; omit when model directly selects the child." }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({ description: "true (default) returns a child task id immediately and delivers completion as a notification; false waits and returns the final response." }),
  ),
  name: Type.Optional(Type.String({ description: "Optional stable name for this task within the current session; must be unique within the session." })),
  model: Type.Optional(Type.String({ description: "Exact model id from the current session catalog. A model alone is a complete target; with category or subagent_type it overrides that preset's model." })),
  load_skills: Type.Optional(
    Type.Array(Type.String(), {
      description: "Skill names whose SKILL.md content is prepended to the child prompt. Defaults to [].",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        prompt: Type.String({ description: "The instruction for this child task. MUST be written in English." }),
        task_summary: Type.Optional(
          Type.String({
            maxLength: TASK_SUMMARY_MAX_LENGTH,
            description: "One-line summary of this task's delegated work, shown in the task footer/widget UI. Longer values are force-truncated to 80 chars.",
          }),
        ),
        description: Type.Optional(Type.String({ description: "Short human label for this task." })),
        category: Type.Optional(Type.String({ description: "Optional category preset for this task." })),
        subagent_type: Type.Optional(Type.String({ description: "Optional named agent persona for this task." })),
        name: Type.Optional(Type.String({ description: "Optional stable name for this task." })),
        model: Type.Optional(Type.String({ description: "Exact model id from the current session catalog; a complete target by itself." })),
        load_skills: Type.Optional(Type.Array(Type.String(), { description: "Skills loaded for this task." })),
      }),
      {
        maxItems: MAX_TASK_BATCH_ITEMS,
        description: "Batch of up to 16 child tasks to spawn in one call. Empty provider padding is normalized before validation. Mutually exclusive with prompt; top-level category/subagent_type/model/load_skills are inherited by items that omit them.",
      },
    ),
  ),
})

export type TaskToolParamsStatic = Static<typeof TaskToolParams>
