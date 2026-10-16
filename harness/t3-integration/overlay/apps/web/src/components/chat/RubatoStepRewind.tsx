import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Undo2Icon, XIcon } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
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

// Rewind to a finished tool step (step-rewind-ui-edits.mjs). Every Rubato tool row offers it:
// hovering the row's rewind button fades what would go, the card says what stays and what
// goes, and then either
// - "Rewind & instruct": the rewind waits for the next message, so it can still be undone
//   (the composer tag, the marker under the row, the toast). Sending lands the rewind and
//   then sends, so the message follows the step's results like a steered message; or
// - "Rewind & continue": rewinds now and runs on from the step's results with no message.
// In a thread with its own worktree the card can also put the files back to that step.
//
// The server does the cut (POST /rubato/step-rewind, RubatoStepRewind.ts): it keeps the
// step's whole batch — calls made in one model message rewind together — and moves what
// came after onto a rolled-back run. Only the engine knows which calls one model message
// made, so the preview asks the server where the batch ends (/rubato/step-rewind/batch)
// and fades the same rows: in the step's run, what follows that batch, and every later
// run. The wait ends when the rows the server named are gone from the thread.
//
// The same button sits where the steps are folded away: the "Worked for" row and a tool
// group's row rewind after the last step under them, so nothing has to be expanded. A
// reply's row rewinds to right after that reply: a run boundary, so it is T3's ordinary
// revert, with nothing to continue from. A button shows only where a rewind can land: a
// reply with rows after it, a folded row with a Rubato step under it.

/** A rewind point, with the rows it drops. */
export interface StepCut {
  /** `step`: after a tool step's batch; `turn`: after a whole run (a reply's). */
  readonly kind: "step" | "turn";
  readonly runId: string;
  /** The row the rewind lands after: the step's item, or the reply's message. */
  readonly anchorId: string;
  /** The tool item the server is asked to cut after. */
  readonly itemId?: string | undefined;
  /** The run's checkpoint turn count, for a run boundary. */
  readonly turnCount?: number | undefined;
  readonly droppedItemIds: ReadonlySet<string>;
  readonly droppedMessageIds: ReadonlySet<string>;
  readonly label: string;
}

export interface StepRewindHost {
  readonly threadRef: ScopedThreadRef;
  /** Files can be restored only in a thread's own worktree. */
  readonly canRestoreFiles: boolean;
  /** T3's ordinary revert to after `turnCount` runs. */
  readonly revert: (input: { readonly turnCount: number; readonly restoreFiles: boolean }) => Promise<void>;
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

/** What a cut is computed from: the thread's visible rows, its runs and checkpoints. */
export interface RewindThread {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly runs: ReadonlyArray<{ readonly id: string; readonly ordinal: number; readonly status: string }>;
  readonly checkpoints: ReadonlyArray<{
    readonly runId: string | null;
    readonly appRunOrdinal: number | null;
    readonly status: string;
  }>;
}

function readThread(threadRef: ScopedThreadRef): RewindThread | null {
  const detail = appAtomRegistry.get(environmentThreadDetails.threadAtom(threadRef));
  if (!detail) return null;
  return {
    items: appAtomRegistry.get(environmentThreadDetails.visibleTurnItemsAtom(threadRef)),
    runs: detail.projection.runs,
    checkpoints: detail.projection.checkpoints,
  };
}

const TOOL_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "file_search",
  "web_search",
]);
const isTool = (item: OrchestrationV2TurnItem) => TOOL_TYPES.has(item.type);
// A tool that ended in an error is a finished step too: its result is what the model saw.
const isStep = (item: OrchestrationV2TurnItem) =>
  isTool(item) &&
  (item.status === "completed" || item.status === "failed") &&
  item.nativeItemRef?.driver === "rubato-pi";
const messageIdOf = (item: OrchestrationV2TurnItem): string | undefined =>
  item.type === "user_message" || item.type === "assistant_message" ? item.messageId : undefined;

/** Whether a row is dropped by the shown rewind: by its item, or by its message. */
export function stepRewindDrops(
  cut: StepCut,
  row: { readonly itemId?: string | undefined; readonly messageId?: string | undefined },
): boolean {
  return (
    (row.itemId !== undefined && cut.droppedItemIds.has(row.itemId)) ||
    (row.messageId !== undefined && cut.droppedMessageIds.has(row.messageId))
  );
}

/** Fades a timeline row the shown rewind would drop. */
export function useRubatoStepRewindDropped(
  threadKey: string,
  row: { readonly itemId?: string | undefined; readonly messageId?: string | undefined } | undefined,
): boolean {
  return useRewindState(() => {
    const cut = row ? shownCut(threadKey) : undefined;
    return cut !== undefined && row !== undefined && stepRewindDrops(cut, row);
  });
}
export const RUBATO_STEP_DROPPED_CLASS = "opacity-35 transition-opacity duration-150";

const settledRun = (thread: RewindThread, runId: string) => {
  const run = thread.runs.find((entry) => entry.id === runId);
  return run && run.status !== "running" && run.status !== "starting" && run.status !== "preparing" &&
    run.status !== "waiting" && run.status !== "queued"
    ? run
    : undefined;
};

/** Items after `position` in `runId`, and every item of the runs after it. */
function droppedAfter(thread: RewindThread, runId: string, ordinal: number, position: number) {
  const later = new Set(thread.runs.filter((run) => run.ordinal > ordinal).map((run) => run.id));
  const droppedItemIds = new Set<string>();
  const droppedMessageIds = new Set<string>();
  for (const row of thread.items) {
    const item = row.item;
    const inRun = item.runId === runId && row.position > position;
    if (!inRun && !(item.runId !== null && later.has(item.runId))) continue;
    droppedItemIds.add(item.id);
    const messageId = messageIdOf(item);
    if (messageId !== undefined) droppedMessageIds.add(messageId);
  }
  return { droppedItemIds, droppedMessageIds };
}

/** Why a tool row cannot be rewound to, or undefined when it can. */
export function stepRefusal(thread: RewindThread, itemId: string): string | undefined {
  const row = thread.items.find((entry) => entry.item.id === itemId);
  if (!row) return "This step is not in the thread any more.";
  if (!isStep(row.item)) return "Only a finished Rubato step can be rewound to.";
  if (row.item.runId === null || !settledRun(thread, row.item.runId)) return "This run has not finished yet.";
  return undefined;
}

/**
 * The cut a tool row stands for, or why there is none. `cutAfterItemId` is the last row of
 * the step's batch, as the server answered it: calls made together rewind together.
 */
export function stepCutFor(
  thread: RewindThread,
  itemId: string,
  label: string,
  cutAfterItemId: string,
): StepCut | string {
  const refusal = stepRefusal(thread, itemId);
  if (refusal !== undefined) return refusal;
  const row = thread.items.find((entry) => entry.item.id === itemId)!;
  const runId = row.item.runId!;
  const run = settledRun(thread, runId)!;
  // A batch end the thread does not show yet would put the cut in the wrong place: no cut.
  const last = thread.items.find((entry) => entry.item.id === cutAfterItemId && entry.item.runId === runId);
  if (!last) return "This step's calls are not all shown yet.";
  return {
    kind: "step",
    runId,
    anchorId: itemId,
    itemId,
    ...droppedAfter(thread, runId, run.ordinal, Math.max(row.position, last.position)),
    label,
  };
}

/** The last finished Rubato step of a run, or of the given items: what a folded row rewinds to. */
export function lastStepOf(
  thread: RewindThread,
  scope: { readonly runId: string; readonly itemIds?: ReadonlyArray<string | undefined> },
): { readonly itemId: string; readonly label: string } | string {
  const within = scope.itemIds ? new Set(scope.itemIds) : undefined;
  const last = thread.items.findLast(
    (row) => row.item.runId === scope.runId && isStep(row.item) && (within === undefined || within.has(row.item.id)),
  );
  if (!last) return "There is no finished step to rewind to here.";
  return { itemId: last.item.id, label: last.item.title ?? "this step" };
}

/** The cut right after a run's reply: the run stays whole and the runs after it go. */
export function replyCutFor(
  thread: RewindThread,
  reply: { readonly runId: string; readonly messageId: string },
): StepCut | string {
  const run = settledRun(thread, reply.runId);
  if (!run) return "This run has not finished yet.";
  const turnCount = thread.checkpoints.find(
    (checkpoint) => checkpoint.runId === reply.runId && checkpoint.status === "ready",
  )?.appRunOrdinal;
  if (turnCount == null) return "This run has no checkpoint to rewind to.";
  const dropped = droppedAfter(thread, reply.runId, run.ordinal, Number.POSITIVE_INFINITY);
  if (dropped.droppedItemIds.size === 0) return "Nothing comes after this reply.";
  return {
    kind: "turn",
    runId: reply.runId,
    anchorId: reply.messageId,
    turnCount,
    ...dropped,
    label: "this reply",
  };
}

/** Where a rewind button points. */
export type RewindTarget =
  | { readonly kind: "step"; readonly itemId: string | undefined; readonly runId: string | null | undefined }
  | {
      readonly kind: "last-step";
      readonly runId: string | null | undefined;
      readonly itemIds?: ReadonlyArray<string | undefined>;
    }
  | { readonly kind: "reply"; readonly runId: string | null | undefined; readonly messageId: string };

/** Where each step's batch ends, as the server answered: thread key → step → its last row. */
const batchEnds = new Map<string, Map<string, Promise<string>>>();
function batchEndOf(threadKey: string, threadRef: ScopedThreadRef, itemId: string): Promise<string> {
  const known = batchEnds.get(threadKey) ?? new Map<string, Promise<string>>();
  batchEnds.set(threadKey, known);
  const cached = known.get(itemId);
  if (cached) return cached;
  const asked = postRubato<{ cutAfterItemId?: string }>(
    threadRef.environmentId,
    "/rubato/step-rewind",
    "batch",
    { threadId: threadRef.threadId, itemId },
    "step rewinds",
  ).then((answer) => answer.cutAfterItemId ?? itemId);
  // A refusal is asked again next time: the engine may hold the step by then.
  asked.catch(() => known.delete(itemId));
  known.set(itemId, asked);
  return asked;
}

/** The cut a button stands for, or why there is none; a step's batch end comes from the server. */
async function resolveTarget(
  threadKey: string,
  threadRef: ScopedThreadRef,
  target: RewindTarget,
  label: string,
): Promise<StepCut | string> {
  const thread = readThread(threadRef);
  if (!thread) return "This thread is not loaded.";
  if (!target.runId) return "This row belongs to no run.";
  if (target.kind === "reply")
    return replyCutFor(thread, { runId: target.runId, messageId: target.messageId });
  const step =
    target.kind === "step"
      ? target.itemId
        ? { itemId: target.itemId, label }
        : "This row names no step."
      : lastStepOf(thread, { runId: target.runId, ...(target.itemIds ? { itemIds: target.itemIds } : {}) });
  if (typeof step === "string") return step;
  const refusal = stepRefusal(thread, step.itemId);
  if (refusal !== undefined) return refusal;
  const end = await batchEndOf(threadKey, threadRef, step.itemId);
  const now = readThread(threadRef);
  return now ? stepCutFor(now, step.itemId, step.label, end) : "This thread is not loaded.";
}

/** Per visible rows: which steps each run has, and the latest run that has rows. */
interface OfferIndex {
  readonly runs: RewindThread["runs"];
  readonly steps: ReadonlyMap<string, ReadonlySet<string>>;
  readonly latestOrdinal: number;
}
const offerIndexes = new WeakMap<RewindThread["items"], OfferIndex>();
function offerIndexOf(thread: RewindThread): OfferIndex {
  const cached = offerIndexes.get(thread.items);
  if (cached && cached.runs === thread.runs) return cached;
  const ordinals = new Map(thread.runs.map((run) => [run.id, run.ordinal]));
  const steps = new Map<string, Set<string>>();
  let latestOrdinal = Number.NEGATIVE_INFINITY;
  for (const row of thread.items) {
    const runId = row.item.runId;
    if (runId === null) continue;
    latestOrdinal = Math.max(latestOrdinal, ordinals.get(runId) ?? Number.NEGATIVE_INFINITY);
    if (!isStep(row.item)) continue;
    const ids = steps.get(runId) ?? new Set<string>();
    ids.add(row.item.id);
    steps.set(runId, ids);
  }
  const index = { runs: thread.runs, steps, latestOrdinal };
  offerIndexes.set(thread.items, index);
  return index;
}

/** Whether a button can land anywhere: a Rubato step, a folded row with one, a reply with rows after it. */
export function rewindOffered(
  thread: RewindThread | null,
  target: RewindTarget,
  item?: OrchestrationV2TurnItem,
): boolean {
  if (!target.runId) return false;
  if (target.kind === "step") return item !== undefined && isStep(item);
  if (!thread) return false;
  const index = offerIndexOf(thread);
  if (target.kind === "reply") {
    const ordinal = thread.runs.find((run) => run.id === target.runId)?.ordinal;
    return ordinal !== undefined && index.latestOrdinal > ordinal;
  }
  const steps = index.steps.get(target.runId);
  if (!steps) return false;
  return target.itemIds === undefined || target.itemIds.some((id) => id !== undefined && steps.has(id));
}

const noSubscription = () => () => {};
function useRewindOffered(
  threadRef: ScopedThreadRef | null,
  target: RewindTarget,
  item?: OrchestrationV2TurnItem,
): boolean {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  // Steps need no thread: whether the row is a Rubato step is on the row itself.
  const subscribeThread = useCallback((listener: () => void) => {
    if (!threadRef) return () => {};
    const stopItems = appAtomRegistry.subscribe(environmentThreadDetails.visibleTurnItemsAtom(threadRef), listener);
    const stopDetail = appAtomRegistry.subscribe(environmentThreadDetails.threadAtom(threadRef), listener);
    return () => {
      stopItems();
      stopDetail();
    };
    // The ref's identity changes with every render; the thread it names does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, threadId]);
  const read = () =>
    rewindOffered(target.kind === "step" || !threadRef ? null : readThread(threadRef), target, item);
  return useSyncExternalStore(target.kind === "step" ? noSubscription : subscribeThread, read, read);
}

export interface StepRewindSummary {
  readonly steps: number;
  readonly replies: number;
  readonly messages: number;
}

/** What a rewind to `cut` drops, for the card. */
export function stepRewindSummary(thread: RewindThread, cut: StepCut): StepRewindSummary {
  let steps = 0;
  let replies = 0;
  let messages = 0;
  for (const row of thread.items) {
    if (!cut.droppedItemIds.has(row.item.id)) continue;
    if (isTool(row.item)) steps += 1;
    if (row.item.type === "assistant_message") replies += 1;
    if (row.item.type === "user_message") messages += 1;
  }
  return { steps, replies, messages };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
export function describeDropped(summary: StepRewindSummary): string {
  const parts = [
    summary.steps > 0 ? plural(summary.steps, "step") : null,
    summary.messages > 0 ? plural(summary.messages, "message") : null,
    summary.replies > 0 ? plural(summary.replies, "reply", "replies") : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(", ") : "Nothing after this step";
}

/**
 * Lands a rewind and resolves once the thread shows it: the rows it drops are gone. `act`
 * answers which rows those are (the server's list for a step, the preview's for a run).
 */
export function waitForStepRewind(
  threadRef: ScopedThreadRef,
  act: () => Promise<ReadonlySet<string>>,
  timeoutMs = 120_000,
): Promise<void> {
  const itemsAtom = environmentThreadDetails.visibleTurnItemsAtom(threadRef);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let hidden: ReadonlySet<string> | null = null;
    let unsubscribe = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      if (hidden === null) return;
      const items = appAtomRegistry.get(itemsAtom);
      if (!items.some((row) => hidden!.has(row.item.id))) finish();
    };
    unsubscribe = appAtomRegistry.subscribe(itemsAtom, inspect);
    const timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(act)
      .then((ids) => {
        hidden = ids;
        inspect();
      }, finish);
  });
}

function land(host: StepRewindHost, cut: StepCut, restoreFiles: boolean): Promise<void> {
  batchEnds.clear();
  return waitForStepRewind(host.threadRef, async () => {
    if (cut.kind === "turn") {
      await host.revert({ turnCount: cut.turnCount ?? 0, restoreFiles });
      return cut.droppedItemIds;
    }
    const answer = await postRubato<{ hiddenItemIds?: ReadonlyArray<string> }>(
      host.threadRef.environmentId,
      "/rubato",
      "step-rewind",
      { threadId: host.threadRef.threadId, itemId: cut.itemId, restoreFiles },
      "step rewinds",
    );
    return new Set(answer.hiddenItemIds ?? []);
  });
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

/** A run a step rewind cut: upstream's Resume would send a prompt; the card continues instead. */
export function isStepCutRun(
  runs: ReadonlyArray<{ readonly id: string; readonly ordinal: number; readonly status: string }>,
  runId: string,
): boolean {
  const run = runs.find((entry) => entry.id === runId);
  return (
    run !== undefined &&
    runs.some(
      (entry) => entry.ordinal > run.ordinal && entry.status === "rolled_back" && entry.id.includes(":rubato-step-cut:"),
    )
  );
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
  /** A step row's item, to offer only finished Rubato steps. */
  readonly item?: OrchestrationV2TurnItem | undefined;
  readonly label: string;
  readonly busy: boolean;
  readonly reveal?: "row" | "inherit";
}) {
  const { threadKey, threadRef, target, item, label, busy, reveal = "row" } = props;
  const [card, setCard] = useState<{ cut: StepCut; summary: StepRewindSummary } | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(true);
  const anchor =
    target.kind === "step" ? target.itemId : target.kind === "reply" ? target.messageId : undefined;
  const pending = useRewindState(() => {
    const cut = states.get(threadKey)?.pending?.cut;
    return (
      cut !== undefined &&
      (anchor !== undefined ? cut.anchorId === anchor : cut.runId === target.runId)
    );
  });
  const isOffered = useRewindOffered(threadRef, target, item);
  const hovered = useRef(false);
  if (!threadRef || !isOffered || busy) return null;
  const resolve = () => resolveTarget(threadKey, threadRef, target, label);
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
                hovered.current = true;
                void resolve().then(
                  (cut) => {
                    if (hovered.current && typeof cut !== "string") update(threadKey, { preview: cut });
                  },
                  () => {},
                );
              }}
              onPointerLeave={() => {
                hovered.current = false;
                update(threadKey, { preview: undefined });
              }}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                // Open: the trigger closes it.
                if (card !== null) return;
                void resolve()
                  .then((cut) => {
                    const thread = readThread(threadRef);
                    if (typeof cut === "string" || !thread)
                      throw new Error(typeof cut === "string" ? cut : "This thread is not loaded.");
                    setRestoreFiles(true);
                    setCard({ cut, summary: stepRewindSummary(thread, cut) });
                    update(threadKey, { open: cut });
                  })
                  .catch((error: unknown) => failed("Cannot rewind here", error));
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
              <span className="min-w-0">Restore files to this step</span>
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
