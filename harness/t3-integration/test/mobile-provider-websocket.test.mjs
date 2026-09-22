import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('mobile marks cross the authenticated T3 WebSocket route with web isolation and reconnect', {
  skip: !process.env.T3_SOURCE, timeout: 120000,
}, async t => {
  const source = process.env.T3_SOURCE;
  const directory = path.join(source, 'apps/server/src');
  const upstream = await readFile(path.join(directory, 'server.test.ts'), 'utf8');
  const marker = 'it.layer(NodeServices.layer)("server router seam", (it) => {';
  const boundary = upstream.indexOf(marker);
  assert.ok(boundary > 0, 'Pinned T3 HTTP/WebSocket test harness changed');
  const fixture = await readFile(new URL('./fixtures/mobile-provider-websocket.ts', import.meta.url), 'utf8');
  const generated = path.join(directory, `RubatoMobileWebsocket.${process.pid}.test.ts`);
  const home = await mkdtemp(path.join(tmpdir(), 'rb-mobile-ws-home-'));
  t.after(async () => { await unlink(generated).catch(() => {}); await rm(home, { recursive: true, force: true }); });
  await writeFile(generated,
    'import { ServerProvider as RubatoTestProviderSchema } from "@t3tools/contracts";\n' +
    upstream.slice(0, boundary) + marker + '\n' + fixture + '\n});\n', { flag: 'wx' });
  try {
    const result = await promisify(execFile)(path.join(source, 'node_modules/.bin/vp'),
      ['test', 'run', path.relative(path.join(source, 'apps/server'), generated)],
      { cwd: path.join(source, 'apps/server'), timeout: 110000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, HOME: home, USERPROFILE: home } });
    t.diagnostic(result.stdout);
  } catch (error) {
    assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
  }
});
