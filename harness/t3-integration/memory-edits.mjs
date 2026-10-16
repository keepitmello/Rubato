// Settings > 기억. The page, its route and its server route are ours; the edits
// below only register them: a nav entry, a device-only page (no scope picker),
// the route in the generated tree, and the HTTP route on the server.
export const memoryOverlays = [
  'apps/server/src/RubatoMemory.ts',
  'apps/web/src/state/rubatoMemory.ts',
  // Auth for fetches to Rubato routes; the voice client uses it too.
  'apps/web/src/state/rubatoHttp.ts',
  'apps/web/src/state/rubatoHttp.test.ts',
  'apps/web/src/components/settings/RubatoMemorySettings.tsx',
  'apps/web/src/components/settings/RubatoMemorySettings.logic.ts',
  'apps/web/src/components/settings/RubatoMemorySettings.logic.test.ts',
  'apps/web/src/components/settings/RubatoMemoryIntro.tsx',
  'apps/web/src/routes/settings.memory.tsx',
];

export const memoryEdits = {
  // The one-time dream introduction sits with the app's other root dialogs.
  'apps/web/src/routes/__root.tsx': [
    ['import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";',
      'import { RubatoMemoryIntro } from "../components/settings/RubatoMemoryIntro";\n'],
    ['          <SshPasswordPromptDialog />', '          <RubatoMemoryIntro />\n'],
  ],
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";', 'import { rubatoMemoryRouteLayer } from "./RubatoMemory.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoMemoryRouteLayer,\n'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  | "/settings/storage"\n', '  | "/settings/memory"\n'],
    ['  "/settings/providers": "Providers",\n', '  "/settings/providers": "Providers",\n  "/settings/memory": "Memory",\n', 'replace'],
    ['  "/settings/storage": "project-defaults",\n', '  "/settings/memory": null,\n'],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['  BotIcon,\n', '  BotIcon,\n  BrainIcon,\n', 'replace'],
    ['  "/settings/storage": HardDriveIcon,\n', '  "/settings/memory": BrainIcon,\n'],
  ],
  'apps/web/src/components/settings/SettingsScopeSentence.tsx': [
    ['  "/settings/connections",\n]);', '  "/settings/connections",\n  "/settings/memory",\n]);', 'replace'],
  ],

};
