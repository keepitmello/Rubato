// Official AGY keeps the model and tool execution. This stdio adapter gives its
// Rubato MCP child a way to ask the existing ACP client's user-input handler.
// With RUBATO_AGY_NATIVE_DIR set it also gives the client rewind and fork on agy's own
// conversation store (agy-native.mjs).
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { AGY_NATIVE_DIR_ENV, agyLogDirectory, createAgyNative } from './agy-native.mjs';

export async function runAgyApprovalBridge(command, args, { input = process.stdin, output = process.stdout,
  env = process.env, nativeOptions = {} } = {}) {
  const token = `Bearer ${randomUUID()}${randomUUID()}`;
  const prefix = `rubato-local-${randomUUID()}-`;
  let sequence = 0, child, native;
  const pending = new Map(), turnIds = new Map();
  const write = (stream, value) => stream.write(`${JSON.stringify(value)}\n`);
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const reject = (status) => { res.writeHead(status); res.end(); };
    const candidate = Buffer.from(auth);
    const expected = Buffer.from(token);
    if (req.url !== '/form' || req.method !== 'POST' || req.headers.origin ||
        candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return reject(403);
    if (turnIds.size !== 1) return reject(409);
    const [turnId, sessionId] = turnIds.entries().next().value;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 128 * 1024) return reject(413);
      }
      const { message, requestedSchema } = JSON.parse(body);
      if (typeof message !== 'string' || !message.trim() || message.length > 32_768 ||
          requestedSchema?.type !== 'object' || !requestedSchema.properties?.answer) return reject(400);
      if (turnIds.get(turnId) !== sessionId || pending.size) return reject(409);
      const id = `${prefix}${++sequence}`;
      const finish = (result = { action: 'cancel' }) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        if (!res.destroyed) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      };
      const timer = setTimeout(finish, 120_000);
      pending.set(id, { finish, turnId });
      res.once('close', () => finish());
      write(output, { jsonrpc: '2.0', id, method: 'elicitation/create',
        params: { mode: 'form', sessionId, message, requestedSchema } });
    } catch { reject(400); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env,
      RUBATO_AGY_APPROVAL_URL: `http://127.0.0.1:${server.address().port}/form`, RUBATO_AGY_APPROVAL_TOKEN: token } });
    child.stdin.on('error', () => {});
    const nativeDir = env[AGY_NATIVE_DIR_ENV];
    if (nativeDir) native = createAgyNative({ dir: nativeDir, logDir: agyLogDirectory(args, env.HOME || homedir()),
      pid: child.pid, prefix, toAgent: (value) => write(child.stdin, value), toClient: (value) => write(output, value),
      ...nativeOptions });
    const clientLines = createInterface({ input });
    const agentLines = createInterface({ input: child.stdout });
    const cancel = (turnId) => {
      turnIds.delete(turnId);
      for (const request of pending.values()) if (request.turnId === turnId) request.finish();
    };
    const forward = async (line) => {
      let wire;
      try { wire = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); return; }
      if (!wire.method && typeof wire.id === 'string' && wire.id.startsWith(prefix)) {
        pending.get(wire.id)?.finish(wire.result);
        return;
      }
      if (native) {
        const next = await native.fromClient(wire);
        if (next === null) return;
        if (next !== wire) { wire = next; line = JSON.stringify(next); }
      }
      if (wire.method === 'session/prompt' && typeof wire.params?.sessionId === 'string') {
        turnIds.set(wire.id, wire.params.sessionId);
      } else if (wire.method === 'session/cancel') {
        for (const [id, sid] of turnIds) if (sid === wire.params?.sessionId) cancel(id);
      }
      child.stdin.write(`${line}\n`);
    };
    // A cut or fork answers agy before the client's message goes on, so client messages keep their order.
    let forwarding = Promise.resolve();
    clientLines.on('line', line => { forwarding = forwarding.then(() => forward(line)).catch(() => {}); });
    const deliver = async (line) => {
      let wire;
      try {
        wire = JSON.parse(line);
      } catch {}
      if (wire && native) {
        const next = await native.fromAgent(wire);
        if (next === null) return;
        if (next !== wire) { wire = next; line = JSON.stringify(next); }
      }
      if (wire) {
        if (!wire.method && turnIds.has(wire.id)) cancel(wire.id);
      }
      output.write(`${line}\n`);
    };
    // A reply's end can wait on its saved batches, so agy messages keep their order behind it.
    // The bridge's own answers from agy settle at once: a cut waiting on them holds client lines, not these.
    let delivering = Promise.resolve();
    agentLines.on('line', line => { delivering = delivering.then(() => deliver(line)).catch(() => {}); });
    clientLines.once('close', () => { forwarding.finally(() => { child.stdin.end(); child.kill(); }); });
    const stop = () => child.kill();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      });
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      clientLines.close();
      agentLines.close();
    }
  } finally {
    native?.close();
    for (const request of pending.values()) request.finish();
    server.close();
    server.closeAllConnections();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , command, ...args] = process.argv;
  process.exitCode = await runAgyApprovalBridge(command, args);
}
