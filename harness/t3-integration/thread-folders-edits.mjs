// Thread folders: folders the user makes and fills by hand, across projects, the same on the
// Mac and on the phone.
//
// - Where they live: the server settings of the Mac that runs the threads, two maps
//   (folder id -> name, thread id -> folder id). A patch merges per entry and null removes
//   one, so the Mac and the phone filing different threads at once do not overwrite each
//   other; the settings stream brings each change to every open window and phone.
//   packages/shared/src/rubatoThreadFolders.ts holds the reading and the patches both use.
// - Desktop (sidebar/rubatoThreadFolders.tsx): the rail's Projects window lists folders
//   above projects; choosing one narrows the sidebar the way a project does and the two
//   replace each other; the list's title names the folder; a thread's context menu has
//   Move to folder; a thread started while a folder is chosen goes into it.
// - Phone: a Folder filter beside Project in the Threads tab, the Environment filter only
//   when more than one Mac is paired, and Move to Folder in a thread's long-press menu.
//
// Registered last: it anchors on lines project-rail-edits.mjs and sidebar-blocks-edits.mjs
// add to Sidebar.tsx.
export const threadFoldersOverlays = [
  'packages/shared/src/rubatoThreadFolders.ts',
  'packages/shared/src/rubatoThreadFolders.test.ts',
  'apps/web/src/components/sidebar/rubatoThreadFolders.tsx',
  'apps/web/src/components/sidebar/rubatoThreadFolders.test.ts',
  'apps/mobile/src/features/rubato-shell/threadFolders.tsx',
  'apps/mobile/src/features/home/rubatoHomeListFolder.test.ts',
];

const FOLDER_ENTRY = 'Schema.Struct({ name: Schema.String, createdAt: Schema.String })';

export const threadFoldersEdits = {
  'packages/contracts/src/settings.ts': [
    ['});\nexport type ServerSettings = typeof ServerSettings.Type;',
      [
        '  // Rubato: thread folders, folder id -> name and thread id -> folder id (thread-folders-edits.mjs).',
        `  rubatoThreadFolders: Schema.Record(Schema.String, ${FOLDER_ENTRY}).pipe(`,
        '    Schema.withDecodingDefault(Effect.succeed({})),',
        '  ),',
        '  rubatoThreadFolderOf: Schema.Record(Schema.String, Schema.String).pipe(',
        '    Schema.withDecodingDefault(Effect.succeed({})),',
        '  ),',
        '',
      ].join('\n')],
    ['});\nexport type ServerSettingsPatch = typeof ServerSettingsPatch.Type;',
      [
        '  /** Rubato: each entry replaces one folder or one thread\'s folder; `null` removes it. */',
        '  rubatoThreadFolders: Schema.optionalKey(',
        `    Schema.Record(Schema.String, Schema.NullOr(${FOLDER_ENTRY})),`,
        '  ),',
        '  rubatoThreadFolderOf: Schema.optionalKey(',
        '    Schema.Record(Schema.String, Schema.NullOr(Schema.String)),',
        '  ),',
        '',
      ].join('\n')],
  ],
  'packages/shared/src/serverSettings.ts': [
    ['    usageModelAliases: usageModelAliasesPatch,\n',
      '    rubatoThreadFolders: rubatoThreadFoldersPatch,\n    rubatoThreadFolderOf: rubatoThreadFolderOfPatch,\n'],
    ['    ...(usageModelAliasesPatch !== undefined\n',
      [
        '    // Rubato: thread folders merge per entry like the maps below (thread-folders-edits.mjs).',
        '    ...(rubatoThreadFoldersPatch !== undefined',
        '      ? {',
        '          rubatoThreadFolders: mergeSettingsEntries(',
        '            current.rubatoThreadFolders,',
        '            rubatoThreadFoldersPatch,',
        '          ),',
        '        }',
        '      : {}),',
        '    ...(rubatoThreadFolderOfPatch !== undefined',
        '      ? {',
        '          rubatoThreadFolderOf: mergeSettingsEntries(',
        '            current.rubatoThreadFolderOf,',
        '            rubatoThreadFolderOfPatch,',
        '          ),',
        '        }',
        '      : {}),',
        '',
      ].join('\n')],
  ],
  'packages/shared/package.json': [
    ['  "exports": {\n',
      '  "exports": {\n    "./rubatoThreadFolders": {\n      "types": "./src/rubatoThreadFolders.ts",\n      "import": "./src/rubatoThreadFolders.ts"\n    },\n',
      'replace'],
  ],
  'apps/web/src/components/Sidebar.tsx': [
    ['import { RubatoScopeLabel } from "./sidebar/RubatoScopeLabel";\n',
      [
        'import {',
        '  RubatoFolderScopeLabel,',
        '  isRubatoFolderMenuId,',
        '  runRubatoFolderMenu,',
        '  useRubatoFolderActions,',
        '  useRubatoFolderDraftCapture,',
        '  useRubatoFolderScopeState,',
        '  useRubatoThreadFolders,',
        '  withRubatoFolderMenu,',
        '} from "./sidebar/rubatoThreadFolders";',
        '',
      ].join('\n')],
    // After the project scope it gives way to.
    ['  const toggleProjectScopeKey = (key: string) =>\n',
      [
        '  // Rubato: the folder the list is narrowed to, in place of a project, and where a',
        '  // thread started meanwhile goes (thread-folders-edits.mjs).',
        '  const rubatoFolders = useRubatoThreadFolders();',
        '  const rubatoFolderActions = useRubatoFolderActions(rubatoFolders);',
        '  const rubatoFolder = useRubatoFolderScopeState(rubatoFolders, projectScopeKey);',
        '  useRubatoFolderDraftCapture(rubatoFolder, rubatoFolderActions);',
        '',
      ].join('\n')],
    // A chosen folder lists its threads, whatever project they are in.
    ['    threads:\n      scopedProjectKeys === null\n        ? withoutHiddenProjects(listedThreads, projectGroups, rubatoHiddenProjects)\n        : listedThreads,\n',
      [
        '    threads:',
        '      rubatoFolder !== null',
        '        ? listedThreads.filter((thread) => rubatoFolders.folderOf(thread)?.id === rubatoFolder.id)',
        '        : scopedProjectKeys === null',
        '          ? withoutHiddenProjects(listedThreads, projectGroups, rubatoHiddenProjects)',
        '          : listedThreads,',
        '',
      ].join('\n'),
      'replace'],
    ['      title: !isMobile && scopedProjectGroup !== null,\n',
      '      title: !isMobile && (scopedProjectGroup !== null || rubatoFolder !== null),\n',
      'replace'],
    ['              {!isMobile && scopedProjectGroup !== null ? (\n                <RubatoScopeLabel group={scopedProjectGroup} />\n              ) : null}\n',
      [
        '              {!isMobile && scopedProjectGroup !== null ? (',
        '                <RubatoScopeLabel group={scopedProjectGroup} />',
        '              ) : !isMobile && rubatoFolder !== null ? (',
        '                <RubatoFolderScopeLabel folder={rubatoFolder} count={0} />',
        '              ) : null}',
        '',
      ].join('\n'),
      'replace'],
    ['                                  <RubatoScopeLabel group={scopedProjectGroup} />\n                                </SortableSidebarMarker>,\n                              );\n                            }\n',
      [
        '                                  <RubatoScopeLabel group={scopedProjectGroup} />',
        '                                </SortableSidebarMarker>,',
        '                              );',
        '                            } else if (rubatoFolder !== null) {',
        '                              items.push(',
        '                                <SortableSidebarMarker',
        '                                  key="rubato-title"',
        '                                  marker="rubato-title"',
        '                                  data-testid="sidebar-rubato-title"',
        '                                >',
        '                                  <RubatoFolderScopeLabel',
        '                                    folder={rubatoFolder}',
        '                                    count={searchableThreads.length}',
        '                                  />',
        '                                </SortableSidebarMarker>,',
        '                              );',
        '                            }',
        '',
      ].join('\n'),
      'replace'],
    ['              ) : scopedProjectGroups.length > 0 ? (\n                <>\n                  <span>\n                    {settledCount > 0\n',
      '              ) : rubatoFolder !== null ? (\n                <span>{`No threads in ${rubatoFolder.name} yet`}</span>\n'],
    ['          api.contextMenu.show(\n            buildThreadActionMenuItems({\n',
      '          api.contextMenu.show(\n            // Rubato: Move to folder (thread-folders-edits.mjs).\n            withRubatoFolderMenu(rubatoFolders, thread, buildThreadActionMenuItems({\n',
      'replace'],
    ['              snoozePresets,\n            }),\n            position,\n            source,\n          ),\n        );\n        if (clicked._tag === "Failure" || clicked.value === null) return;\n',
      [
        '              snoozePresets,',
        '            })),',
        '            position,',
        '            source,',
        '          ),',
        '        );',
        '        if (clicked._tag === "Failure" || clicked.value === null) return;',
        '        if (isRubatoFolderMenuId(clicked.value)) {',
        '          await runRubatoFolderMenu(clicked.value, thread, rubatoFolderActions);',
        '          return;',
        '        }',
        '',
      ].join('\n'),
      'replace'],
  ],
  // The phone: the folder filter is saved with the other thread-list filters.
  'apps/mobile/src/persistence/mobile-preferences.ts': [
    ['  projectKey: Schema.NullOr(Schema.String),\n});\nexport type ThreadListFilters',
      '  projectKey: Schema.NullOr(Schema.String),\n  // Rubato: the chosen thread folder (thread-folders-edits.mjs).\n  rubatoFolderId: Schema.optional(Schema.NullOr(Schema.String)),\n});\nexport type ThreadListFilters',
      'replace'],
  ],
  'apps/mobile/src/features/home/home-list-options.ts': [
    ['  readonly projectSortOrder: HomeProjectSortOrder;\n}\n\nexport interface ResolvedHomeListOptions',
      '  readonly projectSortOrder: HomeProjectSortOrder;\n  /** Rubato: the thread folder the list is narrowed to (thread-folders-edits.mjs). */\n  readonly rubatoFolderId: string | null;\n}\n\nexport interface ResolvedHomeListOptions',
      'replace'],
    ['    selectedProjectKey: filters?.projectKey ?? null,\n',
      '    rubatoFolderId: filters?.rubatoFolderId ?? null,\n'],
    ["      next.selectedProjectKey !== current.selectedProjectKey\n    ) {\n      void savePreferences({\n        threadListFilters: {\n          environmentId: next.selectedEnvironmentId,\n          projectKey: next.selectedProjectKey,\n        },",
      "      next.selectedProjectKey !== current.selectedProjectKey ||\n      next.rubatoFolderId !== current.rubatoFolderId\n    ) {\n      void savePreferences({\n        threadListFilters: {\n          environmentId: next.selectedEnvironmentId,\n          projectKey: next.selectedProjectKey,\n          ...(next.rubatoFolderId !== null ? { rubatoFolderId: next.rubatoFolderId } : {}),\n        },",
      'replace'],
    ["export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<EnvironmentId>) {\n",
      "/** Rubato: the chosen thread folder and its setter (rubato-shell/threadFolders.tsx). */\nexport function useHomeListFolder(): readonly [string | null, (folderId: string | null) => void] {\n  const shared = useContext(HomeListOptionsContext);\n  const setFolderId = (folderId: string | null) => shared?.updateOptions({ rubatoFolderId: folderId });\n  return [shared?.options.rubatoFolderId ?? null, setFolderId] as const;\n}\n\n"],
  ],
  // Folders narrow the list before anything else reads it.
  'apps/mobile/src/features/home/HomeRouteScreen.tsx': [
    ["  const threads = useWithoutCompanionThreads(\n    useLaunchingThreads(useAtomValueWhileVisible(steadyNavigationThreadShellsAtom, visible)),\n  );",
      "  // Rubato: the chosen thread folder narrows the list (thread-folders-edits.mjs).\n  const threads = useInRubatoFolder(\n    useWithoutCompanionThreads(\n      useLaunchingThreads(useAtomValueWhileVisible(steadyNavigationThreadShellsAtom, visible)),\n    ),\n  );",
      'replace'],
    ["import { useWithoutCompanionThreads } from \"../rubato-shell/companionThreads\";\n",
      "import { useInRubatoFolder } from \"../rubato-shell/threadFolders\";\n"],
  ],
  // One Mac: no Environment filter to choose from. Folder sits before Project.
  'apps/mobile/src/features/home/ThreadListFilters.tsx': [
    ['import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";\n',
      'import { RubatoFolderFilter, useRubatoFolderFilterActive } from "../rubato-shell/threadFolders";\n'],
    ['  const selectedProject = props.projects.find(\n    (project) => project.key === props.selectedProjectKey,\n  );\n',
      '  const selectedProject = props.projects.find(\n    (project) => project.key === props.selectedProjectKey,\n  );\n  const [folderActive, clearFolder] = useRubatoFolderFilterActive();\n',
      'replace'],
    ['      <ListFilterMenu\n        label={selectedEnvironment?.label ?? gt("All environments")}\n',
      '      {props.environments.length > 1 || selectedEnvironment !== undefined ? (\n      <ListFilterMenu\n        label={selectedEnvironment?.label ?? gt("All environments")}\n',
      'replace'],
    ['            if (environment) props.onEnvironmentChange(environment.environmentId);\n          }\n        }}\n      />\n',
      '            if (environment) props.onEnvironmentChange(environment.environmentId);\n          }\n        }}\n      />\n      ) : null}\n      <RubatoFolderFilter />\n',
      'replace'],
    ['      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (\n',
      '      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null || folderActive ? (\n',
      'replace'],
    ['            props.onProjectChange(null);\n          }}\n',
      '            props.onProjectChange(null);\n            clearFolder();\n          }}\n',
      'replace'],
  ],
  // A thread's long-press menu: Move to Folder, after Rename.
  'apps/mobile/src/features/threads/thread-list-v2-items.tsx': [
    ['import { useEnvironmentScope } from "../../state/session";\n',
      'import { useRubatoThreadFolderMenu } from "../rubato-shell/threadFolders";\n'],
    ["  const titleMenuItems = useMemo<MenuAction[]>(\n    () => [\n      {\n        id: \"rename\",\n        title: gt(\"Rename\", { $context: \"verb, thread action\" }),\n        image: \"square.and.pencil\",\n      },\n",
      "  // Rubato: Move to Folder (thread-folders-edits.mjs).\n  const rubatoFolderMenu = useRubatoThreadFolderMenu(thread);\n  const titleMenuItems = useMemo<MenuAction[]>(\n    () => [\n      {\n        id: \"rename\",\n        title: gt(\"Rename\", { $context: \"verb, thread action\" }),\n        image: \"square.and.pencil\",\n      },\n      ...rubatoFolderMenu.items,\n",
      'replace'],
    ["    [\n      canTurnIntoProject,\n      gt,\n      m,\n      props.titleRegenerationSupported,\n",
      "    [\n      canTurnIntoProject,\n      gt,\n      m,\n      rubatoFolderMenu.items,\n      props.titleRegenerationSupported,\n",
      'replace'],
    ["      if (nativeEvent.event === \"new-thread-on-branch\") onNewThreadOnBranch(thread);\n",
      "      if (rubatoFolderMenu.handle(nativeEvent.event)) return;\n"],
    ["    [\n      gt,\n      m,\n      onNewThreadOnBranch,\n      thread,\n",
      "    [\n      gt,\n      m,\n      onNewThreadOnBranch,\n      rubatoFolderMenu,\n      thread,\n",
      'replace'],
  ],
};
