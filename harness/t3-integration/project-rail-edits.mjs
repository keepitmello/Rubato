// The project rail and the project-aware home (intent sidebar-rail-home).
//
// T3's new sidebar is one time-ordered list; the legacy tree groups by project
// but loses recency. Rubato keeps the new sidebar and adds a rail to its left:
//
// - The rail (sidebar/RubatoProjectRail.tsx): app controls only. Home, one
//   Projects button whose window lists projects by name and edits the list
//   (sidebar/RubatoProjectPicker.tsx), narrowing the thread list through the
//   scope key T3's own project filter already persists
//   (uiStateStore.sidebarProjectScopeKey); then the pages (scheduled tasks,
//   memory, pull requests, usage, settings), which replace the sidebar's
//   footer row. AppSidebarLayout places it before the sidebar and moves the
//   fixed sidebar one rail to the right; collapsing the sidebar leaves the
//   rail. Only with the new sidebar: the legacy tree keeps its layout.
// - The Recent box (sidebar/RubatoRecentBox.tsx): while one project is
//   selected, the head of the all-projects inbox stays above the narrowed list.
// - The home row (chat/RubatoHomeProjects.tsx): on the new-thread screen, the
//   project tabs and the selected project's newest threads along the bottom,
//   inside the composer's width; the composer stays centered.
// - Memory and Scheduled Tasks leave Settings for their own pages
//   (routes/memory.tsx, routes/scheduled.tsx; the route tree in
//   route-tree-edits.mjs). Their Settings addresses redirect there, so the
//   Settings nav drops them.
//
// The project window and the home tabs share one project list (sidebar/rubatoProjectList.ts).
export const projectRailOverlays = [
  'apps/web/src/components/sidebar/rubatoProjectRail.logic.ts',
  'apps/web/src/components/sidebar/rubatoProjectRail.logic.test.ts',
  'apps/web/src/components/sidebar/rubatoProjectList.ts',
  'apps/web/src/components/sidebar/RubatoProjectRail.tsx',
  'apps/web/src/components/sidebar/RubatoProjectPicker.tsx',
  'apps/web/src/components/sidebar/RubatoScopeLabel.tsx',
  'apps/web/src/components/sidebar/RubatoThreadLine.tsx',
  'apps/web/src/components/sidebar/RubatoRecentBox.tsx',
  'apps/web/src/components/chat/RubatoHomeProjects.tsx',
  'apps/web/src/components/RubatoStandalonePage.tsx',
  'apps/web/src/routes/memory.tsx',
  'apps/web/src/routes/scheduled.tsx',
];

export const projectRailEdits = {
  // The fixed sidebar starts at --sidebar-offset-left instead of the window edge,
  // and slides under the rail when it collapses. Unset, the offset is 0 and the
  // sidebar behaves as upstream's.
  'apps/web/src/components/ui/sidebar.tsx': [
    [
      '              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"\n',
      '              ? "left-[var(--sidebar-offset-left,0px)] group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-offset-left,0px)-var(--sidebar-width))]"\n',
      'replace',
    ],
  ],
  'apps/web/src/components/AppSidebarLayout.tsx': [
    ['import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";\n',
      'import { RubatoProjectRail, RUBATO_RAIL_TITLEBAR_STYLE } from "./sidebar/RubatoProjectRail";\n'],
    [
      '  const legacySidebarEnabled = useLegacySidebarEnabled();\n',
      '  const legacySidebarEnabled = useLegacySidebarEnabled();\n  // The project rail sits beside the new sidebar only (project-rail-edits.mjs).\n  const rubatoRailShown = !legacySidebarEnabled;\n',
      'replace',
    ],
    ['    ...windowControlsInsetStyle,\n', '    ...(rubatoRailShown ? RUBATO_RAIL_TITLEBAR_STYLE : {}),\n'],
    [
      '        className="h-dvh! min-h-0!"\n',
      '        className={cn("h-dvh! min-h-0!", rubatoRailShown && "md:[--sidebar-offset-left:52px]")}\n',
      'replace',
    ],
    ['        <Sidebar\n          side="left"\n', '        {rubatoRailShown ? <RubatoProjectRail /> : null}\n'],
  ],
  // The rail carries Settings, Pull Requests and Usage; the footer row would
  // repeat them. Phones have no rail, so their sheet keeps the row.
  'apps/web/src/components/sidebar/SidebarChrome.tsx': [
    [
      'import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";\n',
      'import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../../hooks/useSettings";\n',
      'replace',
    ],
    [
      '  const { isMobile, setOpenMobile } = useSidebar();\n',
      '  const { isMobile, setOpenMobile } = useSidebar();\n  const rubatoRailShown = !useLegacySidebarEnabled() && !isMobile;\n',
      'replace',
    ],
    ['      {isOnUtilityPage ? (\n', '      {rubatoRailShown ? null : isOnUtilityPage ? (\n', 'replace'],
  ],
  'apps/web/src/components/Sidebar.tsx': [
    // The rail narrows the list on desktop, so the project filter beside the
    // search field would be a second control for the same thing. Phones keep it.
    [
      '              projectScope={\n                <Combobox\n',
      '              projectScope={\n                // Rubato: the rail narrows the list on desktop (project-rail-edits.mjs).\n                isMobile ? (\n                <Combobox\n',
      'replace',
    ],
    [
      '                </Combobox>\n              }\n              onNewProject={openAddProjectCommandPalette}\n',
      '                </Combobox>\n                ) : null\n              }\n              onNewProject={openAddProjectCommandPalette}\n',
      'replace',
    ],
    ['import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";\n',
      [
        'import { RubatoRecentBox } from "./sidebar/RubatoRecentBox";',
        'import { RubatoScopeLabel } from "./sidebar/RubatoScopeLabel";',
        'import { selectRecentThreads } from "./sidebar/rubatoProjectRail.logic";',
        '',
      ].join('\n')],
    ['  const threadSearchInputRef = useRef<HTMLInputElement>(null);\n',
      [
        '  // Rubato: the head of the all-projects inbox, kept above the list while one',
        '  // project is selected (RubatoRecentBox, project-rail-edits.mjs).',
        '  const rubatoRecentThreads = useMemo(() => {',
        '    void nowMinute;',
        '    if (scopedProjectKeys === null) return [];',
        '    const capabilities = (thread: EnvironmentThreadShell) =>',
        '      serverConfigs.get(thread.environmentId)?.environment.capabilities;',
        '    return selectRecentThreads({',
        '      threads,',
        '      supportsSettlement: (thread) => capabilities(thread)?.threadSettlement === true,',
        '      supportsSnooze: (thread) => capabilities(thread)?.threadSnooze === true,',
        '      workingShelfEnabled,',
        '      returnedAt: workingShelfEnabled ? inboxReturns.returnedAt : undefined,',
        '      now: new Date().toISOString(),',
        '    });',
        '  }, [nowMinute, scopedProjectKeys, serverConfigs, threads, workingShelfEnabled]);',
        '',
      ].join('\n')],
    ['          {!isSearchingThreads ? (\n            <TooltipProvider\n              key="sidebar-thread-tooltips-150"\n',
      [
        '          {!isSearchingThreads && rubatoRecentThreads.length > 0 ? (',
        '            <RubatoRecentBox',
        '              threads={rubatoRecentThreads}',
        '              projectFor={(thread) =>',
        '                projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null',
        '              }',
        '              activeThreadKey={routeThreadKey}',
        '              {...(isMobile ? { onNavigate: () => setOpenMobile(false) } : {})}',
        '            />',
        '          ) : null}',
        '',
      ].join('\n')],
    // Projects are off the rail, so the narrowed list names its project under
    // the search field, with a way back to all projects.
    [
      '          </SidebarGroup>\n        }\n      >\n        <SidebarGroup className="flex-1" role="presentation">\n',
      [
        '            {!isMobile && scopedProjectGroup !== null ? (',
        '              <RubatoScopeLabel group={scopedProjectGroup} onClear={() => setProjectScopeKey(null)} />',
        '            ) : null}',
        '',
      ].join('\n'),
    ],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";\n',
      'import { RubatoHomeProjects } from "./chat/RubatoHomeProjects";\n'],
    // Absolutely placed along the bottom of the centered overlay, so the
    // composer's centering is untouched unless the window is too short.
    ['              <div\n                ref={draftHeroTransition.transitionGroupRef}\n',
      [
        '              {isDraftHeroState ? (',
        '                <RubatoHomeProjects draftId={draftId} activeProjectRef={activeProjectRef} />',
        '              ) : null}',
        '',
      ].join('\n')],
  ],
  // Memory and Scheduled Tasks have their own pages now; their Settings
  // addresses only redirect. Anchored on schedule-edits.mjs's version of the line.
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    [
      '  .filter((to) => to !== "/settings/diagnostics" && to !== "/settings/scheduled-tasks")\n',
      [
        '  .filter(',
        '    (to) =>',
        '      to !== "/settings/diagnostics" &&',
        '      to !== "/settings/scheduled-tasks" &&',
        '      // Rubato: on the rail as their own pages (project-rail-edits.mjs).',
        '      to !== "/settings/memory" &&',
        '      to !== "/settings/scheduled",',
        '  )',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
};
