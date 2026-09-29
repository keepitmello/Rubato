import type { ContextMenuItem, EnvironmentId } from "@t3tools/contracts";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";

import { readEnvironmentSupportsPinning } from "~/state/entities";

type PinnableThread = Parameters<typeof sortPinnedThreadsByOrderKey>[0][number] & {
  readonly pinnedAt?: string | null | undefined;
};

/**
 * Rubato: the legacy sidebar lists each project's threads in one run. Pinned
 * threads lead that run in the pin order the server keeps (a fresh pin takes
 * the top); the rest keep the order the caller already sorted them in.
 */
export function pinnedThreadsFirst<T extends PinnableThread>(threads: readonly T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) (thread.pinnedAt != null ? pinned : rest).push(thread);
  return [...sortPinnedThreadsByOrderKey(pinned), ...rest];
}

/** The thread menu's pin entry, or none when the thread's server cannot pin. */
export function pinMenuItems(
  thread: { readonly environmentId: EnvironmentId; readonly pinnedAt?: string | null | undefined },
  supportsPinning: (environmentId: EnvironmentId) => boolean = readEnvironmentSupportsPinning,
): ContextMenuItem<"pin" | "unpin">[] {
  if (!supportsPinning(thread.environmentId)) return [];
  return [
    thread.pinnedAt != null
      ? { id: "unpin", label: "Unpin thread", icon: "pin-off" }
      : { id: "pin", label: "Pin thread", icon: "pin" },
  ];
}
