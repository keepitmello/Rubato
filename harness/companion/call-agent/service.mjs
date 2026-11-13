// The call service the engine keeps running (pi-server/src/resident-services.mjs). The engine's main
// thread owns LiveKit and the worker (ctx.spawn), so they stop with the engine and never outlive it.
// When either one ends on its own the service ends too, and the engine starts it again.
//
// A Mac without LiveKit or this package's dependencies keeps the service idle with the reason in the
// engine log, instead of failing and starting again forever.
import { livekitServerPath } from './livekit.mjs';

export async function start(ctx) {
  let startCallStack;
  try { ({ startCallStack } = await import('./stack.mjs')); }
  catch (error) { ctx.log?.('call service idle', { reason: `dependencies missing (npm install in call-agent): ${error.message}` }); return {}; }
  if (!livekitServerPath()) { ctx.log?.('call service idle', { reason: 'livekit-server is not installed (brew install livekit)' }); return {}; }
  const stack = await startCallStack({
    spawn: (command, args, options) => ctx.spawn(command, args, options),
    say: (text, fields) => ctx.log?.(text, fields),
    onExit: (name, code) => setImmediate(() => { throw new Error(`call ${name} exited (${code})`); }),
  });
  ctx.log?.('call service ready', { port: stack.port, livekit: stack.livekit.url });
  return { close: () => stack.close() };
}
