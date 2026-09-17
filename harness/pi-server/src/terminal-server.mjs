import { createServer } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { terminalWire } from './terminal-wire.mjs';
import { startTerminalSession } from './terminal-session.mjs';

/** A byte-I/O endpoint of the SAME profile engine. No runtime acquisition here. */
export async function startTerminalServer({ socketPath, host, descriptor, api, onError = () => {} }) {
  if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > 100) throw new Error('Terminal socket path exceeds platform limit');
  try {
    const previous = await lstat(socketPath);
    if (!previous.isSocket()) throw new Error('Refusing to replace a non-socket terminal path');
    await unlink(socketPath); // Caller already holds the exclusive profile lock.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const connections = new Set();
  const server = createServer(socket => {
    let session, opened = false;
    const entry = { socket, close: async () => { await session?.close(); await session?.done; } }; connections.add(entry);
    const stop = error => { if (error) onError(error); void session?.close(1).catch(onError); socket.destroy(); };
    const wire = terminalWire(socket, { onError: stop, onFrame(frame) {
      if (!opened) {
        if (frame.type !== 'open' || frame.version !== 1) throw new Error('Expected terminal open');
        opened = true;
        socket.setTimeout(0);
        session = startTerminalSession({ host, descriptor, api, open: frame, send: wire.send });
        void session.done.finally(() => socket.end()).catch(stop);
      } else session.receive(frame);
    } });
    // A connection must identify itself promptly; idle sessions are owned by
    // the runtime router, not by an unrelated socket timeout.
    socket.setTimeout(10000, () => { if (!opened) stop(new Error('Terminal open timed out')); });
    socket.on('close', () => {
      void (async () => { await session?.close(); await session?.done; })().catch(onError).finally(() => connections.delete(entry));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  server.on('error', onError);
  let closing;
  return { socketPath, close: () => closing ??= (async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all([...connections].map(async entry => { await entry.close(); entry.socket.destroy(); }));
    await closed;
  })() };
}
