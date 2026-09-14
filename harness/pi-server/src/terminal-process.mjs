import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import nodeProcess from 'node:process';

/** The native TUI's process I/O, owned by one terminal attachment, not the engine. */
export class TerminalProcess extends EventEmitter {
  constructor({ send, rows = 24, columns = 80, pid, cwd, onExit, stdinIsTTY = true, stdoutIsTTY = true }) {
    super();
    this.send = send; this.pid = pid; this.cwd = cwd; this.onExit = onExit;
    this.stdin = new PassThrough();
    this.stdin.on('resume', () => this.control({ type: 'input_flow', paused: false }));
    this.stdin.on('pause', () => this.control({ type: 'input_flow', paused: true }));
    this.stdin.isTTY = stdinIsTTY; this.stdin.isRaw = false;
    this.stdin.setRawMode = value => { this.stdin.isRaw = Boolean(value); this.control({ type: 'raw', enabled: Boolean(value) }); return this.stdin; };
    const output = stream => {
      const writer = new Writable({ write: (chunk, _encoding, done) => {
        Promise.resolve().then(() => this.send({ type: 'output', stream, data: chunk.toString('utf8') })).then(() => done(), done);
      } });
      writer.isTTY = stdoutIsTTY; writer.rows = rows; writer.columns = columns;
      // A disconnected frontend must never emit an unhandled stream error on
      // the shared engine. Native TUI handlers can still observe this event.
      writer.on('error', () => {});
      const write = writer.write.bind(writer);
      writer.write = (...args) => {
        if (writer.writableLength > 8 * 1024 * 1024) { void this.exit(1).catch(() => {}); return false; }
        return write(...args);
      };
      return writer;
    };
    this.stdout = output('stdout'); this.stderr = output('stderr');
  }
  control(frame) { Promise.resolve().then(() => this.send(frame)).catch(() => this.exit(1)).catch(() => {}); }
  input(data) {
    if (this.exiting) return;
    if (!this.scope.run(() => this.stdin.write(data))) {
      this.control({ type: 'input_flow', paused: true });
      this.stdin.once('drain', () => this.control({ type: 'input_flow', paused: false }));
    }
  }
  resize(rows, columns) {
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 1000 || columns > 2000) throw new Error('Invalid terminal dimensions');
    this.stdout.rows = this.stderr.rows = rows; this.stdout.columns = this.stderr.columns = columns;
    this.scope.run(() => this.stdout.emit('resize'));
  }
  signal(name) {
    if (!['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGCONT'].includes(name)) throw new Error('Invalid terminal signal');
    this.scope.run(() => {
      if (!this.emit(name) && name !== 'SIGCONT') void this.exit({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[name]);
    });
  }
  kill(pid, signal) {
    if (pid === 0 && signal === 'SIGTSTP') { this.control({ type: 'suspend' }); return true; }
    return nodeProcess.kill(pid, signal);
  }
  exit(code = 0) {
    return this.exiting ??= Promise.resolve().then(() => this.onExit(code));
  }
  closeStreams() { this.stdin.destroy(); this.stdout.destroy(); this.stderr.destroy(); this.removeAllListeners(); }
}
