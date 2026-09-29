#!/usr/bin/env node
// Stand-in for /bin/launchctl in tests: records every call, and on `bootstrap` really starts
// the job's ProgramArguments with its EnvironmentVariables (read from the plist), detached, so
// the test sees the shipped plist bring up the shipped daemon. `bootout` stops what it started.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const [command, ...rest] = process.argv.slice(2);
const trace = process.env.FAKE_LAUNCHCTL_TRACE;
const pidFile = `${trace}.pid`;
appendFileSync(trace, `${[command, ...rest].join(' ')}\n`);
if (command === 'print') process.exit(1);
if (command === 'bootout') {
  try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {}
  rmSync(pidFile, { force: true });
}
if (command === 'bootstrap') {
  const plist = readFileSync(rest[1], 'utf8');
  const strings = (block) => [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  const args = strings(plist.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s)[1]);
  const pairs = [...plist.match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/s)[1].matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)];
  const log = strings(plist.match(/<key>StandardOutPath<\/key>(<string>[^<]*<\/string>)/)[1])[0];
  const out = (await import('node:fs')).openSync(log, 'a');
  const child = spawn(args[0], args.slice(1), { env: Object.fromEntries(pairs.map((pair) => [pair[1], pair[2]])), detached: true, stdio: ['ignore', out, out] });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}
