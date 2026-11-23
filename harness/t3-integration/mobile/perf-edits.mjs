// Mobile thread feed performance: keep buildThreadFeed's incremental prefix cache intact when
// streaming emits node.updated / attempt.updated without changing existing topology.
// buildThreadFeed only reads node.id / node.rootNodeId / node.parentNodeId and
// attempt.id / attempt.runId / attempt.rootNodeId to resolve attemptId for existing rows.
export const mobilePerfOverlays = ['apps/mobile/src/lib/rubatoThreadFeedReuse.test.ts'];

export const mobilePerfEdits = {
  'apps/mobile/src/lib/threadActivity.ts': [
    [
      '  readonly feed: ReadonlyArray<ThreadFeedEntry>;\n  /** Grouping is empty',
      '  readonly feed: ThreadFeedEntry[];\n  /** Grouping is empty',
      'replace',
    ],
    [
      '  const locale = options?.locale;\n',
      `  const locale = options?.locale;
  // Composer, scroll and chrome updates are not new conversation events.
  const unchanged = options?.cache?.feedBuild;
  if (unchanged && anchoredMessages.length === 0 && unchanged.rows === visibleTurnItems &&
      unchanged.locale === locale && unchanged.nodes === options?.nodes &&
      unchanged.attempts === options?.attempts && unchanged.checkpointSummaries === options?.checkpointSummaries) {
    return unchanged.feed;
  }
`,
      'replace',
    ],
    [
      '/** Index of the first entry that differs, or the shorter length when one extends the other. */\n',
      `function attemptTopologyUnchanged(
  previous: ReadonlyArray<OrchestrationV2RunAttempt> | undefined,
  next: ReadonlyArray<OrchestrationV2RunAttempt> | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined || next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index]!;
    const b = next[index]!;
    if (a === b) continue;
    if (a.id !== b.id || a.runId !== b.runId || a.rootNodeId !== b.rootNodeId) return false;
  }
  return true;
}

function nodeTopologyUnchanged(
  previous: ReadonlyArray<OrchestrationV2ExecutionNode> | undefined,
  next: ReadonlyArray<OrchestrationV2ExecutionNode> | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined || next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index]!;
    const b = next[index]!;
    if (a === b) continue;
    if (a.id !== b.id || a.rootNodeId !== b.rootNodeId || a.parentNodeId !== b.parentNodeId) {
      return false;
    }
  }
  return true;
}

`,
    ],
    [
      '    previous.attempts === options?.attempts &&\n    previous.nodes === options?.nodes &&\n',
      '    attemptTopologyUnchanged(previous.attempts, options?.attempts) &&\n    nodeTopologyUnchanged(previous.nodes, options?.nodes) &&\n',
      'replace',
    ],
  ],
  'apps/mobile/src/state/use-thread-composer-state.ts': [
    ['import { useEffect, useRef, useState } from "react";', 'import { useEffect, useMemo, useRef, useState } from "react";', 'replace'],
    [`  const selectedThreadQueuedMessages = selectedThreadKey
    ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
        (message) => message.creation === undefined,
      )
    : [];`,
    `  const threadQueue = selectedThreadKey ? queuedMessagesByThreadKey[selectedThreadKey] : undefined;
  const selectedThreadQueuedMessages = useMemo(
    () => threadQueue?.filter((message) => message.creation === undefined) ?? [],
    [threadQueue],
  );`, 'replace'],
  ],
};
