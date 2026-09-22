import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The real T3 ingestion harness proves the stored report survives a fresh fold;
// testing only EventProjection misses both downstream 180-character cuts.
test('agent reports survive T3 storage and reload without truncating the final paragraph', {
  skip: !process.env.T3_SOURCE, timeout: 120_000,
}, async (t) => {
  const source = process.env.T3_SOURCE;
  const directory = path.join(source, 'apps/server/src/orchestration/Layers');
  const upstream = await readFile(path.join(directory, 'ProviderRuntimeIngestion.test.ts'), 'utf8');
  const boundary = upstream.indexOf('  it("maps turn started/completed events into thread session updates"');
  assert.ok(boundary > 0, 'Pinned upstream ingestion harness changed');
  const generated = path.join(directory, `RubatoAgentResults.${process.pid}.test.ts`);
  const fixture = await readFile(new URL('./fixtures/agent-results.ts', import.meta.url), 'utf8');
  const bridge = fileURLToPath(new URL('../src/events.mjs', import.meta.url));
  await writeFile(generated, [
    `import { EventProjection } from ${JSON.stringify(bridge)};`,
    'import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";',
    upstream.slice(0, boundary), fixture, '});',
  ].join('\n'), { flag: 'wx' });
  t.after(() => unlink(generated));
  try {
    const result = await promisify(execFile)(
      path.join(source, 'node_modules/.bin/vp'),
      ['test', 'run', path.relative(path.join(source, 'apps/server'), generated)],
      { cwd: path.join(source, 'apps/server'), timeout: 110_000, maxBuffer: 4 * 1024 * 1024 },
    );
    t.diagnostic(result.stdout);
  } catch (error) {
    assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
  }
});
