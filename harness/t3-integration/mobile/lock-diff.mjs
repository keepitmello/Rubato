#!/usr/bin/env node
// Turns a lockfile change into apply.mjs edits, for packages the iPhone app adds.
//
//   node lock-diff.mjs BASE.yaml NEW.yaml PIN.yaml > deps-lock.json
//
// BASE is the lockfile apply.mjs installs today (pin + desktop edits), NEW is what
// `pnpm install --lockfile-only` wrote after the package.json change, PIN is the pin's
// own. Each changed run of lines becomes one replace edit whose anchor carries enough
// unchanged context to occur once in both BASE and PIN; runs closer than the context
// they would need are merged. The result is checked: BASE → edits → NEW, and back.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const [basePath, nextPath, pinPath] = process.argv.slice(2);
const base = readFileSync(basePath, 'utf8'), next = readFileSync(nextPath, 'utf8'), pin = readFileSync(pinPath, 'utf8');
let diff = '';
try { execFileSync('git', ['diff', '--no-index', '-U0', basePath, nextPath], {encoding: 'utf8', maxBuffer: 1 << 28}); }
catch (error) { diff = error.stdout; }
const A = base.split('\n'), B = next.split('\n');
// Hunks as [oldStart, oldCount, newStart, newCount], 0-based starts of the changed runs.
let hunks = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => {
  const oc = m[2] === undefined ? 1 : +m[2], nc = m[4] === undefined ? 1 : +m[4];
  return [oc === 0 ? +m[1] : +m[1] - 1, oc, nc === 0 ? +m[3] : +m[3] - 1, nc];
});
const once = (text, part) => text.split(part).length === 2;
const MAX = 12;
const edits = [];
for (let i = 0; i < hunks.length;) {
  // Merge following hunks that start within MAX lines of this one's end.
  let [os, oc, ns, nc] = hunks[i];
  let j = i + 1;
  while (j < hunks.length && hunks[j][0] - (os + oc) <= MAX) {
    const [os2, oc2, ns2, nc2] = hunks[j];
    oc = os2 + oc2 - os; nc = ns2 + nc2 - ns; j++;
  }
  let found = null;
  for (let k = 1; k <= MAX && !found; k++) {
    const before = Math.min(k, os), after = k;
    const anchor = A.slice(os - before, os + oc + after).join('\n');
    const addition = [...A.slice(os - before, os), ...B.slice(ns, ns + nc), ...A.slice(os + oc, os + oc + after)].join('\n');
    if (once(base, anchor) && once(pin, anchor) && !base.includes(addition) && !pin.includes(addition)) found = [anchor, addition, 'replace'];
  }
  if (!found) throw new Error(`no unique anchor near line ${os + 1}`);
  edits.push(found);
  i = j;
}
let text = base;
for (const [anchor, addition] of edits) { if (!once(text, anchor)) throw new Error('anchor not unique while applying'); text = text.replace(anchor, addition); }
if (text !== next) throw new Error('edits do not reproduce the new lockfile');
for (const [anchor, addition] of edits) text = text.replace(addition, anchor);
if (text !== base) throw new Error('edits do not undo to the base lockfile');
process.stdout.write(JSON.stringify(edits, null, 1) + '\n');
