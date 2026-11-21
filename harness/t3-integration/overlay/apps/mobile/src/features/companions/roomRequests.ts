// What another screen asks of a companion's room composer: the profile's "ask it to draw" puts the
// request in the field, and the room focuses it when it shows again. Per companion, one at a time,
// taken once.
import { useSyncExternalStore } from "react";

export interface RoomRequest {
  /** Words to put in the field; null leaves the draft as it is. */
  readonly text: string | null;
  readonly id: number;
}

const requests = new Map<string, RoomRequest>();
const listeners = new Set<() => void>();
let next = 1;

const keyOf = (environmentId: string, companionId: string) => `${environmentId}:${companionId}`;

export function requestRoomComposer(environmentId: string, companionId: string, text: string | null) {
  requests.set(keyOf(environmentId, companionId), { text, id: next++ });
  for (const listener of listeners) listener();
}

export function takeRoomRequest(environmentId: string, companionId: string, id: number) {
  const key = keyOf(environmentId, companionId);
  if (requests.get(key)?.id === id) requests.delete(key);
}

export function useRoomRequest(environmentId: string, companionId: string): RoomRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => requests.get(keyOf(environmentId, companionId)) ?? null,
  );
}
