import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../rubato-pi/bin/rubato-pi.mjs', import.meta.url));
const guard = fileURLToPath(new URL('./worker-parent.mjs', import.meta.url));

/** Process transport only. Rubato's real launcher owns the agent and providers. */
export class RpcWorker extends EventEmitter {
  constructor(metadata, { cliPath = launcher, env = {}, args = [], timeoutMs = 30000 } = {}) {
    super();
    this.metadata = metadata;
    this.options = { cliPath, env, args, timeoutMs };
    this.id = randomUUID();
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.eventSequence = 0;
    this.terminated = new Promise((resolve) => { this.finish = resolve; });
  }
  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async start() {
    if (this.child || this.closed) throw new Error('Worker already started or closed');
    const { cliPath, env, args } = this.options;
    this.child = spawn(process.execPath, ['--import', guard, cliPath, '--mode', 'rpc', ...args,
      '--session', this.metadata.file, '--session-dir', path.dirname(this.metadata.file)], {
      cwd: this.metadata.cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const fail = (error) => {
      if (this.failure) return;
      this.failure = error;
      this.closed = true;
      this.rejectPending(error);
      void this.stop();
    };
    this.child.once('error', fail);
    // Wait for physical termination, not just a failed protocol request. The
    // router must not acquire a replacement while an old writer is still alive.
    this.child.once('close', (code, signal) => {
      this.exited = true; this.closed = true;
      const error = this.failure ?? (this.stopping ? undefined : new Error(`Pi worker exited (${code ?? signal}); ${this.stderr.slice(-2048)}`));
      this.rejectPending(error ?? new Error('Pi worker stopped'));
      this.finish(error);
    });
    this.child.stdin.on('error', fail);
    this.child.stderr.on('data', (data) => { this.stderr = (this.stderr + data.toString()).slice(-16384); });
    this.child.stdout.on('data', (data) => {
      if (this.closed) return;
      buffer += decoder.write(data);
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { fail(new Error('Pi RPC frame exceeds limit')); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
          if (!record || typeof record !== 'object' || typeof record.type !== 'string') throw new Error();
        } catch { fail(new Error('Invalid JSON record on Pi RPC stdout')); return; }
        if (record.type === 'response') {
          const pending = this.pending.get(record.id);
          if (!pending) continue;
          this.pending.delete(record.id); clearTimeout(pending.timer);
          if (record.success) pending.resolve(pending.withBoundary
            ? { data: record.data ?? null, eventSequence: this.eventSequence } : record.data ?? null);
          else pending.reject(new Error(record.error || 'Pi RPC failed'));
        } else {
          this.eventSequence++;
          this.emit('event', record);
        }
      }
    });
    try {
      const state = await this.request({ type: 'get_state' });
      if (state.sessionId !== this.metadata.id) throw new Error('Pi resumed a different persisted session');
      return state;
    } catch (error) { await this.stop(); throw error; }
  }
  request(command, { withBoundary = false } = {}) {
    if (this.closed || !this.child || this.stopping) return Promise.reject(new Error('Pi worker is not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC timed out: ${command.type}; outcome may be unknown`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, withBoundary });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + '\n', (error) => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  reply(response) {
    if (this.closed || !this.child || this.stopping) throw new Error('Pi worker is not running');
    this.child.stdin.write(JSON.stringify({ ...response, type: 'extension_ui_response' }) + '\n');
  }
  async stop() {
    if (this.stopping) return this.terminated;
    this.stopping = true;
    if (!this.child) { this.closed = true; this.exited = true; this.finish(); return; }
    if (this.exited) return this.terminated;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    try { await this.terminated; } finally { clearTimeout(timer); }
  }
}
