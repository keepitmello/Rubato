// A new local thread does not read "Preparing worktree". T3 v0.1.11 starts a new thread's first
// run as `preparing` while it prepares the workspace — for a local thread too — and the composer
// takes any `preparing` run for a worktree being made: it says "Preparing worktree" and holds the
// send. A run counts as a worktree setup only with a worktree behind it: the thread's worktree
// path or a worktree setup the server reports.
export const localThreadOverlays = [];

export const localThreadEdits = {
  'apps/web/src/components/chat/useWorktreeSetup.ts': [
    ['    runStatus: activityRun?.status,\n',
      [
        '    // Rubato: a preparing run is a worktree setup only with a worktree behind it (local-thread-edits.mjs).',
        '    runStatus:',
        '      activeThread?.worktreePath != null || latestSnapshot != null || heldSnapshot != null',
        '        ? activityRun?.status',
        '        : undefined,',
        '',
      ].join('\n'),
      'replace'],
  ],
};
