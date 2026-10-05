import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Closing the right panel's last tab used to hide the column; it now lands on the
// panel's own launcher (right-panel-edits.mjs). That we can only see through the
// store, so this runs the store's tests in the applied tree: upstream's file,
// whose three closing tests now assert the launcher, and ours, which holds the
// boundary upstream does not cover — a hidden panel stays hidden.
test('closing the last right-panel tab returns to the surface launcher', {
  skip: !process.env.T3_SOURCE,
  timeout: 180_000,
}, async (t) => {
  const source = process.env.T3_SOURCE;
  let result;
  try {
    result = await promisify(execFile)(
      path.join(source, 'node_modules/.bin/vp'),
      [
        'test', 'run',
        'src/rightPanelStore.test.ts',
        'src/rubatoRightPanelLauncher.test.ts',
        '--project', 'unit',
      ],
      { cwd: path.join(source, 'apps/web'), timeout: 170_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    assert.fail(`${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`);
  }
  t.diagnostic(result.stdout);
  assert.match(result.stdout, /src\/rubatoRightPanelLauncher\.test\.ts/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});
