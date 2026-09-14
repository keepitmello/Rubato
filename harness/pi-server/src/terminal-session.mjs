import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TerminalProcess } from './terminal-process.mjs';
import { createSessionCursor } from './session-cursor.mjs';

/** Preserve native main, bootstrap, commands and renderer; own only this view. */
export function startTerminalSession({ host, descriptor, api, open, send: emit, configureHttp, onMode }) {
  const send = async frame => emit(frame);
  if (!path.isAbsolute(open.cwd ?? '') || !Array.isArray(open.args) || open.args.some(x => typeof x !== 'string')
    || !open.env || typeof open.env !== 'object' || Object.values(open.env).some(x => typeof x !== 'string')) throw new Error('Invalid terminal open');
  const parsed = api.parseArgs(open.args);
  if (parsed.help || parsed.listModels !== undefined || parsed.export || parsed.version
    || ['auth', 'install', 'remove', 'update', 'config', 'list'].includes(open.args[0])) throw new Error('Run maintenance commands through the CLI launcher');
  let mode, cursor, closing;
  const operations = new Map();
  const terminal = new TerminalProcess({ rows: open.rows, columns: open.columns, pid: process.pid,
    cwd: () => cursor?.cwd ?? open.cwd, send, onExit: code => close(code),
    stdinIsTTY: open.stdinIsTTY ?? true, stdoutIsTTY: open.stdoutIsTTY ?? true });
  const scope = api.createUiScope({ process: terminal, env: { ...open.env,
    // The frontend may customize its terminal, never repin the engine profile.
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    RUBATO_PI_CODING_AGENT_DIR: process.env.RUBATO_PI_CODING_AGENT_DIR,
  }, edit: options => new Promise((resolve, reject) => {
    const id = randomUUID(); operations.set(id, { resolve, reject });
    void send({ type: 'edit', id, options }).catch(error => { operations.delete(id); reject(error); });
  }) });
  terminal.scope = scope;
  async function close(code = 0) {
    if (closing) return closing;
    scope.close();
    mode?.onInputCallback?.('');
    for (const operation of operations.values()) operation.resolve({ status: 'failed' });
    operations.clear();
    return closing = scope.run(async () => {
      try {
        if (mode) { mode.isShuttingDown = true; mode.stop(); }
        await cursor?.dispose();
      } finally {
        api.stopThemeWatcher();
        api.onThemeChange(undefined);
        await api.releaseHttp?.();
        // Flush the renderer's final cursor/alternate-screen restoration first.
        await Promise.all([terminal.stdout, terminal.stderr].map(stream => stream.destroyed ? undefined : new Promise(resolve => stream.end(resolve))));
        await send({ type: 'exit', code }).catch(() => {});
        terminal.closeStreams();
        mode = undefined; cursor = undefined;
      }
    });
  }
  const done = scope.run(async () => {
    try {
      await api.main(open.args, {
        createExtensionFactories: api.createExtensionFactories,
        configureHttp: configureHttp ?? api.configureHttp,
        createRuntimeHost: async (createRuntime, initial) => {
          scope.assertOpen();
          cursor = await createSessionCursor({ host, descriptor, api, createRuntime, initial, scope });
          if (scope.closed) { await cursor.dispose(); scope.assertOpen(); }
          return cursor;
        },
        onInteractiveMode(value) { scope.assertOpen(); mode = value; onMode?.(mode); },
      });
      await close(terminal.exitCode ?? 0);
    } catch (error) {
      if (!(error instanceof api.PresentationExit)) await send({ type: 'error', message: error.message }).catch(() => {});
      await close(error instanceof api.PresentationExit ? error.code : 1);
    }
  });
  return { done, close, get mode() { return mode; }, get cursor() { return cursor; },
    receive(frame) {
      if (scope.closed) return;
      if (frame.type === 'input' && typeof frame.data === 'string') {
        if (terminal.stdin.readableLength + Buffer.byteLength(frame.data) > 2 * 1024 * 1024) throw new Error('Terminal input exceeds buffer limit');
        terminal.input(frame.data);
      } else if (frame.type === 'input_end') scope.run(() => terminal.stdin.end());
      else if (frame.type === 'resize') terminal.resize(frame.rows, frame.columns);
      else if (frame.type === 'signal') terminal.signal(frame.signal);
      else if (frame.type === 'edit_result') {
        const pending = operations.get(frame.id);
        if (!pending) throw new Error('Unknown terminal operation');
        const result = frame.result;
        if (result?.status !== 'failed' && !(result?.status === 'complete' && typeof result.content === 'string')) throw new Error('Invalid editor result');
        operations.delete(frame.id); pending.resolve(result);
      } else throw new Error('Unsupported terminal frame');
    },
  };
}
