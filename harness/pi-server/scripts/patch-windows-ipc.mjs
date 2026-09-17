#!/usr/bin/env node
// Named pipes are Node net sockets. pi-client/pi-server still throw on win32
// before createConnection. Strip that guard and bind pipes without Unix
// chmod/link. npm ci restores the packages, so this runs from postinstall.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THROW = 'Unix transport is not supported on Windows';
const THROW_BLOCK = /[ \t]*if \(process\.platform === "win32"\)\s*throw new Error\("Unix transport is not supported on Windows"\);\n?/g;
const FASTPATH_MARK = 'WINDOWS_PIPE_FASTPATH';
const FASTPATH = `        if (process.platform === "win32") { // ${FASTPATH_MARK}
            const server = createServer((socket) => this.acceptSocket(socket));
            server.on("error", (error) => this.reportError(error));
            this.server = server;
            await new Promise((resolve, reject) => {
                const onError = (error) => { server.off("listening", onListening); reject(error); };
                const onListening = () => { server.off("error", onError); resolve(); };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(this.path);
            });
            this.socketIdentity = { dev: 0, ino: 0 };
            return;
        }
`;

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const require = createRequire(join(pkgRoot, 'package.json'));

function tryResolve(id) {
  try { return require.resolve(id); } catch { return null; }
}

function walkUnixClients(root, found, depth = 0) {
  if (!root || depth > 8 || !existsSync(root)) return;
  let entries;
  try { entries = readdirSync(root); } catch { return; }
  for (const name of entries) {
    if (name === '.git' || name === 'stock-engine.previous') continue;
    const full = join(root, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isFile() && name === 'unix.js' && full.includes('pi-client')) found.add(full);
    else if (stat.isDirectory() && name !== '.git') {
      walkUnixClients(full, found, depth + 1);
    }
  }
}

function extraUnixClients() {
  const found = new Set();
  const repo = join(pkgRoot, '..', '..');
  const bun = join(repo, 'node_modules', '.bun');
  if (existsSync(bun)) {
    for (const name of readdirSync(bun)) {
      if (!name.includes('senpi') && !name.includes('pi-client')) continue;
      walkUnixClients(join(bun, name), found);
    }
  }
  walkUnixClients(join(repo, 'node_modules', '@earendil-works'), found);
  if (process.env.HOME) walkUnixClients(join(process.env.HOME, '.rubato-pi', 'stock-engine', 'node_modules'), found);
  if (process.env.USERPROFILE) walkUnixClients(join(process.env.USERPROFILE, '.rubato-pi', 'stock-engine', 'node_modules'), found);
  return [...found];
}

function patchThrow(file) {
  if (!file || !existsSync(file)) return 'missing';
  const before = readFileSync(file, 'utf8');
  if (!before.includes(THROW)) return 'clean';
  const after = before.replace(THROW_BLOCK, '');
  if (after === before) return 'unpatched';
  writeFileSync(file, after);
  return 'patched';
}

function patchListener(file) {
  if (!file || !existsSync(file)) return 'missing';
  const before = readFileSync(file, 'utf8');
  if (before.includes(FASTPATH_MARK)) return 'clean';
  const needle = '        this.accept = accept;\n';
  if (!before.includes(needle)) return 'unpatched';
  writeFileSync(file, before.replace(needle, needle + FASTPATH));
  return 'patched';
}

export { patchThrow, patchListener, THROW, FASTPATH_MARK };

function isMain() {
  const argv = process.argv[1];
  return Boolean(argv) && fileURLToPath(import.meta.url) === argv;
}

if (isMain()) {
  const client = tryResolve('@earendil-works/pi-client/unix')
    ?? join(pkgRoot, 'node_modules', '@earendil-works', 'pi-client', 'dist', 'unix.js');
  const defaultListener = join(pkgRoot, 'node_modules', '@earendil-works', 'pi-server', 'dist', 'transports', 'unix', 'listener.js');
  const resolvedListener = tryResolve('@earendil-works/pi-server/unix');
  const listener = resolvedListener && existsSync(resolvedListener) && readFileSync(resolvedListener, 'utf8').includes('class UnixListener')
    ? resolvedListener
    : defaultListener;

  const results = {
    client: patchThrow(client),
    listener: patchListener(listener),
    extras: extraUnixClients().map((file) => ({ file, result: patchThrow(file) })),
  };

  if (process.argv.includes('--print') || process.stdout.isTTY) console.log(JSON.stringify(results, null, 2));
  if (results.client === 'unpatched' || results.listener === 'unpatched' || results.extras.some((item) => item.result === 'unpatched')) {
    process.exitCode = 1;
  }
}
