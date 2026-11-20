import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROUTE_TREE_EDITS, RUBATO_ROUTES, diffRouteTreeEdits } from '../route-tree-edits.mjs';
import { integrationOverlays } from '../apply.mjs';

const ROUTES = 'apps/web/src/routes/';
const TREE = 'apps/web/src/routeTree.gen.ts';
const MODULE = new URL('../route-tree-edits.mjs', import.meta.url);

const apply = (text, edits) => {
  for (const [anchor, addition, mode] of edits) {
    assert.equal(text.split(anchor).length, 2, `anchor must occur once: ${anchor.slice(0, 80)}`);
    text = mode === 'replace' ? text.replace(anchor, addition) : text.replace(anchor, addition + anchor);
  }
  return text;
};

test('the route files Rubato adds are the ones the overlay installs', () => {
  const installed = integrationOverlays.filter((relative) => relative.startsWith(ROUTES)).map((relative) => relative.slice(ROUTES.length));
  assert.deepEqual(installed.toSorted(), RUBATO_ROUTES.toSorted());
});

test('diffRouteTreeEdits anchors each added run on lines that occur once', () => {
  const before = 'a\nlist {\n  x\n}\nlist {\n  x\n}\nz\n';
  const after = 'a\nlist {\n  w\n  x\n}\nlist {\n  w\n  x\n}\nz\n';
  const edits = diffRouteTreeEdits(before, after);
  assert.equal(apply(before, edits), after);
  assert.throws(() => diffRouteTreeEdits('a\nb\n', 'a\n'), /removes or changes/);
});

// The router plugin regenerates routeTree.gen.ts at every build. The applied file
// must be exactly what it writes, or the build rewrites the overlay under the app.
test('the route tree edits equal the router generator output', {skip: !process.env.T3_SOURCE, timeout: 60_000}, async (t) => {
  const source = process.env.T3_SOURCE;
  const pin = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
  // Object reads only: a checkout may share its index with other worktrees.
  const show = (relative) => execFileSync('git', ['-C', source, 'show', `${pin.upstreamCommit}:${relative}`], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const upstream = show(TREE);

  const root = await mkdtemp(path.join(tmpdir(), 'rb-route-tree-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const routes = path.join(root, 'routes');
  await mkdir(routes, {recursive: true});
  for (const relative of execFileSync('git', ['-C', source, 'ls-tree', '-r', '--name-only', pin.upstreamCommit, ROUTES], {encoding: 'utf8'}).split('\n').filter(Boolean)) {
    await writeFile(path.join(routes, path.basename(relative)), show(relative));
  }
  for (const file of RUBATO_ROUTES) await writeFile(path.join(routes, file), await readFile(new URL(`../overlay/${ROUTES}${file}`, import.meta.url)));

  // The generator comes with the router plugin the web build runs.
  const plugin = createRequire(path.join(source, 'apps/web/package.json')).resolve('@tanstack/router-plugin/package.json');
  const {Generator, getConfig} = await import(pathToFileURL(createRequire(plugin).resolve('@tanstack/router-generator')));
  const config = getConfig({routesDirectory: routes, generatedRouteTree: path.join(root, 'routeTree.gen.ts'), autoCodeSplitting: true,
    // Its scratch files must be on the output's disk: it renames them into place, and the repo
    // and the temp directory are different devices on CI (EXDEV).
    tmpDir: path.join(root, '.tanstack', 'tmp')}, root);
  await new Generator({config, root}).run();
  const generated = await readFile(path.join(root, 'routeTree.gen.ts'), 'utf8');

  if (process.env.UPDATE_ROUTE_TREE) {
    const edits = diffRouteTreeEdits(upstream, generated);
    const module = await readFile(MODULE, 'utf8');
    const block = /\/\/ BEGIN ROUTE_TREE_EDITS[^\n]*\n[\s\S]*?\/\/ END ROUTE_TREE_EDITS\n/;
    assert.match(module, block);
    await writeFile(MODULE, module.replace(block, (match) =>
      `${match.split('\n')[0]}\nexport const ROUTE_TREE_EDITS = ${JSON.stringify(edits, null, 2)};\n// END ROUTE_TREE_EDITS\n`));
    assert.equal(apply(upstream, edits), generated);
    return;
  }
  assert.equal(apply(upstream, ROUTE_TREE_EDITS), generated);
});
