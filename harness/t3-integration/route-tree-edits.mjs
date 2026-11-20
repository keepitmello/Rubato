// The routes Rubato adds, in the route tree the TanStack router plugin generates
// from routes/ at dev and build time (apps/web/src/routeTree.gen.ts). The edits
// must leave the file exactly as the generator writes it, or a build rewrites it
// under the app; test/route-tree.test.mjs checks that against the generator.
//
// The edits are not written by hand. The generator's sort order and line
// wrapping decide where each line goes, and a pin bump that renames a parent
// route moves all of them, so ROUTE_TREE_EDITS is the generator's output
// diffed against the pin's file (diffRouteTreeEdits). After a pin bump or a
// change to RUBATO_ROUTES, regenerate it:
//
//   T3_SOURCE=<pinned T3 checkout with node_modules> UPDATE_ROUTE_TREE=1 \
//     node --test test/route-tree.test.mjs

/** Route files Rubato adds under apps/web/src/routes/, each listed by the module that owns it. */
export const RUBATO_ROUTES = [
  // Their own pages, opened from the rail (project-rail-edits.mjs, stats-edits.mjs).
  'memory.tsx',
  'scheduled.tsx',
  'stats.tsx',
  // Settings pages (companion-, permission-, phone-edits.mjs) and the old settings
  // addresses of the rail's pages (memory-, schedule-, stats-edits.mjs).
  '_chat.settings.companion.tsx',
  '_chat.settings.memory.tsx',
  '_chat.settings.permissions.tsx',
  '_chat.settings.phone.tsx',
  '_chat.settings.scheduled.tsx',
  '_chat.settings.stats.tsx',
];

const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const count = (text, part) => text.split(part).length - 1;

/**
 * Anchored edits that turn `before` into `after`, where `after` only adds lines.
 * Each added run is anchored on the fewest neighbouring lines that occur once in
 * the file as it stands when the edit applies (edits apply in order).
 */
export function diffRouteTreeEdits(before, after) {
  const old = lines(before);
  const next = lines(after);
  const runs = [];
  let i = 0;
  for (let j = 0; j < next.length; ) {
    if (i < old.length && next[j] === old[i]) {
      i += 1;
      j += 1;
      continue;
    }
    const start = j;
    while (j < next.length && !(i < old.length && next[j] === old[i])) j += 1;
    runs.push({ at: i, added: next.slice(start, j) });
  }
  if (i !== old.length) throw new Error('the generated route tree removes or changes upstream lines');
  const current = [...old];
  let shift = 0;
  const edits = [];
  for (const { at, added } of runs) {
    const position = at + shift;
    const text = current.join('');
    const insertion = added.join('');
    let edit = null;
    for (let size = 1; edit === null && size <= current.length; size += 1) {
      for (let before = 0; before <= size; before += 1) {
        const after = size - before;
        if (before > position || position + after > current.length) continue;
        const head = current.slice(position - before, position).join('');
        const tail = current.slice(position, position + after).join('');
        if (count(text, head + tail) !== 1) continue;
        edit = before === 0 ? [tail, insertion] : [head + tail, head + insertion + tail, 'replace'];
        break;
      }
    }
    if (edit === null) throw new Error(`no unique anchor for ${insertion.slice(0, 80)}`);
    edits.push(edit);
    current.splice(position, 0, ...added);
    shift += added.length;
  }
  return edits;
}

// BEGIN ROUTE_TREE_EDITS (generated, see above)
export const ROUTE_TREE_EDITS = [
  [
    "import { Route as PairRouteImport } from './routes/pair'\n",
    "import { Route as StatsRouteImport } from './routes/stats'\nimport { Route as ScheduledRouteImport } from './routes/scheduled'\n"
  ],
  [
    "import { Route as GuestRouteImport } from './routes/guest'\n",
    "import { Route as MemoryRouteImport } from './routes/memory'\n"
  ],
  [
    "import { Route as ChatSettingsSourceControlRouteImport } from './routes/_chat.settings.source-control'\n",
    "import { Route as ChatSettingsStatsRouteImport } from './routes/_chat.settings.stats'\n"
  ],
  [
    "import { Route as ChatSettingsProvidersRouteImport } from './routes/_chat.settings.providers'\n",
    "import { Route as ChatSettingsScheduledRouteImport } from './routes/_chat.settings.scheduled'\n"
  ],
  [
    "import { Route as ChatSettingsOpenSourceLicensesRouteImport } from './routes/_chat.settings.open-source-licenses'\n",
    "import { Route as ChatSettingsPhoneRouteImport } from './routes/_chat.settings.phone'\nimport { Route as ChatSettingsPermissionsRouteImport } from './routes/_chat.settings.permissions'\n"
  ],
  [
    "import { Route as ChatSettingsMaintenanceRouteImport } from './routes/_chat.settings.maintenance'\n",
    "import { Route as ChatSettingsMemoryRouteImport } from './routes/_chat.settings.memory'\n"
  ],
  [
    "import { Route as ChatSettingsChatRouteImport } from './routes/_chat.settings.chat'\n",
    "import { Route as ChatSettingsCompanionRouteImport } from './routes/_chat.settings.companion'\n"
  ],
  [
    "const PairRoute = PairRouteImport.update({\n",
    "const StatsRoute = StatsRouteImport.update({\n  id: '/stats',\n  path: '/stats',\n  getParentRoute: () => rootRouteImport,\n} as any)\nconst ScheduledRoute = ScheduledRouteImport.update({\n  id: '/scheduled',\n  path: '/scheduled',\n  getParentRoute: () => rootRouteImport,\n} as any)\n"
  ],
  [
    "const GuestRoute = GuestRouteImport.update({\n",
    "const MemoryRoute = MemoryRouteImport.update({\n  id: '/memory',\n  path: '/memory',\n  getParentRoute: () => rootRouteImport,\n} as any)\n"
  ],
  [
    "const ChatSettingsSourceControlRoute =\n",
    "const ChatSettingsStatsRoute = ChatSettingsStatsRouteImport.update({\n  id: '/stats',\n  path: '/stats',\n  getParentRoute: () => ChatSettingsRoute,\n} as any)\n"
  ],
  [
    "const ChatSettingsProvidersRoute = ChatSettingsProvidersRouteImport.update({\n",
    "const ChatSettingsScheduledRoute = ChatSettingsScheduledRouteImport.update({\n  id: '/scheduled',\n  path: '/scheduled',\n  getParentRoute: () => ChatSettingsRoute,\n} as any)\n"
  ],
  [
    "const ChatSettingsOpenSourceLicensesRoute =\n",
    "const ChatSettingsPhoneRoute = ChatSettingsPhoneRouteImport.update({\n  id: '/phone',\n  path: '/phone',\n  getParentRoute: () => ChatSettingsRoute,\n} as any)\nconst ChatSettingsPermissionsRoute = ChatSettingsPermissionsRouteImport.update({\n  id: '/permissions',\n  path: '/permissions',\n  getParentRoute: () => ChatSettingsRoute,\n} as any)\n"
  ],
  [
    "const ChatSettingsMaintenanceRoute = ChatSettingsMaintenanceRouteImport.update({\n",
    "const ChatSettingsMemoryRoute = ChatSettingsMemoryRouteImport.update({\n  id: '/memory',\n  path: '/memory',\n  getParentRoute: () => ChatSettingsRoute,\n} as any)\n"
  ],
  [
    "const ChatSettingsChatRoute = ChatSettingsChatRouteImport.update({\n",
    "const ChatSettingsCompanionRoute = ChatSettingsCompanionRouteImport.update({\n  id: '/companion',\n  path: '/companion',\n  getParentRoute: () => ChatSettingsRoute,\n} as any)\n"
  ],
  [
    "  '/': typeof ChatIndexRoute\n  '/approve-agent': typeof ApproveAgentRoute\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/guest': typeof GuestRoute\n",
    "  '/': typeof ChatIndexRoute\n  '/approve-agent': typeof ApproveAgentRoute\n  '/connect': typeof ConnectRoute\n  '/connect-agent': typeof ConnectAgentRoute\n  '/guest': typeof GuestRoute\n  '/memory': typeof MemoryRoute\n",
    "replace"
  ],
  [
    "  '/memory': typeof MemoryRoute\n  '/pair': typeof PairRoute\n",
    "  '/memory': typeof MemoryRoute\n  '/pair': typeof PairRoute\n  '/scheduled': typeof ScheduledRoute\n  '/stats': typeof StatsRoute\n",
    "replace"
  ],
  [
    "  '/projects/$projectKey': typeof ProjectsProjectKeyRoute\n  '/$environmentId/$threadId': typeof ChatEnvironmentIdThreadIdRoute\n  '/draft/$draftId': typeof ChatDraftDraftIdRoute\n  '/settings/about': typeof ChatSettingsAboutRoute\n  '/settings/access': typeof ChatSettingsAccessRoute\n  '/settings/appearance': typeof ChatSettingsAppearanceRoute\n  '/settings/archived': typeof ChatSettingsArchivedRoute\n  '/settings/beta': typeof ChatSettingsBetaRoute\n  '/settings/browser': typeof ChatSettingsBrowserRoute\n  '/settings/chat': typeof ChatSettingsChatRoute\n",
    "  '/projects/$projectKey': typeof ProjectsProjectKeyRoute\n  '/$environmentId/$threadId': typeof ChatEnvironmentIdThreadIdRoute\n  '/draft/$draftId': typeof ChatDraftDraftIdRoute\n  '/settings/about': typeof ChatSettingsAboutRoute\n  '/settings/access': typeof ChatSettingsAccessRoute\n  '/settings/appearance': typeof ChatSettingsAppearanceRoute\n  '/settings/archived': typeof ChatSettingsArchivedRoute\n  '/settings/beta': typeof ChatSettingsBetaRoute\n  '/settings/browser': typeof ChatSettingsBrowserRoute\n  '/settings/chat': typeof ChatSettingsChatRoute\n  '/settings/companion': typeof ChatSettingsCompanionRoute\n",
    "replace"
  ],
  [
    "  '/settings/companion': typeof ChatSettingsCompanionRoute\n  '/settings/connections': typeof ChatSettingsConnectionsRoute\n  '/settings/devices': typeof ChatSettingsDevicesRoute\n  '/settings/diagnostics': typeof ChatSettingsDiagnosticsRoute\n  '/settings/diffs': typeof ChatSettingsDiffsRoute\n  '/settings/general': typeof ChatSettingsGeneralRoute\n  '/settings/integrations': typeof ChatSettingsIntegrationsRoute\n  '/settings/keybindings': typeof ChatSettingsKeybindingsRoute\n  '/settings/labs': typeof ChatSettingsLabsRoute\n  '/settings/maintenance': typeof ChatSettingsMaintenanceRoute\n",
    "  '/settings/companion': typeof ChatSettingsCompanionRoute\n  '/settings/connections': typeof ChatSettingsConnectionsRoute\n  '/settings/devices': typeof ChatSettingsDevicesRoute\n  '/settings/diagnostics': typeof ChatSettingsDiagnosticsRoute\n  '/settings/diffs': typeof ChatSettingsDiffsRoute\n  '/settings/general': typeof ChatSettingsGeneralRoute\n  '/settings/integrations': typeof ChatSettingsIntegrationsRoute\n  '/settings/keybindings': typeof ChatSettingsKeybindingsRoute\n  '/settings/labs': typeof ChatSettingsLabsRoute\n  '/settings/maintenance': typeof ChatSettingsMaintenanceRoute\n  '/settings/memory': typeof ChatSettingsMemoryRoute\n",
    "replace"
  ],
  [
    "  '/settings/memory': typeof ChatSettingsMemoryRoute\n  '/settings/open-source-licenses': typeof ChatSettingsOpenSourceLicensesRoute\n",
    "  '/settings/memory': typeof ChatSettingsMemoryRoute\n  '/settings/open-source-licenses': typeof ChatSettingsOpenSourceLicensesRoute\n  '/settings/permissions': typeof ChatSettingsPermissionsRoute\n  '/settings/phone': typeof ChatSettingsPhoneRoute\n",
    "replace"
  ],
  [
    "  '/settings/phone': typeof ChatSettingsPhoneRoute\n  '/settings/projects': typeof ChatSettingsProjectsRoute\n  '/settings/providers': typeof ChatSettingsProvidersRoute\n",
    "  '/settings/phone': typeof ChatSettingsPhoneRoute\n  '/settings/projects': typeof ChatSettingsProjectsRoute\n  '/settings/providers': typeof ChatSettingsProvidersRoute\n  '/settings/scheduled': typeof ChatSettingsScheduledRoute\n",
    "replace"
  ],
  [
    "  '/settings/scheduled': typeof ChatSettingsScheduledRoute\n  '/settings/scheduled-tasks': typeof ChatSettingsScheduledTasksRoute\n  '/settings/secrets': typeof ChatSettingsSecretsRoute\n  '/settings/snap-shot': typeof ChatSettingsSnapShotRoute\n  '/settings/source-control': typeof ChatSettingsSourceControlRoute\n",
    "  '/settings/scheduled': typeof ChatSettingsScheduledRoute\n  '/settings/scheduled-tasks': typeof ChatSettingsScheduledTasksRoute\n  '/settings/secrets': typeof ChatSettingsSecretsRoute\n  '/settings/snap-shot': typeof ChatSettingsSnapShotRoute\n  '/settings/source-control': typeof ChatSettingsSourceControlRoute\n  '/settings/stats': typeof ChatSettingsStatsRoute\n",
    "replace"
  ],
  [
    "  '/pair': typeof PairRoute\n  '/welcome': typeof WelcomeRoute\n  '/issues': typeof ChatIssuesRoute\n",
    "  '/memory': typeof MemoryRoute\n"
  ],
  [
    "  '/pair': typeof PairRoute\n  '/welcome': typeof WelcomeRoute\n  '/issues': typeof ChatIssuesRoute\n",
    "  '/pair': typeof PairRoute\n  '/scheduled': typeof ScheduledRoute\n  '/stats': typeof StatsRoute\n  '/welcome': typeof WelcomeRoute\n  '/issues': typeof ChatIssuesRoute\n",
    "replace"
  ],
  [
    "  '/settings/chat': typeof ChatSettingsChatRoute\n  '/settings/connections': typeof ChatSettingsConnectionsRoute\n",
    "  '/settings/chat': typeof ChatSettingsChatRoute\n  '/settings/companion': typeof ChatSettingsCompanionRoute\n  '/settings/connections': typeof ChatSettingsConnectionsRoute\n",
    "replace"
  ],
  [
    "  '/settings/open-source-licenses': typeof ChatSettingsOpenSourceLicensesRoute\n  '/settings/projects': typeof ChatSettingsProjectsRoute\n",
    "  '/settings/memory': typeof ChatSettingsMemoryRoute\n"
  ],
  [
    "  '/settings/open-source-licenses': typeof ChatSettingsOpenSourceLicensesRoute\n  '/settings/projects': typeof ChatSettingsProjectsRoute\n",
    "  '/settings/open-source-licenses': typeof ChatSettingsOpenSourceLicensesRoute\n  '/settings/permissions': typeof ChatSettingsPermissionsRoute\n  '/settings/phone': typeof ChatSettingsPhoneRoute\n  '/settings/projects': typeof ChatSettingsProjectsRoute\n",
    "replace"
  ],
  [
    "  '/settings/providers': typeof ChatSettingsProvidersRoute\n  '/settings/scheduled-tasks': typeof ChatSettingsScheduledTasksRoute\n",
    "  '/settings/providers': typeof ChatSettingsProvidersRoute\n  '/settings/scheduled': typeof ChatSettingsScheduledRoute\n  '/settings/scheduled-tasks': typeof ChatSettingsScheduledTasksRoute\n",
    "replace"
  ],
  [
    "  '/settings/source-control': typeof ChatSettingsSourceControlRoute\n  '/settings/storage': typeof ChatSettingsStorageRoute\n",
    "  '/settings/source-control': typeof ChatSettingsSourceControlRoute\n  '/settings/stats': typeof ChatSettingsStatsRoute\n  '/settings/storage': typeof ChatSettingsStorageRoute\n",
    "replace"
  ],
  [
    "  '/pair': typeof PairRoute\n  '/welcome': typeof WelcomeRoute\n",
    "  '/memory': typeof MemoryRoute\n"
  ],
  [
    "  '/welcome': typeof WelcomeRoute\n  '/_chat/issues': typeof ChatIssuesRoute\n",
    "  '/scheduled': typeof ScheduledRoute\n  '/stats': typeof StatsRoute\n"
  ],
  [
    "  '/_chat/settings/connections': typeof ChatSettingsConnectionsRoute\n",
    "  '/_chat/settings/companion': typeof ChatSettingsCompanionRoute\n"
  ],
  [
    "  '/_chat/settings/open-source-licenses': typeof ChatSettingsOpenSourceLicensesRoute\n",
    "  '/_chat/settings/memory': typeof ChatSettingsMemoryRoute\n"
  ],
  [
    "  '/_chat/settings/projects': typeof ChatSettingsProjectsRoute\n",
    "  '/_chat/settings/permissions': typeof ChatSettingsPermissionsRoute\n  '/_chat/settings/phone': typeof ChatSettingsPhoneRoute\n"
  ],
  [
    "  '/_chat/settings/scheduled-tasks': typeof ChatSettingsScheduledTasksRoute\n",
    "  '/_chat/settings/scheduled': typeof ChatSettingsScheduledRoute\n"
  ],
  [
    "  '/_chat/settings/storage': typeof ChatSettingsStorageRoute\n",
    "  '/_chat/settings/stats': typeof ChatSettingsStatsRoute\n"
  ],
  [
    "    | '/'\n    | '/approve-agent'\n    | '/connect'\n    | '/connect-agent'\n    | '/guest'\n",
    "    | '/'\n    | '/approve-agent'\n    | '/connect'\n    | '/connect-agent'\n    | '/guest'\n    | '/memory'\n",
    "replace"
  ],
  [
    "    | '/memory'\n    | '/pair'\n",
    "    | '/memory'\n    | '/pair'\n    | '/scheduled'\n    | '/stats'\n",
    "replace"
  ],
  [
    "    | '/projects/$projectKey'\n    | '/$environmentId/$threadId'\n    | '/draft/$draftId'\n    | '/settings/about'\n    | '/settings/access'\n    | '/settings/appearance'\n    | '/settings/archived'\n    | '/settings/beta'\n    | '/settings/browser'\n    | '/settings/chat'\n",
    "    | '/projects/$projectKey'\n    | '/$environmentId/$threadId'\n    | '/draft/$draftId'\n    | '/settings/about'\n    | '/settings/access'\n    | '/settings/appearance'\n    | '/settings/archived'\n    | '/settings/beta'\n    | '/settings/browser'\n    | '/settings/chat'\n    | '/settings/companion'\n",
    "replace"
  ],
  [
    "    | '/settings/companion'\n    | '/settings/connections'\n    | '/settings/devices'\n    | '/settings/diagnostics'\n    | '/settings/diffs'\n    | '/settings/general'\n    | '/settings/integrations'\n    | '/settings/keybindings'\n    | '/settings/labs'\n    | '/settings/maintenance'\n",
    "    | '/settings/companion'\n    | '/settings/connections'\n    | '/settings/devices'\n    | '/settings/diagnostics'\n    | '/settings/diffs'\n    | '/settings/general'\n    | '/settings/integrations'\n    | '/settings/keybindings'\n    | '/settings/labs'\n    | '/settings/maintenance'\n    | '/settings/memory'\n",
    "replace"
  ],
  [
    "    | '/settings/memory'\n    | '/settings/open-source-licenses'\n",
    "    | '/settings/memory'\n    | '/settings/open-source-licenses'\n    | '/settings/permissions'\n    | '/settings/phone'\n",
    "replace"
  ],
  [
    "    | '/settings/phone'\n    | '/settings/projects'\n    | '/settings/providers'\n",
    "    | '/settings/phone'\n    | '/settings/projects'\n    | '/settings/providers'\n    | '/settings/scheduled'\n",
    "replace"
  ],
  [
    "    | '/settings/scheduled'\n    | '/settings/scheduled-tasks'\n    | '/settings/secrets'\n    | '/settings/snap-shot'\n    | '/settings/source-control'\n",
    "    | '/settings/scheduled'\n    | '/settings/scheduled-tasks'\n    | '/settings/secrets'\n    | '/settings/snap-shot'\n    | '/settings/source-control'\n    | '/settings/stats'\n",
    "replace"
  ],
  [
    "    | '/pair'\n    | '/welcome'\n    | '/issues'\n",
    "    | '/memory'\n"
  ],
  [
    "    | '/pair'\n    | '/welcome'\n    | '/issues'\n",
    "    | '/pair'\n    | '/scheduled'\n    | '/stats'\n    | '/welcome'\n    | '/issues'\n",
    "replace"
  ],
  [
    "    | '/settings/chat'\n    | '/settings/connections'\n",
    "    | '/settings/chat'\n    | '/settings/companion'\n    | '/settings/connections'\n",
    "replace"
  ],
  [
    "    | '/settings/open-source-licenses'\n    | '/settings/projects'\n",
    "    | '/settings/memory'\n"
  ],
  [
    "    | '/settings/open-source-licenses'\n    | '/settings/projects'\n",
    "    | '/settings/open-source-licenses'\n    | '/settings/permissions'\n    | '/settings/phone'\n    | '/settings/projects'\n",
    "replace"
  ],
  [
    "    | '/settings/providers'\n    | '/settings/scheduled-tasks'\n",
    "    | '/settings/providers'\n    | '/settings/scheduled'\n    | '/settings/scheduled-tasks'\n",
    "replace"
  ],
  [
    "    | '/settings/source-control'\n    | '/settings/storage'\n",
    "    | '/settings/source-control'\n    | '/settings/stats'\n    | '/settings/storage'\n",
    "replace"
  ],
  [
    "    | '/pair'\n    | '/welcome'\n",
    "    | '/memory'\n"
  ],
  [
    "    | '/welcome'\n    | '/_chat/issues'\n",
    "    | '/scheduled'\n    | '/stats'\n"
  ],
  [
    "    | '/_chat/settings/connections'\n",
    "    | '/_chat/settings/companion'\n"
  ],
  [
    "    | '/_chat/settings/open-source-licenses'\n",
    "    | '/_chat/settings/memory'\n"
  ],
  [
    "    | '/_chat/settings/projects'\n",
    "    | '/_chat/settings/permissions'\n    | '/_chat/settings/phone'\n"
  ],
  [
    "    | '/_chat/settings/scheduled-tasks'\n",
    "    | '/_chat/settings/scheduled'\n"
  ],
  [
    "    | '/_chat/settings/storage'\n",
    "    | '/_chat/settings/stats'\n"
  ],
  [
    "  PairRoute: typeof PairRoute\n",
    "  MemoryRoute: typeof MemoryRoute\n"
  ],
  [
    "  WelcomeRoute: typeof WelcomeRoute\n",
    "  ScheduledRoute: typeof ScheduledRoute\n  StatsRoute: typeof StatsRoute\n"
  ],
  [
    "    '/pair': {\n",
    "    '/stats': {\n      id: '/stats'\n      path: '/stats'\n      fullPath: '/stats'\n      preLoaderRoute: typeof StatsRouteImport\n      parentRoute: typeof rootRouteImport\n    }\n    '/scheduled': {\n      id: '/scheduled'\n      path: '/scheduled'\n      fullPath: '/scheduled'\n      preLoaderRoute: typeof ScheduledRouteImport\n      parentRoute: typeof rootRouteImport\n    }\n"
  ],
  [
    "    '/guest': {\n",
    "    '/memory': {\n      id: '/memory'\n      path: '/memory'\n      fullPath: '/memory'\n      preLoaderRoute: typeof MemoryRouteImport\n      parentRoute: typeof rootRouteImport\n    }\n"
  ],
  [
    "    '/_chat/settings/source-control': {\n",
    "    '/_chat/settings/stats': {\n      id: '/_chat/settings/stats'\n      path: '/stats'\n      fullPath: '/settings/stats'\n      preLoaderRoute: typeof ChatSettingsStatsRouteImport\n      parentRoute: typeof ChatSettingsRoute\n    }\n"
  ],
  [
    "    '/_chat/settings/providers': {\n",
    "    '/_chat/settings/scheduled': {\n      id: '/_chat/settings/scheduled'\n      path: '/scheduled'\n      fullPath: '/settings/scheduled'\n      preLoaderRoute: typeof ChatSettingsScheduledRouteImport\n      parentRoute: typeof ChatSettingsRoute\n    }\n"
  ],
  [
    "    '/_chat/settings/open-source-licenses': {\n",
    "    '/_chat/settings/phone': {\n      id: '/_chat/settings/phone'\n      path: '/phone'\n      fullPath: '/settings/phone'\n      preLoaderRoute: typeof ChatSettingsPhoneRouteImport\n      parentRoute: typeof ChatSettingsRoute\n    }\n    '/_chat/settings/permissions': {\n      id: '/_chat/settings/permissions'\n      path: '/permissions'\n      fullPath: '/settings/permissions'\n      preLoaderRoute: typeof ChatSettingsPermissionsRouteImport\n      parentRoute: typeof ChatSettingsRoute\n    }\n"
  ],
  [
    "    '/_chat/settings/maintenance': {\n",
    "    '/_chat/settings/memory': {\n      id: '/_chat/settings/memory'\n      path: '/memory'\n      fullPath: '/settings/memory'\n      preLoaderRoute: typeof ChatSettingsMemoryRouteImport\n      parentRoute: typeof ChatSettingsRoute\n    }\n"
  ],
  [
    "    '/_chat/settings/chat': {\n",
    "    '/_chat/settings/companion': {\n      id: '/_chat/settings/companion'\n      path: '/companion'\n      fullPath: '/settings/companion'\n      preLoaderRoute: typeof ChatSettingsCompanionRouteImport\n      parentRoute: typeof ChatSettingsRoute\n    }\n"
  ],
  [
    "  ChatSettingsConnectionsRoute: typeof ChatSettingsConnectionsRoute\n",
    "  ChatSettingsCompanionRoute: typeof ChatSettingsCompanionRoute\n"
  ],
  [
    "  ChatSettingsOpenSourceLicensesRoute: typeof ChatSettingsOpenSourceLicensesRoute\n",
    "  ChatSettingsMemoryRoute: typeof ChatSettingsMemoryRoute\n"
  ],
  [
    "  ChatSettingsProjectsRoute: typeof ChatSettingsProjectsRoute\n",
    "  ChatSettingsPermissionsRoute: typeof ChatSettingsPermissionsRoute\n  ChatSettingsPhoneRoute: typeof ChatSettingsPhoneRoute\n"
  ],
  [
    "  ChatSettingsScheduledTasksRoute: typeof ChatSettingsScheduledTasksRoute\n",
    "  ChatSettingsScheduledRoute: typeof ChatSettingsScheduledRoute\n"
  ],
  [
    "  ChatSettingsStorageRoute: typeof ChatSettingsStorageRoute\n",
    "  ChatSettingsStatsRoute: typeof ChatSettingsStatsRoute\n"
  ],
  [
    "  ChatSettingsConnectionsRoute: ChatSettingsConnectionsRoute,\n",
    "  ChatSettingsCompanionRoute: ChatSettingsCompanionRoute,\n"
  ],
  [
    "  ChatSettingsOpenSourceLicensesRoute: ChatSettingsOpenSourceLicensesRoute,\n",
    "  ChatSettingsMemoryRoute: ChatSettingsMemoryRoute,\n"
  ],
  [
    "  ChatSettingsProjectsRoute: ChatSettingsProjectsRoute,\n",
    "  ChatSettingsPermissionsRoute: ChatSettingsPermissionsRoute,\n  ChatSettingsPhoneRoute: ChatSettingsPhoneRoute,\n"
  ],
  [
    "  ChatSettingsScheduledTasksRoute: ChatSettingsScheduledTasksRoute,\n",
    "  ChatSettingsScheduledRoute: ChatSettingsScheduledRoute,\n"
  ],
  [
    "  ChatSettingsStorageRoute: ChatSettingsStorageRoute,\n",
    "  ChatSettingsStatsRoute: ChatSettingsStatsRoute,\n"
  ],
  [
    "  PairRoute: PairRoute,\n",
    "  MemoryRoute: MemoryRoute,\n"
  ],
  [
    "  WelcomeRoute: WelcomeRoute,\n",
    "  ScheduledRoute: ScheduledRoute,\n  StatsRoute: StatsRoute,\n"
  ]
];
// END ROUTE_TREE_EDITS
