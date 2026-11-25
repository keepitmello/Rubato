// A reply's ```svg fence on Telegram (user, 2026-11-25): the app draws it in the bubble
// (harness/t3-integration/reply-visuals-edits.mjs), Telegram shows plain text, so the picture goes
// out as a PNG photo in its place with the fence title as its caption. The fence is cut out before
// any sanitizing, so its markup reaches the renderer exactly as written, `sanitize: false` or not.
//
// Drawn with librsvg (`rsvg-convert`, Homebrew's librsvg) on white, where `currentColor` is black,
// and macOS Quick Look when librsvg is not installed. With neither, the caption goes as text.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*svg\b([^\n]*)$/i;
const FENCE_TITLE = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
/** Telegram scales a photo to fit; past this many pixels across it only weighs more. */
const PNG_WIDTH_MAX = 1600;

/**
 * One bubble's words cut at its ```svg fences, in order: `{ text }` between them, `{ svg, title }`
 * for each fence. A fence that never closes stays words.
 */
export function svgSegments(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
  let words = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = FENCE_OPEN.exec(lines[index]);
    const close = open && new RegExp(`^ {0,3}${open[1][0] === '`' ? '`' : '~'}{${open[1].length},}[ \\t]*$`);
    const end = close ? lines.findIndex((line, at) => at > index && close.test(line)) : -1;
    if (end < 0) { words.push(lines[index]); continue; }
    if (words.join('\n').trim()) segments.push({ text: words.join('\n').trim() });
    words = [];
    const title = FENCE_TITLE.exec(open[2] ?? '');
    segments.push({ svg: lines.slice(index + 1, end).join('\n').trim(), title: title?.[1] ?? title?.[2] ?? title?.[3] });
    index = end;
  }
  if (words.join('\n').trim()) segments.push({ text: words.join('\n').trim() });
  return segments;
}

/** The size the picture was drawn at: width and height, or its viewBox. */
function drawnWidth(svg) {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const width = /\swidth\s*=\s*["']?\s*(\d+(?:\.\d+)?)(?:px)?\s*["'\s>/]/i.exec(root)?.[1];
  if (width) return Number(width);
  const box = /\sviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return box?.length === 4 && box[2] > 0 ? box[2] : undefined;
}

function rsvgConvert(env) {
  const candidates = [...String(env.PATH ?? '').split(path.delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin']
    .map((dir) => path.join(dir, 'rsvg-convert'));
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * The picture as a PNG file in a fresh folder, or undefined when nothing here can draw it. The
 * caller removes the folder (`cleanup`). Never throws: a broken drawing is the same as no renderer.
 */
export async function svgToPng(svg, { env = process.env, timeoutMs = 20_000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rubato-svg-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    // librsvg and Quick Look both need the SVG namespace, which a fence in a chat often leaves out.
    const source = /<svg\b[^>]*\sxmlns\s*=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    const input = path.join(dir, 'figure.svg');
    writeFileSync(input, source);
    const output = path.join(dir, 'figure.png');
    const width = drawnWidth(source);
    const converter = rsvgConvert(env);
    if (converter) {
      const zoom = width ? Math.max(0.25, Math.min(2, PNG_WIDTH_MAX / width)) : 2;
      await run(converter, ['--zoom', String(zoom), '--background-color', 'white', '--output', output, input], { timeout: timeoutMs });
      if (existsSync(output)) return { file: output, cleanup };
    } else if (process.platform === 'darwin' && existsSync('/usr/bin/qlmanage')) {
      await run('/usr/bin/qlmanage', ['-t', '-s', String(PNG_WIDTH_MAX), '-o', dir, input], { timeout: timeoutMs });
      const made = readdirSync(dir).find((name) => name.endsWith('.png'));
      if (made) return { file: path.join(dir, made), cleanup };
    }
  } catch {
    // Falls through: the caption goes as words.
  }
  cleanup();
  return undefined;
}

/** What a figure says when no picture can be drawn: its caption, marked as a picture the app shows. */
export function svgFallbackText(title) {
  return title ? `[그림] ${title} (앱에서 볼 수 있어)` : '[그림] (앱에서 볼 수 있어)';
}
