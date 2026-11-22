// Settings > General > About. T3's rows there report T3's own release and its
// updater, which a source-built Rubato app does not use. The section shows the
// Rubato checkout instead: its commit and pins, `rubato update` (through the
// desktop updater, which confirms and reopens the app) and `rubato restart`.
// The server half is /rubato/app (RubatoServiceRoute.ts, src/app/service.mjs).
//
// Keep Rubato's card at the top of General even though T3 now has a separate
// About page. The update dot leads to the same card.
export const aboutOverlays = [
  'apps/web/src/state/rubatoApp.ts',
  'apps/web/src/components/settings/RubatoAboutSection.tsx',
  'apps/web/src/state/rubatoApp.test.tsx',
];

export const aboutEdits = {
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { useDesktopUpdateState } from "../../state/desktopUpdate";\n',
      'import { RubatoAboutSection } from "./RubatoAboutSection";\n'],
    ['    <SettingsPageContainer>\n      <SettingsSection id="notifications" title={gt("Notifications")}>\n',
      [
        '    <SettingsPageContainer>',
        "      {/* Rubato: the checkout's release, `rubato update` and `rubato restart` (about-edits.mjs). */}",
        '      <SettingsSection id="rubato-about" title={gt("About")}>',
        '        <RubatoAboutSection />',
        '      </SettingsSection>',
        '      <SettingsSection id="notifications" title={gt("Notifications")}>',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";\n',
      'import { RubatoUpdateDot } from "./RubatoAboutSection";\n'],
    ['                                  </span>\n                                </SidebarMenuButton>\n',
      '                                  {to === "/settings/general" ? <RubatoUpdateDot /> : null}\n'],
  ],
};
