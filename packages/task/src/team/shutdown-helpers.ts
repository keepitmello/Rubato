import type { RuntimeState, RuntimeStateMember } from "@rubato/team-core/types"

/**
 * Member statuses from which a member may be torn down during team deletion (Rubato
 * `shutdown-helpers.ts:6-10` parity): a member that has finished, been approved for shutdown, or
 * errored out is safe to remove. Any other status means the member is still live.
 */
export const DELETABLE_MEMBER_STATUSES: ReadonlySet<RuntimeStateMember["status"]> = new Set([
  "completed",
  "shutdown_approved",
  "errored",
])

export function isMemberDeletable(status: RuntimeStateMember["status"]): boolean {
  return DELETABLE_MEMBER_STATUSES.has(status)
}

export function findRuntimeMember(state: RuntimeState, memberName: string): RuntimeStateMember | undefined {
  return state.members.find((candidate) => candidate.name === memberName)
}

type RosterState = Pick<RuntimeState, "members" | "shutdownRequests">

/**
 * A removed member keeps its record, so removal is read from the approved shutdown request: approval
 * leaves a completed/errored member's status as it was, and a status refresh rewrites it from the
 * task record. An approved request is never reopened.
 */
export function isMemberRemoved(state: RosterState, memberName: string): boolean {
  return state.members.some((member) => member.name === memberName && member.status === "shutdown_approved")
    || state.shutdownRequests.some((request) => request.memberId === memberName && request.approvedAt !== undefined)
}

/** Members still on the team. */
export function liveMemberNames(state: RosterState): string[] {
  return state.members.filter((member) => !isMemberRemoved(state, member.name)).map((member) => member.name)
}

/**
 * Index of the most recent shutdown request for a member, scanning newest-first so a fresh request
 * that follows a resolved (approved/rejected) one wins. Returns -1 when the member has no request.
 */
export function findLatestShutdownRequestIndex(state: RuntimeState, memberName: string): number {
  for (let index = state.shutdownRequests.length - 1; index >= 0; index -= 1) {
    if (state.shutdownRequests[index]?.memberId === memberName) return index
  }
  return -1
}

export function isUnresolvedRequest(request: RuntimeState["shutdownRequests"][number] | undefined): boolean {
  return request !== undefined && request.approvedAt === undefined && request.rejectedAt === undefined
}
