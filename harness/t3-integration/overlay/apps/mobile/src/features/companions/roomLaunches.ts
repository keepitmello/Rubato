import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import type { RoomLaunch } from "./roomModel";
import { roomWorkSessions } from "./roomLeadsModel";
import { startRoomPoll } from "./roomPoll";
import { postRubato } from "./rubatoHttp";

const EMPTY: readonly RoomLaunch[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

type Answer = {
  revision?: string; unchanged?: true; launches?: readonly RoomLaunch[];
  workSessionIds?: readonly string[];
  spans?: readonly ({ launches?: readonly RoomLaunch[] } | null)[];
};

export function useRoomLaunches(
  environmentId: EnvironmentId, companionId: string, threadId: string, visible: boolean, busy: boolean,
  after: number | undefined, wantWork: boolean,
) {
  const key = JSON.stringify([environmentId, companionId, threadId]);
  const [result, setResult] = useState<{ key: string; launches: readonly RoomLaunch[]; ids: ReadonlySet<string> }>();
  const snapshot = useRef<{ key: string; scope: number | undefined; revision?: string; wire: string } | null>(null);
  const legacyWork = useRef<{ key: string; ids: readonly string[] } | null>(null);
  useEffect(() => {
    if (!visible) return;
    return startRoomPoll(busy ? 1_500 : 12_000, async (signal) => {
      const current = snapshot.current;
      const answer = await postRubato<Answer>(
        environmentId, "/rubato/companion", "inner",
        { companionId, boundaries: [], after, view: "launches", versioned: true,
          revision: current?.key === key && current.scope === after ? current.revision : undefined },
        { signal, timeoutMs: 4_000 },
      );
      if (signal.aborted) return false;
      if (answer.unchanged) return;
      const launches = answer.launches ?? answer.spans?.[0]?.launches ?? EMPTY;
      let workIds = answer.workSessionIds;
      if (!workIds && wantWork && after !== undefined) {
        // An older Mac returns only the requested period. Read attribution once per
        // open work sheet, not every time the room refreshes.
        if (legacyWork.current?.key !== key) {
          const history = await postRubato<Answer>(environmentId, "/rubato/companion", "inner",
            { companionId, boundaries: [] }, { signal, timeoutMs: 4_000 });
          if (signal.aborted) return false;
          legacyWork.current = { key, ids: [...roomWorkSessions(history.spans?.[0]?.launches ?? EMPTY)] };
        }
        workIds = [...new Set([...legacyWork.current.ids, ...roomWorkSessions(launches)])];
      }
      const ids = workIds ?? [...roomWorkSessions(launches)];
      const wire = JSON.stringify([launches, ids]);
      snapshot.current = { key, scope: after, ...(answer.revision ? { revision: answer.revision } : {}), wire };
      if (current?.key !== key || current.wire !== wire) {
        setResult({ key, launches, ids: new Set(ids) });
      }
    });
  }, [environmentId, companionId, key, visible, busy, after, wantWork]);
  useEffect(() => { if (!wantWork) legacyWork.current = null; }, [wantWork]);
  return result?.key === key ? result : { launches: EMPTY, ids: NO_IDS };
}
