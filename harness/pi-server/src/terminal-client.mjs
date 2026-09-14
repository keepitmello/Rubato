import { connect } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { terminalWire } from './terminal-wire.mjs';

/** Thin frontend: no agent, provider, extension or renderer imports. */
export async function runTerminalClient({ descriptor, args, cwd = process.cwd(), env = process.env,
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, signals = process,
  edit, suspend = () => process.kill(process.pid, 'SIGTSTP') }) {
  if (!path.isAbsolute(descriptor.terminalSocketPath ?? '')) throw new Error('This profile engine does not support shared CLI terminals');
  const originalRaw = Boolean(stdin.isRaw), originalPaused = stdin.isPaused();
  const socket = connect(descriptor.terminalSocketPath);
  let settled = false, editing = false, serverReading = false;
  let outputQueue = Promise.resolve(), queuedBytes = 0;
  const decoder = new StringDecoder('utf8');
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const listeners = new Map();
  const cleanup = () => {
    stdin.off('data', input); stdin.off('end', end); stdout.off('resize', resize);
    for (const [name, handler] of listeners) signals.off(name, handler);
    stdin.setRawMode?.(originalRaw);
    if (originalPaused) stdin.pause();
    socket.destroy();
  };
  const finish = (error, code) => {
    if (settled) return; settled = true; cleanup();
    // Also restore on an engine crash, where no final renderer frame can arrive.
    if (stdout.isTTY) stdout.write('\x1b[?25h\x1b[?1049l');
    if (error) rejectResult(error); else resolveResult(code ?? 0);
  };
  const send = frame => { void wire.send(frame).catch(error => finish(error)); };
  const input = data => { if (!editing) send({ type: 'input', data: typeof data === 'string' ? data : decoder.write(data) }); };
  const end = () => send({ type: 'input_end' });
  const resize = () => send({ type: 'resize', rows: stdout.rows, columns: stdout.columns });
  const handle = async frame => {
    if (frame.type === 'output' && typeof frame.data === 'string' && ['stdout', 'stderr'].includes(frame.stream)) {
      const output = frame.stream === 'stdout' ? stdout : stderr;
      await new Promise((resolve, reject) => output.write(frame.data, error => error ? reject(error) : resolve()));
    } else if (frame.type === 'input_flow' && typeof frame.paused === 'boolean') {
      serverReading = !frame.paused;
      if (serverReading && !editing) stdin.resume(); else stdin.pause();
    } else if (frame.type === 'raw' && typeof frame.enabled === 'boolean') stdin.setRawMode?.(frame.enabled);
    else if (frame.type === 'suspend') suspend();
    else if (frame.type === 'exit' && Number.isInteger(frame.code)) finish(undefined, frame.code);
    else if (frame.type === 'error' && typeof frame.message === 'string') stderr.write(frame.message + '\n');
    else if (frame.type === 'edit' && typeof frame.id === 'string' && typeof frame.options?.command === 'string' && typeof frame.options?.content === 'string') {
      if (editing) throw new Error('An external editor is already open');
      editing = true; stdin.pause();
      try {
        const editor = edit ?? (await import(pathToFileURL(path.join(descriptor.runtimeRoot,
          'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/external-editor.js')).href)).editInExternalEditor;
        await wire.send({ type: 'edit_result', id: frame.id, result: await editor(frame.options) });
      } finally { editing = false; if (!settled && serverReading) stdin.resume(); }
    } else throw new Error('Invalid engine terminal frame');
  };
  const wire = terminalWire(socket, { onError: error => finish(error), onFrame: frame => {
    const bytes = Buffer.byteLength(JSON.stringify(frame)); queuedBytes += bytes;
    if (queuedBytes > 8 * 1024 * 1024) throw new Error('Terminal render queue exceeds limit');
    if (queuedBytes > 256 * 1024) socket.pause();
    outputQueue = outputQueue.then(() => { if (!settled) return handle(frame); }).catch(error => finish(error)).finally(() => {
      queuedBytes -= bytes; if (!settled && queuedBytes < 128 * 1024) socket.resume();
    });
  } });
  socket.once('connect', () => {
    send({ type: 'open', version: 1, args, cwd, env, rows: stdout.rows ?? 24, columns: stdout.columns ?? 80,
      stdinIsTTY: Boolean(stdin.isTTY), stdoutIsTTY: Boolean(stdout.isTTY) });
    stdin.on('data', input); stdin.once('end', end); stdin.pause(); stdout.on('resize', resize);
    if (stdin.readableEnded) end();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGCONT']) {
      const handler = () => send({ type: 'signal', signal: name }); listeners.set(name, handler); signals.on(name, handler);
    }
  });
  socket.once('close', () => { void outputQueue.then(() => { if (!settled) finish(new Error('Shared engine disconnected')); }); });
  return result;
}
