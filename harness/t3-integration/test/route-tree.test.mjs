import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { settingsRouteTreeEdits, topLevelRouteTreeEdits } from '../route-tree-edits.mjs';

const PAGES = ['memory', 'permissions', 'phone', 'scheduled', 'stats'];
const TOP_LEVEL = ['memory', 'scheduled', 'stats'];

// The router plugin regenerates routeTree.gen.ts at every build. The applied file
// must be exactly what it writes, or the build rewrites the overlay under the app.
test('settings and top-level route tree edits equal the router generator output', {skip: !process.env.T3_SOURCE, timeout: 60_000}, async (t) => {
  const source = process.env.T3_SOURCE;
  const pin = JSON.parse(await readFile(new URL('../upstream.json', import.meta.url), 'utf8'));
  const show = (relative) => execFileSync('git', ['-C', source, 'show', `${pin.upstreamCommit}:${relative}`], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});

  let applied = show('apps/web/src/routeTree.gen.ts');
  for (const [anchor, addition, mode] of [...settingsRouteTreeEdits(PAGES), ...topLevelRouteTreeEdits()]) {
    assert.equal(applied.split(anchor).length, 2, `anchor must occur once: ${anchor.slice(0, 80)}`);
    applied = mode === 'replace' ? applied.replace(anchor, addition) : applied.replace(anchor, addition + anchor);
  }

  const root = await mkdtemp(path.join(tmpdir(), 'rb-route-tree-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const routes = path.join(root, 'routes');
  for (const relative of execFileSync('git', ['-C', source, 'ls-tree', '-r', '--name-only', pin.upstreamCommit, 'apps/web/src/routes/'], {encoding: 'utf8'}).split('\n').filter(Boolean)) {
    await mkdir(routes, {recursive: true});
    await writeFile(path.join(routes, path.basename(relative)), show(relative));
  }
  for (const page of PAGES) await cp(new URL(`../overlay/apps/web/src/routes/settings.${page}.tsx`, import.meta.url), path.join(routes, `settings.${page}.tsx`));
  for (const page of TOP_LEVEL) await cp(new URL(`../overlay/apps/web/src/routes/${page}.tsx`, import.meta.url), path.join(routes, `${page}.tsx`));

  // The generator comes with the router plugin the web build runs.
  const plugin = createRequire(path.join(source, 'apps/web/package.json')).resolve('@tanstack/router-plugin/package.json');
  const {Generator, getConfig} = await import(pathToFileURL(createRequire(plugin).resolve('@tanstack/router-generator')));
  const config = getConfig({routesDirectory: routes, generatedRouteTree: path.join(root, 'routeTree.gen.ts'), autoCodeSplitting: true}, root);
  await new Generator({config, root}).run();
  assert.equal(applied, await readFile(path.join(root, 'routeTree.gen.ts'), 'utf8'));
});
