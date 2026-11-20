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
//   the sections, the trash removes a project from Rubato, Add project, a
//   name opens that project's settings. The rail's Projects window, the
//   sidebar's project filter and the headline's picker end in Edit projects,
//   which opens this list. T3's sort select on General shows nowhere: the list
//   is the order (settings/rubatoSettingsSurface.ts).
export const projectOrderOverlays = [
  'apps/web/src/components/sidebar/rubatoProjectOrder.ts',
  'apps/web/src/components/sidebar/rubatoProjectOrder.test.ts',
  'apps/web/src/components/settings/RubatoProjectListSettings.tsx',
  'apps/web/src/components/sidebar/rubatoRemoveProject.ts',
  'apps/web/src/components/sidebar/rubatoRemoveProject.test.ts',
];

export const projectOrderEdits = {
  'apps/web/src/hooks/useSidebarProjectGroups.ts': [
    ['import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../state/entities";\n',
      'import { useProjects } from "../state/entities";\n', 'replace'],
    ['import { orderItemsByPreferredIds, sortSidebarV2ProjectGroups } from "../components/Sidebar.logic";\n',
      'import { orderItemsByPreferredIds } from "../components/Sidebar.logic";\n'
        + 'import { useRubatoProjectOrder } from "../components/sidebar/rubatoProjectOrder";\n',
      'replace'],
    ['  // Activity order lags a running thread\'s streaming ticks until its next\n'
        + '  // real change; reading every tick re-rendered the whole sidebar with it.\n'
        + '  const threads = useQuietThreadShells();\n'
        + '  const delegatedUnderParent = useDelegatedUnderParent();\n',
      '  // Rubato: the shared order reads the threads itself (project-order-edits.mjs).\n', 'replace'],
    [
      '  return sortSidebarV2ProjectGroups(unsortedGroups, threads, sortOrder, delegatedUnderParent);\n',
      '  // Rubato: the shared project order (project-order-edits.mjs).\n  return useRubatoProjectOrder(unsortedGroups).ordered;\n',
      'replace',
    ],
  ],
  'apps/web/src/components/CommandPalette.tsx': [
    ['} from "lucide-react";\n', '  ListOrderedIcon,\n'],
    ['  useSortedProjectGroups,\n} from "./CommandPaletteLookups";\n',
      '  useRubatoSortedProjectOrder,\n} from "./CommandPaletteLookups";\n'
        + 'import { inProjectOrder } from "./sidebar/rubatoProjectOrder";\n'
        + 'import { useOpenRubatoProjectList } from "./settings/RubatoProjectListSettings";\n',
      'replace'],
    ['  newThreadNoProjectIndex,\n', '', 'replace'],
    [
      '  const projectGroups = useSortedProjectGroups(environmentLabelById);\n',
      [
        '  // Rubato: the shared project order (project-order-edits.mjs).',
        '  const rubatoProjectOrder = useRubatoSortedProjectOrder(environmentLabelById);',
        '  const projectGroups = rubatoProjectOrder.ordered;',
        '  const openRubatoProjectList = useOpenRubatoProjectList();',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '  const projectPickerEntries = buildSidebarProjectPickerEntries({\n    groups: pickableProjectGroups(projectGroups),\n    preferredProjectRef: contextualProjectRef,\n  });\n',
      '  // Rubato: the shared order holds; neither a pin nor the current project lifts a row.\n'
        + '  const projectPickerEntries = inProjectOrder(\n'
        + '    buildSidebarProjectPickerEntries({\n      groups: pickableProjectGroups(projectGroups),\n      preferredProjectRef: contextualProjectRef,\n    }),\n'
        + '    projectGroups,\n'
        + '  );\n',
      'replace',
    ],
    [
      [
        '      const noProjectIndex = newThreadNoProjectIndex(',
        '        projectPickerEntries.map(({ group, targetProject, isPreferred }) => ({',
        '          isScratch: isScratchProject(',
        '            targetProject,',
        '            scratchWorkspaceRootFor(targetProject.environmentId),',
        '          ),',
        '          pinned: group.pinned,',
        '          isPreferred,',
        '        })),',
        '      );',
        '',
      ].join('\n'),
      '      // Rubato: after the projects, so it closes My projects (project-order-edits.mjs).\n'
        + '      const noProjectIndex = projectItems.length;\n',
      'replace',
    ],
    ['  const {\n    threadItems: allThreadItems,\n',
      [
        '  // Rubato: My projects, Other projects, and the way to edit the list (project-order-edits.mjs).',
        '  const rubatoQuietValues = new Set(',
        '    rubatoProjectOrder.list.quiet.flatMap((group) =>',
        '      group.memberProjectRefs.map(',
        '        (projectRef) => `new-thread-in:${projectRef.environmentId}:${projectRef.projectId}`,',
      '      ),',
        '    ),',
        '  );',
        '  const rubatoQuietItems = projectThreadItems.filter((item) => rubatoQuietValues.has(item.value));',
        '  const rubatoEditProjectList: CommandPaletteActionItem = {',
        '    kind: "action",',
        '    value: "new-thread-in:edit-project-list",',
        '    searchTerms: ["edit project list", "reorder", "order", "remove", "hide", "manage projects"],',
        '    title: "Edit project list…",',
        '    icon: <ListOrderedIcon className={ITEM_ICON_CLASS} />,',
        '    run: async () => {',
        '      await openRubatoProjectList();',
        '    },',
        '  };',
        '  const rubatoProjectThreadGroups = [',
        '    {',
        '      value: NEW_THREAD_IN_GROUP,',
        '      label: "My projects",',
        '      items: projectThreadItems.filter((item) => !rubatoQuietValues.has(item.value)),',
        '    },',
        '    ...(rubatoQuietItems.length > 0',
        '      ? [{ value: RUBATO_OTHER_PROJECTS_GROUP, label: "Other projects", items: rubatoQuietItems }]',
        '      : []),',
        '    { value: "project-list", label: "", items: [rubatoEditProjectList] },',
        '  ];',
        '',
      ].join('\n')],
    ['const NEW_THREAD_IN_GROUP = "projects";\n',
      'const NEW_THREAD_IN_GROUP = "projects";\n'
        + '// Rubato: the shared order\'s other projects, after My projects (project-order-edits.mjs).\n'
        + 'const RUBATO_OTHER_PROJECTS_GROUP = "other-projects";\n',
      'replace'],
    [
      '      groups: [{ value: NEW_THREAD_IN_GROUP, label: gt("Projects"), items: projectThreadItems }],\n',
      '      groups: rubatoProjectThreadGroups,\n',
      'replace',
    ],
    [
      [
        '          ? [',
        '              {',
        '                value: NEW_THREAD_IN_GROUP,',
        '                label: gt("Projects"),',
        '                // Every project archived and no "No project" home leaves only adding one.',
        '                items: projectThreadItems.length > 0 ? projectThreadItems : [addProjectAction],',
        '              },',
        '            ]',
        '',
      ].join('\n'),
      [
        '          ? // Rubato: My projects, Other projects, Edit project list… (project-order-edits.mjs).',
        '            projectThreadItems.length > 0',
        '            ? rubatoProjectThreadGroups',
        '            : [',
        '                {',
        '                  value: NEW_THREAD_IN_GROUP,',
        '                  label: gt("Projects"),',
        '                  // Every project archived and no "No project" home leaves only adding one.',
        '                  items: [addProjectAction],',
        '                },',
        '              ]',
        '',
      ].join('\n'),
      'replace',
    ],
    // mod+1..9 number My projects and Other projects as one list, as shown.
    [
      [
        '  const filteredGroups = searchedGroups.map((group) => {',
        '    if (group.value !== NEW_THREAD_IN_GROUP) return group;',
        '    const jumpItems = new Map(',
        '      enumerateCommandPaletteItems(',
        '        group.items.filter(',
        '          (item): item is CommandPaletteActionItem =>',
        '            item.kind === "action" &&',
        '            item.value !== NEW_THREAD_NO_PROJECT_VALUE &&',
        '            item.value !== addProjectAction.value,',
        '        ),',
        '      ).map((item) => [item.value, item] as const),',
        '    );',
        '    return { ...group, items: group.items.map((item) => jumpItems.get(item.value) ?? item) };',
        '  });',
        '',
      ].join('\n'),
      [
        '  // Rubato: My projects and Other projects number as one list (project-order-edits.mjs).',
        '  const rubatoJumpGroups = new Set<string>([NEW_THREAD_IN_GROUP, RUBATO_OTHER_PROJECTS_GROUP]);',
        '  const rubatoJumpItems = new Map(',
        '    enumerateCommandPaletteItems(',
        '      searchedGroups',
        '        .filter((group) => rubatoJumpGroups.has(group.value))',
        '        .flatMap((group) => group.items)',
        '        .filter(',
        '          (item): item is CommandPaletteActionItem =>',
        '            item.kind === "action" &&',
        '            item.value !== NEW_THREAD_NO_PROJECT_VALUE &&',
        '            item.value !== addProjectAction.value,',
        '        ),',
        '    ).map((item) => [item.value, item] as const),',
        '  );',
        '  const filteredGroups = searchedGroups.map((group) => {',
        '    if (!rubatoJumpGroups.has(group.value)) return group;',
        '    return { ...group, items: group.items.map((item) => rubatoJumpItems.get(item.value) ?? item) };',
        '  });',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  // The palette's and the headline's projects come from here (useSortedProjectGroups), so the
  // shared order replaces T3's project sort once for both.
  'apps/web/src/components/CommandPaletteLookups.ts': [
    ['import { useProjects, useVisibleThreadShells } from "../state/entities";\n',
      'import { useProjects } from "../state/entities";\n', 'replace'],
    ['import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";\n',
      'import { orderItemsByPreferredIds } from "./Sidebar.logic";\n'
        + 'import { useRubatoProjectOrder } from "./sidebar/rubatoProjectOrder";\n',
      'replace'],
    [
      'export function useSortedProjectGroups(environmentLabelById: ReadonlyMap<EnvironmentId, string>) {\n'
        + '  const projects = useProjects();\n'
        + '  const threads = useVisibleThreadShells();\n',
      '// Rubato: the projects in the shared order (project-order-edits.mjs).\n'
        + 'export function useSortedProjectGroups(environmentLabelById: ReadonlyMap<EnvironmentId, string>) {\n'
        + '  return useRubatoSortedProjectOrder(environmentLabelById).ordered;\n'
        + '}\n'
        + '\n'
        + '/** The shared order with its My/Other split, for lists that show both. */\n'
        + 'export function useRubatoSortedProjectOrder(\n'
        + '  environmentLabelById: ReadonlyMap<EnvironmentId, string>,\n'
        + ') {\n'
        + '  const projects = useProjects();\n',
      'replace',
    ],
    ['  return sortLogicalProjectsForSidebar(\n    unsortedProjectGroups,\n    threads,\n    clientSettings.sidebarProjectSortOrder,\n  );\n',
      '  return useRubatoProjectOrder(unsortedProjectGroups);\n', 'replace'],
  ],
  'apps/web/src/components/chat/DraftHeroHeadline.tsx': [
    // The groups arrive in the shared order (useSortedProjectGroups, CommandPaletteLookups.ts above).
    ['import { useSortedProjectGroups } from "../CommandPaletteLookups";\n',
      'import { inProjectOrder } from "../sidebar/rubatoProjectOrder";\n'],
    [
      '  const projectPickerEntries = buildSidebarProjectPickerEntries({\n    groups: pickableProjectGroups(projectGroups),\n    preferredProjectRef: activeProjectRef,\n  });\n',
      '  // Rubato: the shared order holds; neither a pin nor the current project lifts a row.\n'
        + '  const projectPickerEntries = inProjectOrder(\n'
        + '    buildSidebarProjectPickerEntries({\n      groups: pickableProjectGroups(projectGroups),\n      preferredProjectRef: activeProjectRef,\n    }),\n'
        + '    projectGroups,\n'
        + '  );\n',
      'replace',
    ],
    // Edit projects trails Add project and opens Settings > Projects, where a
    // project is reordered or removed from Rubato.
    ['import { FolderPlusIcon } from "lucide-react";\n',
      'import { FolderPlusIcon, PencilIcon } from "lucide-react";\n', 'replace'],
    ['import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";\n',
      'import { useOpenRubatoProjectList } from "../settings/RubatoProjectListSettings";\n'],
    ['const ADD_PROJECT_VALUE = "add-project";\n',
      'const ADD_PROJECT_VALUE = "add-project";\n'
        + '// Rubato: the "Edit projects" row (project-order-edits.mjs).\n'
        + 'const EDIT_PROJECTS_VALUE = "rubato-edit-projects";\n', 'replace'],
    ['  const { environments } = useEnvironments();\n',
      '  const rubatoOpenProjectList = useOpenRubatoProjectList();\n'],
    ['      { value: ADD_PROJECT_VALUE, label: gt("Add project") },\n',
      '      { value: ADD_PROJECT_VALUE, label: gt("Add project") },\n'
        + '      { value: EDIT_PROJECTS_VALUE, label: "Edit projects" },\n', 'replace'],
    ['        item.value !== ADD_PROJECT_VALUE &&\n',
      '        item.value !== ADD_PROJECT_VALUE &&\n        item.value !== EDIT_PROJECTS_VALUE &&\n', 'replace'],
    ['          openAddProject();\n          return;\n        }\n',
      '          openAddProject();\n          return;\n        }\n'
        + '        if (item.value === EDIT_PROJECTS_VALUE) {\n'
        + '          void rubatoOpenProjectList();\n'
        + '          return;\n'
        + '        }\n', 'replace'],
    ['                  <FolderPlusIcon className="size-4 shrink-0" />\n',
      '                  <FolderPlusIcon className="size-4 shrink-0" />\n'
        + '                ) : item.value === EDIT_PROJECTS_VALUE ? (\n'
        + '                  <PencilIcon className="size-4 shrink-0" />\n', 'replace'],
  ],
  'apps/web/src/hooks/useHandleNewThread.ts': [
    ['import { getClientSettings } from "./useSettings";\n',
      'import { useSidebarProjectGroups } from "./useSidebarProjectGroups";\n'
        + 'import { defaultProjectOrderKeys } from "../components/sidebar/rubatoProjectOrder";\n'],
    // T3's project used last still decides first; when none, the shared order replaces T3's
    // manual order (the scratch home is not a project to start in).
    ['export function useHandleNewThread() {\n  const projectOrder = useUiStateStore((store) => store.projectOrder);\n',
      'export function useHandleNewThread() {\n', 'replace'],
    ['import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";\n',
      'import { legacyProjectCwdPreferenceKey } from "../uiStateStore";\n', 'replace'],
    [
      '  const defaultProjectRef = resolveDefaultProjectRef(\n    projects,\n    projectOrder,\n',
      '  // Rubato: after the project used last, the shared order picks (project-order-edits.mjs).\n'
        + '  const rubatoProjectGroups = useSidebarProjectGroups();\n'
        + '  const defaultProjectRef = resolveDefaultProjectRef(\n'
        + '    projects,\n'
        + '    defaultProjectOrderKeys(rubatoProjectGroups),\n',
      'replace',
    ],
  ],
  // The shared order's hook stands in for the store this test does not set up.
  'apps/web/src/hooks/useHandleNewThread.test.ts': [
    ['vi.mock("../components/Sidebar.logic", () => ({\n',
      'vi.mock("./useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => [] }));\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['    searchTerms: [msg("sort projects sidebar manual created recent")],\n',
      '    searchTerms: [\n'
        + '      msg("sort projects sidebar manual created recent"),\n'
        + '      "reorder drag hide remove add new list my other projects 프로젝트 순서 목록 편집 숨기기 추가 삭제",\n'
        + '    ],\n',
      'replace'],
  ],
  // Before a project is chosen, Settings > Projects is the project list
  // (settings/RubatoProjectListSettings.tsx), with the new-thread screen's project row.
  'apps/web/src/components/settings/ProjectsSettings.tsx': [
    ['import { T, useGT } from "gt-react";\n', 'import { T } from "gt-react";\n', 'replace'],
    ['import { SettingsScopeNotice } from "./SettingsScopeNotice";\n',
      'import { RubatoProjectListSettings } from "./RubatoProjectListSettings";\n', 'replace'],
    ['  const gt = useGT();\n', '', 'replace'],
    [
      '        <SettingsScopeNotice target="project">\n          {gt("Choose a project to manage its name, icon, checkouts and actions.")}\n        </SettingsScopeNotice>\n',
      '        // Rubato: the project list and its order (project-order-edits.mjs).\n        <RubatoProjectListSettings />\n',
      'replace',
    ],
  ],
};
