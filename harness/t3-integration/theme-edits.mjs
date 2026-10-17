// Rubato's theme library replaces T3's built-in themes (T3 Chat, Grove, Ocean,
// Ember, Iris) with Ocean, Ocean Reverse, Nocturne, Ink and Manuscript. The
// palettes are one overlay file, overlay/packages/shared/src/rubatoThemes.ts;
// these edits point every list at it.
//
// T3's own palette constants stay defined. Tests and the theme-file defaults
// (getDefaultThemeColors) name them, and replacing their definitions would make
// every pin bump re-match hundreds of lines. Only the lists change: the ids,
// BUILT_IN_THEMES, the settings cards and the boot copy in index.html.
//
// Ocean keeps the id "ocean", so a saved Ocean preference (and the legacy
// "t3-ocean" alias) lands on Rubato's Ocean. A saved T3 Chat, Grove, Ember or
// Iris preference no longer names a theme and falls back to the standard palette.
//
// The boot copy is built from the overlay file here, so the colors the page
// paints before React mounts cannot drift from the runtime palettes.
import { RUBATO_THEMES } from './overlay/packages/shared/src/rubatoThemes.ts';

export const themeOverlays = ['packages/shared/src/rubatoThemes.ts'];

const ids = RUBATO_THEMES.map((theme) => theme.id);

const bootPalette = (colors) => [
  `              background: "${colors.canvas}",`,
  `              foreground: "${colors.text}",`,
  `              accent: "${colors.accent}",`,
  `              chrome: "${colors.chrome}",`,
];
const bootPalettes = [
  '        const BUILT_IN_THEME_PALETTES = {',
  ...RUBATO_THEMES.flatMap((theme) => [
    `          ${JSON.stringify(theme.id)}: {`,
    '            light: {',
    ...bootPalette(theme.appearance === 'light' ? theme.colors : theme.variants.light),
    '            },',
    '            dark: {',
    ...bootPalette(theme.appearance === 'dark' ? theme.colors : theme.variants.dark),
    '            },',
    '          },',
  ]),
  '        };',
  '        // T3\'s built-in palettes, kept unused so this edit stays a rename (theme-edits.mjs).',
  '        const T3_BUILT_IN_THEME_PALETTES = {',
  '          "t3-chat": {',
  '',
].join('\n');

// T3's theme tests name its stock themes as examples of "a built-in theme". The
// behaviors they check (mix halves, legacy aliases, the boot copy) stay; the
// examples become Rubato's: Nocturne as the base theme, Ocean as the other half,
// and "t3-ocean" as the legacy alias that still resolves.
const renameExamples = (text) => text
  .replaceAll('T3_CHAT_THEME', 'BASE_THEME')
  .replaceAll('GROVE_THEME', 'HALF_THEME')
  .replaceAll('"t3-chat"', '"nocturne"')
  .replaceAll('"t3-grove"', '"t3-ocean"');

const BOOT_MIX_TESTS = [
  "  it(\"applies the matching half of an automatic mix to the splash\", () => {",
  "    const storage = {",
  "      [THEME_STORAGE_KEY]: \"t3-chat\",",
  "      [THEME_APPEARANCE_MODE_STORAGE_KEY]: \"system\",",
  "      \"t3code:theme-halves:v1\": JSON.stringify({ dark: GROVE_THEME.id }),",
  "    };",
  "",
  "    const dark = runBootScript({ storage, prefersDark: true });",
  "    expect(dark.isDark).toBe(true);",
  "    expect(dark.themeId).toBe(GROVE_THEME.id);",
  "    expect(dark.bootVariables[\"--boot-background\"]).toBe(",
  "      getThemeColorsForMode(GROVE_THEME, \"dark\")!.canvas,",
  "    );",
  "",
  "    const light = runBootScript({ storage, prefersDark: false });",
  "    expect(light.isDark).toBe(false);",
  "    expect(light.themeId).toBe(\"t3-chat\");",
  "    expect(light.bootVariables[\"--boot-background\"]).toBe(",
  "      getThemeColorsForMode(T3_CHAT_THEME, \"light\")!.canvas,",
  "    );",
  "  });",
  "",
  "  it(\"lets a dark half go dark when the light-only base cannot\", () => {",
  "    const boot = runBootScript({",
  "      storage: {",
  "        [THEME_STORAGE_KEY]: \"paper\",",
  "        [THEME_APPEARANCE_MODE_STORAGE_KEY]: \"system\",",
  "        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([",
  "          {",
  "            id: \"paper\",",
  "            label: \"Paper\",",
  "            appearance: \"light\",",
  "            colors: { canvas: \"#f8fbff\", text: \"#10243d\", accent: \"#5b6cff\" },",
  "          },",
  "        ]),",
  "        \"t3code:theme-halves:v1\": JSON.stringify({ dark: GROVE_THEME.id }),",
  "      },",
  "      prefersDark: true,",
  "    });",
  "    expect(boot.isDark).toBe(true);",
  "    expect(boot.themeId).toBe(GROVE_THEME.id);",
  "  });",
  "",
  "  it(\"paints the half's splash when the base theme no longer exists\", () => {",
  "    const boot = runBootScript({",
  "      storage: {",
  "        [THEME_STORAGE_KEY]: \"gone-theme\",",
  "        [THEME_APPEARANCE_MODE_STORAGE_KEY]: \"system\",",
  "        \"t3code:theme-halves:v1\": JSON.stringify({ dark: GROVE_THEME.id }),",
  "      },",
  "      prefersDark: true,",
  "    });",
  "    expect(boot.isDark).toBe(true);",
  "    expect(boot.themeId).toBe(GROVE_THEME.id);",
  "    expect(boot.themeSelected).toBe(\"true\");",
  "    expect(boot.bootVariables[\"--boot-background\"]).toBe(",
  "      getThemeColorsForMode(GROVE_THEME, \"dark\")!.canvas,",
  "    );",
  "  });",
  "",
  "  it(\"resolves a legacy-prefixed mix half onto the renamed theme\", () => {",
  "    const boot = runBootScript({",
  "      storage: {",
  "        [THEME_STORAGE_KEY]: \"t3-chat\",",
  "        [THEME_APPEARANCE_MODE_STORAGE_KEY]: \"system\",",
  "        \"t3code:theme-halves:v1\": JSON.stringify({ dark: \"t3-grove\" }),",
  "      },",
  "      prefersDark: true,",
  "    });",
  "    expect(boot.isDark).toBe(true);",
  "    expect(boot.themeId).toBe(GROVE_THEME.id);",
  "    expect(boot.bootVariables[\"--boot-background\"]).toBe(",
  "      getThemeColorsForMode(GROVE_THEME, \"dark\")!.canvas,",
  "    );",
  "  });",
  "",
  "  it(\"ignores a mix half that names an unknown theme\", () => {",
  "    const boot = runBootScript({",
  "      storage: {",
  "        [THEME_STORAGE_KEY]: \"t3-chat\",",
  "        [THEME_APPEARANCE_MODE_STORAGE_KEY]: \"system\",",
  "        \"t3code:theme-halves:v1\": JSON.stringify({ dark: \"gone-theme\" }),",
  "      },",
  "      prefersDark: true,",
  "    });",
  "    expect(boot.themeId).toBe(\"t3-chat\");",
  "    expect(boot.isDark).toBe(true);",
  "  });",
  "",
].join('\n');

const LEGACY_PREFERENCE_TESTS = [
  "  it(\"resolves the legacy t3-chat-dark preference to dark T3 Chat\", () => {",
  "    expect(getThemeDefinition(\"t3-chat-dark\")).toBe(T3_CHAT_THEME);",
  "    expect(getThemePreferenceMode(\"t3-chat-dark\")).toBe(\"dark\");",
  "    expect(resolveThemeAppearance(\"t3-chat-dark\", true, false)).toBe(\"dark\");",
  "    expect(resolveDesktopTheme(\"t3-chat-dark\", false)).toBe(\"dark\");",
  "    expect(isKnownThemePreference(\"t3-chat-dark\")).toBe(true);",
  "  });",
  "",
  "  it(\"resolves legacy t3-prefixed ids onto the renamed themes\", () => {",
  "    for (const [legacy, theme] of [",
  "      [\"t3-grove\", GROVE_THEME],",
  "      [\"t3-ocean\", OCEAN_THEME],",
  "      [\"t3-ember\", EMBER_THEME],",
  "      [\"t3-iris\", IRIS_THEME],",
  "    ] as const) {",
  "      expect(getThemeDefinition(legacy)).toBe(theme);",
  "      expect(isKnownThemePreference(legacy)).toBe(true);",
  "      expect(canonicalThemePreference(legacy)).toBe(theme.id);",
  "    }",
  "    // The dark-variant alias keeps its raw form: it still carries a mode hint.",
  "    expect(canonicalThemePreference(\"t3-chat-dark\")).toBe(\"t3-chat-dark\");",
  "    // A stored mix that predates the rename resolves to the new ids.",
  "    expect(parseThemeHalves(JSON.stringify({ light: \"t3-ocean\", dark: \"t3-grove\" }))).toEqual({",
  "      light: OCEAN_THEME.id,",
  "      dark: GROVE_THEME.id,",
  "    });",
  "  });",
  "",
].join('\n');

const PERSISTED_PREFERENCE_TEST = [
  "  it(\"reads the persisted T3 Chat theme preference\", async () => {",
  "    vi.stubGlobal(\"window\", {",
  "      localStorage: createStorage({",
  "        getItem: () => \"t3-chat\",",
  "      }),",
  "    });",
  "",
  "    const { readThemePreference } = await import(\"./useTheme\");",
  "",
  "    expect(readThemePreference()).toBe(\"t3-chat\");",
  "  });",
  "",
].join('\n');

export const themeEdits = {
  'packages/shared/src/themePalettes.ts': [
    [
      'export const BUILT_IN_THEME_IDS = ["t3-chat", "grove", "ocean", "ember", "iris"] as const;\n',
      [
        'import { RUBATO_THEMES } from "./rubatoThemes.ts";',
        '',
        '// Rubato\'s themes replace T3\'s built-ins (rubatoThemes.ts). T3\'s palettes below stay',
        '// defined for the code and tests that name them; no list offers them.',
        `export const BUILT_IN_THEME_IDS = [${ids.map((id) => JSON.stringify(id)).join(', ')}] as const;`,
        '',
      ].join('\n'),
      'replace',
    ],
    [
      'export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [\n  T3_CHAT_THEME,\n  GROVE_THEME,\n  OCEAN_THEME,\n  EMBER_THEME,\n  IRIS_THEME,\n];\n',
      'export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = RUBATO_THEMES;\n',
      'replace',
    ],
  ],
  'apps/web/src/components/settings/ThemeSettings.tsx': [
    [
      '  T3_CHAT_THEME,\n  EMBER_THEME,\n  GROVE_THEME,\n  IRIS_THEME,\n  OCEAN_THEME,\n} from "../../themePalette";\n',
      '} from "../../themePalette";\nimport { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";\n',
      'replace',
    ],
    [
      'const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = [\n  T3_CHAT_THEME,\n  GROVE_THEME,\n  OCEAN_THEME,\n  EMBER_THEME,\n  IRIS_THEME,\n];\n',
      '// The theme library offers Rubato\'s themes (theme-edits.mjs).\nconst MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEMES;\n',
      'replace',
    ],
  ],
  'apps/web/index.html': [
    ['        const BUILT_IN_THEME_PALETTES = {\n          "t3-chat": {\n', bootPalettes, 'replace'],
    [
      '        const RESERVED_THEME_IDS = [\n          "system",\n          "light",\n          "dark",\n          "t3-chat",\n          "grove",\n          "ocean",\n          "ember",\n          "iris",\n',
      [
        '        const RESERVED_THEME_IDS = [',
        '          "system",',
        '          "light",',
        '          "dark",',
        ...ids.map((id) => `          ${JSON.stringify(id)},`),
        '',
      ].join('\n'),
      'replace',
    ],
  ],
  'apps/web/src/themeBoot.test.ts': [
    ['  resolveThemeAppearance,\n  T3_CHAT_THEME,\n  EMBER_THEME,\n  GROVE_THEME,\n  IRIS_THEME,\n  OCEAN_THEME,\n  THEME_APPEARANCE_MODE_STORAGE_KEY,\n',
      '  resolveThemeAppearance,\n  THEME_APPEARANCE_MODE_STORAGE_KEY,\n', 'replace'],
    [
      '} from "./themePalette";\n',
      [
        '} from "./themePalette";',
        'import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";',
        '',
        '// Rubato\'s themes replace T3\'s built-ins (theme-edits.mjs in the Rubato repo).',
        'const builtInTheme = (id: string) => BUILT_IN_THEMES.find((theme) => theme.id === id)!;',
        'const BASE_THEME = builtInTheme("nocturne");',
        'const HALF_THEME = builtInTheme("ocean");',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '    const chat = runBootScript({\n      storage: { [THEME_STORAGE_KEY]: "t3-chat", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },\n      prefersDark: true,\n    });\n    expect(chat.themeId).toBe("t3-chat");\n',
      '    const chat = runBootScript({\n      storage: { [THEME_STORAGE_KEY]: "nocturne", [THEME_FOLLOW_SYSTEM_STORAGE_KEY]: "true" },\n      prefersDark: true,\n    });\n    expect(chat.themeId).toBe("nocturne");\n',
      'replace',
    ],
    [
      '    for (const theme of [T3_CHAT_THEME, GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME]) {\n      // The boot script resolves every built-in from a light base appearance.\n',
      '    for (const theme of BUILT_IN_THEMES) {\n      // The boot script resolves every built-in from a light base appearance.\n',
      'replace',
    ],
    [BOOT_MIX_TESTS, renameExamples(BOOT_MIX_TESTS), 'replace'],
  ],
  'apps/web/src/themePalette.test.ts': [
    ['  getThemePreviewSidebarArtwork,\n  getThemePreferenceMode,\n  isKnownThemePreference,\n',
      '  getThemePreviewSidebarArtwork,\n  isKnownThemePreference,\n', 'replace'],
    ['  T3_CHAT_THEME,\n  EMBER_THEME,\n  GROVE_THEME,\n  IRIS_THEME,\n  OCEAN_THEME,\n  updateCustomTheme,\n',
      '  T3_CHAT_THEME,\n  GROVE_THEME,\n  updateCustomTheme,\n', 'replace'],
    ['    for (const theme of [T3_CHAT_THEME, GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME]) {\n      expect(getThemeDefinition(theme.id)).toBe(theme);\n',
      '    for (const theme of BUILT_IN_THEMES) {\n      expect(getThemeDefinition(theme.id)).toBe(theme);\n', 'replace'],
    [
      LEGACY_PREFERENCE_TESTS,
      [
        '  it("offers none of T3\'s stock themes, under their ids or the legacy ones", () => {',
        '    // Rubato\'s themes replace T3\'s built-ins (theme-edits.mjs in the Rubato repo).',
        '    for (const id of ["t3-chat", "grove", "ember", "iris", "t3-chat-dark", "t3-grove", "t3-ember", "t3-iris"]) {',
        '      expect(getThemeDefinition(id)).toBeNull();',
        '      expect(isKnownThemePreference(id)).toBe(false);',
        '    }',
        '  });',
        '',
        '  it("resolves the legacy t3-ocean id onto Rubato\'s Ocean", () => {',
        '    const ocean = BUILT_IN_THEMES.find((theme) => theme.id === "ocean")!;',
        '    expect(getThemeDefinition("t3-ocean")).toBe(ocean);',
        '    expect(isKnownThemePreference("t3-ocean")).toBe(true);',
        '    expect(canonicalThemePreference("t3-ocean")).toBe("ocean");',
        '    // A stored mix that predates the rename keeps its Ocean half; a stock half drops out.',
        '    expect(parseThemeHalves(JSON.stringify({ light: "t3-ocean", dark: "t3-grove" }))).toEqual({',
        '      light: "ocean",',
        '    });',
        '  });',
        '',
      ].join('\n'),
      'replace',
    ],
    [
      '    for (const preference of ["light", "dark", "system", T3_CHAT_THEME.id, GROVE_THEME.id]) {\n      expect(isKnownThemePreference(preference)).toBe(true);\n    }\n    expect(isKnownThemePreference(`${GROVE_THEME.id}:dark`)).toBe(false);\n',
      '    for (const preference of ["light", "dark", "system", "ocean", "nocturne"]) {\n      expect(isKnownThemePreference(preference)).toBe(true);\n    }\n    expect(isKnownThemePreference("ocean:dark")).toBe(false);\n',
      'replace',
    ],
  ],
  'apps/web/src/hooks/useTheme.test.ts': [
    [PERSISTED_PREFERENCE_TEST, renameExamples(PERSISTED_PREFERENCE_TEST).replace('T3 Chat theme preference', 'Nocturne theme preference'), 'replace'],
  ],
  'apps/web/src/vscodeThemeImport.test.ts': [
    [
      '    const themes = pairVsCodeThemes([make("grove-light", "light"), make("grove-dark", "dark")]);\n    expect(themes.map((theme) => theme.label).sort()).toEqual(["Grove Dark", "Grove Light"]);\n',
      '    const themes = pairVsCodeThemes([make("ocean-light", "light"), make("ocean-dark", "dark")]);\n    expect(themes.map((theme) => theme.label).sort()).toEqual(["Ocean Dark", "Ocean Light"]);\n',
      'replace',
    ],
  ],
};
