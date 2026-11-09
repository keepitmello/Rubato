// Work cards (chat/RubatoWorkCard.tsx, intent memory-redesign-work-cards): when a conversation
// starts or forks another one (session_create, session_fork), the chat shows a card for the
// launched conversation that follows it live — working, waiting for the person, done, failed or
// stopped — with its title, model, last update and "Open thread".
//
// - In an ordinary thread the call arrives as a dynamic tool item. It becomes a standalone row, as
//   T3 does for a subagent or a fork, so a finished turn's "Worked for" fold leaves it visible
//   (session-logic.ts), and that row is drawn as the card (MessagesTimeline.tsx).
// - A companion's room reads the same calls from its session file (bridge companion/inner.mjs)
//   and draws the card itself (RubatoSegnoChat.tsx, companion overlays).
// Agent, task and team_create rows stay as agents-surface-edits.mjs draws them.
export const workCardOverlays = [
  'apps/web/src/components/chat/rubatoWorkCardModel.ts',
  'apps/web/src/components/chat/rubatoWorkCardModel.test.ts',
  'apps/web/src/components/chat/RubatoWorkCard.tsx',
  'apps/web/src/components/chat/RubatoWorkCard.test.tsx',
];

export const workCardEdits = {
  'apps/web/src/session-logic.ts': [
    ['import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";\n',
      'import { isRubatoLaunchItem } from "./components/chat/rubatoWorkCardModel";\n'],
    ['    entry.kind === "event" && PERSISTENT_RESOURCE_V2_ITEM_TYPES.has(entry.projectedItem.item.type)\n',
      '    entry.kind === "event" &&\n'
        + '    (PERSISTENT_RESOURCE_V2_ITEM_TYPES.has(entry.projectedItem.item.type) ||\n'
        + '      // Rubato: a work card outlives its launching turn (work-card-edits.mjs).\n'
        + '      isRubatoLaunchItem(entry.projectedItem.item))\n',
      'replace'],
    ['    if (STANDALONE_V2_ITEM_TYPES.has(item.type)) {\n',
      '    // Rubato: session_create / session_fork stand alone as work cards (work-card-edits.mjs).\n'
        + '    if (STANDALONE_V2_ITEM_TYPES.has(item.type) || isRubatoLaunchItem(item)) {\n',
      'replace'],
  ],
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    ['import { formatDuration } from "@t3tools/shared/orchestrationTiming";\n',
      'import { RubatoTimelineWorkCard } from "./RubatoWorkCard";\nimport { isRubatoLaunchItem } from "./rubatoWorkCardModel";\n'],
    ['  const { item, visibility, sourceThreadId } = row.projectedItem;\n',
      '  const { item, visibility, sourceThreadId } = row.projectedItem;\n'
        + '  // Rubato: a launched conversation\'s card (work-card-edits.mjs).\n'
        + '  if (isRubatoLaunchItem(item))\n'
        + '    return <RubatoTimelineWorkCard projectedItem={row.projectedItem} environmentId={ctx.activeThreadEnvironmentId} />;\n',
      'replace'],
  ],
};
