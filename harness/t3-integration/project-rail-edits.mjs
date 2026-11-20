// The project rail and the project-aware home (intent sidebar-rail-home).
//
// T3's new sidebar is one time-ordered list; the legacy tree groups by project
// but loses recency. Rubato keeps the new sidebar and adds a rail to its left:
//
// - The rail (sidebar/RubatoProjectRail.tsx): app controls only. Home, one
//   Projects button whose window lists projects by name and edits the list
//   (sidebar/RubatoProjectPicker.tsx), narrowing the thread list through the
//   scope key T3's own project filter already persists
//   (uiStateStore.sidebarProjectScopeKeys, one key from the rail); then the
//   pages (scheduled tasks,
//   memory, pull requests, usage, settings), which replace the sidebar's
//   footer row. AppSidebarLayout places it before the sidebar and moves the
//   fixed sidebar one rail to the right; collapsing the sidebar leaves the
//   rail. The rail shows wherever the sidebar does.
// - The Recent box (sidebar/RubatoRecentBox.tsx): while one project is
//   selected, the head of the all-projects inbox stays in the sidebar, as many
//   rows as the client setting rubatoRecentLimit. It and the project's title
//   are sections of the thread list (sidebar-blocks-edits.mjs); only an empty
//   list shows them here, above where the list would be.
// - The home filter (sidebar/RubatoHomeProjectFilter.tsx): with no project
//   selected, a button beside Add project checks which projects the
//   all-projects list shows. Unchecked ones leave that list and the Recent
//   box; pinned threads and search keep them.
// - The home row (chat/RubatoHomeProjects.tsx): on the new-thread screen, the
//   project tabs and the selected project's newest threads along the bottom,
//   inside the composer's width; the composer stays centered. Off by default:
//   the client setting rubatoHomeProjects turns it on (Settings > Threads &
//   Projects, settings/RubatoHomeProjectsSetting.tsx).
// - New thread inside a project: while the list is narrowed to one project,
//   the sidebar's new-thread button and chat.new open the thread in that
//   project instead of the "New thread in..." picker
//   (rubatoProjectRail.logic.ts scopedNewThreadProjectRef). Shift+click and
//   chat.newLocal keep T3's "current thread's project".
// - Memory and Scheduled Tasks leave Settings for their own pages
//   (routes/memory.tsx, routes/scheduled.tsx; the route tree in
//   route-tree-edits.mjs). Their Settings addresses redirect there. The nav
//   lists what settingsSearch lists, so these never appear in it; upstream's
//   own Settings > Scheduled tasks page now shares that address and stays in
//   the nav (a UX decision, not this module's).
//
// The project window and the home tabs share one project list (sidebar/rubatoProjectList.ts),
// whose order every other project list follows too (project-order-edits.mjs).
export const projectRailOverlays = [
  'apps/web/src/components/sidebar/rubatoProjectRail.logic.ts',
  'apps/web/src/components/sidebar/rubatoProjectRail.logic.test.ts',
  'apps/web/src/components/sidebar/rubatoProjectList.ts',
  'apps/web/src/components/sidebar/RubatoProjectRail.tsx',
  'apps/web/src/components/sidebar/rubatoCompanionRailAction.ts',
  'apps/web/src/components/sidebar/RubatoProjectPicker.tsx',
  'apps/web/src/components/sidebar/RubatoScopeLabel.tsx',
  'apps/web/src/components/sidebar/RubatoThreadLine.tsx',
  'apps/web/src/components/sidebar/RubatoRecentBox.tsx',
  'apps/web/src/components/sidebar/RubatoHomeProjectFilter.tsx',
  'apps/web/src/components/chat/RubatoHomeProjects.tsx',
  'apps/web/src/components/settings/RubatoHomeProjectsSetting.tsx',
  'apps/web/src/components/settings/RubatoHomeProjectsSetting.test.ts',
  'apps/web/src/components/RubatoStandalonePage.tsx',
  'apps/web/src/routes/memory.tsx',
  'apps/web/src/routes/scheduled.tsx',
];

export const projectRailEdits = {
  // The fixed sidebar starts at --sidebar-offset-left instead of the window edge.
  // Collapsed, it parks a full width off-screen as upstream's does, not at
  // offset - width: that left its last 52px behind the rail, and the rail's
  // translucent window material showed the thread list's times and icons
  // through the rail's own buttons. Unset, the offset is 0 and the sidebar
  // behaves as upstream's.
  'apps/web/src/components/ui/sidebar.tsx': [
    [
      '              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"\n',
      '              ? "left-[var(--sidebar-offset-left,0px)] group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]"\n',
      'replace',
    ],
  ],
  'apps/web/src/components/AppSidebarLayout.tsx': [
    ['import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";\n',
      'import { RubatoProjectRail, RUBATO_RAIL_TITLEBAR_STYLE } from "./sidebar/RubatoProjectRail";\n'],
    // v0.1.11 keeps one sidebar (the legacy tree is gone), so the rail needs no
    // switch; it follows the sidebar itself.
    ['    ...windowControlsInsetStyle,\n', '    ...(showSidebar ? RUBATO_RAIL_TITLEBAR_STYLE : {}),\n'],
    [
      '        className="h-dvh! min-h-0!"\n',
      '        className={cn("h-dvh! min-h-0!", showSidebar && "md:[--sidebar-offset-left:52px]")}\n',
      'replace',
    ],
    [
      '            <Sidebar\n              side="left"\n',
      '            <RubatoProjectRail />\n            <Sidebar\n              side="left"\n',
      'replace',
    ],
  ],
  // The rail carries Settings, Pull Requests and Usage; the footer row would
  // repeat them. Phones have no rail, so their sheet keeps the row.
  'apps/web/src/components/sidebar/SidebarChrome.tsx': [
    [
      '  const { isMobile, setOpenMobile } = useSidebar();\n',
      '  const { isMobile, setOpenMobile } = useSidebar();\n  const rubatoRailShown = !isMobile; // the rail replaces this row (project-rail-edits.mjs)\n',
      'replace',
    ],
    ['      {isOnUtilityPage ? (\n', '      {rubatoRailShown ? null : isOnUtilityPage ? (\n', 'replace'],
  ],
  // The Recent box folds running threads into the Working shelf as the sidebar does
  // (sidebar/rubatoProjectRail.logic.ts reads the sidebar's own logic module).
  'apps/web/src/components/Sidebar.logic.ts': [
    ['export {\n  sortInboxThreadsByReturn,\n  sortWorkingThreadsBySend,\n} from "@t3tools/client-runtime/state/thread-inbox";\n',
      'export {\n  isThreadWorking as isSidebarThreadWorking,\n  sortInboxThreadsByReturn,\n  sortWorkingThreadsBySend,\n} from "@t3tools/client-runtime/state/thread-inbox";\n',
      'replace'],
  ],
  'apps/web/src/components/Sidebar.tsx': [
    [
      '  const handleNewThreadClick = (event?: ReactMouseEvent) => {\n',
      [
        '  const handleNewThreadClick = (event?: ReactMouseEvent) => {',
        '    // Rubato: inside the selected project, open the thread there instead',
        '    // of asking which project (project-rail-edits.mjs).',
        '    const rubatoScopedRef = event?.shiftKey',
        '      ? null',
        '      : scopedNewThreadProjectRef({',
        '          group: scopedProjectGroup,',
        '          contextProjectRef:',
        '            newThreadContext.activeThread ?? newThreadContext.activeDraftThread ?? null,',
        '        });',
        '    if (rubatoScopedRef !== null) {',
        '      if (isMobile) setOpenMobile(false);',
        '      void newThreadContext.handleNewThread(rubatoScopedRef);',
        '      return;',
        '    }',
        '',
      ].join('\n'),
      'replace',
    ],
    // The rail narrows the list on desktop, so the project filter beside the
    // search field would be a second control for the same thing. Phones keep it.
    [
      '              projectScope={\n                <Combobox\n',
      '              projectScope={\n                // Rubato: the rail narrows the list on desktop (project-rail-edits.mjs).\n                isMobile ? (\n                <Combobox\n',
      'replace',
    ],
    [
      '                </Combobox>\n              }\n              onNewProject={openAddProjectCommandPalette}\n',
      '                </Combobox>\n                ) : scopedProjectGroup === null ? (\n                  <RubatoHomeProjectFilter groups={projectGroups} threads={threads} />\n                ) : null\n              }\n              onNewProject={openAddProjectCommandPalette}\n',
      'replace',
    ],
    // Home's header filter: the projects the user unchecked leave the
    // all-projects list and the Recent box (RubatoHomeProjectFilter.tsx).
    [
      '  const threads = useQuietThreadShells();\n',
      [
        '  const threads = useQuietThreadShells();',
        '  // Rubato: the all-projects list without the projects the user unchecked',
        '  // (RubatoHomeProjectFilter, project-rail-edits.mjs).',
        '  const { hidden: rubatoHiddenProjects } = useRubatoHomeHiddenProjects();',
        '  const rubatoAllProjectsThreads = withoutHiddenProjects(',
        '    threads,',
        '    projectGroups,',
        '    rubatoHiddenProjects,',
        '  );',
        '',
      ].join('\n'),
      'replace',
    ],
    // v0.1.11 partitions the list in a standalone function, so the narrowing goes
    // in where the component hands it the threads.
    [
      '    threads: listedThreads,\n',
      [
        '    threads:',
        '      scopedProjectKeys === null',
        '        ? withoutHiddenProjects(listedThreads, projectGroups, rubatoHiddenProjects)',
        '        : listedThreads,',
        '',
      ].join('\n'),
      'replace',
    ],
    // v0.1.11 narrows to a set of projects; the rail selects one, and the rest of
    // this module keeps speaking of that one project.
    [
      '  const scopedProjectRefs = scopedProjectGroups.flatMap((project) => project.memberProjectRefs);\n',
      '  // Rubato: the project the sidebar is narrowed to (project-rail-edits.mjs).\n  const scopedProjectGroup =\n    scopedProjectGroups.length === 1 ? (scopedProjectGroups[0] ?? null) : null;\n',
    ],
    ['import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";\n',
      [
        'import { RubatoHomeProjectFilter, useRubatoHomeHiddenProjects } from "./sidebar/RubatoHomeProjectFilter";',
        'import { RubatoRecentBox } from "./sidebar/RubatoRecentBox";',
        'import { RubatoScopeLabel } from "./sidebar/RubatoScopeLabel";',
        'import {',
        '  scopedNewThreadProjectRef,',
        '  selectRecentThreads,',
        '  withoutHiddenProjects,',
        '} from "./sidebar/rubatoProjectRail.logic";',
        'import { clampRecentLimit } from "./sidebar/rubatoSidebarBlocks";',
        '',
      ].join('\n')],
    // After the list's own hook, whose minute clock re-renders this component.
    ['  // Ranked across environments as the palette ranks them, so one\n',
      [
        '  // Rubato: the head of the all-projects inbox, kept in the sidebar while one',
        '  // project is selected (RubatoRecentBox, project-rail-edits.mjs).',
        '  const rubatoRecentLimit = useClientSettings((settings) => settings.rubatoRecentLimit);',
        '  const rubatoCapabilities = (thread: EnvironmentThreadShell) =>',
        '    serverConfigs.get(thread.environmentId)?.environment.capabilities;',
        '  const rubatoRecentThreads =',
        '    scopedProjectKeys === null',
        '      ? []',
        '      : selectRecentThreads({',
        '          threads: rubatoAllProjectsThreads,',
        '          supportsSettlement: (thread) => rubatoCapabilities(thread)?.threadSettlement === true,',
        '          supportsSnooze: (thread) => rubatoCapabilities(thread)?.threadSnooze === true,',
        '          workingShelfEnabled,',
        '          returnedAt: workingShelfEnabled ? inboxReturns.returnedAt : undefined,',
        '          now: new Date().toISOString(),',
        '          limit: clampRecentLimit(rubatoRecentLimit),',
        '          delegatedUnderParent,',
        '        });',
        '',
      ].join('\n')],
    ['          {!isSearchingThreads ? (\n            <TooltipProvider\n              key="sidebar-thread-tooltips-150"\n',
      [
        '          {/* Rubato: with no thread list to sit in, Recent and the title stand here (sidebar-blocks-edits.mjs). */}',
        '          {!isSearchingThreads && sidebarListItems.length === 0 ? (',
        '            <>',
        '              {rubatoRecentThreads.length > 0 ? (',
        '                <RubatoRecentBox',
        '                  threads={rubatoRecentThreads}',
        '                  projectFor={(thread) =>',
        '                    projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null',
        '                  }',
        '                  activeThreadKey={routeThreadKey}',
        '                  {...(isMobile ? { onNavigate: () => setOpenMobile(false) } : {})}',
        '                />',
        '              ) : null}',
        '              {!isMobile && scopedProjectGroup !== null ? (',
        '                <RubatoScopeLabel group={scopedProjectGroup} />',
        '              ) : null}',
        '            </>',
        '          ) : null}',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/ChatView.tsx': [
    ['import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";\n',
      'import { RubatoHomeProjects } from "./chat/RubatoHomeProjects";\n'],
    // Absolutely placed along the bottom of the centered overlay, so the
    // composer's centering is untouched unless the window is too short.
    ['              <div ref={draftHeroTransitionGroupRef} className="chat-composer-lane w-full">\n',
      [
        '              {isDraftHeroState ? (',
        '                <RubatoHomeProjects draftId={draftId} activeProjectRef={activeProjectRef} />',
        '              ) : null}',
        '',
      ].join('\n')],
  ],
  // chat.new follows the sidebar's new-thread button: inside the selected
  // project it opens the thread there. v0.1.11 moved the command out of the
  // route into the chat route's command installer.
  'apps/web/src/shortcuts/chatRouteCommands.ts': [
    [
      'import { shouldCreateNewThreadInCurrentProject } from "../components/Sidebar.logic";\n',
      'import { scopedNewThreadProjectRef } from "../components/sidebar/rubatoProjectRail.logic";\n',
    ],
    [
      '  const claim = (event: KeyboardEvent) => {\n',
      [
        '  // Rubato: the one project the rail narrows the list to (project-rail-edits.mjs).',
        '  const readRubatoScopedProjectGroup = () => {',
        '    const keys = useUiStateStore.getState().sidebarProjectScopeKeys;',
        '    if (keys.length === 0) return null;',
        '    const scoped = readProjectGroups().filter(',
        '      (group) => !group.archived && keys.includes(group.projectKey),',
        '    );',
        '    return scoped.length === 1 ? (scoped[0] ?? null) : null;',
        '  };',
        '  const claim = (event: KeyboardEvent) => {',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '        const groups = readProjectGroups();\n',
      [
        '        // Rubato: inside the selected project, open the thread there instead',
        '        // of asking which project (project-rail-edits.mjs).',
        '        const rubatoContext = readThreadContext();',
        '        const rubatoScopedRef = scopedNewThreadProjectRef({',
        '          group: readRubatoScopedProjectGroup(),',
        '          contextProjectRef: rubatoContext.activeThread ?? rubatoContext.activeDraftThread ?? null,',
        '        });',
        '        if (rubatoScopedRef !== null) {',
        '          claim(event);',
        '          void handleNewThread(rubatoScopedRef);',
        '          return;',
        '        }',
        '        const groups = readProjectGroups();',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  // The home row's switch, off until turned on, and how many rows Recent
  // shows (1-15, sidebar/rubatoSidebarBlocks.ts clamps it): device settings.
  'packages/contracts/src/settings.ts': [
    ['  composerRichTextEnabled: Schema.Boolean.pipe(',
      '  // Rubato: the project row on the new-thread screen (project-rail-edits.mjs).\n'
        + '  rubatoHomeProjects: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),\n'
        + '  // Rubato: how many threads the Recent box shows (project-rail-edits.mjs).\n'
        + '  rubatoRecentLimit: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(5))),\n'],
    ['  composerRichTextEnabled: Schema.optionalKey(Schema.Boolean),\n',
      '  rubatoHomeProjects: Schema.optionalKey(Schema.Boolean),\n'
        + '  rubatoRecentLimit: Schema.optionalKey(Schema.Number),\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  {\n    id: "project-grouping",\n',
      [
        '  {',
        '    // Rubato: the project row on the new-thread screen (project-rail-edits.mjs).',
        '    id: "rubato-home-projects",',
        '    title: "Projects on the new-thread screen",',
        '    to: "/settings/projects",',
        '    searchTerms: ["home new thread draft project tabs recent threads list bottom row 새 스레드 프로젝트 목록 세션"],',
        '  },',
        '',
      ].join('\n')],
  ],
};
