// Whether the person's own Telegram client (`tg`, the MTProto one) is here and working. Only that
// can make a bot by talking to @BotFather, and most people do not have it: Settings shows the
// "make it for me" button only when this answers yes, and pasting a token from @BotFather is the
// path everyone else takes.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { accessSync, constants } from 'node:fs';

/** The `tg` binary this machine would run: `RUBATO_TG_BIN`, else `tg` on the PATH. */
export function tgBinary(env = process.env) {
  return env.RUBATO_TG_BIN || 'tg';
}

function runnable(bin) {
  if (bin.includes('/') || bin.includes(path.sep)) {
    try { accessSync(bin, constants.X_OK); return true; } catch { return false; }
  }
  const paths = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return paths.some((dir) => {
    try { accessSync(path.join(dir, bin), constants.X_OK); return true; } catch { return false; }
  });
}

/**
 * `{ available, account?, reason? }`: a binary that runs is not enough, because the daemon must be
 * connected for a bot to be made; `tg status` answers both without a Telegram call of our own.
 */
export function probeTg({ env = process.env, timeoutMs = 4000 } = {}) {
  const bin = tgBinary(env);
  if (!runnable(bin)) return Promise.resolve({ available: false, reason: 'no tg client on this computer' });
  return new Promise((resolve) => {
    execFile(bin, ['status'], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
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
