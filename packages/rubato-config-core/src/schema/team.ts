import * as z from "zod"

const RubatoTeamMemberBaseSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  cwd: z.string().optional(),
  worktreePath: z.string().optional(),
  task_summary: z.string().max(80).optional(),
  subscriptions: z.array(z.string()).optional(),
  backendType: z.enum(["in-process", "tmux"]).default("in-process"),
  color: z.string().optional(),
  isActive: z.boolean().default(true),
}).strict()

export const RubatoTeamMemberSchema = RubatoTeamMemberBaseSchema.extend({
  kind: z.enum(["owner", "verifier"]),
  model: z.string().min(1),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  prompt: z.string().min(1),
})

const RubatoTeamSpecBaseSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  createdAt: z.number().int().positive().optional(),
  teamAllowedPaths: z.array(z.string()).optional(),
  sessionPermission: z.string().optional(),
  members: z.array(RubatoTeamMemberSchema).min(1).max(8),
}).strict()

export const RubatoTeamSpecSchema = RubatoTeamSpecBaseSchema

export const RubatoTeamSpecLayerSchema = RubatoTeamSpecBaseSchema.partial()

export const RubatoTeamsConfigSchema = z.record(z.string(), RubatoTeamSpecSchema)
export const RubatoTeamsConfigLayerSchema = z.record(z.string(), RubatoTeamSpecLayerSchema)

export type RubatoTeamMember = z.infer<typeof RubatoTeamMemberSchema>
export type RubatoTeamSpec = z.infer<typeof RubatoTeamSpecSchema>
export type RubatoTeamsConfig = z.infer<typeof RubatoTeamsConfigSchema>
