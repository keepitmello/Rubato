import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { SplitIcon } from "lucide-react";
import { useState } from "react";

import { buildThreadRouteParams } from "~/threadRoutes";
import { forkThread } from "../sidebar/rubatoThreadFork";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// "Fork into new chat" under a reply, as Codex has it (turn-actions-edits.mjs). The new
// thread holds the conversation up to the end of this reply's turn and opens at once; the
// thread it came from is left as it is. The server half is /rubato/thread-fork with `at`.

export function RubatoReplyForkButton(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly messageId: string;
  readonly busy: boolean;
}) {
  const router = useRouter();
  const [forking, setForking] = useState(false);
  const { threadRef } = props;
  if (!threadRef || props.busy) return null;
  const fork = async () => {
    if (forking) return;
    setForking(true);
    const progress = toastManager.add({ type: "loading", title: "Forking into a new chat…" });
    try {
      const forked = await forkThread(threadRef, { at: props.messageId });
      toastManager.close(progress);
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(forked),
      });
    } catch (error) {
      toastManager.update(
        progress,
        stackedThreadToast({
          type: "error",
          title: "Could not fork into a new chat",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setForking(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-muted"
            disabled={forking}
            aria-label="Fork into new chat"
            onClick={() => void fork()}
          />
        }
      >
        <SplitIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork into new chat</TooltipPopup>
    </Tooltip>
  );
}
