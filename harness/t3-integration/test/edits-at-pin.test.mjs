import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {integrationEdits, integrationOverlays} from '../apply.mjs';

// A restart rebuilds the desktop app from these edits on the pinned T3. An edit that leaves a file
// that does not parse surfaces only there, as a failed restart.
const source = process.env.T3_SOURCE;

function loadTypeScript() {
  for (const from of ['apps/marketing/package.json', 'node_modules/.pnpm/node_modules/typescript/package.json']) {
    try { return createRequire(path.join(source, from))('typescript'); } catch {}
  }
  return null;
}

const pinned = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));

// Each of these stopped a restart once: an edited file missing from the list, a recorded hash that
// is not the pin's, an overlay file that was never committed.
test('the overlay is complete: every edited file is listed with the pin\'s hash, every overlay file exists', {skip: !source}, async () => {
  for (const relative of Object.keys(integrationEdits)) assert.ok(relative in pinned.targets, `${relative} is missing from upstream.json`);
  for (const [relative, digest] of Object.entries(pinned.targets)) {
    const original = execFileSync('git', ['-C', source, 'show', `${pinned.upstreamCommit}:${relative}`], {maxBuffer: 1 << 28});
    assert.equal(createHash('sha256').update(original).digest('hex'), digest, `${relative}: upstream.json hash is not the pin's`);
  }
  for (const relative of integrationOverlays) await readFile(new URL(`../overlay/${relative}`, import.meta.url));
});

test('every edit applies at the pin and the file still parses', {skip: !source}, async () => {
  const ts = loadTypeScript();
  assert.ok(ts, 'typescript is not installed in T3_SOURCE');
  for (const [relative, changes] of Object.entries(integrationEdits)) {
    const original = execFileSync('git', ['-C', source, 'show', `${pinned.upstreamCommit}:${relative}`], {encoding: 'utf8', maxBuffer: 1 << 28});
    let text = original;
    for (const [anchor, addition, mode] of changes) {
      assert.equal(text.split(anchor).length, 2, `${relative}: ${anchor.slice(0, 60)}`);
      text = mode === 'replace' ? text.replace(anchor, addition) : text.replace(anchor, addition + anchor);
    }
    if (/\.(m?[jt]sx?)$/.test(relative)) {
      const kind = relative.endsWith('x') ? ts.ScriptKind.TSX : relative.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
      const file = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, false, kind);
      const [first] = file.parseDiagnostics;
      if (first) {
        const {line, character} = file.getLineAndCharacterOfPosition(first.start ?? 0);
        assert.fail(`${relative}:${line + 1}:${character + 1} ${ts.flattenDiagnosticMessageText(first.messageText, '\n')}`);
      }
    }
  }
});
