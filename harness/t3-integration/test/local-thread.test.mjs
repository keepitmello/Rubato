import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// A new local thread's preparing run does not read "Preparing worktree" (local-thread-edits.mjs).
const applied = (relative) => readFile(path.join(process.env.T3_SOURCE, relative), 'utf8');

test('a preparing run counts as a worktree setup only with a worktree behind it', { skip: !process.env.T3_SOURCE }, async () => {
  const hook = await applied('apps/web/src/components/chat/useWorktreeSetup.ts');
  const call = hook.slice(hook.indexOf('resolveWorktreeSetupProgress({'), hook.indexOf('});', hook.indexOf('resolveWorktreeSetupProgress({')));
  assert.match(call, /runStatus:\n\s+activeThread\?\.worktreePath != null \|\| latestSnapshot != null \|\| heldSnapshot != null\n\s+\? activityRun\?\.status\n\s+: undefined,/);
  assert.match(call, /localPreparing,/);
});
