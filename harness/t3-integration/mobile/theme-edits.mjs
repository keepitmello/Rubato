// The phone's themes: the five Rubato library themes the desktop offers (packages/shared
// rubatoThemes.ts through theme-edits.mjs), Ocean first and by default.
//
// T3's mobile theme tests name T3's palettes (grove, iris, t3-chat), which the Rubato library
// replaced; theme-tests.json moves them onto Rubato's five. Generated with lock-diff.mjs from
// the pin's files and their edited copies.
import { readFileSync } from 'node:fs';

const themeTests = JSON.parse(readFileSync(new URL('./theme-tests.json', import.meta.url), 'utf8'));

export const mobileThemeOverlays = [];

export const mobileThemeEdits = {
  ...themeTests,
  // Themes: the five Rubato library themes the desktop offers (packages/shared rubatoThemes.ts,
  // reached through BUILT_IN_THEMES), Ocean first and by default; T3's standard palette is not offered.
  'apps/mobile/src/lib/mobileTheme.ts': [
    ['export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;\n',
      'export const DEFAULT_MOBILE_THEME_ID = MOBILE_DEFAULT_THEME_ID;\n/** Rubato: a fresh install, or a saved theme this build lacks, shows Ocean, as the desktop does. */\nexport const RUBATO_DEFAULT_MOBILE_THEME_ID = "ocean" as const;\n', 'replace'],
    ['  { id: DEFAULT_MOBILE_THEME_ID, label: "T3 Code" },\n  { id: "material-you", label: "Material You" },',
      '  // Rubato: no "T3 Code" card; the desktop offers only its library themes.\n  { id: "material-you", label: "Material You" },', 'replace'],
    ['    ? (value as MobileThemeId)\n    : DEFAULT_MOBILE_THEME_ID;',
      '    ? (value as MobileThemeId)\n    : RUBATO_DEFAULT_MOBILE_THEME_ID;', 'replace'],
    // Rubato: a saved "t3-code" (T3's standard palette, no longer offered) falls back to Ocean too.
    ['(MOBILE_THEME_IDS as readonly string[]).includes(value)',
      '([...BUILT_IN_THEME_IDS, "material-you"] as readonly string[]).includes(value)', 'replace'],
    ['import {\n  BUILT_IN_THEMES,\n', 'import {\n  BUILT_IN_THEME_IDS,\n  BUILT_IN_THEMES,\n', 'replace'],
    // Rubato: none of the five themes is "t3-chat", so its grouped-card and message-action
    // branches have nothing to match; the other themes take the general branches.
    ['      : themeId === "t3-chat"\n        ? appearance === "light"\n          ? colors.toolbarControl\n          : colors.surface\n        : colors.muted;',
      '      : colors.muted; // Rubato: no t3-chat branch (theme-edits.mjs).', 'replace'],
    ['    themeId === "t3-chat" && appearance === "dark"\n      ? [colors.messageActionForeground, colors.messageAction]\n      : themeId !== DEFAULT_MOBILE_THEME_ID && themeId !== "t3-chat"\n        ? [colors.messageAction, colors.messageActionForeground]\n        : undefined,',
      '    themeId !== DEFAULT_MOBILE_THEME_ID\n      ? [colors.messageAction, colors.messageActionForeground]\n      : undefined,', 'replace'],
  ],
  // Uniwind's generated type list names the themes the phone's CSS defines; Rubato's are the
  // five library themes (generated-uniwind-theme-names.json).
  'apps/mobile/uniwind-types.d.ts': [
    ["['light', 'dark', 't3-chat-light', 't3-chat-dark', 'grove-light', 'grove-dark', 'ocean-light', 'ocean-dark', 'ember-light', 'ember-dark', 'iris-light', 'iris-dark']",
      "['light', 'dark', 'ocean-light', 'ocean-dark', 'ink-light', 'ink-dark', 'ocean-reverse-light', 'ocean-reverse-dark', 'nocturne-light', 'nocturne-dark', 'manuscript-light', 'manuscript-dark']", 'replace'],
  ],
};
