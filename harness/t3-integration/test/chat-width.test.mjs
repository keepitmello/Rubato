import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The chat width setting is a pixel cap (chat-width-edits.mjs). Measured in
// Chromium with the applied CSS, three things must hold:
// - The monitor does not change it. A share of the window gave a laptop 734px
//   with wide margins and an external monitor 1280px from the same setting.
// - The chat column does not change it until the column is narrower. Opening or
//   widening the right panel, or the sidebar, narrows the column; then the
//   column bounds it and the messages fill the column.
// - Depth does not change it. The composer caps at it three times, one box in
//   the other (stack > shell > form; the shell is itself a size container), and
//   the timeline twice (row > compaction separator). A % compounded, and a cqi
//   inside the shell measured the shell: the composer's content went narrow.
// The setting-to-value mapping (px, or none at the top) is chatMaxWidthCss,
// tested in the contracts package.
test('chat width is a fixed cap, the same on every monitor, column width and depth', {
  skip: !process.env.T3_SOURCE,
  timeout: 60_000,
}, async () => {
  const source = process.env.T3_SOURCE;
  const css = await readFile(path.join(source, 'apps/web/src/index.css'), 'utf8');
  const rule = css.match(/:root \{\n  --chat-max-width: [^\n]+\n\}/)?.[0];
  assert.ok(rule, 'applied index.css has no --chat-max-width rule');

  const require = createRequire(path.join(source, 'apps/desktop/package.json'));
  const { chromium } = require('playwright-core');
  // playwright-core pins one browser build; a machine may only have Chrome.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      ${rule}
      * { box-sizing: border-box; margin: 0; }
      #shell { container-type: inline-size; }
      .gutter { padding: 0 20px; }
      .cap { display: block; width: 100%; max-width: var(--chat-max-width); margin: 0 auto; }
    </style>
    <div id="column">
      <div><div class="gutter"><div class="cap" id="stack"><div class="cap" id="shell"><div><form class="cap" id="form"></form></div></div></div></div></div>
      <div><div class="cap" id="row"><div class="cap" id="separator"></div></div></div>
    </div>`);

    const measure = async (windowWidth, columnWidth, value) => {
      await page.setViewportSize({ width: windowWidth, height: 900 });
      return page.evaluate(([columnWidth, value]) => {
        document.getElementById('column').style.width = `${columnWidth}px`;
        if (value) document.documentElement.style.setProperty('--chat-max-width', value);
        else document.documentElement.style.removeProperty('--chat-max-width');
        return Object.fromEntries(['stack', 'shell', 'form', 'row', 'separator']
          .map((id) => [id, document.getElementById(id).getBoundingClientRect().width]));
      }, [columnWidth, value]);
    };

    // null = the stylesheet default, before the setting is read.
    for (const [windowWidth, columnWidth, value, composer, timeline] of [
      [1468, 1150, null, 960, 960], // laptop, sidebar open: the default cap
      [2560, 2240, null, 960, 960], // external monitor: the same cap
      [1468, 1150, '960px', 960, 960],
      [2560, 2240, '960px', 960, 960],
      [2560, 1700, '960px', 960, 960], // right panel open: still fits, unchanged
      [1468, 900, '960px', 860, 900], // panel wider than the room left: the column bounds it
      [2560, 2240, '1400px', 1400, 1400],
      [1468, 1150, '1400px', 1110, 1150], // a cap above the column fills the column
      [2560, 2240, 'none', 2200, 2240], // Full: the gutter, not the setting, bounds the composer
    ]) {
      const widths = await measure(windowWidth, columnWidth, value);
      const label = `${value ?? 'default'} in a ${columnWidth}px column, ${windowWidth}px window`;
      for (const id of ['stack', 'shell', 'form']) assert.equal(widths[id], composer, `${id} at ${label}`);
      for (const id of ['row', 'separator']) assert.equal(widths[id], timeline, `${id} at ${label}`);
    }
  } finally {
    await browser.close();
  }
});
