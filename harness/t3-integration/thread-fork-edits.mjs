// Forking a thread from the legacy sidebar. Pi can copy a conversation into a new
// one (pi-server's Management fork); T3 has no fork. This adds:
//
// - the thread's right-click menu offers Fork thread for a thread that runs on Rubato;
// - /rubato/thread-fork on the server (RubatoThreadFork.ts) forks the thread's Pi
//   session under "<title> (fork)" and answers with the thread that shows the copy.
//   That thread is the inventory's import (RubatoPiInventory.ts), so it carries the
//   conversation's text and no tool rows, and its next message continues the copy;
// - the sidebar opens the new thread once it reaches the app.
//
// Forking at an earlier message is a fork followed by the existing rewind.
export const threadForkOverlays = [
  'apps/server/src/RubatoThreadFork.ts',
  'apps/server/src/RubatoThreadFork.test.ts',
  'apps/web/src/components/sidebar/rubatoThreadFork.ts',
  'apps/web/src/components/sidebar/rubatoThreadFork.test.ts',
];

export const threadForkEdits = {
  'apps/server/src/server.ts': [
    ['import { deviceHubProxyRouteLayer } from "./device/DeviceHubProxy.ts";',
      'import { rubatoThreadForkRouteLayer } from "./RubatoThreadFork.ts";\n'],
    ['    deviceHubProxyRouteLayer,\n', '    rubatoThreadForkRouteLayer,\n'],
  ],
  'apps/web/src/components/LegacySidebar.tsx': [
    ['import { pinMenuItems, pinnedThreadsFirst } from "./sidebar/rubatoPinnedThreads";\n',
      'import { forkMenuItems, forkThread } from "./sidebar/rubatoThreadFork";\n'],
    ['          { id: "rename", label: "Rename thread" },\n',
      '          ...forkMenuItems(thread),\n'],
    ['      if (clicked === "rename") {\n',
      [
        '      if (clicked === "fork") {',
        '        const progress = toastManager.add({ type: "loading", title: "Forking thread…" });',
        '        try {',
        '          await navigateToThread(await forkThread(threadRef));',
        '          toastManager.close(progress);',
        '        } catch (error) {',
        '          toastManager.update(',
        '            progress,',
        '            stackedThreadToast({',
        '              type: "error",',
        '              title: "Failed to fork thread",',
        '              description: error instanceof Error ? error.message : "An error occurred.",',
        '            }),',
        '          );',
        '        }',
        '        return;',
        '      }',
        '',
        '',
      ].join('\n')],
    ['      pinThread,\n      confirmAndUnpinThread,\n', '      navigateToThread,\n'],
  ],
};
