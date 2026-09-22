import { listUnreadMessages } from "@rubato/team-core/team-mailbox"

import type { TeamCoreConfig } from "../runtime-config"

/**
 * How many messages sit unread in one team member's inbox. The team-batch wake reads it to tell a
 * parked member apart from a member that is about to be revived by queued mail: a batch with unread
 * mail is still moving, so it must not be reported as finished.
 */
export async function countUnreadTeamMessages(
  teamRunId: string,
  recipient: string,
  config: TeamCoreConfig,
): Promise<number> {
  return (await listUnreadMessages(teamRunId, recipient, config)).length
}
