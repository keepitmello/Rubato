import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Chat tables take the chat width and wrap their cells (chat-table-edits.mjs).
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');
const rule = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing rule: ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

test('a chat table fits the chat width and wraps its cells between words', { skip: !process.env.T3_SOURCE }, async () => {
  const css = await applied('apps/web/src/index.css');
  const table = rule(css, '.chat-markdown table');
  assert.match(table, /width: 100%;/);
  // max-content let two sentence columns push the table past the chat width.
  assert.doesNotMatch(table, /min-width/);
  assert.match(table, /word-break: keep-all;/);
  assert.match(table, /overflow-wrap: normal;/);
  assert.doesNotMatch(rule(css, '.chat-markdown thead th'), /white-space: nowrap/);
  // No state cuts a cell to one line with an ellipsis.
  assert.doesNotMatch(css, /chat-markdown-table-container\[data-expanded/);
});

test('the table footer keeps only the copy menu', { skip: !process.env.T3_SOURCE }, async () => {
  const source = await applied('apps/web/src/components/ChatMarkdown.tsx');
  const table = source.slice(source.indexOf('function MarkdownTable('), source.indexOf('function MarkdownDetails('));
  assert.doesNotMatch(table, /expanded|toggleExpanded|data-expanded/);
  assert.match(table, /className="mt-0\.5 flex items-center justify-end select-none"/);
  assert.match(table, /aria-label=\{copyLabel\}/);
});
