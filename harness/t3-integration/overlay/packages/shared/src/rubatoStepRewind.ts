import { compareDateTimeStrings } from "./dateTime.ts";

// Where a rewind to a finished tool step lands, read from its turn's tool rows. The
// server cuts by it, and the app previews the same cut and waits for it to show, so both
// use this one rule. Calls made together answer together, so a step is the whole batch
// the Rubato bridge tags with one `rubatoStep`; a row without the tag is a step alone.

export interface StepRewindActivity {
  readonly kind: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
}

export interface StepRewindTarget {
  readonly turnId: string;
  readonly toolCallId: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
/** The call a tool row stands for. */
export const stepCallOf = (activity: StepRewindActivity): string | undefined =>
  text(record(activity.payload)?.toolCallId);
const batchOf = (activity: StepRewindActivity): string | undefined =>
  text(record(record(activity.payload)?.data)?.rubatoStep);
const later = (left: string, right: string) =>
  compareDateTimeStrings(right, left) > 0 ? right : left;

export interface StepRewindCut<Step extends StepRewindTarget, At extends string> {
  readonly cut: {
    readonly turnId: Step["turnId"];
    readonly toolCallId: Step["toolCallId"];
    readonly after: At;
  };
  /** The call that finished last in the step: its snapshot holds the files the step left. */
  readonly snapshotCall: string;
  /** Every call of the step. */
  readonly calls: ReadonlyArray<string>;
}

/**
 * When the step `step` names finished: the latest of its rows. Answers the reason as text
 * when a rewind cannot land there.
 */
export function revertCutFor<
  Step extends StepRewindTarget,
  Activity extends StepRewindActivity,
>(input: {
  readonly step: Step;
  readonly turnCount: number;
  readonly checkpoints: ReadonlyArray<{
    readonly turnId: string;
    readonly checkpointTurnCount: number;
  }>;
  readonly activities: ReadonlyArray<Activity>;
}): StepRewindCut<Step, Activity["createdAt"]> | string {
  const { step } = input;
  if (
    !input.checkpoints.some(
      (checkpoint) =>
        checkpoint.turnId === step.turnId && checkpoint.checkpointTurnCount === input.turnCount,
    )
  ) {
    return "This step is not in the turn the rewind keeps.";
  }
  const rows = input.activities.filter(
    (activity) =>
      activity.turnId === step.turnId &&
      (activity.kind === "tool.completed" || activity.kind === "tool.updated"),
  );
  const picked = rows.filter((activity) => stepCallOf(activity) === step.toolCallId);
  const batch = picked.map(batchOf).find((value) => value !== undefined);
  const stepRows =
    batch === undefined ? picked : rows.filter((activity) => batchOf(activity) === batch);
  const finished = new Map<string, string>();
  for (const activity of stepRows) {
    const call = stepCallOf(activity);
    if (activity.kind !== "tool.completed" || call === undefined) continue;
    const previous = finished.get(call);
    finished.set(
      call,
      previous === undefined ? activity.createdAt : later(previous, activity.createdAt),
    );
  }
  const calls = [...new Set(stepRows.map(stepCallOf).filter((call) => call !== undefined))];
  if (!finished.has(step.toolCallId) || calls.some((call) => !finished.has(call))) {
    return "This step has not finished, so there is nothing to rewind to.";
  }
  let after = stepRows[0]!.createdAt as Activity["createdAt"];
  for (const activity of stepRows)
    after = later(after, activity.createdAt) as Activity["createdAt"];
  let snapshotCall = step.toolCallId;
  for (const [call, completedAt] of finished) {
    if (compareDateTimeStrings(completedAt, finished.get(snapshotCall) ?? completedAt) > 0)
      snapshotCall = call;
  }
  return { cut: { turnId: step.turnId, toolCallId: step.toolCallId, after }, snapshotCall, calls };
}
