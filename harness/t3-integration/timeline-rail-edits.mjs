// The timeline rail at an ordinary thread's left edge (user 1d2f3875: "타임라인이 무수하게 쌓여있는데
// 날짜 단위로 간격? 구분되는 단위를 좀 두고").
//
// T3's TimelineMinimap fits every turn into one column the height of the screen, so once a thread runs
// to a few hundred turns its marks touch and the pointer can no longer pick one. The thread draws
// Rubato's rail in its place (overlay RubatoTimelineRail.tsx): marks keep their spacing, the rail
// scrolls past its height and follows the reader, and a new day starts with the day's name. The
// thread hands the rail each turn's time from its user message. A companion's room draws the same
// rail on its own (RubatoSegnoChat.tsx), so T3's TimelineMinimap stays only as code nothing renders.
export const timelineRailOverlays = [
  'apps/web/src/components/chat/RubatoTimelineRail.tsx',
  'apps/web/src/components/chat/RubatoTimelineRail.test.tsx',
  'apps/web/src/components/chat/rubatoTimelineRail.logic.ts',
  'apps/web/src/components/chat/rubatoTimelineRail.logic.test.ts',
];

export const timelineRailEdits = {
  'apps/web/src/components/chat/MessagesTimeline.tsx': [
    // Nothing renders T3's TimelineMinimap now; exported, it stays a module export rather than an unused local.
    ['function TimelineMinimap({\n', 'export function TimelineMinimap({\n', 'replace'],
    ['import {\n  deriveTimelineMinimapItems,\n',
      'import { RubatoTimelineRail } from "./RubatoTimelineRail";\n'
        + 'import { rubatoTimelineItemTimes } from "./rubatoTimelineRail.logic";\n'],
    ['  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);\n',
      '  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);\n'
        + '  // Rubato: each mark\'s time, so the rail names the days (timeline-rail-edits.mjs).\n'
        + '  const rubatoMinimapTimes = useMemo(() => rubatoTimelineItemTimes(rows, minimapItems), [rows, minimapItems]);\n',
      'replace'],
    ['            <TimelineMinimap\n              items={minimapItems}\n',
      '            <RubatoTimelineRail\n              items={minimapItems}\n              times={rubatoMinimapTimes}\n',
      'replace'],
  ],
};
