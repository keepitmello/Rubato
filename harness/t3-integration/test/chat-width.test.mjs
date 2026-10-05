import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// The chat width setting is a share of the chat column (chat-width-edits.mjs).
// The composer caps itself at that width three times, one box inside the other
// (stack, form, shell), and the timeline twice (row, compaction separator). The
// width must not compound with depth: 65% of 65% of 65% made the composer's
// content far narrower than its card. This lays out that nesting in Chromium
// with the applied CSS rule and measures every box.
test('chat width resolves to the same length at every nesting depth', {
  skip: !process.env.T3_SOURCE,
  timeout: 60_000,
}, async () => {
  const source = process.env.T3_SOURCE;
  const css = await readFile(path.join(source, 'apps/web/src/index.css'), 'utf8');
  const rule = css.match(/:root \{\n  --chat-width-percent: \d+;\n  --chat-max-width: [^\n]+\n\}/)?.[0];
  assert.ok(rule, 'applied index.css has no --chat-max-width rule');

  // The CSS unit only means "share of the chat column" if that column is the
  // query container; Tailwind's @container class makes it one.
  const chatView = await readFile(path.join(source, 'apps/web/src/components/ChatView.tsx'), 'utf8');
  assert.match(chatView, /\{\/\* Chat column \*\/\}\n\s*<div\n\s*className="@container\/chat-column /);

  const require = createRequire(path.join(source, 'apps/desktop/package.json'));
  const { chromium } = require('playwright-core');
  // playwright-core pins one browser build; a machine may only have Chrome.
  const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>
      ${rule}
      * { box-sizing: border-box; margin: 0; }
      #column { container-type: inline-size; }
      .gutter { padding: 0 20px; }
      .cap { display: block; width: 100%; max-width: var(--chat-max-width); margin: 0 auto; }
    </style>
    <div id="column">
      <div class="gutter"><div class="cap" id="stack"><form class="cap" id="form"><div class="cap" id="shell"></div></form></div></div>
      <div class="cap" id="row"><div class="cap" id="separator"></div></div>
    </div>`);

    const measure = (columnWidth, percent) => page.evaluate(([columnWidth, percent]) => {
      document.getElementById('column').style.width = `${columnWidth}px`;
      document.documentElement.style.setProperty('--chat-width-percent', String(percent));
      return Object.fromEntries(['stack', 'form', 'shell', 'row', 'separator']
        .map((id) => [id, document.getElementById(id).getBoundingClientRect().width]));
    }, [columnWidth, percent]);

    for (const [columnWidth, percent, composer, timeline] of [
      [1200, 65, 780, 780],
      [1200, 40, 480, 480],
      [1200, 100, 1160, 1200], // the gutter, not the setting, bounds the composer
      [300, 40, 260, 300], // the 24rem floor fills a narrow column
    ]) {
      const widths = await measure(columnWidth, percent);
      const label = `${percent}% of a ${columnWidth}px column`;
      for (const id of ['stack', 'form', 'shell']) assert.equal(widths[id], composer, `${id} at ${label}`);
      for (const id of ['row', 'separator']) assert.equal(widths[id], timeline, `${id} at ${label}`);
    }
  } finally {
    await browser.close();
  }
});

