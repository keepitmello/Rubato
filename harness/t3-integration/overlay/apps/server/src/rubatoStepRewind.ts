import {
  CheckpointRef,
  isToolLifecycleItemType,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";

// Rewinding to a finished tool step inside a turn (step-rewind-edits.mjs). The app names
// the step's row; the server reads when that step finished from the thread's tool rows
// (revertCutFor, shared with the app), puts back the files the step left (a snapshot taken
// when each step finished), and tells Rubato where to land.

/** Where the files a tool step left are kept, beside the thread's turn checkpoints. */
export function stepCheckpointRef(threadId: ThreadId, toolCallId: string): CheckpointRef {
  return CheckpointRef.make(
    `refs/t3/checkpoints/${Encoding.encodeBase64Url(threadId)}/step/${Encoding.encodeBase64Url(toolCallId)}`,
  );
}

/** A Rubato tool call finished: the moment to keep the files it left. */
export function isRubatoStepCompletion(
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "item.completed" }> & {
  readonly itemId: string;
} {
  return (
    event.type === "item.completed" &&
    event.provider === "rubato-pi" &&
    event.itemId !== undefined &&
    isToolLifecycleItemType(event.payload.itemType)
  );
}

export { revertCutFor } from "@t3tools/shared/rubatoStepRewind";
