import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../restart-ssh-servers.sh', import.meta.url));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function run(home) {
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, RUBATO_T3_SOURCE: join(home, 't3-source'), RUBATO_SSH_SERVER_WAIT_MAX: '5' },
  });
}

// 원격 실행기처럼 셸이 백그라운드로 띄우고 빠져서, 서버는 init 에 입양된다.
// 테스트 프로세스의 자식으로 두면 spawnSync 동안 회수되지 않아 죽어도 좀비로
// kill -0 에 살아 있게 보인다.
function detached(args) {
  const quoted = args.map((arg) => `'${arg}'`).join(' ');
  const out = spawnSync('sh', ['-c', `${quoted} >/dev/null 2>&1 </dev/null & echo $!`], { encoding: 'utf8' });
  return Number(out.stdout.trim());
}

async function gone(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

test('stops only servers launched through the Rubato remote entry', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rb-ssh-servers-'));
  const pids = [];
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });
  const entry = join(home, 't3-remote-server.mjs');
  writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
  const ours = detached([process.execPath, entry, 'serve']);
  const foreign = detached([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  pids.push(ours, foreign);
  for (const [key, pid] of [['ours', ours], ['foreign', foreign]]) {
    mkdirSync(join(home, '.t3/ssh-launch', key), { recursive: true });
    writeFileSync(join(home, '.t3/ssh-launch', key, 'pid'), `${pid}\n`);
  }

  const result = run(home);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /SSH 원격 서버 1개/);
  assert.equal(await gone(ours), true);
  assert.equal(alive(foreign), true);
});

test('reports nothing to do without launched servers', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rb-ssh-servers-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(run(home).status, 2);
  mkdirSync(join(home, '.t3/ssh-launch/stale'), { recursive: true });
  writeFileSync(join(home, '.t3/ssh-launch/stale/pid'), '999999\n');
  assert.equal(run(home).status, 2);
});
