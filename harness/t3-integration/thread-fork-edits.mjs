// Forking a whole thread from the sidebar. T3 forks at one reply ("Fork from this
// response") and only from a completed run; Rubato's engine copies the whole conversation,
// a last failed or stopped turn included, and threads brought over from before T3's V2
// orchestrator. This adds:
//
// - the thread's right-click menu offers Fork thread for a thread that runs on Rubato,
//   in the thread action menu (threadActionMenu.logic.ts, the sidebar's) and in the
//   legacy sidebar's own menu;
// - /rubato/thread-fork on the server (RubatoThreadFork.ts) hands the thread to
//   forkWholeThread (RubatoPiSessions.ts): the engine copies the Pi session and the server
//   writes "<title> (fork)" the way an imported native thread is written, so it carries the
//   conversation's messages and its next message continues the copy;
// - the sidebar opens the new thread once it reaches the app.
export const threadForkOverlays = [
  'apps/server/src/RubatoThreadFork.ts',
  'apps/web/src/components/sidebar/rubatoThreadFork.ts',
  'apps/web/src/components/sidebar/rubatoThreadFork.test.ts',
];

const forkHandler = (indent) => [
  'const progress = toastManager.add({ type: "loading", title: "Forking thread…" });',
  'try {',
  '  await navigateToThread(await forkThread(threadRef));',
  '  toastManager.close(progress);',
  '} catch (error) {',
  '  toastManager.update(',
  '    progress,',
  '    stackedThreadToast({',
  '      type: "error",',
  '      title: "Failed to fork thread",',
  '      description: error instanceof Error ? error.message : "An error occurred.",',
  '    }),',
  '  );',
  '}',
  'return;',
].map((line) => indent + line);

export const threadForkEdits = {
  'apps/server/src/server.ts': [
    ['import * as DeviceHubProxy from "./device/DeviceHubProxy.ts";',
      'import { rubatoThreadForkRouteLayer } from "./RubatoThreadFork.ts";\n'],
    ['    DeviceHubProxy.layer,\n', '    rubatoThreadForkRouteLayer,\n'],
  ],
  'apps/web/src/components/threadActionMenu.logic.ts': [
    ['  | "rename"\n', '  | "fork"\n'],
    ['    readonly titleRegeneration: boolean;\n  };\n',
      '    readonly titleRegeneration: boolean;\n    /** The thread runs on Rubato, which can copy its conversation (rubatoThreadFork.ts). */\n    readonly fork?: boolean;\n  };\n',
      'replace'],
    ['    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },\n',
      '    ...(state.supports.fork\n      ? [{ id: "fork" as const, label: "Fork thread", icon: "git-branch" }]\n      : []),\n'],
  ],
  'apps/web/src/components/Sidebar.tsx': [
    ['import {\n  buildDraftActionMenuItems,\n  buildThreadActionMenuItems,\n',
      'import { forkThread, threadRunsOnRubato } from "./sidebar/rubatoThreadFork";\n'],
    ['                titleRegeneration: supportsTitleRegeneration,\n',
      '                titleRegeneration: supportsTitleRegeneration,\n                fork: threadRunsOnRubato(thread),\n',
      'replace'],
    ['          case "rename":\n            startThreadRename(threadRef, thread.title);\n',
      ['          case "fork": {', ...forkHandler('            '), '          }', ''].join('\n')],
  ],
  'apps/web/src/components/LegacySidebar.tsx': [
    ['import { pinMenuItems, pinnedThreadsFirst } from "./sidebar/rubatoPinnedThreads";\n',
      'import { forkMenuItems, forkThread } from "./sidebar/rubatoThreadFork";\n'],
    ['          { id: "rename", label: "Rename thread", disabled: !canOperateThread },\n',
      '          ...forkMenuItems(thread),\n'],
    ['      if (clicked === "rename") {\n',
      ['      if (clicked === "fork") {', ...forkHandler('        '), '      }', '', ''].join('\n')],
    ['      pinThread,\n      confirmAndUnpinThread,\n', '      navigateToThread,\n'],
  ],
};
