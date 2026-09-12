import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../../rubato-pi/bin/rubato-pi.mjs', import.meta.url));

/** Thin process transport for Pi's published RPC. Unlike SDK RpcClient, this
 * boundary exposes process termination and extension_ui_response without using
 * private fields. Conversation semantics remain in the actual Rubato launcher. */
export class RpcWorker extends EventEmitter {
  constructor(metadata, { cliPath = launcher, env = {}, args = [], timeoutMs = 30000 } = {}) {
    super();
    this.metadata = metadata;
    this.options = { cliPath, env, args, timeoutMs };
    this.id = randomUUID();
    this.pending = new Map();
    this.stderr = '';
    this.closed = false;
    this.terminated = new Promise((resolve) => { this.finish = resolve; });
  }
  async start() {
    if (this.child || this.closed) throw new Error('Worker already started or closed');
    const { cliPath, env, args } = this.options;
    this.child = spawn(process.execPath, [cliPath, '--mode', 'rpc', ...args,
      '--session', this.metadata.file, '--session-dir', path.dirname(this.metadata.file)], {
      cwd: this.metadata.cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    const die = (error) => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error || new Error('Worker closed')); }
      this.pending.clear();
      this.finish(this.stopping ? undefined : error || new Error('Worker exited'));
    };
    this.child.once('error', die);
    this.child.once('exit', (code, signal) => die(new Error(`Pi worker exited (${code ?? signal}); ${this.stderr.slice(-2048)}`)));
    this.child.stdin.on('error', (error) => { die(error); this.child.kill(); });
    this.child.stderr.on('data', (data) => { this.stderr = (this.stderr + data.toString()).slice(-16384); });
    this.child.stdout.on('data', (data) => {
      buffer += decoder.write(data);
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { die(new Error('Pi RPC frame exceeds limit')); this.child.kill(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { die(new Error('Non-JSON output on Pi RPC stdout')); this.child.kill(); return; }
        if (record.type === 'response') {
          const pending = this.pending.get(record.id);
          if (!pending) continue;
          this.pending.delete(record.id); clearTimeout(pending.timer);
          if (record.success) pending.resolve(record.data ?? null);
          else pending.reject(new Error(record.error || 'Pi RPC failed'));
        } else { this.emit('event', record); }
      }
    });
    try {
      const state = await this.request({ type: 'get_state' });
      if (state.sessionId !== this.metadata.id) throw new Error('Pi resumed a different persisted session');
      return state;
    } catch (error) { await this.stop(); throw error; }
  }
  request(command) {
    if (this.closed || !this.child) return Promise.reject(new Error('Pi worker is not running'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Do not retry an operation whose outcome is unknown.
        reject(new Error(`Pi RPC timed out: ${command.type}; outcome may be unknown`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + '\n', (error) => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
      });
    });
  }
  reply(response) {
    if (this.closed || !this.child) throw new Error('Pi worker is not running');
    this.child.stdin.write(JSON.stringify({ ...response, type: 'extension_ui_response' }) + '\n');
  }
  async stop() {
    if (this.stopping) return this.terminated;
    this.stopping = true;
    if (!this.child) { this.closed = true; this.finish(); return; }
    if (this.closed) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
    try { await this.terminated; } finally { clearTimeout(timer); }
  }
}
