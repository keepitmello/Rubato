// Settings > General > About. T3's rows there report T3's own release and its
// updater, which a source-built Rubato app does not use. The section shows the
// Rubato checkout instead: its commit and pins, `rubato update` (through the
// desktop updater, which confirms and reopens the app) and `rubato restart`.
// The server half is /rubato/app (RubatoServiceRoute.ts, src/app/service.mjs).
//
// T3 puts About last on General, below every preference, where update and
// restart were hard to find. It moves to the top, and the settings nav shows a
// dot next to General while an update is waiting.
export const aboutOverlays = [
  'apps/web/src/state/rubatoApp.ts',
  'apps/web/src/components/settings/RubatoAboutSection.tsx',
  'apps/web/src/state/rubatoApp.test.tsx',
];

export const aboutEdits = {
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { useDesktopUpdateState } from "../../state/desktopUpdate";\n',
      'import { RubatoAboutSection } from "./RubatoAboutSection";\n'],
    // About is its own settings page now (AboutSettingsPanel), so Rubato's section opens
    // that page, above the App rows upstream keeps for organization policy and mobile.
    ['    <SettingsPageContainer>\n      <SettingsSection id="about" title={gt("App")}>\n',
      [
        '    <SettingsPageContainer>',
        "      {/* Rubato: the checkout's release, `rubato update` and `rubato restart` (about-edits.mjs). */}",
        '      <SettingsSection id="rubato-about" title={gt("About")}>',
        '        <RubatoAboutSection />',
        '      </SettingsSection>',
        '      <SettingsSection id="about" title={gt("App")}>',
        '',
      ].join('\n'),
      'replace'],
  ],
  // The settings nav is built from SETTINGS_NAV_GROUPS now, and About is its own item.
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";\n',
      'import { RubatoUpdateDot } from "./RubatoAboutSection";\n'],
    ['                                  </span>\n                                </SidebarMenuButton>\n',
      '                                  {to === "/settings/about" ? <RubatoUpdateDot /> : null}\n'],
  ],
};
