import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { RUBATO_THEMES } from '../overlay/packages/shared/src/rubatoThemes.ts';

// Rubato's themes replace T3's built-in themes (theme-edits.mjs). Ocean and
// Ocean Reverse keep Ocean's own colors and only place them again; the other
// three are new palettes on the same placement.
const byId = Object.fromEntries(RUBATO_THEMES.map((theme) => [theme.id, theme]));
const lightness = (color) => Number(/^oklch\(([\d.]+) /.exec(color)[1]);
const T3_STOCK_IDS = ['t3-chat', 'grove', 'ember', 'iris'];

test('the library is Ocean, Ocean Reverse, Nocturne, Ink and Manuscript, each light and dark', () => {
  assert.deepEqual(RUBATO_THEMES.map((theme) => theme.label), ['Ocean', 'Ocean Reverse', 'Nocturne', 'Ink', 'Manuscript']);
  // Ocean keeps its id so a saved Ocean preference lands on Rubato's Ocean.
  assert.equal(byId.ocean.label, 'Ocean');
  for (const theme of RUBATO_THEMES) {
    // index.html's boot script resolves every built-in from a light base.
    assert.equal(theme.appearance, 'light', theme.id);
    assert.ok(theme.variants?.dark, `${theme.id} has no dark half`);
  }
});

test('every theme has one accent: the send button, the accent and the terminal cursor share it', () => {
  for (const theme of RUBATO_THEMES) {
    for (const colors of [theme.colors, theme.variants.dark]) {
      assert.equal(colors.messageAction, colors.accent, theme.id);
      assert.equal(colors.terminalCursor, colors.accent, theme.id);
    }
  }
});

test('Ocean raises the sidebar over a deep canvas; Ocean Reverse swaps the two in the dark half', () => {
  const ocean = byId.ocean.variants.dark;
  const reverse = byId['ocean-reverse'].variants.dark;
  assert.ok(lightness(ocean.sidebar) > lightness(ocean.canvas));
  // The composer and code blocks sit on the sidebar's sheet, not on a gray of their own.
  assert.equal(ocean.surfaceRaised, ocean.sidebar);
  assert.equal(ocean.codeBackground, ocean.sidebar);

  assert.equal(reverse.canvas, ocean.sidebar);
  assert.equal(reverse.sidebar, ocean.canvas);
  assert.ok(lightness(reverse.sidebar) < lightness(reverse.canvas));
  // Light mode has no reverse: both read Ocean's light half.
  assert.deepEqual(byId['ocean-reverse'].colors, byId.ocean.colors);
});

test('Nocturne, Ink and Manuscript keep the sidebar behind the canvas and climb one ladder', () => {
  for (const id of ['nocturne', 'ink', 'manuscript']) {
    const { colors: light, variants: { dark } } = byId[id];
    assert.ok(lightness(light.sidebar) < lightness(light.canvas), `${id} light`);
    assert.ok(lightness(light.canvas) <= lightness(light.surfaceRaised), `${id} light`);
    assert.ok(lightness(dark.sidebar) < lightness(dark.canvas), `${id} dark`);
    assert.ok(lightness(dark.canvas) < lightness(dark.surfaceRaised), `${id} dark`);
    assert.ok(lightness(dark.surfaceRaised) < lightness(dark.border), `${id} dark`);
  }
});

test('Ocean and Ocean Reverse place only colors T3 Ocean already has', { skip: !process.env.T3_SOURCE }, async () => {
  const source = await readFile(path.join(process.env.T3_SOURCE, 'packages/shared/src/themePalettes.ts'), 'utf8');
  const start = source.indexOf('export const OCEAN_THEME: ThemeDefinition = {');
  assert.notEqual(start, -1, "T3's Ocean definition is gone; this check has nothing to compare with");
  const block = source.slice(start, source.indexOf('\n};\n', start));
  const [lightBlock, darkBlock] = block.split('    dark: {');
  const values = (text) => Object.fromEntries([...text.matchAll(/(\w+): "(oklch\([^"]+\))"/g)].map(([, role, value]) => [role, value]));
  const t3Light = values(lightBlock);
  const t3Dark = new Set(Object.values(values(darkBlock)));

  // The surfaces, lines and the one accent come from Ocean. Only muted text and the
  // placeholder may move, to keep T3's contrast on Ocean Reverse's brighter canvas.
  const placed = ['canvas', 'chrome', 'toolbar', 'surface', 'sidebar', 'surfaceRaised', 'surfaceOverlay', 'codeBackground',
    'messageSurface', 'muted', 'border', 'input', 'toolbarBorder', 'sidebarBorder', 'sidebarRowHover', 'sidebarRowActive',
    'sidebarRowSelected', 'sidebarControlSurface', 'accentSurface', 'accent', 'messageAction', 'text', 'terminalBackground'];
  for (const id of ['ocean', 'ocean-reverse']) {
    const dark = byId[id].variants.dark;
    for (const role of placed) assert.ok(t3Dark.has(dark[role]), `${id} dark ${role} ${dark[role]} is not an Ocean color`);
  }
  // The light half is Ocean's light half with the send button's teal as the one accent.
  const light = byId.ocean.colors;
  for (const [role, value] of Object.entries(t3Light)) {
    const expected = { accent: t3Light.messageAction, focus: t3Light.messageAction, terminalCursor: t3Light.messageAction,
      accentForeground: t3Light.messageActionForeground }[role] ?? value;
    assert.equal(light[role], expected, `ocean light ${role}`);
  }
});

test("T3's stock themes are gone from every list the app reads", { skip: !process.env.T3_SOURCE }, async () => {
  const read = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
  const ids = RUBATO_THEMES.map((theme) => theme.id);

  const palettes = await read('packages/shared/src/themePalettes.ts');
  assert.match(palettes, /^import \{ RUBATO_THEMES \} from "\.\/rubatoThemes\.ts";$/m);
  const listed = JSON.parse(/export const BUILT_IN_THEME_IDS = (\[[^\]]*\]) as const;/.exec(palettes)[1]);
  assert.deepEqual(listed, ids);
  assert.match(palettes, /export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = RUBATO_THEMES;/);

  const settings = await read('apps/web/src/components/settings/ThemeSettings.tsx');
  assert.match(settings, /const MAINTAINER_THEMES: ReadonlyArray<ThemeDefinition> = BUILT_IN_THEMES;/);
  assert.doesNotMatch(settings, /\bT3_CHAT_THEME\b|\bGROVE_THEME\b|\bEMBER_THEME\b|\bIRIS_THEME\b/);

  // The boot script paints the saved theme before React mounts; its copy must
  // offer exactly Rubato's themes, in the colors the runtime applies.
  const html = await read('apps/web/index.html');
  const literal = (name) => {
    const match = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n        \\}|\\[[\\s\\S]*?\\n        \\]);`).exec(html);
    assert.ok(match, `index.html has no ${name}`);
    return Function(`"use strict"; return (${match[1]});`)();
  };
  const boot = literal('BUILT_IN_THEME_PALETTES');
  assert.deepEqual(Object.keys(boot), ids);
  for (const theme of RUBATO_THEMES) {
    for (const [mode, colors] of [['light', theme.colors], ['dark', theme.variants.dark]]) {
      assert.deepEqual(boot[theme.id][mode],
        { background: colors.canvas, foreground: colors.text, accent: colors.accent, chrome: colors.chrome }, `${theme.id} ${mode}`);
    }
  }
  const reserved = literal('RESERVED_THEME_IDS');
  for (const id of ids) assert.ok(reserved.includes(id), `${id} is not reserved at boot`);
  for (const id of T3_STOCK_IDS) assert.ok(!reserved.includes(id) && !(id in boot), `${id} is still a boot theme`);
});
