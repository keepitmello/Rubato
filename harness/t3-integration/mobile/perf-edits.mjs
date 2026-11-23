// Mobile thread feed performance: keep buildThreadFeed's incremental prefix cache intact when
// streaming emits node.updated / attempt.updated without changing existing topology.
// buildThreadFeed only reads node.id / node.rootNodeId / node.parentNodeId and
// attempt.id / attempt.runId / attempt.rootNodeId to resolve attemptId for existing rows.
export const mobilePerfOverlays = ['apps/mobile/src/lib/rubatoThreadFeedReuse.test.ts'];

export const mobilePerfEdits = {
  'apps/mobile/src/Stack.tsx': [
    [
      '  const path = getPathFromState(effectiveState, navigationPathConfig);',
      '  const path = rootPathnameFromState(effectiveState);', 'replace',
    ],
    [
      'export function rootPathnameFromState(state: NavigationState): string {\n  const path = getPathFromState(state, navigationPathConfig);\n  return path.startsWith("/") ? path : `/${path}`;\n}',
      `// Root layout, workspace chrome and notification routing read the same immutable state.
const pathByNavigationState = new WeakMap<NavigationState, string>();
export function rootPathnameFromState(state: NavigationState): string {
  const known = pathByNavigationState.get(state);
  if (known !== undefined) return known;
  const path = getPathFromState(state, navigationPathConfig);
  const absolute = path.startsWith("/") ? path : \`/\${path}\`;
  pathByNavigationState.set(state, absolute);
  return absolute;
}`, 'replace',
    ],
  ],
  'apps/mobile/src/lib/threadActivity.ts': [
    [
      '  const foldedAnswerRunIdByMessageId = new Map<string, RunId | null>();',
      '  const compactPromptRunIds = new Set<RunId>();\n  const compactedRunIds = new Set<RunId>();\n',
    ],
    [
      '    if (item.type === "user_input_request" && item.questionAnswer) {',
      `    // Collect the compaction pair in the existing pass over history. Avoid cloning every
    // prompt each time a new fragment arrives on the last assistant row.
    if (item.runId !== null) {
      if (item.type === "user_message" && isCompactionCommandMessage({ role: "user", text: item.text, attachments: item.attachments })) {
        compactPromptRunIds.add(item.runId);
      } else if (item.type === "compaction") {
        compactedRunIds.add(item.runId);
      }
    }
`,
    ],
    [
      `  // A stopped compaction's own row already says it stopped. A \`/compact\` run stopped
  // before its provider started has no such row, so it keeps the interrupted one.
  const compactPromptRunIds = new Set<RunId>();
  const compactedRunIds = new Set<RunId>();
  for (const { item } of visibleTurnItems) {
    if (item.runId === null) continue;
    if (item.type === "user_message" && isCompactionCommandMessage({ role: "user", ...item })) {
      compactPromptRunIds.add(item.runId);
    } else if (item.type === "compaction") {
      compactedRunIds.add(item.runId);
    }
  }
  for (let index = restart?.row ?? 0; index < visibleTurnItems.length; index += 1) {`,
      '  for (let index = restart?.row ?? 0; index < visibleTurnItems.length; index += 1) {',
      'replace',
    ],
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
