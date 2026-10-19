#!/usr/bin/env node
// Stand-in for /bin/launchctl that behaves like launchd for one user: `bootstrap` loads a job and,
// like RunAtLoad + KeepAlive, starts its ProgramArguments with its EnvironmentVariables and starts
// them again whenever they end; `bootout` stops that and waits for the process to end; `print`
// names the job's pid; `kickstart -k` ends the running process (the keeper starts the next one).
// Every call is appended to $FAKE_LAUNCHD_DIR/calls.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.FAKE_LAUNCHD_DIR;
mkdirSync(dir, { recursive: true });
const [command, ...rest] = process.argv.slice(2);
const unescape = (value) => value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
const stateFile = (label) => path.join(dir, `${label}.json`);
const childFile = (label) => path.join(dir, `${label}.pid`);
const labelOf = (target) => target.split('/').at(-1);
const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (command === '__keep') {
  // The job's keeper: what launchd does for a KeepAlive job.
  const [label] = rest;
  const job = read(stateFile(label));
  let child;
  let stopping = false;
  const start = () => {
    const out = openSync(job.log, 'a');
    child = spawn(job.args[0], job.args.slice(1), { env: { ...job.env, XPC_SERVICE_NAME: label }, cwd: job.cwd, stdio: ['ignore', out, out] });
    writeFileSync(childFile(label), String(child.pid));
    appendFileSync(path.join(dir, 'starts'), `${label} ${child.pid}\n`);
    child.on('exit', () => {
      rmSync(childFile(label), { force: true });
      if (stopping) { rmSync(stateFile(label), { force: true }); process.exit(0); }
      setTimeout(start, 300);
    });
  };
  process.on('SIGTERM', () => {
    stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) { rmSync(stateFile(label), { force: true }); process.exit(0); }
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
  });
  start();
} else {
  appendFileSync(path.join(dir, 'calls'), `${[command, ...rest].join(' ')}\n`);
  switch (command) {
    case 'print': {
      const label = labelOf(rest[0]);
      const job = read(stateFile(label));
      if (!job || !alive(job.keeper)) process.exit(113);
      const pid = Number(readFileSync(childFile(label), 'utf8').trim() || 0);
      process.stdout.write(`${rest[0]} = {\n\tstate = ${pid ? 'running' : 'waiting'}\n${pid ? `\tpid = ${pid}\n` : ''}}\n`);
      break;
    }
    case 'enable': break;
    case 'bootstrap': {
      const plist = readFileSync(rest[1], 'utf8');
      const label = unescape(plist.match(/<key>Label<\/key><string>([^<]*)<\/string>/)[1]);
      const job = read(stateFile(label));
      if (job && alive(job.keeper)) { process.stderr.write('Bootstrap failed: 5: Input/output error\n'); process.exit(5); }
      const strings = (block) => [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescape(match[1]));
      const args = strings(plist.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)[1]);
      const env = Object.fromEntries([...plist.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s)[1]
        .matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)].map((match) => [match[1], unescape(match[2])]));
      const log = unescape(plist.match(/<key>StandardOutPath<\/key><string>([^<]*)<\/string>/)[1]);
      const cwd = unescape(plist.match(/<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/)?.[1] ?? '/');
      writeFileSync(stateFile(label), JSON.stringify({ args, env, log, cwd, plist: rest[1] }));
      const keeper = spawn(process.execPath, [fileURLToPath(import.meta.url), '__keep', label], { detached: true, stdio: 'ignore', env: process.env });
      keeper.unref();
      writeFileSync(stateFile(label), JSON.stringify({ args, env, log, cwd, plist: rest[1], keeper: keeper.pid }));
      break;
    }
    case 'kickstart': {
      const kill = rest[0] === '-k';
      const label = labelOf(rest.at(-1));
      const job = read(stateFile(label));
      if (!job || !alive(job.keeper)) process.exit(113);
      if (kill && existsSync(childFile(label))) { try { process.kill(Number(readFileSync(childFile(label), 'utf8')), 'SIGTERM'); } catch {} }
      break;
    }
    case 'bootout': {
      const label = labelOf(rest[0]);
      const job = read(stateFile(label));
      if (!job || !alive(job.keeper)) process.exit(113);
      process.kill(job.keeper, 'SIGTERM');
      for (let i = 0; i < 400 && alive(job.keeper); i++) await sleep(50);
      break;
    }
    default: process.exit(64);
  }
}
