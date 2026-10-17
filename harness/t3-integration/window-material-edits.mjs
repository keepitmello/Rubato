// The sidebar material: Settings > Appearance > Sidebar material lets the
// desktop show through the left sidebar and the right panel's frame, while the
// chat canvas and the right panel's content card stay opaque.
//
// - Opaque: T3's own look.
// - macOS material: Electron's `vibrancy` (NSVisualEffectView), switched on the
//   running window.
// - Liquid Glass (macOS 26+): NSGlassEffectView through electron-liquid-glass.
//   It needs a transparent window, which Electron makes only at creation, so a
//   change into or out of it applies after a restart and the row says so.
//
// The rules live in overlay/packages/contracts/src/rubatoWindowMaterial.ts,
// shared by the main process, the web app and test/window-material.test.mjs.
// The window is made from the saved client setting; the preload passes the
// material it was made with to the page, which marks <html data-window-material>
// and rubatoWindowMaterial.css clears the sidebar's paint for it.
export const windowMaterialOverlays = [
  'packages/contracts/src/rubatoWindowMaterial.ts',
  'apps/desktop/src/window/rubatoWindowMaterial.ts',
  'apps/desktop/src/rubatoWindowMaterialPreload.ts',
  'apps/web/src/rubatoWindowMaterial.ts',
  'apps/web/src/rubatoInlinePanelMarkers.ts',
  'apps/web/src/rubatoWindowMaterial.css',
  'apps/web/src/components/settings/RubatoSidebarMaterialRow.tsx',
];

export const windowMaterialEdits = {
  'packages/contracts/src/settings.ts': [
    [
      'import { UsageLimitSourceId } from "./usageLimitSourceId.ts";\n',
      'import { SIDEBAR_MATERIALS } from "./rubatoWindowMaterial.ts";\n',
    ],
    [
      '\nexport const MIN_APPEARANCE_CONTRAST = 50;\n',
      [
        '',
        'export * from "./rubatoWindowMaterial.ts";',
        '/** Rubato: what the sidebar and the right panel\'s frame are made of (rubatoWindowMaterial.ts). */',
        'export const SidebarMaterialSetting = Schema.Literals(SIDEBAR_MATERIALS);',
        '',
      ].join('\n'),
    ],
    [
      '  glassOpacity: GlassOpacity.pipe(\n',
      [
        '  // Desktop-only. Absent means this machine\'s default (rubatoWindowMaterial.ts).',
        '  sidebarMaterial: Schema.optionalKey(SidebarMaterialSetting),',
        '',
      ].join('\n'),
    ],
    ['  glassOpacity: Schema.optionalKey(GlassOpacity),\n', '  sidebarMaterial: Schema.optionalKey(SidebarMaterialSetting),\n'],
  ],
  'apps/desktop/src/window/DesktopWindow.ts': [
    [
      'import { makeQuitShortcutHandler } from "./QuitHold.ts";\n',
      [
        'import {',
        '  attachRubatoWindowMaterial,',
        '  planRubatoWindowMaterial,',
        '  rubatoWindowBackgroundColor,',
        '} from "./rubatoWindowMaterial.ts";',
        '',
      ].join('\n'),
    ],
    // A theme change repaints the window color; a material keeps it clear.
    [
      '    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));\n',
      [
        '    window.setBackgroundColor(',
        '      rubatoWindowBackgroundColor(window, getInitialWindowBackgroundColor(shouldUseDarkColors)),',
        '    );',
        '',
      ].join('\n'),
      'replace',
    ],
    // The saved setting decides the material the window is made with. An
    // unreadable settings file falls back to this machine's default.
    [
      '    const window = yield* electronWindow.create({\n      ...initialBounds,\n',
      [
        '    const savedClientSettings = yield* clientSettings.get.pipe(',
        '      Effect.orElseSucceed(() => Option.none()),',
        '    );',
        '    const windowMaterial = planRubatoWindowMaterial(',
        '      Option.getOrUndefined(savedClientSettings)?.sidebarMaterial,',
        '    );',
        '',
      ].join('\n'),
    ],
    [
      '      webPreferences: {\n        preload: environment.preloadPath,\n',
      [
        '      ...windowMaterial.options,',
        '      webPreferences: {',
        '        preload: environment.preloadPath,',
        '        additionalArguments: [windowMaterial.argument],',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '    if (environment.platform === "darwin") {\n      window.setAutoHideCursor(false);\n    }\n',
      [
        '    attachRubatoWindowMaterial(window, windowMaterial.active, () =>',
        '      getInitialWindowBackgroundColor(Electron.nativeTheme.shouldUseDarkColors),',
        '    );',
        '',
      ].join('\n'),
    ],
  ],
  // Opaque and macOS material switch on the open window as the setting changes.
  'apps/desktop/src/ipc/methods/clientSettings.ts': [
    [
      'import * as IpcChannels from "../channels.ts";\n',
      'import { applyRubatoSidebarMaterial } from "../../window/rubatoWindowMaterial.ts";\n',
    ],
    [
      '    yield* clientSettings.set(settings);\n',
      [
        '    yield* clientSettings.set(settings);',
        '    applyRubatoSidebarMaterial(settings.sidebarMaterial);',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/desktop/src/preload.ts': [
    ['import { mergeLegacyLocalStorage } from "./legacyLocalStorageMerge.ts";\n', 'import "./rubatoWindowMaterialPreload.ts";\n'],
  ],
  // macOS binaries only, so optional: Linux and Windows installs skip it.
  'apps/desktop/package.json': [
    ['  "productName": "T3 Code (Beta)"\n', '  "optionalDependencies": {\n    "electron-liquid-glass": "1.1.1"\n  },\n'],
  ],
  // What `pnpm add --save-optional --save-exact electron-liquid-glass@1.1.1` adds
  // in apps/desktop, without the unrelated peer re-resolution it also does.
  'pnpm-lock.yaml': [
    [
      '\n  apps/marketing:\n',
      [
        '    optionalDependencies:',
        '      electron-liquid-glass:',
        '        specifier: 1.1.1',
        '        version: 1.1.1',
        '',
      ].join('\n'),
    ],
    [
      '  bippy@0.5.41:\n    resolution:',
      [
        '  bindings@1.5.0:',
        '    resolution: {integrity: sha512-p2q/t/mhvuOj/UeLlV6566GD/guowlr0hHxClI0W9m7MWYkL1F0hLo+0Aexs9HSPCtR1SXQ0TD3MMKrXZajbiQ==}',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  electron-publish@26.15.3:\n    resolution:',
      [
        '  electron-liquid-glass@1.1.1:',
        '    resolution: {integrity: sha512-AfPxcu6RJYxlsW2sjgjDEON0rVOjhh5QYM6ur5hsfILQmfY5ewHCWJZJZoDsQxhjeW1DAhbRbvB79IvgW4ansA==}',
        "    engines: {node: '>=18'}",
        '    os: [darwin]',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  filelist@1.0.6:\n    resolution:',
      [
        '  file-uri-to-path@1.0.0:',
        '    resolution: {integrity: sha512-0Zt+s3L7Vf1biwWZ29aARiVYLx7iMGnEUl9x33fbB/j3jR81u/O2LbqK+Bm1CDSNDKVtJ/YjwY7TUd5SkeLQLw==}',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  bippy@0.5.41(react@19.2.6):\n',
      [
        '  bindings@1.5.0:',
        '    dependencies:',
        '      file-uri-to-path: 1.0.0',
        '    optional: true',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  electron-publish@26.15.3:\n    dependencies:\n',
      [
        '  electron-liquid-glass@1.1.1:',
        '    dependencies:',
        '      bindings: 1.5.0',
        '      node-addon-api: 8.9.2',
        '    optionalDependencies:',
        '      node-gyp-build: 4.8.4',
        '    optional: true',
        '',
        '',
      ].join('\n'),
    ],
    [
      '  filelist@1.0.6:\n    dependencies:\n',
      ['  file-uri-to-path@1.0.0:', '    optional: true', '', ''].join('\n'),
    ],
  ],
  // After the polish's import, which sits right above this line. Not anchored on
  // that import itself: apply undoes edits first to last, and undoing the polish
  // would take its line out from under this one.
  'apps/web/src/index.css': [
    ['\n@custom-variant dark (&:is(.dark, .dark *));\n', '@import "./rubatoWindowMaterial.css";\n'],
  ],
  'apps/web/src/routes/__root.tsx': [
    [
      'import { shouldResumeSnapShotSetupOnStartup } from "../lib/snapShotSetupResume";\n',
      'import { useRubatoWindowMaterialSync } from "../rubatoWindowMaterial";\n',
    ],
    // Mounted on every app shell, the welcome flow included.
    [
      'function GlassAppearanceSync() {\n  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);\n',
      [
        'function GlassAppearanceSync() {',
        '  useRubatoWindowMaterialSync();',
        '  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);',
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  // The inline right panel marks the workspace and row it sits in, so the CSS
  // needs no :has() (see useRubatoInlinePanelMarkers).
  'apps/web/src/components/preview/PreviewPanelShell.tsx': [
    ['import { RightPanelResizeHandle } from "./RightPanelResizeHandle";\n', 'import { useRubatoInlinePanelMarkers } from "~/rubatoInlinePanelMarkers";\n'],
    [
      '  const hostRef = props.hostRef ?? localHostRef;\n',
      '  const hostRef = props.hostRef ?? localHostRef;\n  useRubatoInlinePanelMarkers(hostRef, isInline);\n',
      'replace',
    ],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { CliCommandSettingsRow } from "./CliCommandSettingsRow";\n', 'import { SidebarMaterialSettingsRow } from "./RubatoSidebarMaterialRow";\n'],
    ['        {showEnvironmentIdentification ? (\n', '        <SidebarMaterialSettingsRow />\n\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    [
      '  {\n    id: "diff-color-scheme",\n',
      [
        '  {',
        '    id: "sidebar-material",',
        '    title: "Sidebar material",',
        '    to: "/settings/appearance",',
        '    searchTerms: ["opaque translucent transparent vibrancy blur desktop wallpaper macos right panel"],',
        '    desktopOnly: true,',
        '    macOnly: true,',
        '  },',
        '',
      ].join('\n'),
    ],
  ],
};
