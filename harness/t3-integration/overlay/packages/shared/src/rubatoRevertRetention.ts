import { compareDateTimeStrings } from "./dateTime.ts";

export interface RevertMessageRef {
  readonly id: string;
  readonly role: string;
  readonly turnId: string | null;
  readonly createdAt: string;
}

export interface RetainedUserMessages {
  /** User messages whose turn survives the revert. */
  readonly retained: ReadonlySet<string>;
  /** User messages whose turn is known, kept or not. The rest fall back to counting. */
  readonly decided: ReadonlySet<string>;
  /** Surviving turns that no user message started, such as a turn a finished child woke. */
  readonly promptlessTurns: number;
}

/**
 * A user message is stored without a turn. It belongs to the turn of the reply that
 * follows it: the prompt to the turn it started, a steered message to the turn it
 * joined. This is the same pairing the timeline uses to offer a rewind from a message.
 * Counting instead (keep as many user messages as turns) dropped a steered message
 * from a kept turn and kept the rewound prompt whenever a turn had no user message,
 * which left the client waiting for a rewind that never showed.
 */
export function retainUserMessagesAfterRevert(
  messages: ReadonlyArray<RevertMessageRef>,
  retainedTurnIds: ReadonlySet<string>,
): RetainedUserMessages {
  const ordered = messages
    .slice()
    .sort(
      (left, right) =>
        compareDateTimeStrings(left.createdAt, right.createdAt) || left.id.localeCompare(right.id),
    );
  const retained = new Set<string>();
  const decided = new Set<string>();
  const promptedTurns = new Set<string>();
  const turnsWithMessages = new Set<string>();
  let waiting: string[] = [];
  for (const message of ordered) {
    if (message.role === "user" && message.turnId === null) {
      waiting.push(message.id);
      continue;
    }
    if (message.role === "system") continue;
    if (message.turnId === null) {
      // A reply without a turn gives no evidence; those prompts keep the counting rule.
      waiting = [];
      continue;
    }
    turnsWithMessages.add(message.turnId);
    if (waiting.length === 0) continue;
    promptedTurns.add(message.turnId);
    for (const id of waiting) {
      decided.add(id);
      if (retainedTurnIds.has(message.turnId)) retained.add(id);
    }
    waiting = [];
  }
  let promptlessTurns = 0;
  for (const turnId of turnsWithMessages) {
    if (retainedTurnIds.has(turnId) && !promptedTurns.has(turnId)) promptlessTurns += 1;
  }
  return { retained, decided, promptlessTurns };
}
