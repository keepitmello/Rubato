// One project order for every surface that lists projects, and one place that
// edits it (sidebar/rubatoProjectOrder.ts).
//
// The rail's Projects window and the home tabs already shared a list (the
// user's projects in their order, then the others; project-rail-edits.mjs),
// but T3 sorted its own pickers by its project sort setting and lifted the
// current project to the top, so the same projects showed in three orders.
// Now:
//
// - The command palette's "New thread in..." lists My projects in the shared
//   order, then Other projects, with mod+1..9 on the first nine; "No project"
//   closes My projects and keeps its own shortcut. Its last row, Edit project
//   list..., opens the list.
// - The headline's picker on the new-thread screen, the sidebar's project
//   groups (the phone filter, Pull Requests) and the project a new thread
//   starts in when nothing else decides follow the same order.
// - The legacy sidebar shows its projects in that order and its drag edits it;
//   its options menu drops "Sort projects" for Edit project list....
// - Settings > Projects, before a project is chosen, is the list itself
//   (settings/RubatoProjectListSettings.tsx): drag to reorder, − and + between
//   the sections, Add project, a name opens that project's settings. The page
//   is laid out like Rubato's other settings pages (settings/rubatoSettingsLayout.ts),
//   and T3's sort select has no row there: the list is the order.
export const projectOrderOverlays = [
  'apps/web/src/components/sidebar/rubatoProjectOrder.ts',
  'apps/web/src/components/sidebar/rubatoProjectOrder.test.ts',
  'apps/web/src/components/settings/RubatoProjectListSettings.tsx',
];

const ORDER_IMPORT = 'import { inProjectOrder, useRubatoProjectOrder } from "./sidebar/rubatoProjectOrder";\n';

export const projectOrderEdits = {
  'apps/web/src/hooks/useSidebarProjectGroups.ts': [
    ['import { useProjects, useThreadShells } from "../state/entities";\n',
      'import { useProjects } from "../state/entities";\n', 'replace'],
    ['import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";\n',
      'import { orderItemsByPreferredIds } from "../components/Sidebar.logic";\n'
        + 'import { useRubatoProjectOrder } from "../components/sidebar/rubatoProjectOrder";\n',
      'replace'],
    ['  const threads = useThreadShells();\n',
      '  // Rubato: the shared order reads the threads itself (project-order-edits.mjs).\n', 'replace'],
    [
      '  return useMemo(\n    () => sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder),\n    [sortOrder, threads, unsortedGroups],\n  );\n',
      '  // Rubato: the shared project order (project-order-edits.mjs).\n  return useRubatoProjectOrder(unsortedGroups).ordered;\n',
      'replace',
    ],
  ],
  'apps/web/src/components/CommandPalette.tsx': [
    ['} from "lucide-react";\n', '  ListOrderedIcon,\n'],
    ['import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";\n',
      'import { orderItemsByPreferredIds } from "./Sidebar.logic";\n'
        + ORDER_IMPORT
        + 'import { useOpenRubatoProjectList } from "./settings/RubatoProjectListSettings";\n',
      'replace'],
    [
      [
        '  const projectGroups = useMemo(',
        '    () =>',
        '      sortLogicalProjectsForSidebar(',
        '        unsortedProjectGroups,',
        '        threads,',
        '        clientSettings.sidebarProjectSortOrder,',
        '      ),',
        '    [clientSettings.sidebarProjectSortOrder, threads, unsortedProjectGroups],',
        '  );',
        '',
      ].join('\n'),
      [
        '  // Rubato: the shared project order (project-order-edits.mjs).',
        '  const rubatoProjectOrder = useRubatoProjectOrder(unsortedProjectGroups);',
        '  const projectGroups = rubatoProjectOrder.ordered;',
        '  const openRubatoProjectList = useOpenRubatoProjectList();',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '      buildSidebarProjectPickerEntries({\n        groups: projectGroups,\n        preferredProjectRef: contextualProjectRef,\n      }),\n',
      '      // Rubato: the shared order holds; the current project is not lifted.\n'
        + '      inProjectOrder(\n'
        + '        buildSidebarProjectPickerEntries({\n          groups: projectGroups,\n          preferredProjectRef: contextualProjectRef,\n        }),\n'
        + '        projectGroups,\n'
        + '      ),\n',
      'replace',
    ],
    [
      '    const noProjectIndex = pickerProjects[0] !== undefined && isScratch(pickerProjects[0]) ? 0 : 1;\n',
      '    // Rubato: after the projects, so it closes My projects (project-order-edits.mjs).\n'
        + '    const noProjectIndex = projectItems.length;\n',
      'replace',
    ],
    ['  const allThreadItems = useMemo(\n',
      [
        '  // Rubato: My projects, Other projects, and the way to edit the list (project-order-edits.mjs).',
        '  const rubatoProjectThreadGroups = useMemo(() => {',
        '    const quietValues = new Set(',
        '      rubatoProjectOrder.list.quiet.flatMap((group) =>',
        '        group.memberProjectRefs.map(',
        '          (projectRef) => `new-thread-in:${projectRef.environmentId}:${projectRef.projectId}`,',
        '        ),',
        '      ),',
        '    );',
        '    const quiet = projectThreadItems.filter((item) => quietValues.has(item.value));',
        '    const editList: CommandPaletteActionItem = {',
        '      kind: "action",',
        '      value: "new-thread-in:edit-project-list",',
        '      searchTerms: ["edit project list", "reorder", "order", "remove", "hide", "manage projects"],',
        '      title: "Edit project list…",',
        '      icon: <ListOrderedIcon className={ITEM_ICON_CLASS} />,',
        '      run: async () => {',
        '        await openRubatoProjectList();',
        '      },',
        '    };',
        '    return [',
        '      {',
        '        value: "projects",',
        '        label: "My projects",',
        '        items: projectThreadItems.filter((item) => !quietValues.has(item.value)),',
        '      },',
        '      ...(quiet.length > 0 ? [{ value: "other-projects", label: "Other projects", items: quiet }] : []),',
        '      { value: "project-list", label: "", items: [editList] },',
        '    ];',
        '  }, [openRubatoProjectList, projectThreadItems, rubatoProjectOrder.list.quiet]);',
        '',
        '',
      ].join('\n')],
    [
      '    pushPaletteView({\n      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,\n      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],\n',
      '    pushPaletteView({\n      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,\n      groups: rubatoProjectThreadGroups,\n',
      'replace',
    ],
    [
      '  }, [clearOpenIntent, browseNavigation, openIntent, projectThreadItems, pushPaletteView]);\n',
      '  }, [\n    clearOpenIntent,\n    browseNavigation,\n    openIntent,\n    projectThreadItems,\n    pushPaletteView,\n    rubatoProjectThreadGroups,\n  ]);\n',
      'replace',
    ],
    [
      '      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,\n      groups: [{ value: "projects", label: "Projects", items: projectThreadItems }],\n',
      '      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,\n      groups: rubatoProjectThreadGroups,\n',
      'replace',
    ],
  ],
  'apps/web/src/components/chat/DraftHeroHeadline.tsx': [
    ['import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";\n',
      'import { inProjectOrder, useRubatoProjectOrder } from "../sidebar/rubatoProjectOrder";\n', 'replace'],
    ['  const threads = useThreadShells();\n',
      '  // Rubato: the shared order reads the threads itself (project-order-edits.mjs).\n', 'replace'],
    ['import { useProjects, useThreadShells } from "~/state/entities";\n',
      'import { useProjects } from "~/state/entities";\n', 'replace'],
    ['  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);\n',
      '  // Rubato: T3\'s project sort setting no longer orders projects (project-order-edits.mjs).\n', 'replace'],
    [
      [
        '  const projectGroups = useMemo(',
        '    () =>',
        '      sortLogicalProjectsForSidebar(',
        '        buildSidebarProjectSnapshots({',
        '          projects,',
        '          settings: projectGroupingSettings,',
        '          primaryEnvironmentId,',
        '          resolveEnvironmentLabel: (environmentId) =>',
        '            environmentLabelById.get(environmentId) ?? null,',
        '        }),',
        '        threads,',
        '        projectSortOrder,',
        '      ),',
        '    [',
        '      environmentLabelById,',
        '      primaryEnvironmentId,',
        '      projectGroupingSettings,',
        '      projectSortOrder,',
        '      projects,',
        '      threads,',
        '    ],',
        '  );',
        '',
      ].join('\n'),
      [
        '  const unsortedProjectGroups = useMemo(',
        '    () =>',
        '      buildSidebarProjectSnapshots({',
        '        projects,',
        '        settings: projectGroupingSettings,',
        '        primaryEnvironmentId,',
        '        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,',
        '      }),',
        '    [environmentLabelById, primaryEnvironmentId, projectGroupingSettings, projects],',
        '  );',
        '  // Rubato: the shared project order (project-order-edits.mjs).',
        '  const projectGroups = useRubatoProjectOrder(unsortedProjectGroups).ordered;',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '      buildSidebarProjectPickerEntries({\n        groups: projectGroups,\n        preferredProjectRef: activeProjectRef,\n      }),\n',
      '      // Rubato: the shared order holds; the current project is not lifted.\n'
        + '      inProjectOrder(\n'
        + '        buildSidebarProjectPickerEntries({\n          groups: projectGroups,\n          preferredProjectRef: activeProjectRef,\n        }),\n'
        + '        projectGroups,\n'
        + '      ),\n',
      'replace',
    ],
  ],
  'apps/web/src/hooks/useHandleNewThread.ts': [
    ['import { useClientSettings } from "./useSettings";\n',
      'import { useSidebarProjectGroups } from "./useSidebarProjectGroups";\n'],
    ['  const handleNewThread = useNewThreadHandler();\n\n  return {\n    activeDraftThread,\n',
      '  // Rubato: the first project in the shared order (project-order-edits.mjs).\n'
        + '  const rubatoFirstGroup = useSidebarProjectGroups().find((group) => group.isScratch !== true);\n'],
    [
      '    defaultProjectRef: orderedProjects[0]\n      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)\n      : null,\n',
      '    defaultProjectRef: rubatoFirstGroup\n'
        + '      ? scopeProjectRef(rubatoFirstGroup.environmentId, rubatoFirstGroup.id)\n'
        + '      : orderedProjects[0]\n'
        + '        ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)\n'
        + '        : null,\n',
      'replace',
    ],
  ],
  // The shared order's hook stands in for the store this test does not set up.
  'apps/web/src/hooks/useHandleNewThread.test.ts': [
    ['vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));\n',
      'vi.mock("./useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => [] }));\n'],
  ],
  'apps/web/src/components/LegacySidebar.tsx': [
    ['import { pinMenuItems, pinnedThreadsFirst } from "./sidebar/rubatoPinnedThreads";\n',
      'import { useRubatoProjectOrder } from "./sidebar/rubatoProjectOrder";\n'
        + 'import { moveInProjectList } from "./sidebar/rubatoProjectRail.logic";\n'
        + 'import { useOpenRubatoProjectList } from "./settings/RubatoProjectListSettings";\n'],
    ['import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";\n',
      'import {\n  Menu,\n  MenuGroup,\n  MenuItem,\n  MenuPopup,\n  MenuRadioGroup,\n  MenuRadioItem,\n  MenuTrigger,\n} from "./ui/menu";\n',
      'replace'],
    ['  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;\n}) {\n',
      '  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;\n}) {\n'
        + '  const openRubatoProjectList = useOpenRubatoProjectList();\n',
      'replace'],
    [
      [
        '        <MenuGroup>',
        '          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">',
        '            Sort projects',
        '          </div>',
        '          <MenuRadioGroup',
        '            value={projectSortOrder}',
        '            onValueChange={(value) => {',
        '              onProjectSortOrderChange(value as SidebarProjectSortOrder);',
        '            }}',
        '          >',
        '            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(',
        '              ([value, label]) => (',
        '                <MenuRadioItem key={value} value={value}>',
        '                  {label}',
        '                </MenuRadioItem>',
        '              ),',
        '            )}',
        '          </MenuRadioGroup>',
        '        </MenuGroup>',
        '',
      ].join('\n'),
      [
        '        {/* Rubato: one project order everywhere; drag projects here or edit the list (project-order-edits.mjs). */}',
        '        <MenuGroup>',
        '          <MenuItem onClick={() => void openRubatoProjectList()}>Edit project list…</MenuItem>',
        '        </MenuGroup>',
        '',
      ].join('\n'),
      'replace',
    ],
    ['    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),\n    [sidebarProjects],\n  );\n',
      '    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),\n    [sidebarProjects],\n  );\n'
        + '  // Rubato: the shared project order, which the drag below edits (project-order-edits.mjs).\n'
        + '  const rubatoProjectOrder = useRubatoProjectOrder(sidebarProjects);\n',
      'replace'],
    [
      '      if (sidebarProjectSortOrder !== "manual") {\n        dragInProgressRef.current = false;\n        return;\n      }\n',
      '      // Rubato: every project drags; the shared order has no sort modes (project-order-edits.mjs).\n',
      'replace',
    ],
    [
      [
        '      const activeMemberKeys = activeProject.memberProjects.map(',
        '        (member) => member.physicalProjectKey,',
        '      );',
        '      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);',
        '      reorderProjects(orderedProjects.map(getProjectOrderKey), activeMemberKeys, overMemberKeys);',
        '    },',
        '    [orderedProjects, sidebarProjectSortOrder, reorderProjects, sidebarProjects],',
        '',
      ].join('\n'),
      [
        '      rubatoProjectOrder.setState(',
        '        moveInProjectList(rubatoProjectOrder.list, activeProject.projectKey, overProject.projectKey),',
        '      );',
        '    },',
        '    [rubatoProjectOrder, sidebarProjects],',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '      if (sidebarProjectSortOrder !== "manual") {\n        return;\n      }\n',
      '      // Rubato: every project drags (project-order-edits.mjs).\n',
      'replace',
    ],
    ['    [sidebarProjectSortOrder],\n  );\n\n  const handleProjectDragCancel',
      '    [],\n  );\n\n  const handleProjectDragCancel', 'replace'],
    [
      [
        '  const sortedProjects = useMemo(() => {',
        '    const sortableProjects = sidebarProjects.map((project) => ({',
        '      ...project,',
        '      id: project.projectKey,',
        '    }));',
        '    const sortableThreads = visibleThreads.map((thread) => {',
        '      const physicalKey =',
        '        projectPhysicalKeyByScopedRef.get(',
        '          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),',
        '        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));',
        '      return {',
        '        ...thread,',
        '        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,',
        '      };',
        '    });',
        '    return sortProjectsForSidebar(',
        '      sortableProjects,',
        '      sortableThreads,',
        '      sidebarProjectSortOrder,',
        '    ).flatMap((project) => {',
        '      const resolvedProject = sidebarProjectByKey.get(project.id);',
        '      return resolvedProject ? [resolvedProject] : [];',
        '    });',
        '  }, [',
        '    sidebarProjectSortOrder,',
        '    physicalToLogicalKey,',
        '    projectPhysicalKeyByScopedRef,',
        '    sidebarProjectByKey,',
        '    sidebarProjects,',
        '    visibleThreads,',
        '  ]);',
        '  const isManualProjectSorting = sidebarProjectSortOrder === "manual";',
        '',
      ].join('\n'),
      [
        '  const sortedProjects = rubatoProjectOrder.ordered;',
        '  const isManualProjectSorting = true;',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['    searchTerms: ["sort projects sidebar manual created recent"],\n',
      '    searchTerms: [\n'
        + '      "sort projects sidebar manual created recent reorder drag hide remove add new list my other projects 프로젝트 순서 목록 편집 숨기기 추가 삭제",\n'
        + '    ],\n',
      'replace'],
  ],
  // Before a project is chosen, Settings > Projects is the project list.
  'apps/web/src/components/settings/ProjectsSettings.tsx': [
    ['import { SettingsScopeNotice } from "./SettingsScopeNotice";\n',
      'import { RubatoSettingsPage } from "./RubatoSettingsPage";\n', 'replace'],
    [
      '        <SettingsScopeNotice target="project">\n          Choose a project to manage its name, icon, checkouts and actions.\n        </SettingsScopeNotice>\n',
      '        // Rubato: the project list, its order and the options around it (project-order-edits.mjs).\n        <RubatoSettingsPage path="/settings/projects" />\n',
      'replace',
    ],
  ],
};
