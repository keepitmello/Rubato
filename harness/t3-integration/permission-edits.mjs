// macOS 권한 설정 화면. 세션이 돌리는 명령(screencapture, osascript)은 Rubato
// 앱의 자식이라 macOS 가 권한을 Rubato.app 기준으로 본다. 컴퓨터 유즈 백엔드인
// Cua Driver 는 자기 데몬 앱의 권한을 쓴다. 설정 → macOS 권한 한 화면에서 Rubato 앱의
// 화면 기록·손쉬운 사용·전체 디스크 접근·자동화와 Cua Driver 설치·실행·권한을 맞춘다.
// 데스크톱 쪽 등록(attachRubatoPermissions)은 DesktopWindow 편집이 apply.mjs 에
// 있어서 거기서 같이 건다 — 같은 앵커에 두 번 붙이면 되돌리기가 어긋난다.
export const permissionOverlays = [
  'apps/desktop/src/permissions/RubatoPermissions.ts',
  'apps/desktop/src/permissions/RubatoServices.ts',
  'apps/desktop/src/permissions/RubatoServices.test.ts',
  'apps/web/src/components/settings/RubatoPermissionsSettings.tsx',
  'apps/web/src/routes/settings.permissions.tsx',
];

const permissionTypes = [
  'export type RubatoPermissionId = "screen" | "accessibility" | "fullDisk" | "automation";',
  'export type RubatoPermissionStatus = "granted" | "denied" | "unknown";',
  'export type RubatoPermissionAction =',
  '  | "request" | "open" | "reset" | "relaunch"',
  '  | "cua-install" | "cua-start" | "cua-grant" | "cua-update"',
  '  | "service-start";',
  '/** The launchd agents Rubato runs beside the app (desktop RubatoServices.ts). */',
  'export type RubatoServiceId = "msearch" | "scheduler" | "remote-hub" | "aside-cursor" | "speed-data";',
  'export type RubatoServiceStatus = "running" | "scheduled" | "stopped" | "failed" | "missing";',
  'export interface RubatoServiceState {',
  '  id: RubatoServiceId;',
  '  status: RubatoServiceStatus;',
  '  /** The last error line its log holds, when it is failing. */',
  '  detail: string | null;',
  '}',
  'export interface RubatoPermissionsState {',
  '  appPath: string | null;',
  '  bundleId: string | null;',
  '  /** "stable" keeps grants across rebuilds; "adhoc" loses them on every rebuild. */',
  '  signing: "stable" | "adhoc" | "unknown";',
  '  items: Array<{ id: RubatoPermissionId; status: RubatoPermissionStatus }>;',
  '  /** Cua Driver, the computer-use backend. Its grants belong to its own daemon app. */',
  '  cua: {',
  '    installed: boolean;',
  '    version: string | null;',
  '    latest: string | null;',
  '    running: boolean;',
  '    accessibility: RubatoPermissionStatus;',
  '    screenRecording: RubatoPermissionStatus;',
  '  };',
  '  services: RubatoServiceState[];',
  '}',
  '',
].join('\n');

export const permissionEdits = {
  'packages/contracts/src/ipc.ts': [
    ['export const SystemSettingsPaneSchema = Schema.Literals(["full-disk-access"]);', permissionTypes],
    ['  getPathForFile?: (file: File) => string;',
      [
        '  rubatoPermissions?: {',
        '    getState: () => Promise<RubatoPermissionsState>;',
        '    act: (',
        '      id: RubatoPermissionId | RubatoServiceId | null,',
        '      action: RubatoPermissionAction,',
        '    ) => Promise<RubatoPermissionsState>;',
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
      '  "/settings/snap-shot": "SnapShots",\n  "/settings/permissions": "macOS Permissions",\n',
      'replace'],
    ['  "/settings/snap-shot": null,\n',
      '  "/settings/snap-shot": null,\n  "/settings/permissions": null,\n',
      'replace'],
    ['  {\n    id: "snap-shot-enabled",',
      [
        '  {',
        '    id: "rubato-permissions",',
        '    title: "macOS Permissions",',
        '    to: "/settings/permissions",',
        '    searchTerms: ["permissions privacy screen recording accessibility full disk access automation computer use cua driver background services launchd msearch memory search scheduler remote hub 화면 기록 손쉬운 사용 전체 디스크 자동화 권한 컴퓨터 유즈 백그라운드 서비스 기억 검색 예약"],',
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
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/snap-shot",\n  "/settings/connections",\n',
      '  "/settings/snap-shot",\n  "/settings/permissions",\n  "/settings/connections",\n',
      'replace'],
  ],
};
