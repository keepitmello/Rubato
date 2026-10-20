// Whether the person's own Telegram client (`tg`, the MTProto one) is here and working. Only that
// can make a bot by talking to @BotFather, and most people do not have it: Settings shows the
// "make it for me" button only when this answers yes, and pasting a token from @BotFather is the
// path everyone else takes.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';

/** The `tg` binary this machine would run: `RUBATO_TG_BIN`, else `tg` on the PATH. */
export function tgBinary(env = process.env) {
  return env.RUBATO_TG_BIN || 'tg';
}

/** The search path as the platform names it: `Path` on Windows (any case), `PATH` elsewhere. */
function searchPath(env, platform) {
  if (platform !== 'win32') return String(env.PATH ?? '');
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return String(key ? env[key] : '');
}

/**
 * Where `bin` runs from, or undefined: a path as given, else the first match on the search path of
 * `env` (with PATHEXT's extensions on Windows, where `tg` is `tg.exe` or `tg.cmd`).
 */
export function resolveBinary(bin, env = process.env, platform = process.platform) {
  const executable = (file) => {
    try {
      if (!statSync(file).isFile()) return false;
      if (platform === 'win32') return true;
      accessSync(file, constants.X_OK);
      return true;
    } catch { return false; }
  };
  if (bin.includes('/') || bin.includes('\\')) return executable(bin) ? bin : undefined;
  const delimiter = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? ['', ...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of searchPath(env, platform).split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(dir, `${bin}${extension}`);
      if (executable(file)) return file;
    }
  }
  return undefined;
}

/**
 * `{ available, account?, reason? }`: a binary that runs is not enough, because the daemon must be
 * connected for a bot to be made; `tg status` answers both without a Telegram call of our own.
 */
export function probeTg({ env = process.env, timeoutMs = 4000, platform = process.platform } = {}) {
  const bin = resolveBinary(tgBinary(env), env, platform);
  if (!bin) return Promise.resolve({ available: false, reason: 'no tg client on this computer' });
  // A Windows .cmd or .bat runs through the shell; anything else runs directly.
  const shell = platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  return new Promise((resolve) => {
    execFile(bin, ['status'], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, ...(shell ? { shell: true } : {}) }, (error, stdout) => {
      if (error) { resolve({ available: false, reason: 'the tg client is not answering' }); return; }
      try {
        const status = JSON.parse(stdout);
        const connected = status?.daemon?.connected === true;
        resolve(connected
          ? { available: true, ...(status.daemon.account ? { account: status.daemon.account } : {}) }
          : { available: false, reason: 'the tg client is not connected' });
      } catch {
        resolve({ available: false, reason: 'the tg client returned something unreadable' });
      }
    });
  });
}
