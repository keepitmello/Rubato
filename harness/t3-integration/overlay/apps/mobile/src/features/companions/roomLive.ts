// What the companion's tool does right now, for the room's typing bubble (user a9b0890f: the work
// animation never showed). The thread gets none of the companion's work (intent companion-segno
// rev 17), so the room asks the Mac, which reads it from the conversation's session file
// (companion/inner.mjs liveWork), and only while the person's turn runs.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { roomTool, type RoomTool } from "./roomModel";
import { postRubato } from "./rubatoHttp";

const LIVE_EVERY_MS = 1_200;

export function useRoomLiveWork(environmentId: EnvironmentId, companionId: string, active: boolean): RoomTool | null {
  const [work, setWork] = useState<RoomTool | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polling: the Mac's answer arrives over time
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      postRubato<{ work?: unknown }>(environmentId, "/rubato/companion", "live", { companionId }, { timeoutMs: 4_000 })
        // A Mac without the route answers an error: the bubble stays thinking.
        .then((answer) => live && setWork(roomTool(answer.work)), () => undefined)
        .finally(() => {
          if (live) timer = setTimeout(ask, LIVE_EVERY_MS);
        });
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
      setWork(null);
    };
  }, [environmentId, companionId, active]);
  return active ? work : null;
}
