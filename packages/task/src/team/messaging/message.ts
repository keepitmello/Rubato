import { randomUUID } from "node:crypto"

import type { Message } from "@rubato/team-core/types"

import type { SendTeamMessageInput } from "./types"

export { buildEnvelope as buildPeerMessageEnvelope } from "@rubato/team-core/team-mailbox"

export type BuildTeamMessageOptions = {
  readonly now?: () => number
  readonly newMessageId?: () => string
}

/**
 * Builds a `kind: "message"` team-core `Message` for a team send. `messageId`/`timestamp` are injected
 * (defaulting to `randomUUID`/`Date.now`) so tests stay deterministic. `to` is passed through verbatim
 * (a member name, the "lead" sentinel, or "*"); `correlationId`/`references`/`color` are left unset.
 */
export function buildTeamMessage(
  input: Pick<SendTeamMessageInput, "from" | "to" | "body" | "summary">,
  options: BuildTeamMessageOptions = {},
): Message {
  const timestamp = (options.now ?? Date.now)()
  const messageId = (options.newMessageId ?? randomUUID)()
  const base: Message = {
    version: 1,
    messageId,
    from: input.from,
    to: input.to,
    kind: "message",
    body: input.body,
    timestamp,
  }
  return input.summary === undefined ? base : { ...base, summary: input.summary }
}
