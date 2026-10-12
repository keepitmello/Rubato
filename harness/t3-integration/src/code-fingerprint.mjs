// Which repository code a running desktop app has loaded.
//
// The app's server imports the bridge (this directory) from the repository when it
// starts, and from there a few files of the engine client. Everything else it
// runs is the compiled T3 bundle, which install-gui.sh fingerprints on its own.
// A restart used to quit and reopen the app every time; when neither the bundle
// nor this code changed, the open app only has to reconnect to the new engine,
// which the bridge already does by itself. restart-gui.sh asks here.
//
// The bridge records what it loaded under its own pid when it is imported. The
// check compares every live record with the code on disk now. No live record
// means we cannot tell, and the app is reopened.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
// Relative static imports, re-exports, side-effect imports and dynamic import().
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE = /\.(?:m?js|cjs|json)$/;

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(file));
    else if (SOURCE.test(entry.name)) files.push(file);
  }
  return files;
}

/** Every file under `root`, plus every repository file they reach by relative import. */
export function loadedCodeFiles(root = here) {
  const seen = new Set();
  const pending = listFiles(root);
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    seen.add(file);
    if (file.endsWith('.json')) continue;
    for (const match of text.matchAll(RELATIVE_IMPORT)) pending.push(path.resolve(path.dirname(file), match[1]));
  }
  return [...seen].sort();
}

/**
 * One hash over those files' contents and the workspace lockfile. Package
 * imports resolve through node_modules, and the lockfile changes whenever they do.
 */
export function codeFingerprint({ root = here, base = repo, lockfiles = [path.join(repo, 'bun.lock')] } = {}) {
  const hash = createHash('sha256');
  for (const file of [...loadedCodeFiles(root), ...lockfiles]) {
    let content;
    try { content = readFileSync(file); } catch { content = Buffer.from('missing'); }
    hash.update(path.relative(base, file)).update('\0')
      .update(createHash('sha256').update(content).digest('hex')).update('\n');
  }
  return hash.digest('hex');
}

export const loadedDirectory = (env = process.env) =>
  env.RUBATO_LOADED_CODE_DIR || path.join(env.HOME || os.homedir(), '.rubato-pi', 'gui-update', 'loaded');

/** Called once when the bridge is imported. Never throws: a failed record only means the next restart reopens the app. */
export function recordLoadedCode({ pid = process.pid, directory = loadedDirectory(), fingerprint } = {}) {
  try {
    const value = fingerprint ?? codeFingerprint();
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${pid}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ pid, fingerprint: value, loadedAt: Date.now() })}\n`);
    renameSync(temporary, file);
    return value;
  } catch { return null; }
}

const isAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/**
 * Whether every process that still runs the bridge loaded the code on disk now.
 * Records of exited processes are removed on the way.
 */
export function loadedCodeIsCurrent({ directory = loadedDirectory(), fingerprint = codeFingerprint(), alive = isAlive } = {}) {
  let names = [];
  try { names = readdirSync(directory).filter((name) => name.endsWith('.json')); } catch { /* none yet */ }
  let live = 0;
  let stale = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { record = null; }
    if (!record || !alive(record.pid)) {
      try { unlinkSync(file); } catch { /* already gone */ }
      continue;
    }
    live += 1;
    if (record.fingerprint !== fingerprint) stale += 1;
  }
  if (live === 0) return { current: false, reason: 'unknown' };
  return stale ? { current: false, reason: 'changed', live, stale } : { current: true, reason: 'same', live };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `node code-fingerprint.mjs check`: exit 0 when the running app loaded today's code.
  if (process.argv[2] !== 'check') {
    console.error('Usage: node code-fingerprint.mjs check');
    process.exitCode = 2;
  } else {
    const result = loadedCodeIsCurrent();
    console.log(JSON.stringify(result));
    process.exitCode = result.current ? 0 : 1;
  }
}
