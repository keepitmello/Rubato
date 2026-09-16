import * as z from "zod"
import { createParseMember } from "./member-parser"

export const MESSAGE_KINDS = [
  "message",
  "shutdown_request",
  "shutdown_approved",
  "shutdown_rejected",
  "announcement",
] as const

export const MEMBER_KINDS = ["owner", "verifier"] as const

export const TASK_STATUSES = ["pending", "claimed", "in_progress", "completed", "deleted"] as const

export const RUNTIME_STATUSES = [
  "creating",
  "active",
  "shutdown_requested",
  "deleting",
  "deleted",
  "failed",
  "orphaned",
] as const

const MemberBaseSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  cwd: z.string().optional(),
  worktreePath: z.string().optional(),
  task_summary: z.string().max(80).optional(),
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  subscriptions: z.array(z.string()).optional(),
  backendType: z.enum(["in-process", "tmux"]).default("in-process"),
  color: z.string().optional(),
  isActive: z.boolean().default(true),
}).strict()

const ModelBackedMemberSchema = MemberBaseSchema.extend({
  model: z.string().min(1),
  prompt: z.string().min(1),
})

export const OwnerMemberSchema = ModelBackedMemberSchema.extend({
  kind: z.literal("owner"),
})

export const VerifierMemberSchema = ModelBackedMemberSchema.extend({
  kind: z.literal("verifier"),
})

export const MemberSchema = z.discriminatedUnion("kind", [OwnerMemberSchema, VerifierMemberSchema])

const TeamReferenceSchema = z.object({
  path: z.string(),
  description: z.string().optional(),
}).strict()

export const TeamSpecSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  createdAt: z.number().int().positive().default(() => Date.now()),
  teamAllowedPaths: z.array(z.string()).optional(),
  sessionPermission: z.string().optional(),
  members: z.array(MemberSchema).min(1).max(8),
})

export const MessageSchema = z.object({
  version: z.literal(1),
  messageId: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  body: z.string().max(32 * 1024),
  summary: z.string().optional(),
  references: z.array(TeamReferenceSchema).optional(),
  timestamp: z.number().int().positive(),
  correlationId: z.string().uuid().optional(),
  color: z.string().optional(),
})

export const TaskSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(TASK_STATUSES),
  owner: z.string().optional(),
  blocks: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  claimedAt: z.number().int().positive().optional(),
})

const RuntimeStateMemberModelSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().optional(),
  reasoningEffort: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  maxTokens: z.number().optional(),
  thinking: z.object({
    type: z.enum(["enabled", "disabled"]),
    budgetTokens: z.number().int().positive().optional(),
  }).optional(),
}).strict()

const RuntimeStateMemberSchema = z.object({
  name: z.string(),
  kind: z.enum(MEMBER_KINDS),
  sessionId: z.string().optional(),
  tmuxPaneId: z.string().optional(),
  tmuxGridPaneId: z.string().optional(),
  model: RuntimeStateMemberModelSchema.optional(),
  status: z.enum(["pending", "running", "idle", "errored", "completed", "shutdown_approved"]),
  color: z.string().optional(),
  worktreePath: z.string().optional(),
  lastInjectedTurnMarker: z.string().optional(),
  pendingInjectedMessageIds: z.array(z.string()).default([]),
}).strict()

const RuntimeBoundsSchema = z.object({
  maxMembers: z.number().int().default(8),
  maxParallelMembers: z.number().int().default(4),
  maxMessagesPerRun: z.number().int().default(10000),
  maxWallClockMinutes: z.number().int().default(120),
  maxMemberTurns: z.number().int().default(500),
}).strict()

const ShutdownRequestSchema = z.object({
  memberId: z.string(),
  requesterName: z.string(),
  requestedAt: z.number().int().positive(),
  approvedAt: z.number().int().positive().optional(),
  rejectedReason: z.string().optional(),
  rejectedAt: z.number().int().positive().optional(),
}).strict()

const RuntimeStateTmuxLayoutSchema = z.object({
  ownedSession: z.boolean(),
  targetSessionId: z.string(),
  focusWindowId: z.string().optional(),
  gridWindowId: z.string().optional(),
  paneIds: z.array(z.string()).optional(),
}).strict()

export const RuntimeStateSchema = z.object({
  version: z.literal(1),
  teamRunId: z.string().uuid(),
  teamName: z.string(),
  specSource: z.enum(["project", "user"]),
  createdAt: z.number().int().positive(),
  status: z.enum(RUNTIME_STATUSES),
  leadSessionId: z.string().optional(),
  tmuxLayout: RuntimeStateTmuxLayoutSchema.optional(),
  members: z.array(RuntimeStateMemberSchema),
  shutdownRequests: z.array(ShutdownRequestSchema).default([]),
  bounds: RuntimeBoundsSchema,
})

const parseMemberBase = createParseMember(MemberSchema)

export function parseMember(input: unknown): Member {
  return parseMemberBase(input)
}

export type TeamSpec = z.infer<typeof TeamSpecSchema>
export type Member = z.infer<typeof MemberSchema>
export type OwnerMember = z.infer<typeof OwnerMemberSchema>
export type VerifierMember = z.infer<typeof VerifierMemberSchema>
export type Message = z.infer<typeof MessageSchema>
export type Task = z.infer<typeof TaskSchema>
export type RuntimeStateMember = z.infer<typeof RuntimeStateMemberSchema>
export type RuntimeState = z.infer<typeof RuntimeStateSchema>

export type ActiveTeamSummary = Readonly<
  Pick<RuntimeState, "teamRunId" | "teamName" | "status" | "leadSessionId"> & {
    memberCount: number
    scope: RuntimeState["specSource"]
  }
>
