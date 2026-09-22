import { randomUUID } from "node:crypto"

import { defineTool, type AgentToolResult, type ToolDefinition } from "@code-yeongyu/senpi"
import type { TeamModeConfig } from "@rubato/team-core/config"
import { sendMessage } from "@rubato/team-core/team-mailbox"
import { Type, type Static } from "typebox"

import type { PersistedTaskEvent } from "../../store"
import { toolResult } from "../../tools/control/tool-result"
import { buildTeamMessage } from "../messaging/message"
import { TEAM_LEAD_SENTINEL } from "../normalize"

export const MemberTaskSendParams = Type.Object({
  to: Type.String({ description: "Recipient member name or lead." }),
  message: Type.String({ description: "Message body." }),
  summary: Type.Optional(Type.String({ description: "Optional short summary." })),
})

export type MemberTaskSendInput = Static<typeof MemberTaskSendParams>

export type MemberTaskSendDetails = {
  readonly kind: "team_message"
  readonly message_id: string
  readonly to: string
}

export type MemberTaskSendDeps = {
  readonly teamRunId: string
  readonly memberName: string
  readonly taskId: string
  readonly config: TeamModeConfig
  readonly members: readonly string[]
  readonly appendEvent?: (taskId: string, event: PersistedTaskEvent) => void
  readonly onSent?: () => void
  readonly now?: () => number
  readonly newMessageId?: () => string
  readonly isCurrentMember?: () => Promise<boolean>
}

export class UnknownMemberRecipientError extends Error {
  readonly recipient: string

  constructor(recipient: string, members: readonly string[]) {
    const valid = [...members, TEAM_LEAD_SENTINEL].sort().join(", ")
    super(`Unknown team recipient: ${recipient}. Valid recipients: ${valid}.`)
    this.name = "UnknownMemberRecipientError"
    this.recipient = recipient
  }
}

export async function runMemberTaskSend(
  deps: MemberTaskSendDeps,
  input: MemberTaskSendInput,
): Promise<AgentToolResult<MemberTaskSendDetails>> {
  const recipients = new Set([...deps.members, TEAM_LEAD_SENTINEL])
  if (!recipients.has(input.to)) throw new UnknownMemberRecipientError(input.to, deps.members)
  if (deps.isCurrentMember !== undefined && !(await deps.isCurrentMember())) {
    throw new Error("This execution is not the team's active member. If still starting, retry after activation; a replaced execution must not use the peer address.")
  }

  const message = buildTeamMessage({
    from: deps.memberName,
    to: input.to,
    body: input.message,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  }, {
    now: deps.now ?? Date.now,
    newMessageId: deps.newMessageId ?? randomUUID,
  })

  await sendMessage(message, deps.teamRunId, deps.config, {
    isLead: false,
    activeMembers: [...deps.members],
    leadRecipient: TEAM_LEAD_SENTINEL,
  })
  deps.appendEvent?.(deps.taskId, {
    type: "team_message_sent",
    payload: { message_id: message.messageId, from: message.from, to: message.to, kind: message.kind },
  })
  deps.onSent?.()
  // A member cannot see task records: say what storage establishes and no more.
  return toolResult(`Message enqueued to ${input.to} (id: ${message.messageId}). Stored in the recipient inbox; delivery and processing are unconfirmed until the recipient acts on it.`, {
    kind: "team_message",
    message_id: message.messageId,
    to: input.to,
  })
}

export function createMemberTaskSendTool(
  deps: MemberTaskSendDeps,
): ToolDefinition<typeof MemberTaskSendParams, MemberTaskSendDetails> {
  return defineTool({
    name: "team_send",
    label: "Team Send",
    description: "Send a durable message to a peer. Technical defects, counterevidence and rechecks go directly to the responsible owner, even when the lead proposed the method. Send the lead intent/criterion/authority changes or an unresolvable execution failure, not routine technical relay. Enqueued is not evidence of receipt or action.",
    parameters: MemberTaskSendParams,
    execute: (_toolCallId, params) => runMemberTaskSend(deps, params),
  })
}
