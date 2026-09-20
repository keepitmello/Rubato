import type { Message } from "@rubato/team-core/types"

import type { ResidencyState, TaskStatus } from "../../state"
import type { PersistedTaskEvent, StateDirConfig } from "../../store"
import type { MemberTaskMap } from "../member-map"
import type { TeamCoreConfig } from "../runtime-config"

export type SendTeamMessageInput = {
  readonly from: string
  // A member name, the reserved lead sentinel "lead", or "*" for a lead broadcast to every member.
  readonly to: string
  readonly body: string
  readonly summary?: string
}

export type MessagingEngineDeps = {
  readonly teamRunId: string
  readonly stateDir: StateDirConfig
  readonly config: TeamCoreConfig
  readonly activeMembers: readonly string[]
  readonly appendEvent?: (taskId: string, event: PersistedTaskEvent) => void
  /**
   * Optional task-record view of a member. When present, a member-direction send reports recipients
   * whose execution is suspended or gone, so "enqueued" is never mistaken for "will be read".
   */
  readonly inspectMember?: (taskId: string) => MemberExecutionView | undefined
  readonly now?: () => number
  readonly newMessageId?: () => string
}

export type MemberExecutionView = {
  readonly status: TaskStatus
  readonly residency_state: ResidencyState
  readonly killed?: boolean
}

/** A recipient whose inbox accepted the message but whose execution cannot read it right now. */
export type NotLiveRecipient = {
  readonly member: string
  readonly status: TaskStatus
  readonly residency_state: ResidencyState
  /** suspended: revives on the lead session's resume; disposed: no execution will read it. */
  readonly state: "suspended" | "disposed"
}

export type SendTeamMessageResult =
  | { readonly kind: "to_lead"; readonly messageId: string }
  | {
      readonly kind: "to_members"
      readonly messageId: string
      readonly recipients: readonly string[]
      readonly notLive?: readonly NotLiveRecipient[]
    }

export type { Message, MemberTaskMap }
