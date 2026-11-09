// The chat's card for a conversation another one started or forked (rubatoWorkCardModel.ts): its state
// word with an icon, its title, model, when it last moved, and "Open thread". The same card stands
// in an ordinary thread's timeline (MessagesTimeline, work-card-edits.mjs) and in a companion's
// room (RubatoSegnoChat.tsx), and follows the launched thread live.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { turnItemDetailRevision, turnItemNeedsDetailFetch } from "@t3tools/client-runtime/work-log/item-detail";
import { ThreadId, type EnvironmentId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleStopIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import { useTurnItemDetail } from "../../state/queries";
import { rubatoCompanion } from "../../state/rubatoCompanion";
import {
  type RubatoLaunch,
  rubatoLaunchOfItem,
  WORK_CARD_WORDS,
  type WorkCardState,
  workCardModelLabel,
  workCardState,
  workCardUpdatedAt,
} from "./rubatoWorkCardModel";

/** How often an unfound conversation is looked for; the inventory imports one within seconds. */
const FIND_MS = 3_000;
/** After this long unfound, the card keeps looking, slower. */
const FIND_PATIENCE_MS = 120_000;

const foundThreads = new Map<string, string>();

/** The thread that shows `sessionId`, from the server's session-to-thread lookup; null until found. */
export function useLaunchedThreadId(environmentId: EnvironmentId | null | undefined, sessionId: string | null): string | null {
  const key = environmentId && sessionId ? `${environmentId}:${sessionId}` : null;
  // The answer belongs to the key it was found for: a card that comes to show another conversation
  // (or environment) drops the old thread in the same render, so Open never goes to the previous one.
  const [found, setFound] = useState<{ key: string | null; threadId: string | null }>(() => ({
    key,
    threadId: key ? (foundThreads.get(key) ?? null) : null,
  }));
  useEffect(() => {
    if (!key || !environmentId || !sessionId) return;
    const known = foundThreads.get(key);
    if (known) {
      setFound({ key, threadId: known });
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const started = Date.now();
    const look = async () => {
      try {
        const answer = await rubatoCompanion.thread(environmentId, sessionId);
        if (stopped) return;
        if (answer.threadId) {
          foundThreads.set(key, answer.threadId);
          setFound({ key, threadId: answer.threadId });
          return;
        }
      } catch {
        // A server without the route, or a restart: look again.
      }
      if (!stopped) timer = window.setTimeout(look, Date.now() - started < FIND_PATIENCE_MS ? FIND_MS : FIND_MS * 5);
    };
    void look();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [key, environmentId, sessionId]);
  if (found.key === key) return found.threadId;
  return key ? (foundThreads.get(key) ?? null) : null;
}

function StateIcon({ state }: { state: WorkCardState }) {
  const className = "size-3.5 shrink-0";
  switch (state) {
    case "starting":
      return <CircleDashedIcon aria-hidden="true" className={cn(className, "text-muted-foreground")} />;
    case "working":
      return <LoaderCircleIcon aria-hidden="true" className={cn(className, "animate-spin text-info")} />;
    case "waiting":
      return <CircleAlertIcon aria-hidden="true" className={cn(className, "text-warning")} />;
    case "done":
      return <CircleCheckIcon aria-hidden="true" className={cn(className, "text-success")} />;
    case "failed":
      return <CircleXIcon aria-hidden="true" className={cn(className, "text-destructive")} />;
    case "stopped":
      return <CircleStopIcon aria-hidden="true" className={cn(className, "text-muted-foreground")} />;
    case "idle":
      return <CircleDashedIcon aria-hidden="true" className={cn(className, "text-muted-foreground/70")} />;
  }
}

function updatedLabel(at: string, now: number): string {
  const when = new Date(at);
  const sameDay = new Date(now).toDateString() === when.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(when);
}

export function RubatoWorkCard({
  launch,
  environmentId,
  className,
}: {
  launch: RubatoLaunch;
  environmentId: EnvironmentId | null | undefined;
  className?: string;
}) {
  const navigate = useNavigate();
  const threadId = useLaunchedThreadId(environmentId, launch.error === null ? launch.sessionId : null);
  const ref = useMemo(
    () => (environmentId && threadId ? scopeThreadRef(environmentId, ThreadId.make(threadId)) : null),
    [environmentId, threadId],
  );
  const shell = useThreadShell(ref);
  const title = shell?.title || launch.title || (launch.tool === "fork" ? "Fork" : "New conversation");
  const model = workCardModelLabel(shell?.modelSelection.model ?? launch.model);
  const updatedAt = workCardUpdatedAt(shell);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Often enough that "Starting" gives way within its grace (rubatoWorkCardModel START_GRACE_MS).
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const state = workCardState(launch, shell, now);
  const open =
    environmentId && threadId
      ? () => void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } })
      : null;
  return (
    <div
      data-rubato-work-card={state}
      data-rubato-work-card-tool={launch.tool}
      className={cn(
        "my-1 w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs",
        className,
      )}
    >
      <div className="px-3 pt-2 pb-2">
        <div className="flex items-center gap-1.5 text-xs">
          <StateIcon state={state} />
          <span className={cn("font-medium", state === "failed" ? "text-destructive" : "text-foreground/80")}>
            {WORK_CARD_WORDS[state]}
          </span>
          {launch.tool === "fork" ? <span className="text-muted-foreground">· Fork</span> : null}
        </div>
        <p className="mt-1 truncate font-medium text-sm" translate="no" title={title}>
          {title}
        </p>
        {launch.error !== null ? (
          <p className="mt-0.5 line-clamp-2 text-destructive/80 text-xs" translate="no">
            {launch.error}
          </p>
        ) : model ? (
          <p className="mt-0.5 truncate font-mono text-[.7rem] text-muted-foreground" translate="no">
            {model}
          </p>
        ) : null}
      </div>
      {launch.error === null ? (
        <div className="flex items-center justify-between gap-2 border-border border-t px-3 py-1.5 text-muted-foreground text-xs">
          <span className="truncate tabular-nums">
            {updatedAt ? `Updated ${updatedLabel(updatedAt, now)}` : launch.pending ? "Starting" : "Looking for the conversation"}
          </span>
          {open ? (
            <button
              type="button"
              onClick={open}
              className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open thread
              <ChevronRightIcon aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The card for a launch call in an ordinary thread's timeline. The timeline item carries no output
 * (T3 fetches it when a row opens), so the card asks for the item's detail, as the row inspector
 * does (V2ItemInspector), to learn which conversation the call started.
 */
export function RubatoTimelineWorkCard({
  projectedItem,
  environmentId,
}: {
  projectedItem: OrchestrationV2ProjectedTurnItem;
  environmentId: EnvironmentId | null | undefined;
}) {
  const wire = projectedItem.item;
  const fetches = turnItemNeedsDetailFetch(wire);
  const detail = useTurnItemDetail(
    fetches && environmentId
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wire),
        }
      : null,
  );
  const fetched = detail.data?.item;
  const item = fetched?.type === wire.type ? fetched : wire;
  const launch = rubatoLaunchOfItem(item, { outputPending: fetches && item === wire });
  return launch ? <RubatoWorkCard launch={launch} environmentId={environmentId} /> : null;
}
