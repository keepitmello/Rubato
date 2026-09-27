// Settings > General > About. T3's rows there report T3's own release and its
// updater, which a source-built Rubato app does not use. The section shows the
// Rubato checkout instead: its commit and pins, `rubato update` (through the
// desktop updater, which confirms and reopens the app) and `rubato restart`.
// The server half is /rubato/app (RubatoServiceRoute.ts, src/app/service.mjs).
export const aboutOverlays = [
  'apps/web/src/state/rubatoApp.ts',
  'apps/web/src/components/settings/RubatoAboutSection.tsx',
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
    ].join('\n'), [
      '      <SettingsSection id="about" title="About">',
      '        <RubatoAboutSection />',
      '      </SettingsSection>',
    ].join('\n'), 'replace'],
  ],
};
