import type { OrchestrationThreadActivity, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import { revertCutFor } from "@t3tools/shared/rubatoStepRewind";
import { Undo2Icon, XIcon } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { postRubato } from "~/state/rubatoHttp";
import { environmentThreadDetails } from "~/state/threads";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";

// Rewind to a finished tool step (step-rewind-edits.mjs). Every Rubato tool row offers it:
// hovering the row's rewind button fades what would go, the card says what stays and
// what goes, and then either
// - "Rewind & instruct": the rewind waits for the next message, so it can still be undone
//   (the composer tag, the marker under the row, the toast). Sending lands the rewind and
//   then sends, so the message follows the step's results like a steered message; or
// - "Rewind & continue": rewinds now and runs on from the step's results with no message.
// The cut is the server's own rule (revertCutFor), so the preview fades exactly what the
// server drops and the wait ends when exactly that is gone.
//
// The same button sits where the steps are folded away: the "Worked for" row and a tool
// group's row rewind after the last step under them, so nothing has to be expanded. A
// reply's row rewinds to right after that reply: a turn boundary, so it is T3's ordinary
// turn revert, and with the reply last there is nothing to continue from.

/**
 * A rewind point. `step`: after the step `toolCallId` belongs to, inside turn `turnId`.
 * `turn`: after turn `turnId`, which ends at the reply `anchorId`.
 */
export interface StepCut {
  readonly kind: "step" | "turn";
  readonly turnId: TurnId;
  /** The row the rewind lands after: the step's call, or the reply. */
  readonly anchorId: string;
  readonly toolCallId?: string | undefined;
  /** When the step finished; the turn's rows stamped later go. */
  readonly after: string;
  /** The turn's checkpoint count: later turns go. */
  readonly turnCount: number;
  readonly label: string;
}

export interface StepRewindHost {
  readonly threadRef: ScopedThreadRef;
  /** Files can be restored only in a thread's own worktree. */
  readonly canRestoreFiles: boolean;
  /** Without `step`, T3's ordinary turn revert. */
  readonly revert: (input: {
    readonly turnCount: number;
    readonly restoreFiles: boolean;
    readonly step?: { readonly turnId: TurnId; readonly toolCallId: string } | undefined;
  }) => Promise<void>;
  readonly focusComposer: () => void;
}

interface ThreadRewindState {
  readonly preview?: StepCut | undefined;
  readonly open?: StepCut | undefined;
  readonly pending?: { readonly cut: StepCut; readonly restoreFiles: boolean } | undefined;
}

const states = new Map<string, ThreadRewindState>();
const hosts = new Map<string, StepRewindHost>();
const landing = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function update(threadKey: string, patch: Partial<ThreadRewindState>) {
  states.set(threadKey, { ...states.get(threadKey), ...patch });
  for (const listener of listeners) listener();
}
/** The store as React reads it; server rendering (tests, prerender) sees the same value. */
const useRewindState = <T,>(read: () => T): T => useSyncExternalStore(subscribe, read, read);
const shownCut = (threadKey: string): StepCut | undefined => {
  const state = states.get(threadKey);
  return state?.pending?.cut ?? state?.open ?? state?.preview;
};

type RewindRow = {
  readonly turnId?: string | null | undefined;
  readonly createdAt: string;
  readonly role?: string | undefined;
};
const readThreadDetail = (threadRef: ScopedThreadRef) =>
  appAtomRegistry.get(environmentThreadDetails.detailAtom(threadRef));
type ThreadDetail = NonNullable<ReturnType<typeof readThreadDetail>>;

/**
 * Whether a rewind to `cut` drops a row: a turn after the step's, or a row of the step's
 * turn stamped after it (a message steered in after it too). The server's rule
 * (keptAfterRevertCut); rows of no turn that are not user messages stay.
 */
export function stepRewindDrops(
  cut: StepCut,
  removedTurns: ReadonlySet<string>,
  row: RewindRow,
): boolean {
  const turnId = row.turnId ?? null;
  if (turnId !== null && removedTurns.has(turnId)) return true;
  if (compareDateTimeStrings(row.createdAt, cut.after) <= 0) return false;
  return turnId === cut.turnId || (turnId === null && row.role === "user");
}

const removedTurnsOf = (thread: ThreadDetail, cut: StepCut) =>
  new Set(
    thread.checkpoints
      .filter((checkpoint) => (checkpoint.checkpointTurnCount ?? 0) > cut.turnCount)
      .map((checkpoint) => checkpoint.turnId as string),
  );

/** Fades a timeline row the shown rewind would drop. */
export function useRubatoStepRewindDropped(threadKey: string, row: RewindRow | undefined): boolean {
  return useRewindState(() => {
    const cut = row ? shownCut(threadKey) : undefined;
    if (!cut || !row) return false;
    // A later turn is past the cut's instant too, so the instant decides here.
    if (compareDateTimeStrings(row.createdAt, cut.after) <= 0) return false;
    return (row.turnId ?? null) !== null || row.role === "user";
  });
}
export const RUBATO_STEP_DROPPED_CLASS = "opacity-35 transition-opacity duration-150";

function readThread(threadRef: ScopedThreadRef): ThreadDetail | null {
  return readThreadDetail(threadRef) ?? null;
}

/** The cut a tool row stands for, or why there is none. */
export function stepCutFor(
  thread: ThreadDetail,
  row: { readonly toolCallId: string; readonly turnId: TurnId },
  label: string,
): StepCut | string {
  const checkpoints = thread.checkpoints.map((checkpoint) => ({
    turnId: checkpoint.turnId as string,
    checkpointTurnCount: checkpoint.checkpointTurnCount ?? 0,
  }));
  const turnCount = checkpoints.find(
    (checkpoint) => checkpoint.turnId === row.turnId,
  )?.checkpointTurnCount;
  if (turnCount === undefined) return "This turn has not finished yet.";
  const resolved = revertCutFor({
    step: { turnId: row.turnId, toolCallId: row.toolCallId },
    turnCount,
    checkpoints,
    activities: thread.activities,
  });
  if (typeof resolved === "string") return resolved;
  return { ...resolved.cut, kind: "step", anchorId: row.toolCallId, turnCount, label };
}

const callOf = (activity: { readonly payload: unknown }): string | undefined => {
  const value = (activity.payload as { toolCallId?: unknown } | null)?.toolCallId;
  return typeof value === "string" ? value : undefined;
};

/**
 * The cut after the last finished Rubato step of a turn, or of the calls `toolCallIds`
 * when a tool group names them: what a folded row rewinds to.
 */
export function lastStepCutFor(
  thread: ThreadDetail,
  scope: { readonly turnId: TurnId; readonly toolCallIds?: ReadonlyArray<string | undefined> },
): StepCut | string {
  const calls = scope.toolCallIds ? new Set(scope.toolCallIds) : undefined;
  let last: OrchestrationThreadActivity | undefined;
  for (const activity of thread.activities as ReadonlyArray<OrchestrationThreadActivity>) {
    const call = callOf(activity);
    if (
      activity.kind !== "tool.completed" ||
      activity.turnId !== scope.turnId ||
      !call?.startsWith("pi-tool:") ||
      (calls !== undefined && !calls.has(call))
    )
      continue;
    if (!last || compareDateTimeStrings(activity.createdAt, last.createdAt) > 0) last = activity;
  }
  if (!last) return "There is no finished step to rewind to here.";
  const title = (last.payload as { title?: unknown } | null)?.title;
  return stepCutFor(
    thread,
    { toolCallId: callOf(last)!, turnId: scope.turnId },
    typeof title === "string" && title.length > 0 ? title : last.summary,
  );
}

/** The cut right after a turn's reply: the turn stays whole and the turns after it go. */
export function replyCutFor(
  thread: ThreadDetail,
  reply: { readonly turnId: TurnId; readonly messageId: string },
): StepCut | string {
  const turnCount = thread.checkpoints.find(
    (checkpoint) => checkpoint.turnId === reply.turnId,
  )?.checkpointTurnCount;
  if (turnCount === undefined) return "This turn has not finished yet.";
  if (!thread.checkpoints.some((checkpoint) => (checkpoint.checkpointTurnCount ?? 0) > turnCount))
    return "Nothing comes after this reply.";
  // The turn keeps every row it has, so the cut sits after the latest of them.
  let after: string | undefined;
  for (const row of [...thread.messages, ...thread.activities]) {
    if (row.turnId !== reply.turnId) continue;
    if (after === undefined || compareDateTimeStrings(row.createdAt, after) > 0)
      after = row.createdAt;
  }
  if (after === undefined) return "This reply is not in the thread any more.";
  return {
    kind: "turn",
    turnId: reply.turnId,
    anchorId: reply.messageId,
    after,
    turnCount,
    label: "this reply",
  };
}

/** Where a rewind button points. */
export type RewindTarget =
  | {
      readonly kind: "step";
      readonly toolCallId: string | undefined;
      readonly turnId: TurnId | null | undefined;
    }
  | {
      readonly kind: "last-step";
      readonly turnId: TurnId | null | undefined;
      readonly toolCallIds?: ReadonlyArray<string | undefined>;
    }
  | {
      readonly kind: "reply";
      readonly turnId: TurnId | null | undefined;
      readonly messageId: string;
    };

function resolveTarget(
  thread: ThreadDetail,
  target: RewindTarget,
  label: string,
): StepCut | string {
  if (!target.turnId) return "This row belongs to no turn.";
  switch (target.kind) {
    case "step":
      return target.toolCallId
        ? stepCutFor(thread, { toolCallId: target.toolCallId, turnId: target.turnId }, label)
        : "This row names no tool call.";
    case "last-step":
      return lastStepCutFor(thread, {
        turnId: target.turnId,
        ...(target.toolCallIds ? { toolCallIds: target.toolCallIds } : {}),
      });
    case "reply":
      return replyCutFor(thread, { turnId: target.turnId, messageId: target.messageId });
  }
}

/** Whether a target can be offered at all, before the thread is read. */
function offered(target: RewindTarget): boolean {
  if (!target.turnId) return false;
  if (target.kind === "step") return target.toolCallId?.startsWith("pi-tool:") === true;
  if (target.kind === "last-step")
    return (
      target.toolCallIds === undefined ||
      target.toolCallIds.some((call) => call?.startsWith("pi-tool:"))
    );
  return true;
}

export interface StepRewindSummary {
  readonly steps: number;
  readonly replies: number;
  readonly messages: number;
  readonly files: ReadonlyArray<string>;
}

/** What a rewind to `cut` drops, for the card. */
export function stepRewindSummary(thread: ThreadDetail, cut: StepCut): StepRewindSummary {
  const removed = removedTurnsOf(thread, cut);
  const calls = new Set<string>();
  const files = new Set<string>();
  for (const activity of thread.activities as ReadonlyArray<OrchestrationThreadActivity>) {
    if (activity.kind !== "tool.completed" || !stepRewindDrops(cut, removed, activity)) continue;
    const payload = activity.payload as { toolCallId?: unknown; data?: { files?: unknown } } | null;
    if (typeof payload?.toolCallId === "string") calls.add(payload.toolCallId);
    if (Array.isArray(payload?.data?.files))
      for (const file of payload.data.files as Array<{ path?: unknown }>)
        if (typeof file?.path === "string") files.add(file.path);
  }
  let replies = 0;
  let messages = 0;
  for (const message of thread.messages) {
    if (!stepRewindDrops(cut, removed, message)) continue;
    if (message.role === "assistant") replies += 1;
    if (message.role === "user") messages += 1;
  }
  return { steps: calls.size, replies, messages, files: [...files] };
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
export function describeDropped(summary: StepRewindSummary): string {
  const parts = [
    summary.steps > 0 ? plural(summary.steps, "step") : null,
    summary.messages > 0 ? plural(summary.messages, "message") : null,
    summary.replies > 0 ? plural(summary.replies, "reply") : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "Nothing after this step";
}

/**
 * Lands a rewind and resolves once the thread shows it: the rows it drops are gone.
 * A failure the server records for it rejects with the server's reason.
 */
export function waitForStepRewind(
  threadRef: ScopedThreadRef,
  cut: StepCut,
  revert: () => Promise<void>,
  timeoutMs = 120_000,
): Promise<void> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const initial = appAtomRegistry.get(threadAtom);
  if (!initial) return Promise.reject(new Error("This thread is not loaded."));
  const removed = removedTurnsOf(initial, cut);
  const previousFailures = new Set(
    initial.activities
      .filter((activity) => activity.kind === "checkpoint.revert.failed")
      .map((activity) => activity.id),
  );
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = appAtomRegistry.get(threadAtom);
      if (!thread) return;
      const failure = thread.activities.findLast(
        (activity) =>
          activity.kind === "checkpoint.revert.failed" && !previousFailures.has(activity.id),
      );
      if (failure) {
        const detail = (failure.payload as { detail?: unknown } | null)?.detail;
        finish(new Error(typeof detail === "string" ? detail : failure.summary));
        return;
      }
      if (
        accepted &&
        !thread.checkpoints.some((checkpoint) => removed.has(checkpoint.turnId)) &&
        !thread.messages.some((message) => stepRewindDrops(cut, removed, message)) &&
        !thread.activities.some(
          (activity) =>
            activity.kind.startsWith("tool.") && stepRewindDrops(cut, removed, activity),
        )
      ) {
        finish();
      }
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}

function land(host: StepRewindHost, cut: StepCut, restoreFiles: boolean): Promise<void> {
  return waitForStepRewind(host.threadRef, cut, () =>
    host.revert({
      turnCount: cut.turnCount,
      restoreFiles,
      ...(cut.kind === "step" && cut.toolCallId
        ? { step: { turnId: cut.turnId, toolCallId: cut.toolCallId } }
        : {}),
    }),
  );
}

const failed = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );

function cancelPending(threadKey: string) {
  update(threadKey, { pending: undefined, open: undefined, preview: undefined });
}

/**
 * Before a message goes: a rewind waiting for it lands first. Answers whether the message
 * may go now; a failed rewind keeps both the rewind and the message for another try.
 */
export async function landRubatoStepRewind(threadKey: string): Promise<boolean> {
  const pending = states.get(threadKey)?.pending;
  if (!pending) return true;
  if (landing.has(threadKey)) return false;
  const host = hosts.get(threadKey);
  if (!host) {
    failed("Could not rewind", new Error("This thread is not ready to rewind."));
    return false;
  }
  landing.add(threadKey);
  try {
    await land(host, pending.cut, pending.restoreFiles);
    cancelPending(threadKey);
    return true;
  } catch (error) {
    failed("Could not rewind", error);
    return false;
  } finally {
    landing.delete(threadKey);
  }
}

/** ChatView lends the rewind what only it holds: the revert command and the composer. */
export function useRubatoStepRewindHost(threadKey: string, host: StepRewindHost) {
  useEffect(() => {
    hosts.set(threadKey, host);
    return () => {
      if (hosts.get(threadKey) === host) hosts.delete(threadKey);
    };
  }, [threadKey, host]);
}

const stop = (event: MouseEvent | PointerEvent) => event.stopPropagation();

/**
 * A rewind button with its card: on a finished Rubato tool row, on a folded row (after its
 * last step), or on a reply. `reveal: "row"` shows it while its `group/timeline-row` is
 * hovered; `"inherit"` leaves that to the surrounding row (a reply's action row).
 */
export function RubatoStepRewindButton(props: {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly target: RewindTarget;
  readonly label: string;
  readonly busy: boolean;
  readonly reveal?: "row" | "inherit";
}) {
  const { threadKey, threadRef, target, label, busy, reveal = "row" } = props;
  const [card, setCard] = useState<{ cut: StepCut; summary: StepRewindSummary } | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const anchor =
    target.kind === "step"
      ? target.toolCallId
      : target.kind === "reply"
        ? target.messageId
        : undefined;
  const pending = useRewindState(() => {
    const cut = states.get(threadKey)?.pending?.cut;
    return (
      cut !== undefined &&
      (anchor !== undefined ? cut.anchorId === anchor : cut.turnId === target.turnId)
    );
  });
  if (!threadRef || !offered(target) || busy) return null;
  const resolve = (): StepCut | string => {
    const thread = readThread(threadRef);
    return thread ? resolveTarget(thread, target, label) : "This thread is not loaded.";
  };
  const host = hosts.get(threadKey);
  const canRestoreFiles = host?.canRestoreFiles === true;
  const close = () => {
    setCard(null);
    update(threadKey, { open: undefined, preview: undefined });
  };
  const instruct = () => {
    if (!card) return;
    const cut = card.cut;
    update(threadKey, {
      pending: { cut, restoreFiles: canRestoreFiles && restoreFiles },
      open: undefined,
      preview: undefined,
    });
    setCard(null);
    host?.focusComposer();
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `Rewinds after ${cut.label} when you send`,
        description: describeDropped(card.summary),
        actionProps: { children: "Undo", onClick: () => cancelPending(threadKey) },
      }),
    );
  };
  const resume = () => {
    if (!card || !host) return;
    const cut = card.cut;
    close();
    void land(host, cut, canRestoreFiles && restoreFiles)
      .then(() =>
        postRubato(
          host.threadRef.environmentId,
          "/rubato/step-rewind",
          "continue",
          { threadId: host.threadRef.threadId },
          "step rewinds",
        ),
      )
      .catch((error: unknown) => failed("Could not rewind and continue", error));
  };
  return (
    <Popover
      open={card !== null}
      onOpenChange={(open) => {
        if (open) return;
        close();
      }}
    >
      <span
        className={cn(
          "flex shrink-0",
          reveal === "row" &&
            "opacity-0 transition-opacity focus-within:opacity-100 group-hover/timeline-row:opacity-100",
          (card !== null || pending) && "opacity-100",
        )}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              aria-label="Rewind to here"
              title="Rewind to here"
              onPointerDown={stop}
              onPointerEnter={() => {
                const cut = resolve();
                if (typeof cut !== "string") update(threadKey, { preview: cut });
              }}
              onPointerLeave={() => update(threadKey, { preview: undefined })}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                // Open: the trigger closes it.
                if (card !== null) return;
                const cut = resolve();
                const thread = readThread(threadRef);
                if (typeof cut === "string" || !thread) {
                  failed(
                    "Cannot rewind here",
                    new Error(typeof cut === "string" ? cut : "This thread is not loaded."),
                  );
                  return;
                }
                setRestoreFiles(true);
                setCard({ cut, summary: stepRewindSummary(thread, cut) });
                update(threadKey, { open: cut });
              }}
            />
          }
        >
          <Undo2Icon className="size-3" />
        </PopoverTrigger>
      </span>
      {card ? (
        <PopoverPopup side="bottom" align="end" className="w-88" onClick={stop}>
          <StepRewindCard
            cut={card.cut}
            summary={card.summary}
            canRestoreFiles={canRestoreFiles}
            restoreFiles={restoreFiles}
            onRestoreFilesChange={setRestoreFiles}
            onInstruct={instruct}
            {...(card.cut.kind === "step" ? { onContinue: resume } : {})}
            onCancel={close}
          />
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}

/** What the card says before a rewind: what stays, what goes, and the two ways on. */
export function StepRewindCard(props: {
  readonly cut: StepCut;
  readonly summary: StepRewindSummary;
  readonly canRestoreFiles: boolean;
  readonly restoreFiles: boolean;
  readonly onRestoreFilesChange: (restore: boolean) => void;
  readonly onInstruct: () => void;
  /** Absent where there is nothing to continue from (after a reply). */
  readonly onContinue?: (() => void) | undefined;
  readonly onCancel: () => void;
}) {
  return (
    <div
      className="space-y-3 py-2 text-sm"
      onKeyDown={(event) => {
        // The card renders inside the row, which toggles on Enter and Space.
        event.stopPropagation();
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !(event.target instanceof HTMLButtonElement)
        ) {
          event.preventDefault();
          props.onInstruct();
        }
      }}
    >
      <p className="font-medium">
        Rewind to after <span className="font-mono text-xs">{props.cut.label}</span>
      </p>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Conversation</dt>
        <dd className="min-w-0">
          {props.cut.kind === "step"
            ? "Keeps everything up to this result, as the model saw it."
            : "Keeps this reply and everything before it."}
        </dd>
        <dt className="text-muted-foreground">Files</dt>
        <dd className="min-w-0">
          {props.canRestoreFiles ? (
            <label className="flex min-w-0 cursor-pointer items-start gap-2">
              <Checkbox
                checked={props.restoreFiles}
                onCheckedChange={(checked) => props.onRestoreFilesChange(checked === true)}
              />
              <span className="min-w-0">
                Restore files to this step
                {props.summary.files.length > 0 ? (
                  <span className="mt-0.5 block truncate font-mono text-2xs text-muted-foreground">
                    {props.summary.files
                      .slice(0, 3)
                      .map((file) => file.split("/").at(-1))
                      .join(", ")}
                    {props.summary.files.length > 3 ? ` +${props.summary.files.length - 3}` : ""}
                  </span>
                ) : null}
              </span>
            </label>
          ) : (
            "Stay as they are: this thread shares the project folder."
          )}
        </dd>
        <dt className="text-muted-foreground">Removed</dt>
        <dd className="min-w-0">
          {describeDropped(props.summary)}
          <span className="text-muted-foreground"> — kept as a side branch</span>
        </dd>
      </dl>
      <div className="flex items-center gap-2">
        <Button size="xs" autoFocus onClick={props.onInstruct}>
          Rewind &amp; instruct
        </Button>
        {props.onContinue ? (
          <Button size="xs" variant="outline" onClick={props.onContinue}>
            Rewind &amp; continue
          </Button>
        ) : null}
        <Button size="xs" variant="ghost-muted" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The line under the step a waiting rewind lands after. */
export function StepRewindMarkerLine(props: { readonly onUndo: () => void }) {
  return (
    <div
      className="mt-1 flex items-center gap-2 border-warning/32 border-t border-dashed pt-1 text-warning text-xs"
      onClick={stop}
      onPointerDown={stop}
    >
      <Undo2Icon className="size-3" aria-hidden />
      <span>Your next message continues from here; the faded rows go.</span>
      <button
        type="button"
        className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={props.onUndo}
      >
        Undo
      </button>
    </div>
  );
}

/** Under the row a waiting rewind lands after: where the next message will go. */
export function RubatoStepRewindMarker(props: {
  readonly threadKey: string;
  /** The tool call or reply the rewind lands after. */
  readonly anchorId: string | undefined;
}) {
  const pending = useRewindState(() => {
    const cut = states.get(props.threadKey)?.pending?.cut;
    return cut !== undefined && cut.anchorId === props.anchorId ? cut : undefined;
  });
  if (!pending) return null;
  return <StepRewindMarkerLine onUndo={() => cancelPending(props.threadKey)} />;
}

/** The composer's note of where a waiting rewind sends the message. */
export function StepRewindTag(props: { readonly label: string; readonly onUndo: () => void }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs">
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-warning/16 px-2 py-0.5 text-warning">
        <Undo2Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          After <span className="font-mono">{props.label}</span>
        </span>
      </span>
      <span className="text-muted-foreground">Sent right after this step's results</span>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label="Undo the rewind"
        title="Undo the rewind"
        onClick={props.onUndo}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}

/** Above the composer while a rewind waits for the message. */
export function RubatoStepRewindComposerTag(props: { readonly threadKey: string }) {
  const pending = useRewindState(() => states.get(props.threadKey)?.pending?.cut);
  if (!pending) return null;
  return <StepRewindTag label={pending.label} onUndo={() => cancelPending(props.threadKey)} />;
}
