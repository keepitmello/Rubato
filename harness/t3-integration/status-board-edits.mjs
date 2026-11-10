// The status board (현황판): a row at the top of the thread sidebar, with how many agents are at
// work, opens a page of every team and subagent in the app's projects: who leads whom, what
// each member last said and how long ago it moved, its recent steps, the team's board and one
// combined log. A member whose turn has been quiet past the threshold shows as stalled; one
// whose process died or was evicted shows as lost, whatever its record says. The Agents panel
// reads the same answer for its rows (agents-surface-edits.mjs), so both views say the same.
//
// - server: src/status-board/{scan,service}.mjs behind /rubato/status-board (RubatoServiceRoute.ts);
//   the clock is session_read's (pi-server session-inspect.mjs lastActivity).
// - web: state/rubatoStatusBoard.ts polls it, one poller for every reader;
//   components/rubatoLiveness.ts is the rule, rubatoStatusBoardModel.ts the page model,
//   RubatoStatusBoardPage.tsx the page and sidebar/RubatoStatusBoardEntry.tsx the row;
//   routes/board.tsx is the page (its route-tree lines are in route-tree-edits.mjs).
// Registered after the sidebar edits it sits beside.
export const statusBoardOverlays = [
  'apps/web/src/state/rubatoStatusBoard.ts',
  'apps/web/src/components/rubatoLiveness.ts',
  'apps/web/src/components/rubatoLiveness.test.ts',
  'apps/web/src/components/rubatoStatusBoardModel.ts',
  'apps/web/src/components/rubatoStatusBoardModel.test.ts',
  'apps/web/src/components/rubatoBoardFolders.ts',
  'apps/web/src/components/sidebar/RubatoStatusBoardEntry.tsx',
  'apps/web/src/components/RubatoStatusBoardPage.tsx',
  'apps/web/src/routes/board.tsx',
  'apps/web/src/components/RubatoAgentsPanel.liveness.test.tsx',
];

export const statusBoardEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoStatusBoardRouteLayer } from "./RubatoServiceRoute.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoStatusBoardRouteLayer,\n'],
  ],
  'apps/web/src/components/Sidebar.tsx': [
    ['import { RubatoRecentBox } from "./sidebar/RubatoRecentBox";\n',
      'import { RubatoStatusBoardEntry } from "./sidebar/RubatoStatusBoardEntry";\n'],
    ['              onClearSearch={clearThreadSearch}\n            />\n          </SidebarGroup>\n        }\n', [
      '              onClearSearch={clearThreadSearch}',
      '            />',
      '            {/* Rubato: the status board and how many agents are at work (status-board-edits.mjs). */}',
      '            {isMobile ? null : <RubatoStatusBoardEntry />}',
      '          </SidebarGroup>',
      '        }',
      '',
    ].join('\n'), 'replace'],
  ],
};
