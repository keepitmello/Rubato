import type { ActiveTeamSummary } from "@rubato/task"
import type { Task } from "@rubato/team-core/types"

import type { ComponentLogger, SenpiExtensionAPI } from "../../extension/types"

export const TEAM_BOARD_UPDATED_EVENT = "rubato.team.board.updated"
export const MAX_BOARD_DESCRIPTION_CHARS = 4_000

type BoardTaskStatus = Exclude<Task["status"], "deleted">

export type TeamBoardTaskSnapshot = {
  readonly id: string
  readonly subject: string
  readonly description: string
  readonly description_truncated?: true
  readonly status: BoardTaskStatus
  readonly owner?: string
  readonly blocked_by: readonly string[]
  readonly updated_at: string
}

export type TeamBoardSnapshot = {
  readonly team_run_id: string
  readonly team_name: string
  readonly tasks: readonly TeamBoardTaskSnapshot[]
}

export type TeamBoardRpcBridgeDeps = {
  readonly pi: Pick<SenpiExtensionAPI, "rpc">
  readonly sessionId: () => string | undefined
  readonly listTeams: () => Promise<readonly ActiveTeamSummary[]>
  readonly listTasks: (teamRunId: string) => Promise<readonly Task[]>
  readonly logger?: Pick<ComponentLogger, "warn">
}

export interface TeamBoardRpcBridge {
  attach(): void
  /** A store mutation or other edge that can create, delete or change a team: always re-reads. */
  schedule(): void
  /**
   * The periodic lead-poller tick. Member board writes happen in other processes and leave no
   * signal in this one, so the board is re-read on the tick - but only while this session leads a
   * team; team creation/deletion itself arrives through `schedule` (member task records change).
   */
  tick(): void
  /** Resolves once no refresh is in flight (tests, shutdown ordering). */
  idle(): Promise<void>
  detach(): void
  dispose(): void
}

// Emits `rubato.team.board.updated`: the boards of every team the active session leads. Reads are
// serialized: a request during an in-flight read marks one re-run instead of starting another, so a
// burst of store mutations costs at most two reads. Identical data is never re-emitted.
export function createTeamBoardRpcBridge(deps: TeamBoardRpcBridgeDeps): TeamBoardRpcBridge {
  let activeSessionId: string | undefined
  let generation = 0
  let lastSnapshot: string | undefined
  let ownsTeams = false
  let inFlight: Promise<void> | undefined
  let rerun = false
  let disposed = false

  const canEmit = () => !disposed && activeSessionId !== undefined && deps.pi.rpc?.emit !== undefined

  const refreshOnce = async (): Promise<void> => {
    const sessionId = activeSessionId
    const startedGeneration = generation
    if (sessionId === undefined) return
    const stale = () => disposed || generation !== startedGeneration
    let teams: TeamBoardSnapshot[]
    try {
      const owned = (await deps.listTeams())
        .filter((team) => team.leadSessionId === sessionId)
        .sort(compareTeams)
      teams = []
      for (const team of owned) {
        if (stale()) return
        teams.push({
          team_run_id: team.teamRunId,
          team_name: team.teamName,
          tasks: [...await deps.listTasks(team.teamRunId)].sort(compareTaskIds).flatMap(boardTaskSnapshot),
        })
      }
    } catch (error) {
      deps.logger?.warn("rubato-runtime team board snapshot failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (stale()) return
    ownsTeams = teams.length > 0
    // Nothing was ever shown for this session: an empty board list is not news.
    if (teams.length === 0 && lastSnapshot === undefined) return
    const data = { parent_session_id: sessionId, teams }
    const fingerprint = JSON.stringify(data)
    if (fingerprint === lastSnapshot) return
    lastSnapshot = fingerprint
    deps.pi.rpc?.emit(TEAM_BOARD_UPDATED_EVENT, data)
  }

  const schedule = (): void => {
    if (!canEmit()) return
    if (inFlight !== undefined) {
      rerun = true
      return
    }
    inFlight = (async () => {
      do {
        rerun = false
        await refreshOnce()
      } while (rerun && canEmit())
    })().finally(() => {
      inFlight = undefined
    })
  }

  const detach = (): void => {
    generation += 1
    activeSessionId = undefined
    lastSnapshot = undefined
    ownsTeams = false
    rerun = false
  }

  return {
    attach() {
      if (disposed) return
      detach()
      activeSessionId = deps.sessionId()
      schedule()
    },
    schedule,
    tick() {
      if (ownsTeams) schedule()
    },
    async idle() {
      while (inFlight !== undefined) await inFlight
    },
    detach,
    dispose() {
      if (disposed) return
      disposed = true
      detach()
    },
  }
}

function compareTeams(left: ActiveTeamSummary, right: ActiveTeamSummary): number {
  return left.teamName.localeCompare(right.teamName) || left.teamRunId.localeCompare(right.teamRunId)
}

function compareTaskIds(left: Task, right: Task): number {
  return Number.parseInt(left.id, 10) - Number.parseInt(right.id, 10) || left.id.localeCompare(right.id)
}

function boardTaskSnapshot(task: Task): TeamBoardTaskSnapshot[] {
  if (task.status === "deleted") return []
  const truncated = task.description.length > MAX_BOARD_DESCRIPTION_CHARS
  return [{
    id: task.id,
    subject: task.subject,
    description: truncated ? task.description.slice(0, MAX_BOARD_DESCRIPTION_CHARS) : task.description,
    ...(truncated ? { description_truncated: true as const } : {}),
    status: task.status,
    ...(task.owner !== undefined ? { owner: task.owner } : {}),
    blocked_by: [...task.blockedBy],
    updated_at: new Date(task.updatedAt).toISOString(),
  }]
}
