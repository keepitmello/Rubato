// `t3 thread archive <thread>...`: archives threads through the running server, the way the
// sidebar's Archive does (the MCP tool t3_thread_organize, signed in as a short-lived CLI
// client like the other `t3 thread` commands). Archived threads come back from Settings ›
// Archive. archive-old-side-chats.mjs uses it at cutover for the side chats Rubato made
// before T3 had its own.
export const threadArchiveOverlays = [];

export const threadArchiveEdits = {
  'apps/server/src/cli/thread.ts': [
    ['export const threadCommand = Command.make("thread").pipe(\n',
      [
        'const threadArchiveCommand = Command.make("archive", {',
        '  ...projectLocationFlags,',
        '  threads: Argument.String("thread").pipe(',
        '    Argument.withDescription("Thread ids."),',
        '    Argument.atLeast(1),',
        '  ),',
        '}).pipe(',
        '  Command.withDescription("Archive threads; they come back from Settings > Archive."),',
        '  Command.withHandler((flags) =>',
        '    Effect.gen(function* () {',
        '      const threadIds = yield* Effect.forEach(flags.threads, decodeThreadId);',
        '      yield* withThreadTools(',
        '        { ...flags, json: false },',
        '        Effect.fn("cli.thread.archive")(function* (tools) {',
        '          for (const threadId of threadIds) {',
        '            yield* tools.call("t3_thread_organize", { threadId, action: "archive" }, Schema.Unknown);',
        '            yield* Console.log(`Archived ${threadId}`);',
        '          }',
        '        }),',
        '      );',
        '    }).pipe(reportThreadErrors),',
        '  ),',
        ');',
        '',
        '',
      ].join('\n')],
    ['    threadShowCommand,\n  ]),\n', '    threadShowCommand,\n    threadArchiveCommand,\n  ]),\n', 'replace'],
  ],
};
