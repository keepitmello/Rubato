import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, realpath, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { resolvePiRuntime } from '../../resolve-runtime.mjs';
import { stagePiRuntime } from '../../stage-runtime.mjs';
import { loadPiFeatures } from '../../feature-catalog.mjs';
import { patches } from './patches.mjs';

const sourceRoot = path.resolve(import.meta.dirname, '../..');
test('UI scope patches are pinned and reject a second application', async () => {
  const source = resolvePiRuntime({ root: sourceRoot });
  for (const patch of patches) {
    const text = await readFile(path.join(source.packages[patch.packageName].dir, patch.path), 'utf8');
    assert.equal(createHash('sha256').update(text).digest('hex'), patch.preimageSha256);
    assert.throws(() => patch.apply(patch.apply(text)), /anchor mismatch/);
  }
});
test('composed candidate keeps the hosted stock-UI wiring remote-surface introduces', async t => {
  // session-ui 의 interactive-mode 단계는 remote-surface 가 넣는 `bindStockUiHost(...)` 호출에
  // 옵션을 붙인다. 그 호출이 없으면 그 단계는 조용히 건너뛰므로, 순서가 뒤집히면 hosted 배선이
  // 꺼진 후보가 소리 없이 나온다. 스테이징된 바이트를 직접 보는 이 단언이 그 회귀를 막는다.
  //
  // 회귀에 눈이 있는 것은 **아래 `bindStockUiHost` 정규식 하나뿐**이다(실측: 순서를 뒤집은
  // 빌드에서 0, 올바른 빌드에서 1). `presentationOnly` 단언은 다른 단계(session-ui 의
  // bindExtensions 배선)를 보는 것이라 이 회귀에는 반응하지 않는다 — 둘을 같은 근거로
  // 세지 말 것.
  const scratch = await mkdtemp(path.join(tmpdir(), 'rb-ui-compose-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const staged = await stagePiRuntime({
    sourceRoot,
    outputRoot: path.join(scratch, 'stage'),
    features: await loadPiFeatures(['session-ui']),
  });
  assert.equal(staged.receipt.features.includes('remote-surface'), true);
  const interactive = await readFile(
    path.join(staged.root, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js'),
    'utf8',
  );
  assert.match(
    interactive,
    /bindStockUiHost\(this, this\.createExtensionUIContext\(\), \{ env: process\.env, onClose: uiScope\(\)\?\.onClose, run: uiScope\(\)\?\.run \}\)/,
  );
  assert.match(interactive, /presentationOnly: this\.options\.hosted === true/);
});
test('real theme, keybindings and keyboard/capabilities stay local across concurrent callbacks', { timeout: 60000 }, async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'rb-ui-scope-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: path.join(scratch, 'stage'), features: await loadPiFeatures(['session-ui']) });
  const load = file => import(pathToFileURL(path.join(staged.root, file)).href);
  const { createUiScope, bindUiCallback, bindUiContext, uiProcess } = await load('rubato-features/session-ui/context.mjs');
  const agent = 'node_modules/@earendil-works/pi-coding-agent/';
  const tui = agent + 'node_modules/@earendil-works/pi-tui/dist/';
  const themes = await load(agent + 'dist/modes/interactive/theme/theme.js');
  const keys = await load(tui + 'keys.js');
  const bindings = await load(tui + 'keybindings.js');
  const images = await load(tui + 'terminal-image.js');
  // Import the remaining patched modules too: malformed rewrites must fail.
  await load(agent + 'dist/modes/interactive/interactive-mode.js');
  await load(agent + 'dist/core/agent-session.js');
  await load(tui + 'terminal.js');
  themes.initTheme('dark');
  const baseline = themes.theme.fg('accent', 'baseline');
  const scopes = ['dark', 'light'].map((name, i) => createUiScope({ env: { TERM_PROGRAM: i ? 'xterm' : 'kitty' },
    process: { stdout: { marker: i } } }));
  const callbacks = scopes.map((scope, i) => scope.run(() => {
    themes.initTheme(i ? 'light' : 'dark');
    keys.setKittyProtocolActive(i === 0);
    bindings.setKeybindings({ marker: i });
    images.setCellDimensions({ widthPx: 8 + i, heightPx: 16 + i });
    return bindUiCallback(() => ({ color: themes.theme.fg('accent', 'sample'), keys: keys.isKittyProtocolActive(),
      marker: bindings.getKeybindings().marker, cell: images.getCellDimensions(), output: uiProcess.stdout.marker }));
  }));
  const values = await Promise.all(callbacks.map(async cb => { await new Promise(resolve => setImmediate(resolve)); return cb(); }));
  assert.notEqual(values[0].color, values[1].color);
  assert.deepEqual(values.map(x => [x.keys, x.marker, x.cell.widthPx, x.output]), [[true, 0, 8, 0], [false, 1, 9, 1]]);
  const ui = scopes[0].run(() => bindUiContext({ notify() { return uiProcess.stdout.marker; } }));
  assert.equal(scopes[1].run(() => ui.notify()), 0);
  assert.equal(themes.theme.fg('accent', 'baseline'), baseline);
  assert.equal(uiProcess.stdout, process.stdout);
  const rendered = [];
  const firstUi = scopes[0].run(() => bindUiContext({ setWidget(key, value) { rendered.push([uiProcess.stdout.marker, key, value]); } }));
  const captured = firstUi.setWidget;
  captured('task', ['running']);
  const secondUi = scopes[1].run(() => bindUiContext({ setWidget(key, value) { rendered.push([uiProcess.stdout.marker, key, value]); } }, firstUi));
  assert.equal(secondUi, firstUi);
  captured('task', undefined);
  assert.deepEqual(rendered, [[0, 'task', ['running']], [1, 'task', ['running']], [1, 'task', undefined]]);
  assert.ok('setWidget' in firstUi); assert.deepEqual(Object.keys(firstUi), ['setWidget']);
  const http = await load(agent + 'dist/core/http-dispatcher.js');
  const fetch = globalThis.fetch;
  // Preserve deliberate caller overrides while checking pool ownership offline.
  globalThis.fetch = () => { throw new Error('Network not permitted'); };
  try {
    scopes[0].run(() => http.configureHttpDispatcher(30000));
    scopes[1].run(() => http.configureHttpDispatcher(30000));
    const shared = scopes[0].state.httpEntry;
    assert.equal(scopes[1].state.httpEntry, shared); assert.equal(shared.references, 2);
    scopes[1].run(() => http.configureHttpDispatcher(60000));
    assert.notEqual(scopes[1].state.httpEntry, shared); assert.equal(shared.references, 1);
    await scopes[0].run(() => http.releaseScopedHttpDispatcher());
    assert.equal(shared.references, 0);
    assert.ok(scopes[1].state.httpDispatcher);
    await scopes[1].run(() => http.releaseScopedHttpDispatcher());
  } finally { globalThis.fetch = fetch; }

  const config = await load(agent + 'dist/core/resolve-config-value.js');
  for (const [i, scope] of scopes.entries()) {
    Object.assign(scope.env, { RUBATO_TEST_KEY: `key-${i}`, OPENAI_API_KEY: `api-${i}`, PI_OFFLINE: '1' });
    assert.equal(scope.run(() => config.resolveConfigValue('$RUBATO_TEST_KEY')), `key-${i}`);
    assert.equal(scope.run(() => config.resolveConfigValue('!printf "$RUBATO_TEST_KEY"')), `key-${i}`);
  }
  const { ModelRuntime } = await load(agent + 'dist/core/model-runtime.js');
  const models = await Promise.all(scopes.map(scope => scope.run(() => ModelRuntime.create({ modelsPath: null }))));
  const auth = await Promise.all(models.map(model => model.getAuth('openai')));
  assert.deepEqual(auth.map(x => x.auth.apiKey), ['api-0', 'api-1'], 'credentials keep their originating environment outside the presentation callback');

  // Real loopback CONNECT requests: the two scopes must not silently use the
  // first frontend's global proxy. This never contacts an external provider.
  const origin = createServer((_req, res) => res.end('loopback'));
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const hits = [0, 0], peers = new Set();
  const proxies = [0, 1].map(i => createServer().on('connect', (_req, client, head) => {
    hits[i]++; peers.add(client); client.on('close', () => peers.delete(client));
    const upstream = connect(origin.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); client.pipe(upstream).pipe(client);
    });
    peers.add(upstream); upstream.on('close', () => peers.delete(upstream));
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
  }));
  try {
    for (const [i, proxy] of proxies.entries()) {
      proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
      Object.assign(scopes[i].env, { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' });
      scopes[i].run(() => http.configureHttpDispatcher(30000));
    }
    const results = await Promise.all(scopes.map(scope => scope.run(async () =>
      (await globalThis.fetch(`http://127.0.0.1:${origin.address().port}/`, { signal: AbortSignal.timeout(5000) })).text())));
    assert.deepEqual(results, ['loopback', 'loopback']); assert.deepEqual(hits, [1, 1]);
  } finally {
    for (const peer of peers) peer.destroy();
    await Promise.all(scopes.map(scope => scope.run(() => http.releaseScopedHttpDispatcher())));
    await Promise.all([...proxies, origin].map(server => new Promise(resolve => server.close(resolve))));
    globalThis.fetch = fetch;
  }
});

test('two native InteractiveModes render and accept terminal input without process-wide lifecycle effects', { timeout: 60000 }, async t => {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'rb-native-ui-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const staged = await stagePiRuntime({ sourceRoot, outputRoot: path.join(scratch, 'stage'), features: await loadPiFeatures(['session-ui']) });
  const home = path.join(scratch, 'home'); await mkdir(home);
  let command = process.execPath, args = [path.join(import.meta.dirname, 'native-ui-fixture.mjs'), staged.root];
  if (process.platform === 'darwin') {
    args = ['-p', `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "${scratch}") (subpath "/dev"))(deny network*)(deny signal)(allow signal (target self))`, command, ...args];
    command = '/usr/bin/sandbox-exec';
  }
  const child = spawn(command, args, { cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' } });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 25000);
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer); assert.equal(result.code, 0, output); assert.match(output, /NATIVE_UI_ISOLATION_OK/);
});
