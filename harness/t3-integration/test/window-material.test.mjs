import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { t3Modules } from './t3-source.mjs';
import {
  LIQUID_GLASS_IS_DEFAULT,
  LIQUID_GLASS_MIN_MACOS,
  SIDEBAR_MATERIALS,
  TRANSPARENT_WINDOW_BACKGROUND,
  VIBRANCY_MATERIAL,
  WINDOW_MATERIAL_ARGUMENT,
  availableSidebarMaterials,
  defaultSidebarMaterial,
  formatWindowMaterialArgument,
  isSidebarMaterial,
  liveSidebarMaterial,
  macosMajorVersion,
  parseWindowMaterialArgument,
  pickSidebarMaterial,
  resolveSidebarMaterial,
  sidebarMaterialNeedsRestart,
  windowMaterialCreationOptions,
} from '../overlay/packages/contracts/src/rubatoWindowMaterial.ts';

// The sidebar material setting (window-material-edits.mjs): Opaque, macOS
// material (Electron vibrancy) or Liquid Glass (electron-liquid-glass).
const here = path.dirname(fileURLToPath(import.meta.url));
const overlay = (relative) => readFile(path.join(here, '../overlay', relative), 'utf8');
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');

const linux = { platform: 'linux', macosMajor: null };
const windows = { platform: 'win32', macosMajor: null };
const sequoia = { platform: 'darwin', macosMajor: 15 };
const tahoe = { platform: 'darwin', macosMajor: LIQUID_GLASS_MIN_MACOS };
const macos27 = { platform: 'darwin', macosMajor: 27 };
const unknownMac = { platform: 'darwin', macosMajor: null };

test('the setting has three values, and nothing else passes for one', () => {
  assert.deepEqual(SIDEBAR_MATERIALS, ['opaque', 'vibrancy', 'liquid-glass']);
  for (const value of SIDEBAR_MATERIALS) assert.ok(isSidebarMaterial(value));
  for (const value of ['', 'glass', 'Liquid Glass', 'sidebar', null, undefined, 1]) assert.equal(isSidebarMaterial(value), false);
});

test('macOS material is offered only on macOS, Liquid Glass only from macOS 26', () => {
  assert.equal(LIQUID_GLASS_MIN_MACOS, 26);
  assert.deepEqual(availableSidebarMaterials(linux), ['opaque']);
  assert.deepEqual(availableSidebarMaterials(windows), ['opaque']);
  assert.deepEqual(availableSidebarMaterials(sequoia), ['opaque', 'vibrancy']);
  assert.deepEqual(availableSidebarMaterials({ platform: 'darwin', macosMajor: 25 }), ['opaque', 'vibrancy']);
  assert.deepEqual(availableSidebarMaterials(unknownMac), ['opaque', 'vibrancy']);
  assert.deepEqual(availableSidebarMaterials(tahoe), ['opaque', 'vibrancy', 'liquid-glass']);
  assert.deepEqual(availableSidebarMaterials(macos27), ['opaque', 'vibrancy', 'liquid-glass']);
});

test('the macOS major version comes from Darwin\'s system version', () => {
  assert.equal(macosMajorVersion('darwin', '27.0'), 27);
  assert.equal(macosMajorVersion('darwin', '26.1.2'), 26);
  assert.equal(macosMajorVersion('darwin', '15.7'), 15);
  assert.equal(macosMajorVersion('darwin', ''), null);
  assert.equal(macosMajorVersion('linux', '6.8.0'), null);
});

test('the default: macOS material on a Mac, opaque elsewhere; Liquid Glass waits for a manual resize check', () => {
  // Synthetic drags resize no window on macOS 27, so the transparent window's
  // drag-resize could not be confirmed by machine; a person flips this.
  assert.equal(LIQUID_GLASS_IS_DEFAULT, false);
  assert.equal(defaultSidebarMaterial(linux), 'opaque');
  assert.equal(defaultSidebarMaterial(windows), 'opaque');
  assert.equal(defaultSidebarMaterial(sequoia), 'vibrancy');
  assert.equal(defaultSidebarMaterial(macos27), LIQUID_GLASS_IS_DEFAULT ? 'liquid-glass' : 'vibrancy');
});

test('a saved value this machine cannot show falls back to the closest it can', () => {
  assert.equal(resolveSidebarMaterial(undefined, macos27), defaultSidebarMaterial(macos27));
  assert.equal(resolveSidebarMaterial(undefined, linux), 'opaque');
  assert.equal(resolveSidebarMaterial('liquid-glass', macos27), 'liquid-glass');
  assert.equal(resolveSidebarMaterial('liquid-glass', sequoia), 'vibrancy');
  assert.equal(resolveSidebarMaterial('liquid-glass', linux), 'opaque');
  assert.equal(resolveSidebarMaterial('vibrancy', windows), 'opaque');
  for (const host of [linux, sequoia, macos27]) assert.equal(resolveSidebarMaterial('opaque', host), 'opaque');
  // The renderer resolves from what its window reported, with the same answer.
  for (const host of [linux, windows, sequoia, tahoe, macos27, unknownMac]) {
    const machine = { available: availableSidebarMaterials(host), fallback: defaultSidebarMaterial(host) };
    for (const saved of [undefined, ...SIDEBAR_MATERIALS]) {
      assert.equal(pickSidebarMaterial(saved, machine), resolveSidebarMaterial(saved, host), `${host.platform} ${host.macosMajor} ${saved}`);
    }
  }
});

test('each material maps to the window options Electron needs at creation', () => {
  assert.deepEqual(windowMaterialCreationOptions('opaque'), {});
  assert.deepEqual(windowMaterialCreationOptions('vibrancy'), {
    vibrancy: VIBRANCY_MATERIAL,
    visualEffectState: 'followWindow',
    backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
  });
  assert.equal(VIBRANCY_MATERIAL, 'sidebar');
  // electron-liquid-glass needs a transparent window and no vibrancy under the glass.
  assert.deepEqual(windowMaterialCreationOptions('liquid-glass'), {
    transparent: true,
    backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
  });
  assert.equal(TRANSPARENT_WINDOW_BACKGROUND, '#00000000');
});

test('opaque and macOS material switch live; entering or leaving Liquid Glass waits for a restart', () => {
  const expected = {
    'opaque>opaque': 'opaque', 'opaque>vibrancy': 'vibrancy', 'opaque>liquid-glass': 'opaque',
    'vibrancy>opaque': 'opaque', 'vibrancy>vibrancy': 'vibrancy', 'vibrancy>liquid-glass': 'vibrancy',
    'liquid-glass>opaque': 'liquid-glass', 'liquid-glass>vibrancy': 'liquid-glass', 'liquid-glass>liquid-glass': 'liquid-glass',
  };
  for (const active of SIDEBAR_MATERIALS) {
    for (const wanted of SIDEBAR_MATERIALS) {
      const live = liveSidebarMaterial(active, wanted);
      assert.equal(live, expected[`${active}>${wanted}`], `${active} -> ${wanted}`);
      assert.equal(sidebarMaterialNeedsRestart(active, wanted), live !== wanted, `${active} -> ${wanted}`);
    }
  }
});

test('the window tells its page what it was made with through one argument', async () => {
  const state = { active: 'liquid-glass', available: ['opaque', 'vibrancy', 'liquid-glass'], fallback: 'vibrancy' };
  const argument = formatWindowMaterialArgument(state);
  assert.ok(argument.startsWith(WINDOW_MATERIAL_ARGUMENT));
  assert.deepEqual(parseWindowMaterialArgument(['--other', argument]), state);
  assert.equal(parseWindowMaterialArgument(['--other']), null);
  assert.equal(parseWindowMaterialArgument([`${WINDOW_MATERIAL_ARGUMENT}glass;opaque;opaque`]), null);
  assert.equal(parseWindowMaterialArgument([`${WINDOW_MATERIAL_ARGUMENT}opaque;;opaque`]), null);
  // The sandboxed preload keeps its own copy of the prefix; it must be this one.
  const preload = await overlay('apps/desktop/src/rubatoWindowMaterialPreload.ts');
  assert.equal(/const WINDOW_MATERIAL_ARGUMENT = "([^"]+)";/.exec(preload)?.[1], WINDOW_MATERIAL_ARGUMENT);
});

test('the material CSS takes its colors from the theme and leaves the chat column and content card opaque', async () => {
  const css = (await overlay('apps/web/src/rubatoWindowMaterial.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /\b(?:rgb|rgba|oklch|oklab|hsl|hsla|lab|lch)\(/i);
  // Nothing applies to an opaque window.
  assert.doesNotMatch(css, /data-window-material="opaque"/);
  assert.match(css, /--rb-material-wash: color-mix\(in srgb, var\(--sidebar\) \d+%, transparent\)/);
  // The column beside the panel carries the sheet; the right panel's card is not cleared.
  assert.match(css, /> :not\(\[data-preview-panel-mode\], \[data-workspace-titlebar-controls\]\) \{\s*background-color: var\(--background\);/);
  assert.doesNotMatch(css, /data-right-panel-surface-content/);
});

test('the setting is a client setting the desktop window is made from', { skip: !process.env.T3_SOURCE }, async () => {
  const { source, effect } = t3Modules(process.env.T3_SOURCE);
  const Schema = await effect('Schema');
  const { ClientSettingsSchema, ClientSettingsPatch, DEFAULT_CLIENT_SETTINGS } = await source('packages/contracts/src/settings.ts');
  assert.equal(DEFAULT_CLIENT_SETTINGS.sidebarMaterial, undefined, 'no saved value means the machine default');
  for (const value of SIDEBAR_MATERIALS) {
    assert.equal(Schema.decodeUnknownSync(ClientSettingsSchema)({ sidebarMaterial: value }).sidebarMaterial, value);
    assert.equal(Schema.decodeUnknownSync(ClientSettingsPatch)({ sidebarMaterial: value }).sidebarMaterial, value);
  }
  assert.throws(() => Schema.decodeUnknownSync(ClientSettingsSchema)({ sidebarMaterial: 'glass' }));

  const window = await applied('apps/desktop/src/window/DesktopWindow.ts');
  const create = window.slice(window.indexOf('const window = yield* electronWindow.create({'), window.indexOf('webPreferences: {'));
  // The material's clear background must win over T3's opaque one.
  assert.ok(create.indexOf('backgroundColor: getInitialWindowBackgroundColor') < create.indexOf('...windowMaterial.options,'));
  assert.match(window, /additionalArguments: \[windowMaterial\.argument\],/);
  assert.match(window, /attachRubatoWindowMaterial\(window, windowMaterial\.active,/);
  assert.match(window, /rubatoWindowBackgroundColor\(window, getInitialWindowBackgroundColor\(shouldUseDarkColors\)\)/);
  const ipc = await applied('apps/desktop/src/ipc/methods/clientSettings.ts');
  assert.match(ipc, /yield\* clientSettings\.set\(settings\);\n\s*applyRubatoSidebarMaterial\(settings\.sidebarMaterial\);/);
  assert.match(await applied('apps/desktop/src/preload.ts'), /^import "\.\/rubatoWindowMaterialPreload\.ts";$/m);
});

test('Liquid Glass ships as a macOS-only optional dependency, locked', { skip: !process.env.T3_SOURCE }, async () => {
  const desktop = JSON.parse(await applied('apps/desktop/package.json'));
  assert.equal(desktop.optionalDependencies?.['electron-liquid-glass'], '1.1.1');
  assert.equal(desktop.dependencies['electron-liquid-glass'], undefined);
  const lock = await applied('pnpm-lock.yaml');
  assert.match(lock, /\n    optionalDependencies:\n      electron-liquid-glass:\n        specifier: 1\.1\.1\n        version: 1\.1\.1\n\n  apps\/marketing:\n/);
  assert.match(lock, /\n  electron-liquid-glass@1\.1\.1:\n    resolution: \{integrity: sha512-[^}]+\}\n    engines: \{node: '>=18'\}\n    os: \[darwin\]\n/);
  // Loaded by a name the bundler cannot follow, so it is not inlined.
  const main = await applied('apps/desktop/src/window/rubatoWindowMaterial.ts');
  assert.match(main, /const LIQUID_GLASS_MODULE: string = "electron-liquid-glass";/);
  assert.match(main, /await import\(LIQUID_GLASS_MODULE\)/);
});

test('the web app marks the live material and imports its CSS after the polish', { skip: !process.env.T3_SOURCE }, async () => {
  const index = await applied('apps/web/src/index.css');
  assert.match(index, /^@import "tailwindcss";\n@import "\.\/rubatoPolish\.css";\n@import "\.\/rubatoWindowMaterial\.css";\n/);
  assert.match(await applied('apps/web/src/routes/__root.tsx'), /function GlassAppearanceSync\(\) \{\n  useRubatoWindowMaterialSync\(\);/);
  assert.match(await applied('apps/web/src/components/settings/SettingsPanels.tsx'), /<SidebarMaterialSettingsRow \/>/);
  const search = await applied('apps/web/src/components/settings/settingsSearch.ts');
  assert.match(search, /id: "sidebar-material",\n    title: "Sidebar material",[\s\S]*?desktopOnly: true,\n    macOnly: true,/);
});
