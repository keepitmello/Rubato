import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
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

test('the polish stays off :has(), which re-ran style on every streamed message', async () => {
  // Measured on a long thread: 300 appended paragraphs cost ~12% more style recalc
  // with the :has() rules than without any Rubato CSS. State comes from markers instead.
  const css = (await polishCss()).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /:has\(/);
  assert.match(css, /\[data-right-panel-surface-content\]:not\(\[data-surface-empty\]\)/);
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

test('sidebar cards stay readable over the see-through material', { skip: !process.env.T3_SOURCE }, async () => {
  const sidebar = await applied('apps/web/src/components/Sidebar.tsx');
  // A read or background thread's card title sits one step below an unread one.
  const card = sidebar.slice(sidebar.indexOf('variant === "card"'), sidebar.indexOf('isRegeneratingTitle && "opacity-55"'));
  assert.match(card, /shouldRecede\n\s+\? "text-foreground\/80"\n\s+: isUnread \|\| isWoke \|\| status === "input"\n\s+\? "text-foreground"/);
  assert.doesNotMatch(card, /\? "text-secondary-label"\n/);
  // A working row no longer fades as a whole.
  assert.doesNotMatch(sidebar, /status === "working" &&\n\s+"opacity-70/);
  // The default branch goes unnamed; the third line and its model logo stay.
  assert.match(sidebar, /\{thread\.branch && !isDefaultBranchName\(thread\.branch\) \? \(\n\s+<>\n\s+<ThreadWorktreeIndicator/);
  assert.match(sidebar, /<SidebarProviderStack\n/);
  // The header carries the marker the New thread rule in rubatoPolish.css selects on.
  assert.match(sidebar, /<SidebarGroup className="z-\[1\]" data-rubato-thread-header>\n\s+<SidebarThreadHeader\n/);
});

test('New thread leads the sidebar header and New project follows in the muted color', async () => {
  const css = (await polishCss()).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector) => new RegExp(`${selector.replace(/[[\]>:().-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const actions = '[data-rubato-thread-header] > div > div:last-child > button';
  assert.match(rule(`${actions} > svg`), /color: var\(--color-sidebar-muted-foreground\)/);
  assert.match(rule(`${actions}:last-child > svg`), /color: var\(--color-sidebar-foreground\);[\s\S]*stroke-width: 2\.25/);
  assert.match(rule(`${actions}:hover > svg`), /color: var\(--color-sidebar-foreground\)/);
});

test('the project window is solid, so thread cards do not show between its rows', async () => {
  const css = (await polishCss()).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\[data-rubato-project-window\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /background: var\(--popover\);/);
  assert.match(rule, /(?:^|\s)backdrop-filter: none;/);
  // It must come after the glass rule it overrides, which has the same specificity.
  assert.ok(css.indexOf('[data-rubato-project-window]') > css.indexOf('.dropdown-glass,'));

  const rail = await readFile(path.join(overlayComponents, 'sidebar/RubatoProjectRail.tsx'), 'utf8');
  assert.match(rail, /<PopoverPopup\b[^>]*\bdata-rubato-project-window=""/);
});

const overlayComponents = path.join(here, '../overlay/apps/web/src/components');

test('every sidebar color a Rubato component paints with exists in the app theme', { skip: !process.env.T3_SOURCE }, async () => {
  // Tailwind emits nothing for a color the theme does not define. Upstream renamed
  // sidebar-accent to sidebar-row-hover/-active, and the rail's hover went blank.
  const index = await applied('apps/web/src/index.css');
  const defined = new Set([...index.matchAll(/--color-(sidebar[a-z-]*):/g)].map((match) => match[1]));
  assert.ok(defined.has('sidebar-foreground'), 'the theme lost its sidebar colors');
  const files = (await readdir(overlayComponents, { recursive: true })).filter((file) => file.endsWith('.tsx'));
  const missing = [];
  for (const file of files) {
    const text = await readFile(path.join(overlayComponents, file), 'utf8');
    for (const [, name] of text.matchAll(/\b(?:bg|text|border|ring|fill|stroke|outline|from|to|via)-(sidebar(?:-[a-z]+)*)/g)) {
      if (!defined.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
