import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The chat width setting scales with the window (chat-width-edits.mjs). Measured
// in Chromium with the applied CSS, three things must hold:
// - The monitor scales it, and a small window gets a larger share. At the same
//   50%, a 4K monitor (2560px window) keeps the 1280px that looked right and a
//   laptop (1472px window) gets 954px, not the 736px that looked narrow.
// - The chat column does not change it until the column is narrower. Opening or
//   widening the right panel, or the sidebar, narrows the column; then the
//   column bounds it and the messages fill the column.
// - Depth does not change it. The composer caps at it three times, one box in
//   the other (stack > shell > form; the shell is itself a size container), and
//   the timeline twice (row > compaction separator). A % compounded, and a cqi
//   inside the shell measured the shell: the composer's content went narrow.
test('chat width scales with the window, the same at every depth and column width', {
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

    const measure = async (windowWidth, columnWidth, percent) => {
      await page.setViewportSize({ width: windowWidth, height: 900 });
      return page.evaluate(([columnWidth, percent]) => {
        document.getElementById('column').style.width = `${columnWidth}px`;
        document.documentElement.style.setProperty('--chat-width-percent', String(percent));
        return Object.fromEntries(['stack', 'shell', 'form', 'row', 'separator']
          .map((id) => [id, Math.round(document.getElementById(id).getBoundingClientRect().width)]));
      }, [columnWidth, percent]);
    };

    for (const [windowWidth, columnWidth, percent, composer, timeline] of [
      [1472, 1150, 50, 954, 954], // laptop, sidebar open
      [2560, 2240, 50, 1280, 1280], // 4K monitor at 2560px: the width that looked right
      [2560, 1700, 50, 1280, 1280], // right panel open: still fits, unchanged
      [1472, 900, 50, 860, 900], // panel wider than the room left: the column bounds it
      [2560, 2240, 40, 1024, 1024],
      [1472, 1150, 100, 1110, 1150], // 100% passes the column: the messages fill it
      [2560, 2240, 100, 2200, 2240], // the gutter, not the setting, bounds the composer
    ]) {
      const widths = await measure(windowWidth, columnWidth, percent);
      const label = `${percent}% in a ${columnWidth}px column, ${windowWidth}px window`;
      for (const id of ['stack', 'shell', 'form']) assert.equal(widths[id], composer, `${id} at ${label}`);
      for (const id of ['row', 'separator']) assert.equal(widths[id], timeline, `${id} at ${label}`);
    }
  } finally {
    await browser.close();
  }
});
