import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { svgFallbackText, svgSegments, svgToPng } from '../svg-figures.mjs';
import { telegramMarkup, telegramText } from '../reply-text.mjs';

const FIGURE = '<svg viewBox="0 0 320 160"><ellipse cx="120" cy="80" rx="90" ry="50" fill="none" stroke="currentColor"/></svg>';

test('a bubble is cut at its svg fences: words, then each picture with its title, in order', () => {
  assert.deepEqual(svgSegments(`위\n\`\`\`svg title="개략도"\n${FIGURE}\n\`\`\`\n아래`), [
    { text: '위' }, { svg: FIGURE, title: '개략도' }, { text: '아래' },
  ]);
  assert.deepEqual(svgSegments(`~~~svg\n${FIGURE}\n~~~`), [{ svg: FIGURE, title: undefined }]);
  // Not closed yet, or another language: words.
  assert.deepEqual(svgSegments('```svg\n<svg/>'), [{ text: '```svg\n<svg/>' }]);
  assert.deepEqual(svgSegments('```xml\n<svg/>\n```'), [{ text: '```xml\n<svg/>\n```' }]);
});

test('a figure is drawn as a PNG on white, even without the SVG namespace', { skip: !['/opt/homebrew/bin/rsvg-convert', '/usr/local/bin/rsvg-convert'].some(existsSync) && process.platform !== 'darwin' }, async () => {
  const png = await svgToPng(FIGURE);
  assert.ok(png, 'nothing could draw it');
  try {
    const bytes = readFileSync(png.file);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    // Width at offset 16: drawn up to twice its size, never past 1600 pixels.
    assert.ok(bytes.readUInt32BE(16) >= 320 && bytes.readUInt32BE(16) <= 1600);
  } finally {
    png.cleanup();
  }
  assert.equal(existsSync(png.file), false);
});

test('a broken drawing is the same as no renderer', async () => {
  assert.equal(await svgToPng('<svg><unclosed'), undefined);
  assert.equal(svgFallbackText(undefined), '[그림] (앱에서 볼 수 있어)');
});

test('Telegram reads a toned table row by row, its colours as dots', () => {
  const table = '| 항목 | 값 | 차이 |\n|---|:---:|---|\n| 무게 | 60g | <span data-tone="good">매우 큼</span> |\n| 휠 | 노치 | <span data-tone="bad">소폭 퇴보</span> |';
  assert.equal(telegramMarkup(table), '• 무게 — 값 60g · 차이 🟢 매우 큼\n• 휠 — 값 노치 · 차이 🔴 소폭 퇴보');
});

test('Telegram opens <details> with its summary as a line, and leaves code blocks as written', () => {
  assert.equal(telegramMarkup('<details><summary>자세히</summary>\n\n센서 위치 차이\n\n</details>'), '▸ 자세히\n\n센서 위치 차이\n\n');
  const code = '```html\n<span data-tone="good">x</span>\n| a | b |\n|---|---|\n```';
  assert.equal(telegramMarkup(code), code);
  assert.equal(telegramText('**굵게** <span data-tone="warn">비슷</span>'), '굵게 🟡 비슷');
});
