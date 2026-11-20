// A companion's room thread, subscribed by target: the list's preview of each room reads it while
// that room is not the selected thread. T3 keeps its own per-target hooks private.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails, useEnvironmentThread } from "../../state/threads";

export interface RoomThreadTarget {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}

const NO_TURN_ITEMS = Atom.make<OrchestrationV2ThreadProjection["visibleTurnItems"]>(
  Object.freeze([]),
).pipe(Atom.withLabel("rubato-room-turn-items:empty"));

/** Keeps the room's thread subscribed, so what it shows stays current. */
export function useRoomThread(target: RoomThreadTarget) {
  return useEnvironmentThread(target.environmentId, target.threadId);
}

export function useRoomTurnItems(
  target: RoomThreadTarget,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return useAtomValue(
    target.environmentId === null || target.threadId === null
      ? NO_TURN_ITEMS
      : environmentThreadDetails.visibleTurnItemsAtom({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
  );
}
