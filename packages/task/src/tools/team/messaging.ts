import type { AgentToolResult, ToolDefinition } from "@code-yeongyu/senpi"
import { Type, type Static } from "typebox"

import { TEAM_LEAD_SENTINEL } from "../../team"
import { toolResult } from "../control"
import { classifyMailboxError, type MailboxErrorKind } from "./classify-error"
import type { TeamToolDeps, TeamToolsService } from "./types"

export type LeadDeliveryView = "enqueued"
export type MemberDeliveryOutcome = "enqueued"
export type TeamSendMemberView = { readonly member: string; readonly outcome: MemberDeliveryOutcome }

export type TeamSendNotLive = {
  readonly member: string
  readonly status: string
  readonly residency_state: string
  readonly state: "suspended" | "disposed"
}

export type TeamSendDetails =
  | { readonly kind: "to_lead"; readonly message_id: string }
  | {
      readonly kind: "to_members"
      readonly message_id: string
      readonly recipients: readonly string[]
      readonly not_live?: readonly TeamSendNotLive[]
    }
  | { readonly kind: MailboxErrorKind; readonly to: string; readonly reason: string }

export type TeamSendInput = { readonly to: string; readonly body: string; readonly summary?: string }

export const TeamSendParams = Type.Object({
  team_run_id: Type.String({ description: "Team run id (returned by team_create)." }),
  to: Type.String({ description: "Recipient member name, 'lead', or '*' for a lead-only broadcast." }),
  message: Type.String({ description: "Durable mailbox message body." }),
  summary: Type.Optional(Type.String({ description: "Optional short summary." })),
})

export type TeamSendToolInput = Static<typeof TeamSendParams>

const SEND_DESCRIPTION = [
  "Send a durable team mailbox message to a member, the lead, or '*' (lead-only broadcast).",
  "This is team mail, not an Agent session: use AgentSend to continue a spawned Agent.",
].join(" ")

export async function runTeamSend(
  service: TeamToolsService,
  teamRunId: string,
  from: string,
  input: TeamSendInput,
): Promise<AgentToolResult<TeamSendDetails>> {
  try {
    const result = await service.sendMessage(teamRunId, {
      from,
      to: input.to,
      body: input.body,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
    })
    switch (result.kind) {
      case "to_lead":
        return toolResult(`Message enqueued to lead (id: ${result.messageId}).`, { kind: "to_lead", message_id: result.messageId })
      case "to_members": {
        const notLive = result.notLive ?? []
        const text = [
          `Message enqueued to ${result.recipients.length} recipient(s): ${result.recipients.join(", ")} (id: ${result.messageId}).`,
          ...notLive.map(describeNotLive),
        ].join("\n")
        return toolResult(text, {
          kind: "to_members",
          message_id: result.messageId,
          recipients: result.recipients,
          ...(notLive.length > 0 ? { not_live: notLive } : {}),
        })
      }
      default:
        return assertNever(result)
    }
  } catch (error) {
    const mailbox = classifyMailboxError(error)
    if (mailbox !== undefined) {
      const reason = error instanceof Error ? error.message : String(error)
      return toolResult(reason, { kind: mailbox, to: input.to, reason })
    }
    throw error
  }
}

/**
 * Acceptance into a durable inbox is not execution. Describe the observed state at send time
 * without predicting the future: storage succeeded, delivery and resumed work are unconfirmed.
 */
function describeNotLive(entry: TeamSendNotLive): string {
  const state = `Stored in ${entry.member}'s inbox. Last known execution state: ${entry.status}/${entry.residency_state}.`
  return entry.state === "suspended"
    ? `${state} Delivery remains pending; the member must be successfully resumed before it can process the message.`
    : `${state} No live execution is currently available; delivery and resumed work are unconfirmed. Sending did not restart the task. Check the current task state before reporting progress.`
}

export function createTeamSendTool(deps: TeamToolDeps): ToolDefinition {
  return {
    name: "team_send",
    label: "Team Send",
    description: SEND_DESCRIPTION,
    parameters: TeamSendParams,
    execute: (_toolCallId: string, params: TeamSendToolInput) =>
      runTeamSend(deps.service, params.team_run_id, TEAM_LEAD_SENTINEL, {
        to: params.to,
        body: params.message,
        ...(params.summary !== undefined ? { summary: params.summary } : {}),
      }),
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected team send result: ${JSON.stringify(value)}`)
}
