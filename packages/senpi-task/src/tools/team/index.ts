import type { ToolDefinition } from "@code-yeongyu/senpi"

import { createTeamCreateTool, createTeamDeleteTool } from "./lifecycle"
import { createTeamSendTool } from "./messaging"
import {
  createTeamApproveShutdownTool,
  createTeamRejectShutdownTool,
  createTeamShutdownRequestTool,
} from "./shutdown"
import { createTeamTaskCreateTool, createTeamTaskGetTool, createTeamTaskListTool, createTeamTaskUpdateTool } from "./tasks"
import type { LeadTeamToolDeps, TeamToolDeps } from "./types"

export type { ActiveTeamSummary, CreateTeamTaskServiceInput, CreateTeamToolInput, LeadTeamToolDeps, TeamToolDeps, TeamToolsService, TeamTaskStatus, UpdateTeamTaskServiceInput } from "./types"
export { classifyMailboxError, isMissingStateError } from "./classify-error"
export type { MailboxErrorKind } from "./classify-error"
export {
  TeamCreateParams,
  TeamDeleteParams,
  createTeamCreateTool,
  createTeamDeleteTool,
  runTeamCreate,
  runTeamDelete,
} from "./lifecycle"
export type { TeamCreateDetails, TeamCreateInput, TeamCreateMemberView, TeamDeleteDetails, TeamDeleteInput } from "./lifecycle"
export { TeamSendParams, createTeamSendTool, runTeamSend } from "./messaging"
export type {
  LeadDeliveryView,
  MemberDeliveryOutcome,
  TeamSendDetails,
  TeamSendInput,
  TeamSendMemberView,
  TeamSendToolInput,
} from "./messaging"
export {
  TeamTaskCreateParams,
  TeamTaskGetParams,
  TeamTaskListParams,
  TeamTaskUpdateParams,
  createTeamTaskCreateTool,
  createTeamTaskGetTool,
  createTeamTaskListTool,
  createTeamTaskUpdateTool,
  runTeamTaskCreate,
  runTeamTaskGet,
  runTeamTaskList,
  runTeamTaskUpdate,
} from "./tasks"
export type {
  TeamTaskCreateDetails,
  TeamTaskCreateInput,
  TeamTaskGetDetails,
  TeamTaskGetInput,
  TeamTaskListDetails,
  TeamTaskListInput,
  TeamTaskUpdateDetails,
  TeamTaskUpdateInput,
} from "./tasks"
export {
  TeamApproveShutdownParams,
  TeamRejectShutdownParams,
  TeamShutdownRequestParams,
  createTeamApproveShutdownTool,
  createTeamRejectShutdownTool,
  createTeamShutdownRequestTool,
  runTeamApproveShutdown,
  runTeamRejectShutdown,
  runTeamShutdownRequest,
} from "./shutdown"
export type {
  ShutdownErrorView,
  TeamApproveShutdownDetails,
  TeamApproveShutdownInput,
  TeamRejectShutdownDetails,
  TeamRejectShutdownInput,
  TeamShutdownRequestDetails,
  TeamShutdownRequestInput,
} from "./shutdown"

export function buildLeadTeamTools(deps: LeadTeamToolDeps): ToolDefinition[] {
  return [
    createTeamCreateTool(deps),
    createTeamDeleteTool(deps),
    createTeamSendTool(deps),
    createTeamShutdownRequestTool(deps),
    createTeamApproveShutdownTool(deps),
    createTeamRejectShutdownTool(deps),
    createTeamTaskCreateTool(deps),
    createTeamTaskGetTool(deps),
    createTeamTaskListTool(deps),
    createTeamTaskUpdateTool(deps),
  ]
}

export function buildMemberTeamBoardTools(deps: TeamToolDeps): ToolDefinition[] {
  return [
    createTeamTaskCreateTool(deps),
    createTeamTaskListTool(deps),
    createTeamTaskGetTool(deps),
    createTeamTaskUpdateTool(deps),
  ]
}
