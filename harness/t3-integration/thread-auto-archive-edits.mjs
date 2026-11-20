// Threads nobody touched for two weeks go to the archive on their own (RubatoThreadAutoArchive.ts).
// Upstream archives only on request, and every session started elsewhere shows as a thread, so the
// active list every client reloads on each connection only grew. The server's startup gains a job
// that archives idle threads two minutes after startup and every hour after.
export const threadAutoArchiveOverlays = [
  'apps/server/src/RubatoThreadAutoArchive.ts',
  'apps/server/src/RubatoThreadAutoArchive.test.ts',
];

export const threadAutoArchiveEdits = {
  'apps/server/src/serverRuntimeStartup.ts': [
    ['import { resolveProjectSettings } from "@t3tools/shared/projectSettings";\n',
      'import { makeRubatoThreadAutoArchive } from "./RubatoThreadAutoArchive.ts";\n'],
    // After the inventory's first pass is under way, once commands are accepted.
    ['    yield* flushCompileCache;\n',
      '    yield* runStartupPhase("rubato.auto-archive", Effect.flatMap(makeRubatoThreadAutoArchive, (job) => job.start));\n'],
  ],
};
