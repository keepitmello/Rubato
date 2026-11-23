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
  'apps/web/src/state/rubatoPush.ts',
  'apps/web/src/components/settings/RubatoCompanionThreadNotifications.tsx',
];

export const aboutEdits = {
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['  {\n    id: "in-app-notifications",\n',
      [
        '  {',
        '    id: "rubato-companion-thread-notifications",',
        '    title: "Companion-created thread notifications",',
        '    to: "/settings/general",',
        '    searchTerms: ["companion work completion failure alerts 알림 컴패니언 작업 완료 실패"],',
        '  },',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { useDesktopUpdateState } from "../../state/desktopUpdate";\n',
      'import { RubatoAboutSection } from "./RubatoAboutSection";\n'
        + 'import { RubatoCompanionThreadNotifications } from "./RubatoCompanionThreadNotifications";\n'],
    ['        <NotificationSettings />\n', '        <RubatoCompanionThreadNotifications />\n'],
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
