import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuotaReader } from '../quota.mjs';
import { heartbeatText } from '../control-tower.mjs';

test('createQuotaReader caches within TTL and falls back to stale cache on failure', async () => {
  let clock = 1_000_000;
  let calls = 0;
  let fail = false;
  const reader = createQuotaReader({
    ttlMs: 5_000,
    staleMs: 20_000,
    now: () => clock,
    timeZone: 'Asia/Seoul',
    fetchUsage: async () => {
      calls += 1;
      if (fail) throw new Error('offline');
      return {
        accounts: [
          { provider: 'anthropic', account: 'main', modelSuffix: '', usageLimits: { windows: [{ label: 'Weekly', kind: 'weekly', usedPercent: 40 }] } },
        ],
      };
    },
  });

  const first = await reader();
  assert.equal(first, 'Anthropic main 60%');
  assert.equal(calls, 1);

  clock += 2_000;
  assert.equal(await reader(), 'Anthropic main 60%');
  assert.equal(calls, 1, 'cached within TTL');

  clock += 4_000;
  fail = true;
  assert.equal(await reader(), 'Anthropic main 60%', 'falls back to stale cache within staleMs');
  assert.equal(calls, 2);

  clock += 25_000;
  assert.equal(await reader(), '', 'returns empty once past staleMs');
});

test('heartbeatText includes QUOTA line when provided', () => {
  const line = heartbeatText({
    tick: 1,
    at: Date.UTC(2026, 10, 26, 9, 0, 0),
    quota: 'Anthropic main 50% · sub 61% | Codex 88%',
  });
  assert.match(line, /^QUOTA Anthropic main 50% · sub 61% \| Codex 88%$/m);
});
