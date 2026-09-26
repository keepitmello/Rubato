// macOS 권한 설정 화면. 에이전트 도구(screencapture, Peekaboo, osascript)는 Rubato
// 앱의 자식이라 macOS 가 권한을 Rubato.app 기준으로 본다. 설정 → macOS 권한에서
// 화면 기록·손쉬운 사용·전체 디스크 접근·자동화 상태를 보고 바로 요청한다.
// 데스크톱 쪽 등록(attachRubatoPermissions)은 DesktopWindow 편집이 apply.mjs 에
// 있어서 거기서 같이 건다 — 같은 앵커에 두 번 붙이면 되돌리기가 어긋난다.
export const permissionOverlays = [
  'apps/desktop/src/permissions/RubatoPermissions.ts',
  'apps/web/src/components/settings/RubatoPermissionsSettings.tsx',
  'apps/web/src/routes/settings.permissions.tsx',
];

const permissionTypes = [
  'export type RubatoPermissionId = "screen" | "accessibility" | "fullDisk" | "automation";',
  'export type RubatoPermissionStatus = "granted" | "denied" | "unknown";',
  'export type RubatoPermissionAction = "request" | "open" | "reset" | "relaunch";',
  'export interface RubatoPermissionsState {',
  '  appPath: string | null;',
  '  bundleId: string | null;',
  '  /** "stable" keeps grants across rebuilds; "adhoc" loses them on every rebuild. */',
  '  signing: "stable" | "adhoc" | "unknown";',
  '  items: Array<{ id: RubatoPermissionId; status: RubatoPermissionStatus }>;',
  '}',
  '',
].join('\n');

// The router plugin writes routeTree.gen.ts from routes/ at build time. These are
// exactly its lines for settings.permissions.tsx, so a rebuild leaves the file as
// applied. Three route lists repeat the same neighbours; each anchor runs on to
// the first line that differs between them.
const settingsTail = (line) =>
  ['projects', 'providers', 'snap-shot', 'source-control', 'storage']
    .map((name) => line(name))
    .join('');
const typed = (name) => {
  const route = name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  return `  '/settings/${name}': typeof Settings${route}Route\n`;
};
const union = (name) => `    | '/settings/${name}'\n`;
const routeTreeEdits = [
  ["import { Route as SettingsOpenSourceLicensesRouteImport } from './routes/settings.open-source-licenses'\n",
    "import { Route as SettingsPermissionsRouteImport } from './routes/settings.permissions'\n"],
  ['const SettingsOpenSourceLicensesRoute =\n',
    "const SettingsPermissionsRoute = SettingsPermissionsRouteImport.update({\n  id: '/permissions',\n  path: '/permissions',\n  getParentRoute: () => SettingsRoute,\n} as any)\n"],
  ...["  '/$environmentId/$threadId'", "  '/': typeof ChatIndexRoute", "  '/_chat/': typeof"].map((next) =>
    [settingsTail(typed) + next, "  '/settings/permissions': typeof SettingsPermissionsRoute\n"]),
  ...["    | '/$environmentId/$threadId'", "    | '/'\n", "    | '/_chat/'"].map((next) =>
    [settingsTail(union) + next, "    | '/settings/permissions'\n"]),
  ["    '/settings/open-source-licenses': {\n",
    "    '/settings/permissions': {\n      id: '/settings/permissions'\n      path: '/permissions'\n      fullPath: '/settings/permissions'\n      preLoaderRoute: typeof SettingsPermissionsRouteImport\n      parentRoute: typeof SettingsRoute\n    }\n"],
  ['  SettingsProjectsRoute: typeof SettingsProjectsRoute\n', '  SettingsPermissionsRoute: typeof SettingsPermissionsRoute\n'],
  ['  SettingsProjectsRoute: SettingsProjectsRoute,\n', '  SettingsPermissionsRoute: SettingsPermissionsRoute,\n'],
];

export const permissionEdits = {
  'apps/web/src/routeTree.gen.ts': routeTreeEdits,
  'packages/contracts/src/ipc.ts': [
    ['export const SystemSettingsPaneSchema = Schema.Literals(["full-disk-access"]);', permissionTypes],
    ['  getPathForFile?: (file: File) => string;',
      [
        '  rubatoPermissions?: {',
        '    getState: () => Promise<RubatoPermissionsState>;',
        '    act: (id: RubatoPermissionId | null, action: RubatoPermissionAction) => Promise<RubatoPermissionsState>;',
        '  };',
        '',
      ].join('\n')],
  ],
  'apps/desktop/src/preload.ts': [
    ['  getAppBranding: () => {',
      [
        '  rubatoPermissions: {',
        '    getState: () => ipcRenderer.invoke("rubato:permissions:get"),',
        '    act: (id, action) => ipcRenderer.invoke("rubato:permissions:action", { id, action }),',
        '  },',
        '',
      ].join('\n')],
  ],
  // T3 의 끌어다 놓기 도우미가 앱 이름을 박아 두었다.
  'apps/desktop/src/permissions/MacPermissionHelper.ts': [
    ['<header>↑ Drag T3 Code into the list above</header>\n<button id="app" draggable="true" aria-label="Drag T3 Code to System Settings, or click to reveal in Finder"><img src="${escapeHtml(icon)}" alt="" draggable="false">T3 Code</button>',
      '<header>↑ Drag Rubato into the list above</header>\n<button id="app" draggable="true" aria-label="Drag Rubato to System Settings, or click to reveal in Finder"><img src="${escapeHtml(icon)}" alt="" draggable="false">Rubato</button>',
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/snap-shot"\n  | "/settings/providers"',
      '  | "/settings/snap-shot"\n  | "/settings/permissions"\n  | "/settings/providers"',
      'replace'],
    ['  "/settings/snap-shot": "SnapShots",\n',
      '  "/settings/snap-shot": "SnapShots",\n  "/settings/permissions": "macOS 권한",\n',
      'replace'],
    ['  "/settings/snap-shot": null,\n',
      '  "/settings/snap-shot": null,\n  "/settings/permissions": null,\n',
      'replace'],
    ['  {\n    id: "snap-shot-enabled",',
      [
        '  {',
        '    id: "rubato-permissions",',
        '    title: "macOS 권한",',
        '    to: "/settings/permissions",',
        '    searchTerms: ["permissions privacy screen recording accessibility full disk access automation 화면 기록 손쉬운 사용 전체 디스크 자동화 권한"],',
        '    desktopOnly: true,',
        '    macOnly: true,',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['  SearchIcon,\n  Settings2Icon,\n', '  SearchIcon,\n  Settings2Icon,\n  ShieldCheckIcon,\n', 'replace'],
    ['  "/settings/snap-shot": SnapShotIcon,\n',
      '  "/settings/snap-shot": SnapShotIcon,\n  "/settings/permissions": ShieldCheckIcon,\n',
      'replace'],
    ['    (item) => item.to !== "/settings/projects" || isSettingsOverviewVisible(scopeSearch),\n',
      [
        '    (item) =>',
        '      (item.to !== "/settings/projects" || isSettingsOverviewVisible(scopeSearch)) &&',
        '      (item.to !== "/settings/permissions" || window.desktopBridge?.getClientPlatform?.() === "darwin"),',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/src/routes/settings.tsx': [
    ['  "/settings/snap-shot",\n  "/settings/connections",\n',
      '  "/settings/snap-shot",\n  "/settings/permissions",\n  "/settings/connections",\n',
      'replace'],
  ],
};
