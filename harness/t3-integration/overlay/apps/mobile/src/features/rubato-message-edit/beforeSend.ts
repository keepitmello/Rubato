// Where the composer state asks for a rewind before a send (message-edit-edits.mjs). The composer
// state is imported by tests that load nothing of the app, so it reaches the edit through this
// file, which imports nothing; sentMessageEdit.ts answers here when it loads, which is before any
// edit can start (the long-press menu that starts one imports it).
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface RewindBeforeSendInput {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly busy: boolean;
}

let answer: ((input: RewindBeforeSendInput) => Promise<void>) | null = null;

export function answerRewindBeforeSend(next: (input: RewindBeforeSendInput) => Promise<void>): void {
  answer = next;
}

/** Rewinds the conversation to just before a sent message under edit; nothing when none is. */
export function rewindBeforeSend(input: RewindBeforeSendInput): Promise<void> {
  return answer ? answer(input) : Promise.resolve();
}
