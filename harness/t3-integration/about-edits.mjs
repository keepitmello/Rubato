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
    [[
      '      <SettingsSection id="about" title="About">',
      '        {isElectron || HOSTED_APP_CHANNEL ? (',
      '          <AboutVersionSection />',
      '        ) : (',
      '          <SettingsRow',
      '            title={<AboutVersionTitle />}',
      '            description="Current version of the application."',
      '          />',
      '        )}',
      '      </SettingsSection>',
    ].join('\n'), '      {/* Rubato: About is the first section of General. */}', 'replace'],
    ['    <SettingsPageContainer>\n      <ProjectDefaultsSettings category="general" />\n',
      [
        '    <SettingsPageContainer>',
        '      <SettingsSection id="about" title="About">',
        '        <RubatoAboutSection />',
        '      </SettingsSection>',
        '      <ProjectDefaultsSettings category="general" />',
        '',
      ].join('\n'), 'replace'],
  ],
  'apps/web/src/components/settings/SettingsSidebarNav.tsx': [
    ['import { SidebarUtilityMenu } from "../sidebar/SidebarChrome";\n',
      'import { RubatoUpdateDot } from "./RubatoAboutSection";\n'],
    ['                      <span className="truncate">{item.label}</span>\n',
      '                      <span className="truncate">{item.label}</span>\n' +
      '                      {item.to === "/settings/general" ? <RubatoUpdateDot /> : null}\n',
      'replace'],
  ],
};
