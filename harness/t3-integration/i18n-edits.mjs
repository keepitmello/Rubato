// Korean interface. The page swaps T3's English text for Korean from a
// dictionary as React writes it (apps/web/src/rubatoI18n.ts), so no component
// changes; only these few places know about it:
// - the client setting uiLanguage, and its row at the top of
//   Settings > Appearance > Interface (RubatoLanguageSetting.tsx);
// - main.tsx, which loads the dictionary before the first render when the
//   last run was Korean, then follows the saved setting once settings load;
// - settings search, which also matches the Korean titles;
// - the macOS menu bar, rebuilt in Korean by the desktop app when the client
//   setting is read or written (apps/desktop/src/window/rubatoMenuLanguage.ts).
// The dictionary is built by i18n/ in this folder (README.md there).
export const i18nOverlays = [
  'apps/web/src/rubatoI18n.ts',
  'apps/web/src/rubatoI18n.test.tsx',
  'apps/web/src/rubatoI18n.ko.json',
  'apps/web/src/components/settings/RubatoLanguageSetting.tsx',
  'apps/desktop/src/window/rubatoMenuLanguage.ts',
  'apps/desktop/src/window/rubatoMenuLanguage.test.ts',
];

const SEARCH_ITEM = [
  '  {',
  '    id: "ui-language",',
  '    title: "Language",',
  '    to: "/settings/appearance",',
  '    searchTerms: ["language interface korean english translation locale 언어 한국어 영어 번역"],',
  '  },',
  '',
].join('\n');

export const i18nEdits = {
  'packages/contracts/src/settings.ts': [
    ['  diffColorScheme: DiffColorScheme.pipe(\n    Schema.withDecodingDefault(Effect.succeed("red-green" as const)),\n  ),\n',
      '  uiLanguage: Schema.Literals(["en", "ko"]).pipe(Schema.withDecodingDefault(Effect.succeed("en" as const))),\n'],
    ['  diffColorScheme: Schema.optionalKey(DiffColorScheme),\n',
      '  uiLanguage: Schema.optionalKey(Schema.Literals(["en", "ko"])),\n'],
  ],
  'apps/web/src/main.tsx': [
    ['import { AppRoot } from "./AppRoot";\n',
      'import { ensureClientSettingsHydrated, getClientSettings } from "./hooks/useSettings";\nimport { setUiLanguage, startUiLanguage } from "./rubatoI18n";\n'],
    ['  router.load(),\n', '  startUiLanguage(),\n'],
    ['const app = <AppRoot router={router} />;\n',
      [
        '// The first render used the language of the last run; the saved setting decides from here.',
        'void ensureClientSettingsHydrated()',
        '  .then(() => setUiLanguage(getClientSettings().uiLanguage))',
        '  .catch(() => undefined);',
        '',
        '',
      ].join('\n')],
  ],
  'apps/web/src/components/settings/SettingsPanels.tsx': [
    ['import { PRIVACY_POLICY_URL } from "../../legalLinks";\n',
      'import { RubatoLanguageSetting } from "./RubatoLanguageSetting";\n'],
    ['      <SettingsSection id="appearance-interface" title="Interface">\n',
      '      <SettingsSection id="appearance-interface" title="Interface">\n        <RubatoLanguageSetting />\n',
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";\n',
      'import { uiText } from "~/rubatoI18n";\n'],
    ['  {\n    id: "color-scheme",\n', SEARCH_ITEM],
    ['      const title = normalizeSearchText(item.title);\n      const fields = [\n        title,\n        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),\n',
      [
        '      // In Korean the title people read is the Korean one; the English still matches.',
        '      const title = normalizeSearchText(uiText(item.title));',
        '      const fields = [',
        '        title,',
        '        normalizeSearchText(item.title),',
        '        normalizeSearchText(uiText(SETTINGS_SECTION_LABELS[item.to])),',
        '        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/desktop/src/window/DesktopApplicationMenu.ts': [
    ['import * as ElectronMenu from "../electron/ElectronMenu.ts";\n',
      'import { rememberRubatoMenu } from "./rubatoMenuLanguage.ts";\n'],
    ['    yield* electronMenu.setApplicationMenu(template);\n',
      '    yield* electronMenu.setApplicationMenu(rememberRubatoMenu(template));\n', 'replace'],
  ],
  'apps/desktop/src/ipc/methods/clientSettings.ts': [
    ['import * as DesktopIpc from "../DesktopIpc.ts";\n',
      'import { setRubatoMenuLanguage } from "../../window/rubatoMenuLanguage.ts";\n'],
    ['    return Option.getOrNull(yield* clientSettings.get);\n',
      [
        '    const saved = Option.getOrNull(yield* clientSettings.get);',
        '    setRubatoMenuLanguage(saved?.uiLanguage);',
        '    return saved;',
        '',
      ].join('\n'),
      'replace'],
    ['    yield* snapShot.configure(settings);\n', '    setRubatoMenuLanguage(settings.uiLanguage);\n'],
  ],
};
