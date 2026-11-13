import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The app loads LiveKit's browser client from this one vendored module (call-edits.mjs). A copy that
// lost its export list loaded without error and left every call stuck on "Connecting the call".
const vendored = new URL('../overlay/apps/web/public/rubato-livekit-client.mjs', import.meta.url);

test('the vendored LiveKit client exports what the call layer uses', async () => {
  const livekit = await import(vendored.href);
  assert.equal(typeof livekit.Room, 'function');
  assert.equal(typeof livekit.RoomEvent?.TrackSubscribed, 'string');
  assert.equal(typeof livekit.Track?.Kind?.Audio, 'string');
  assert.match(readFileSync(vendored, 'utf8').slice(0, 200), /livekit-client (\d+\.\d+\.\d+)/);
});
