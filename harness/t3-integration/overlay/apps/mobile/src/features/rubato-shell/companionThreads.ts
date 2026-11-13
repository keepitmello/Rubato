// Rubato: a companion's conversation is its room in the Companions tab, so the Threads tab
// leaves it out. The rooms come from features/companions (each companion names its thread);
// until they have loaded, or when the Mac does not answer, nothing is hidden.
import { useMemo } from "react";

import { useCompanions } from "../companions/companionsStore";
import { withoutThreads, type ThreadRef } from "./companionThreadFilter";

export function useWithoutCompanionThreads<T extends ThreadRef>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const { companions } = useCompanions();
  return useMemo(() => withoutThreads(threads, companions), [threads, companions]);
}
