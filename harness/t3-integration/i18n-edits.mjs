// Korean interface, on T3's own i18n (apps/web/src/i18n/, gt-react).
// - T3's Korean catalog loads with Rubato's wording put over it wherever
//   Rubato's dictionary has the same English (packages/shared rubatoWording.ts,
//   which the phone's Korean catalog goes through too).
// - Rubato's own text (overlay components, text its edits add) is written in
//   English and swapped from the same dictionary while the interface is Korean
//   (rubatoI18n.ts); T3's i18n runtime switches it with each language change.
// - Settings search also matches Rubato's titles in Korean.
// - A settings file from before, with Rubato's `uiLanguage: "ko"` and no
//   `language`, opens in Korean (DesktopClientSettings, rubatoUiLanguage.ts).
// T3's Language row (Settings, Display) and its translated macOS menu replace
// Rubato's own row and menu. The dictionary is built by i18n/ (README.md there).
export const i18nOverlays = [
  'apps/web/src/rubatoI18n.ts',
  'apps/web/src/rubatoI18n.test.tsx',
  // The dictionary and the catalog wording are shared with the phone.
  'packages/shared/src/rubatoI18n.ko.json',
  'packages/shared/src/rubatoWording.ts',
  'apps/web/src/i18n/rubatoWording.ts',
  'apps/web/src/i18n/rubatoWording.test.ts',
  'apps/web/src/rubatoKorean.browser.test.tsx',
  'apps/desktop/src/settings/rubatoUiLanguage.ts',
  'apps/desktop/src/settings/rubatoUiLanguage.test.ts',
];

export const i18nEdits = {
  'packages/shared/package.json': [
    ['    "./png": {\n',
      '    "./rubatoWording": {\n      "types": "./src/rubatoWording.ts",\n      "import": "./src/rubatoWording.ts"\n    },\n    "./rubatoI18n.ko.json": "./src/rubatoI18n.ko.json",\n'],
  ],
  'apps/web/src/i18n/initializeI18n.ts': [
    ['import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";\n',
      'import { loadRubatoKorean } from "./rubatoWording";\n'],
    ['  return module.default;\n',
      '  return locale === "ko" ? loadRubatoKorean(module.default) : module.default;\n', 'replace'],
  ],
  'apps/web/src/i18n/runtime.ts': [
    ['import { setActiveLocale } from "./messages";\n',
      'import { followLocale } from "../rubatoI18n";\n'],
    ['  return loadLocale(locale).then(() => activateLocale(locale));\n',
      [
        '  return loadLocale(locale)',
        '    .then(() => activateLocale(locale))',
        "    // Rubato's own text follows, before main.tsx's first render on a Korean start.",
        '    .then(() => followLocale(snapshot.locale));',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/web/src/components/settings/settingsSearch.ts': [
    ['import { isMacPlatform, isWindowsPlatform, normalizeSearchText } from "~/lib/utils";\n',
      'import { uiText } from "~/rubatoI18n";\n'],
    ['        normalizeSearchText(translate(SETTINGS_SECTION_LABELS[item.to])),\n',
      [
        '        normalizeSearchText(translate(SETTINGS_SECTION_LABELS[item.to])),',
        "        // Rubato's titles are English literals; in Korean they read from Rubato's dictionary.",
        '        normalizeSearchText(uiText(decodeMsg(item.title))),',
        '        normalizeSearchText(uiText(decodeMsg(SETTINGS_SECTION_LABELS[item.to]))),',
        '',
      ].join('\n'),
      'replace'],
  ],
  'apps/desktop/src/settings/DesktopClientSettings.ts': [
    ['import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";\n',
      'import { withRubatoUiLanguage } from "./rubatoUiLanguage.ts";\n'],
    ['    Object.hasOwn(document, "settings") ? document.settings : document,\n',
      '    withRubatoUiLanguage(Object.hasOwn(document, "settings") ? document.settings : document),\n',
      'replace'],
  ],
};
