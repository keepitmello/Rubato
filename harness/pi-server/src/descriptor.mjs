import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Address/build metadata only. Never a second session database. */
export async function readDescriptor(file) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.version !== 1 || typeof value.serverId !== 'string' || typeof value.socketPath !== 'string'
    || !path.isAbsolute(value.socketPath)) throw new Error('Invalid Rubato Pi server descriptor');
  if (value.terminalSocketPath !== undefined && !path.isAbsolute(value.terminalSocketPath)) throw new Error('Invalid terminal socket path');
  if (value.runtimeRoot !== undefined && !path.isAbsolute(value.runtimeRoot)) throw new Error('Invalid engine build path');
  return value;
}
