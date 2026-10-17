import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Rubato polish on T3's surfaces (polish-edits.mjs, overlay rubatoPolish.css).
const here = path.dirname(fileURLToPath(import.meta.url));
const polishCss = () => readFile(path.join(here, '../overlay/apps/web/src/rubatoPolish.css'), 'utf8');
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');

test('the polish takes every color from the active theme, so all Rubato themes get it', async () => {
  const css = (await polishCss()).replace(/\/\*[\s\S]*?\*\//g, '');
  // Theme roles arrive as CSS variables. A literal color would look right in one
  // theme and wrong in the others; only neutral black and white light/shadow is allowed.
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'hex color in rubatoPolish.css');
  assert.doesNotMatch(css, /\b(?:oklch|oklab|hsl|hsla|lab|lch)\(/i, 'literal color function in rubatoPolish.css');
  for (const [rgb] of css.matchAll(/rgba?\([^)]*\)/g)) {
    assert.match(rgb, /^rgba?\((?:0 0 0|255 255 255) \/ [\d.]+%?\)$/, `only neutral light and shadow: ${rgb}`);
  }
  // Light and dark each set their own light and shadow strengths.
  assert.match(css, /^:root \{[\s\S]*?--rb-rim:/m);
  assert.match(css, /^\.dark \{[\s\S]*?--rb-rim:/m);
});

test('the polish loads with the app styles', { skip: !process.env.T3_SOURCE }, async () => {
  const index = await applied('apps/web/src/index.css');
  assert.match(index, /^@import "tailwindcss";\n@import "\.\/rubatoPolish\.css";\n/);
});

test('thread details stay hidden instead of covering the chat, and the button says why', { skip: !process.env.T3_SOURCE }, async () => {
  // With no room beside the chat T3 floated the card over it as a popover.
  const card = await applied('apps/web/src/components/chat/ThreadDetailsCard.tsx');
  assert.doesNotMatch(card, /<PopoverPopup\b/);
  assert.match(card, /data-rubato-popover-caret/);

  const controls = await applied('apps/web/src/components/chat/PanelLayoutControls.tsx');
  const branch = controls.slice(controls.indexOf('threadPanelPresentation === "popover"'), controls.indexOf(': threadPanelTooltip(threadPanelToggle)'));
  assert.match(branch, /<Toggle[\s\S]*?\bdisabled\b[\s\S]*?aria-label="Toggle thread details panel"/);
  assert.match(branch, /Widen the window or close the right panel to show thread details/);
  assert.doesNotMatch(controls, /PopoverTrigger/);
});

test('"Open a surface" fills the right panel with larger rows', { skip: !process.env.T3_SOURCE }, async () => {
  const tabs = await applied('apps/web/src/components/RightPanelTabs.tsx');
  const launcher = tabs.slice(tabs.indexOf('aria-label="Open a surface"'), tabs.indexOf('function surfaceTitle('));
  assert.match(launcher, /max-w-md/);
  assert.doesNotMatch(launcher, /max-w-xs/);
  // Available and unavailable rows share one size.
  assert.equal(launcher.match(/"flex h-10 w-full cursor-(?:pointer|default) items-center gap-3/g)?.length, 2);
  assert.doesNotMatch(launcher, /"flex h-8 w-full/);
});

test('an unsent draft keeps the normal sidebar row instead of a warning-yellow box', { skip: !process.env.T3_SOURCE }, async () => {
  const sidebar = await applied('apps/web/src/components/Sidebar.tsx');
  const surface = /const draftSurfaceClassName = "([^"]*)";/.exec(sidebar)?.[1];
  const pen = /const draftPenClassName = "([^"]*)";/.exec(sidebar)?.[1];
  assert.ok(surface !== undefined && pen !== undefined, 'draft row classes not found');
  assert.doesNotMatch(`${surface} ${pen}`, /warning/);
  assert.match(surface, /hover:bg-sidebar-row-hover/);
});
