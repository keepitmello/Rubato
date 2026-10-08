import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Type, type Static } from "typebox"

import { SenpiShutdownError } from "../../team"
import { toolResult } from "../control"
import type { TeamToolDeps, TeamToolsService } from "./types"

export const TeamShutdownRequestParams = Type.Object({
  team_run_id: Type.String({ description: "Team run id (returned by team_create)." }),
  member: Type.String({ description: "Member to request shutdown for." }),
})

export const TeamApproveShutdownParams = Type.Object({
  team_run_id: Type.String({ description: "Team run id (returned by team_create)." }),
  member: Type.String({ description: "Member whose shutdown request to approve." }),
})

export const TeamRejectShutdownParams = Type.Object({
  team_run_id: Type.String({ description: "Team run id (returned by team_create)." }),
  member: Type.String({ description: "Member whose shutdown request to reject." }),
  reason: Type.String({ description: "Reason the member should keep running." }),
})

export type TeamShutdownRequestInput = Static<typeof TeamShutdownRequestParams>
export type TeamApproveShutdownInput = Static<typeof TeamApproveShutdownParams>
export type TeamRejectShutdownInput = Static<typeof TeamRejectShutdownParams>

export type ShutdownErrorView =
  | { readonly kind: "unknown_member"; readonly member: string; readonly reason: string }
  | { readonly kind: "no_pending_request"; readonly member: string; readonly reason: string }

export type TeamShutdownRequestDetails = { readonly kind: "requested"; readonly team_run_id: string; readonly member: string } | ShutdownErrorView
export type TeamApproveShutdownDetails = { readonly kind: "approved"; readonly team_run_id: string; readonly member: string } | ShutdownErrorView
export type TeamRejectShutdownDetails = { readonly kind: "rejected"; readonly team_run_id: string; readonly member: string; readonly reason: string } | ShutdownErrorView

// Maps the two lead-driven shutdown failures onto the shared error view; every other throw propagates.
function shutdownErrorView(error: unknown): ShutdownErrorView {
  if (error instanceof SenpiShutdownError) {
    return { kind: error.code, member: error.memberName, reason: error.message }
  }
  throw error
}

export async function runTeamShutdownRequest(service: TeamToolsService, params: TeamShutdownRequestInput): Promise<AgentToolResult<TeamShutdownRequestDetails>> {
  try {
    await service.requestShutdown(params.team_run_id, params.member)
    return toolResult(`Requested shutdown for '${params.member}' (team ${params.team_run_id}).`, { kind: "requested", team_run_id: params.team_run_id, member: params.member })
  } catch (error) {
    const view = shutdownErrorView(error)
    return toolResult(view.reason, view)
  }
}

export async function runTeamApproveShutdown(service: TeamToolsService, params: TeamApproveShutdownInput): Promise<AgentToolResult<TeamApproveShutdownDetails>> {
  try {
    await service.approveShutdown(params.team_run_id, params.member)
    return toolResult(`Approved shutdown for '${params.member}' (team ${params.team_run_id}).`, { kind: "approved", team_run_id: params.team_run_id, member: params.member })
  } catch (error) {
    const view = shutdownErrorView(error)
    return toolResult(view.reason, view)
  }
}

export async function runTeamRejectShutdown(service: TeamToolsService, params: TeamRejectShutdownInput): Promise<AgentToolResult<TeamRejectShutdownDetails>> {
  try {
    await service.rejectShutdown(params.team_run_id, params.member, params.reason)
    return toolResult(`Rejected shutdown for '${params.member}' (team ${params.team_run_id}): ${params.reason.replace(/\s+/g, " ").trim().slice(0, 160)}`, { kind: "rejected", team_run_id: params.team_run_id, member: params.member, reason: params.reason })
  } catch (error) {
    const view = shutdownErrorView(error)
    return toolResult(view.reason, view)
  }
}

export function createTeamShutdownRequestTool(deps: TeamToolDeps): ToolDefinition {
  return {
    name: "team_shutdown_request",
    label: "Team Shutdown Request",
    description:
      "Remove a member from a team, step 1 of 2: notify the member that it is leaving. Then team_approve_shutdown stops it and takes it off the roster. Before removing, have it persist its handoff, and complete or delete its open board items (there is no reassignment; create fresh items for a successor). Lead-only team protocol; distinct from AgentCancel, which stops a spawned Agent session.",
    parameters: TeamShutdownRequestParams,
    execute: (_toolCallId: string, params: TeamShutdownRequestInput) => runTeamShutdownRequest(deps.service, params),
  }
}

export function createTeamApproveShutdownTool(deps: TeamToolDeps): ToolDefinition {
  return {
    name: "team_approve_shutdown",
    label: "Team Approve Shutdown",
    description: "Approve a pending team member shutdown request (step 2 of removing a member): its execution stops, peers can no longer message it, and the team's completion wake no longer waits for it. Its name stays taken. Lead-only team protocol.",
    parameters: TeamApproveShutdownParams,
    execute: (_toolCallId: string, params: TeamApproveShutdownInput) => runTeamApproveShutdown(deps.service, params),
  }
}

export function createTeamRejectShutdownTool(deps: TeamToolDeps): ToolDefinition {
  return {
    name: "team_reject_shutdown",
    label: "Team Reject Shutdown",
    description: "Reject a pending team member shutdown request. Reason is required. Lead-only team protocol.",
    parameters: TeamRejectShutdownParams,
    execute: (_toolCallId: string, params: TeamRejectShutdownInput) => runTeamRejectShutdown(deps.service, params),
  }
}
