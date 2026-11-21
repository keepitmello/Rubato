// The settings menu in Rubato v0.1.0's groups and order (user ba4754d0: menu only, rows stay on
// T3 v0.1.11's pages). T3's list keeps its own name and contents; the exported menu is built
// from it by rubatoSettingsNavGroups.ts, so later T3 pages need no edit here. Registered after
// the modules that add Rubato pages to T3's list (companion, phone, stats, settings layout).
export const settingsMenuOverlays = [
  'apps/web/src/components/settings/rubatoSettingsNavGroups.ts',
  'apps/web/src/components/settings/rubatoSettingsNavGroups.test.ts',
];

export const settingsMenuEdits = {
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['import { commandLabel } from "./KeybindingsSettings.logic";\n',
      'import { rubatoSettingsNavGroups } from "./rubatoSettingsNavGroups";\n'],
    ['export const SETTINGS_NAV_GROUPS: ReadonlyArray<{',
      '// Rubato: T3\'s menu, regrouped below (settings-menu-edits.mjs).\nconst UPSTREAM_SETTINGS_NAV_GROUPS: ReadonlyArray<{',
      'replace'],
    ['export function keybindingSearchAnchorId',
      '// Rubato: the menu in v0.1.0\'s groups and order (rubatoSettingsNavGroups.ts).\nexport const SETTINGS_NAV_GROUPS = rubatoSettingsNavGroups(UPSTREAM_SETTINGS_NAV_GROUPS);\n\n'],
  ],
  // T3's own structure test names its groups; the menu's headings are Rubato's now.
  'apps/web/src/components/settings/SettingsSidebarNav.composition.browser.test.tsx': [
    ['  for (const name of ["Agents", "Code", "Connections"]) {',
      '  for (const name of ["App", "Work", "Tools"]) { // Rubato: v0.1.0 groups (settings-menu-edits.mjs)',
      'replace'],
  ],
};
