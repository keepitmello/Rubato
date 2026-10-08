import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The chat width setting is a share of the window (chat-width-edits.mjs). Two
// things must hold, measured in Chromium with the applied CSS:
// - Depth does not change it. The composer caps at it three times, one box in
//   the other (stack > shell > form; the shell is itself a size container), and
//   the timeline twice (row > compaction separator). A % compounded, and a cqi
//   inside the shell measured the shell: the composer's content went narrow.
// - The chat column does not change it until the column is narrower. Opening or
//   widening the right panel, or the sidebar, narrows the column; a share of the
//   column shrank the messages while empty margins stayed.
test('chat width is a share of the window, the same at every depth and column width', {
  skip: !process.env.T3_SOURCE,
  timeout: 60_000,
}, async () => {
  const source = process.env.T3_SOURCE;
  const css = await readFile(path.join(source, 'apps/web/src/index.css'), 'utf8');
  const rule = css.match(/:root \{\n  --chat-width-percent: \d+;\n  --chat-max-width: [^\n]+\n\}/)?.[0];
  assert.ok(rule, 'applied index.css has no --chat-max-width rule');

  const require = createRequire(path.join(source, 'apps/desktop/package.json'));
  const { chromium } = require('playwright-core');
  // playwright-core pins one browser build; a machine may only have Chrome.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
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

    const measure = (columnWidth, percent) => page.evaluate(([columnWidth, percent]) => {
      document.getElementById('column').style.width = `${columnWidth}px`;
      document.documentElement.style.setProperty('--chat-width-percent', String(percent));
      return Object.fromEntries(['stack', 'shell', 'form', 'row', 'separator']
        .map((id) => [id, document.getElementById(id).getBoundingClientRect().width]));
    }, [columnWidth, percent]);

    // Window 1600px: 65% is 1040px, 40% is 640px, 100% is the whole column.
    for (const [columnWidth, percent, composer, timeline] of [
      [1344, 65, 1040, 1040], // sidebar open, right panel closed
      [1100, 65, 1040, 1040], // right panel open: same width, it still fits
      [804, 65, 764, 804], // panel wider than the room left: the column bounds it
      [1344, 40, 640, 640],
      [804, 40, 640, 640], // the panel does not move a width that fits
      [1344, 100, 1304, 1344], // the gutter, not the setting, bounds the composer
      [300, 40, 260, 300], // narrower than the 24rem floor: the column bounds it
    ]) {
      const widths = await measure(columnWidth, percent);
      const label = `${percent}% in a ${columnWidth}px column`;
      for (const id of ['stack', 'shell', 'form']) assert.equal(widths[id], composer, `${id} at ${label}`);
      for (const id of ['row', 'separator']) assert.equal(widths[id], timeline, `${id} at ${label}`);
    }
  } finally {
    await browser.close();
  }
});
