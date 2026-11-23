import type { EnvironmentId } from "@t3tools/contracts";
import {
  importedWorkSessionId,
  withoutCompanionWorkThreads,
} from "@t3tools/shared/rubatoCompanionWorkThreads";
import { startRoomPoll } from "@t3tools/shared/rubatoRoomPoll";
import { useEffect, useMemo, useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useReadyEnvironmentId, useRubatoCompanion } from "./rubatoCompanion";
import { postRubato } from "./rubatoHttp";

export function useSidebarCompanionWork<T extends {
  readonly id: string;
  readonly environmentId: EnvironmentId;
}>(
  allThreads: readonly T[],
): readonly T[] {
  const primary = useReadyEnvironmentId();
  const { companions } = useRubatoCompanion();
  // Current and past companion rooms belong to the rail, regardless of the work-thread switch.
  const threadIds = useMemo(() => new Set(companions.flatMap(({ threadId, conversationThreadIds }) =>
    [threadId, ...(conversationThreadIds ?? [])])), [companions]);
  const threads = useMemo(() => {
    const list = allThreads.filter(({ id }) => !threadIds.has(id));
    return list.length === allThreads.length ? allThreads : list;
  }, [allThreads, threadIds]);
  const show = useClientSettings((settings) => settings.rubatoShowCompanionLeads);
  const [launches, setLaunches] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const environments = useMemo(
    () => JSON.stringify([...new Set(
      threads.filter(({ id }) => importedWorkSessionId(id) !== null).map(({ environmentId }) => environmentId),
    )].sort()),
    [threads],
  );
  const roomIds = JSON.stringify(companions.filter(({ sessionId }) => sessionId).map(({ id }) => id).sort());
  useEffect(() => {
    if (show) return;
    const ids = JSON.parse(environments) as EnvironmentId[];
    if (!ids.length) return;
    const roomEnvironment = primary && ids.includes(primary) ? primary : null;
    const rooms = JSON.parse(roomIds) as string[];
    const revisions = new Map<string, string>();
    return startRoomPoll(15_000, async (signal) => {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
      const results = await Promise.allSettled([
        ...ids.map(async (id) => {
          const answer = await postRubato<{ sessionIds: readonly string[] | null }>(
            id, "/rubato/companion", "lead-sessions", {}, "companion work threads", requestSignal,
          );
          return [id, answer.sessionIds ?? []] as const;
        }),
        // The room also knows about work forks and older launches without an inventory marker.
        ...(roomEnvironment === null ? [] : rooms.map(async (companionId) => {
          const answer = await postRubato<{ revision?: string; workSessionIds?: readonly string[] }>(
            roomEnvironment, "/rubato/companion", "inner",
            { companionId, boundaries: [], versioned: true, view: "work-ids", revision: revisions.get(companionId) },
            "companion work threads", requestSignal,
          );
          if (answer.revision) revisions.set(companionId, answer.revision);
          return [roomEnvironment, answer.workSessionIds ?? []] as const;
        })),
      ]);
      if (signal.aborted) return false;
      setLaunches((previous) => {
        let next: Map<string, ReadonlySet<string>> | undefined;
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const [id, sessionIds] = result.value;
          const known = (next ?? previous).get(id);
          if (!sessionIds.some((sessionId) => !known?.has(sessionId))) continue;
          (next ??= new Map(previous)).set(id, new Set([...(known ?? []), ...sessionIds]));
        }
        return next ?? previous;
      });
    });
  }, [environments, primary, roomIds, show]);
  return useMemo(() => withoutCompanionWorkThreads(threads, launches, show), [threads, launches, show]);
}
