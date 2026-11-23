import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import type { RoomLaunch } from "./roomModel";
import { startRoomPoll } from "./roomPoll";
import { postRubato } from "./rubatoHttp";

const EMPTY: readonly RoomLaunch[] = [];

export function useRoomLaunches(
  environmentId: EnvironmentId, companionId: string, threadId: string, visible: boolean, busy: boolean,
): readonly RoomLaunch[] {
  const key = JSON.stringify([environmentId, companionId, threadId]);
  const [result, setResult] = useState<{ key: string; launches: readonly RoomLaunch[] }>();
  const snapshot = useRef<{ key: string; wire: string } | null>(null);
  useEffect(() => {
    if (!visible) return;
    return startRoomPoll(busy ? 1_500 : 12_000, async (signal) => {
      const { spans } = await postRubato<{ spans: readonly ({ launches?: readonly RoomLaunch[] } | null)[] }>(
        environmentId, "/rubato/companion", "inner", { companionId, boundaries: [] }, { signal, timeoutMs: 4_000 },
      );
      if (signal.aborted) return false;
      const launches = spans[0]?.launches ?? EMPTY;
      const wire = JSON.stringify(launches);
      if (snapshot.current?.key !== key || snapshot.current.wire !== wire) {
        snapshot.current = { key, wire };
        setResult({ key, launches });
      }
    });
  }, [environmentId, companionId, key, visible, busy]);
  return result?.key === key ? result.launches : EMPTY;
}
