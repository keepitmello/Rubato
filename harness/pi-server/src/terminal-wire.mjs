import { StringDecoder } from 'node:string_decoder';

export const MAX_TERMINAL_FRAME = 2 * 1024 * 1024;
/** Bounded framing shared by the lightweight terminal client and engine. */
export function terminalWire(socket, { onFrame, onError }) {
  let buffer = '', stopped = false;
  const decoder = new StringDecoder('utf8');
  const fail = error => { if (!stopped) { stopped = true; onError(error); socket.destroy(); } };
  socket.on('error', fail);
  socket.on('data', chunk => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    try {
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_TERMINAL_FRAME) throw new Error('Terminal frame exceeds limit');
        const frame = JSON.parse(line);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') throw new Error('Invalid terminal frame');
        onFrame(frame);
      }
      if (Buffer.byteLength(buffer) > MAX_TERMINAL_FRAME) throw new Error('Terminal frame exceeds limit');
    } catch (error) { fail(error); }
  });
  return {
    send(frame) {
      if (stopped || socket.destroyed || !socket.writable) return Promise.reject(new Error('Terminal disconnected'));
      const line = JSON.stringify(frame) + '\n';
      if (Buffer.byteLength(line) > MAX_TERMINAL_FRAME || socket.writableLength > 8 * 1024 * 1024) {
        const error = new Error('Terminal output exceeds buffer limit'); fail(error); return Promise.reject(error);
      }
      return new Promise((resolve, reject) => socket.write(line, error => error ? reject(error) : resolve()));
    },
  };
}
