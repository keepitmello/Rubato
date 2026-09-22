import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the pinned upstream's real SQLite/ingestion harness, rather than a
// second implementation of its assistant fallback and segmentation rules.
test('Pi events survive T3 ingestion, persisted snapshots and web/mobile folds', {
  skip: !process.env.T3_SOURCE, timeout: 120_000,
}, async (t) => {
  const source = process.env.T3_SOURCE;
  const directory = path.join(source, 'apps/server/src/orchestration/Layers');
  const upstream = await readFile(path.join(directory, 'ProviderRuntimeIngestion.test.ts'), 'utf8');
  const marker = '  it("maps turn started/completed events into thread session updates"';
  const boundary = upstream.indexOf(marker);
  assert.ok(boundary > 0, 'Pinned upstream ingestion harness changed');
  const fixture = await readFile(new URL('./fixtures/presentation.ts', import.meta.url), 'utf8');
  const generated = path.join(directory, `RubatoPresentation.${process.pid}.test.ts`);
  const bridge = process.env.T3_PRESENTATION_BRIDGE ??
    fileURLToPath(new URL('../src/events.mjs', import.meta.url));
  const imports = [
    `import { EventProjection } from ${JSON.stringify(bridge)};`,
    'import { deriveMessagesTimelineRows } from "../../../../web/src/components/chat/MessagesTimeline.logic.ts";',
    'import { deriveTimelineEntries, deriveWorkLogEntries } from "../../../../web/src/session-logic.ts";',
    'import { buildThreadFeed, deriveThreadFeedPresentation } from "../../../../mobile/src/lib/threadActivity.ts";',
  ].join('\n');
  await writeFile(generated, imports + '\n' + upstream.slice(0, boundary) + fixture + '\n});\n', { flag: 'wx' });
  t.after(() => unlink(generated));
  try {
    const result = await promisify(execFile)(
      path.join(source, 'node_modules/.bin/vp'),
      ['test', 'run', path.relative(path.join(source, 'apps/server'), generated),
        ...(process.env.T3_PRESENTATION_TEST_NAME ? ['-t', process.env.T3_PRESENTATION_TEST_NAME] : [])],
      { cwd: path.join(source, 'apps/server'), timeout: 110_000, maxBuffer: 4 * 1024 * 1024 },
    );
    t.diagnostic(result.stdout);
  } catch (error) {
    assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
  }
});
