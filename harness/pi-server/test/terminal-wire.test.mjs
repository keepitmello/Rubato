import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { terminalWire, MAX_TERMINAL_FRAME } from '../src/terminal-wire.mjs';
import { TerminalProcess } from '../src/terminal-process.mjs';

function socketFixture() {
  const socket = new EventEmitter(); Object.assign(socket, { writable: true, writableLength: 0,
    destroy() { this.destroyed = true; }, write(_line, callback) { callback(); } });
  const frames = [], errors = [];
  const wire = terminalWire(socket, { onFrame: frame => frames.push(frame), onError: error => errors.push(error) });
  return { socket, frames, errors, wire };
}
test('terminal framing decodes split UTF8 and rejects malformed or oversized input without touching a peer', () => {
  const a = socketFixture(), b = socketFixture();
  const line = Buffer.from(JSON.stringify({ type: 'input', data: '한글' }) + '\n');
  for (const byte of line) a.socket.emit('data', Buffer.from([byte]));
  assert.deepEqual(a.frames, [{ type: 'input', data: '한글' }]);
  a.socket.emit('data', Buffer.from('[]\n')); assert.equal(a.errors.length, 1);
  assert.equal(a.socket.destroyed, true); assert.equal(b.socket.destroyed, undefined);
  const large = socketFixture(); large.socket.emit('data', Buffer.alloc(MAX_TERMINAL_FRAME + 1, 120));
  assert.match(large.errors[0].message, /limit/);
});
test('a stalled terminal has bounded output and closes only its own channel', async () => {
  const slow = socketFixture(), peer = socketFixture();
  slow.socket.writableLength = 8 * 1024 * 1024 + 1;
  await assert.rejects(slow.wire.send({ type: 'output', data: 'x' }), /buffer limit/);
  assert.equal(slow.socket.destroyed, true);
  await peer.wire.send({ type: 'output', data: 'still alive' });
  await assert.rejects(peer.wire.send({ type: 'output', data: 'x'.repeat(MAX_TERMINAL_FRAME) }), /limit/);
});
test('unhandled termination and startup signals close the presentation, not the host process', async () => {
  const exits = [], frames = [];
  const terminal = new TerminalProcess({ send: async frame => frames.push(frame), onExit: async code => exits.push(code) });
  terminal.scope = { run: fn => fn() };
  terminal.signal('SIGTERM'); await terminal.exiting;
  assert.deepEqual(exits, [143]);
  const peer = new TerminalProcess({ send: async () => {}, onExit: async () => assert.fail('peer should survive') });
  peer.scope = terminal.scope; let interrupts = 0; peer.on('SIGINT', () => interrupts++);
  peer.signal('SIGINT'); assert.equal(interrupts, 1); assert.equal(peer.exiting, undefined);
  assert.throws(() => peer.signal('SIGKILL'), /Invalid/);
  terminal.closeStreams(); peer.closeStreams();
});
