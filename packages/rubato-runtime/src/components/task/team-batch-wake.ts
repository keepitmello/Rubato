import { DuplicateMessageIdError, isMessageConsumed, sendMessage } from "@rubato/team-core/team-mailbox"
import { loadRuntimeState } from "@rubato/team-core/team-state-store"
import {
  countUnreadTeamMessages,
  createTeamBatchWake,
  listTeamTasks,
  readMemberTaskMap,
  resolveTeamRuntimeDirs,
  type ActiveTeamSummary,
  type StateDirConfig,
  type TeamBatchWake,
  type TeamCoreConfig,
  type TeamTasklistContext,
} from "@rubato/task"

import type { TaskEngine } from "./engine"

export interface TeamBatchWakeDeps {
  readonly engine: TaskEngine
  readonly listTeams: () => Promise<readonly ActiveTeamSummary[]>
  readonly config: TeamCoreConfig
  readonly stateDir: StateDirConfig
  readonly sessionId: () => string | undefined
  readonly onError?: (error: unknown) => void
}

/**
 * Assemble the team-batch wake's ports from the live task store, the team mailbox and the run's board.
 * The decision and delivery live in `@rubato/task` (team-batch-wake) so they are testable without a
 * runtime; this file only reads real state.
 *
 * Only the LEAD's process runs this: `listTeams` is filtered to teams whose lead session is this
 * session, so a member process (which shares the same project state dir) never emits an aggregate.
 */
export function createRuntimeTeamBatchWake(deps: TeamBatchWakeDeps): TeamBatchWake {
  return createTeamBatchWake({
    activeTeams: async () => {
      const sessionId = deps.sessionId()
      if (sessionId === undefined) return []
      const teams = await deps.listTeams()
      const owned = teams.filter((team) => team.status === "active" && team.leadSessionId === sessionId)
      const resolved: { teamRunId: string; teamName: string; members: { name: string; taskId: string | undefined }[] }[] = []
      for (const team of owned) {
        const runtimeDir = resolveTeamRuntimeDirs(deps.stateDir, team.teamRunId).runtimeDir
        const map = await readMemberTaskMap(runtimeDir)
        const state = await loadRuntimeState(team.teamRunId, deps.config)
        resolved.push({
          teamRunId: team.teamRunId,
          teamName: team.teamName,
          // A missing map entry is unfinished, not permission to shrink "every member".
          members: state.members.map((member) => ({ name: member.name, taskId: map[member.name] })),
        })
      }
      return resolved
    },
    currentSessionId: deps.sessionId,
    loadRecord: (taskId) => deps.engine.manager.get(taskId) ?? null,
    boardState: async (teamRunId) => {
      const context: TeamTasklistContext = { teamRunId, config: deps.config }
      const items = await listTeamTasks(context)
      const live = items.filter((item) => item.status !== "deleted")
      return { items: live.length, open: live.filter((item) => item.status !== "completed").length }
    },
    pendingInbound: async (teamRunId, memberName) => {
      const unread = await countUnreadTeamMessages(teamRunId, memberName, deps.config)
      if (unread > 0) return unread
      const state = await loadRuntimeState(teamRunId, deps.config)
      const member = state.members.find((candidate) => candidate.name === memberName)
      if (member === undefined) throw new Error(`Team member disappeared: ${memberName}`)
      return member.pendingInjectedMessageIds.length
    },
    deliver: async (message, team, messageId) => {
      // Reuse the mailbox's durable reservation/ack path instead of inventing another notification
      // journal. A crash after publication but before markWoken safely reuses the same message id.
      if (await isMessageConsumed(team.teamRunId, "lead", messageId, deps.config)) return
      try {
        await sendMessage({
          version: 1,
          messageId,
          from: "runtime",
          to: "lead",
          kind: "message",
          body: message.content,
          timestamp: Date.now(),
        }, team.teamRunId, deps.config, {
          isLead: true,
          activeMembers: team.members.map((member) => member.name),
          leadRecipient: "lead",
        })
      } catch (error) {
        if (!(error instanceof DuplicateMessageIdError)) throw error
      }
    },
    markWoken: (taskId, epoch) => {
      deps.engine.store.mutate(taskId, (fresh) =>
        (fresh.notification.aggregate_woken_epoch ?? -1) >= epoch
          ? fresh
          : { ...fresh, notification: { ...fresh.notification, aggregate_woken_epoch: epoch } },
      )
    },
    stateDir: deps.engine.stateDir,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  })
}
