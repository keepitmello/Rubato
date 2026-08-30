import * as z from "zod"

const RubatoTeamMemberBaseSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  cwd: z.string().optional(),
  worktreePath: z.string().optional(),
  subscriptions: z.array(z.string()).optional(),
  backendType: z.enum(["in-process", "tmux"]).default("in-process"),
  color: z.string().optional(),
  isActive: z.boolean().default(true),
}).strict()

export const RubatoTeamCategoryMemberSchema = RubatoTeamMemberBaseSchema.extend({
  kind: z.literal("category"),
  category: z.string().min(1),
  prompt: z.string().min(1),
})

export const RubatoTeamSubagentMemberSchema = RubatoTeamMemberBaseSchema.extend({
  kind: z.literal("subagent_type"),
  subagent_type: z.string().min(1),
  prompt: z.string().optional(),
})

export const RubatoTeamMemberSchema = z.discriminatedUnion("kind", [
  RubatoTeamCategoryMemberSchema,
  RubatoTeamSubagentMemberSchema,
])

const RubatoTeamSpecBaseSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  createdAt: z.number().int().positive().optional(),
  leadAgentId: z.string().optional(),
  teamAllowedPaths: z.array(z.string()).optional(),
  sessionPermission: z.string().optional(),
  members: z.array(RubatoTeamMemberSchema).min(1).max(8),
}).strict()

export const RubatoTeamSpecSchema = RubatoTeamSpecBaseSchema.superRefine((teamSpec, ctx) => {
  if (teamSpec.leadAgentId === undefined && teamSpec.members.length > 1) {
    ctx.addIssue({
      code: "custom",
      message: "leadAgentId required when a team has multiple members",
      path: ["leadAgentId"],
    })
  }
})

export const RubatoTeamSpecLayerSchema = RubatoTeamSpecBaseSchema.partial()

export const RubatoTeamsConfigSchema = z.record(z.string(), RubatoTeamSpecSchema)
export const RubatoTeamsConfigLayerSchema = z.record(z.string(), RubatoTeamSpecLayerSchema)

export type RubatoTeamMember = z.infer<typeof RubatoTeamMemberSchema>
export type RubatoTeamSpec = z.infer<typeof RubatoTeamSpecSchema>
export type RubatoTeamsConfig = z.infer<typeof RubatoTeamsConfigSchema>
