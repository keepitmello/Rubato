import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const overlay = (rel) => readFile(path.join(root, 'overlay', rel), 'utf8');

test('RubatoCallHost does not poll /rubato/call every 2s when PushKit VoIP is active and stays unsubscribed from companionsStore while idle', async () => {
  const source = await overlay('apps/mobile/src/features/companions/RubatoCallHost.tsx');
  assert.doesNotMatch(source, /\bRING_POLL_MS\b/);
  assert.match(source, /\bhasVoipPush\b/);
  assert.match(source, /\bIDLE_RING_POLL_MS\b/);
  const hostBody = source.slice(source.indexOf('export function RubatoCallHost'));
  assert.doesNotMatch(hostBody, /\buseCompanions\s*\(/);
});

test('RoomMotion uses native-driven Animated loops rather than Reanimated withRepeat', async () => {
  const source = await overlay('apps/mobile/src/features/companions/RoomMotion.tsx');
  assert.doesNotMatch(source, /\bwithRepeat\s*\(/);
  assert.doesNotMatch(source, /import[\s\S]*\bwithRepeat\b[\s\S]*react-native-reanimated/);
  assert.match(source, /useNativeDriver:\s*true/);
  assert.match(source, /\buseAppActive\b/);
});

test('companionsStore shares one AppState-gated poller and skips identical publishes', async () => {
  const source = await overlay('apps/mobile/src/features/companions/companionsStore.ts');
  assert.match(source, /\bAppState\b/);
  assert.match(source, /\bactiveWatchers\b/);
  assert.match(source, /\bsameCompanionsSnapshot\b/);
});

test('RubatoPiInventory settles sessions whose deleted project returns null so they are not rescanned every 5s', async () => {
  const source = await overlay('apps/server/src/provider/RubatoPiInventory.ts');
  assert.match(source, /if\s*\(location === null\)\s*\{\s*settledSessions\.add\(entry\.sessionId\);\s*return;\s*\}/);
});
