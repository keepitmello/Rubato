// Pinning in the legacy sidebar. Rubato turns the legacy (per-project tree)
// sidebar on (write-gui-settings.mjs), but T3 only built pinning into the new
// sidebar, so a Rubato app had no way to pin a thread. The server already
// speaks thread.pin / thread.unpin; this adds the other half:
//
// - the thread's right-click menu offers Pin thread / Unpin thread, through the
//   same useThreadActions calls the new sidebar uses (an unpin asks first when
//   the "confirm unpin" setting is on);
// - pinned threads lead their project's list in the server's pin order, in both
//   places that order the list (the rows and the ⌘-number jump targets);
// - a pinned row shows a small pin before its title.
export const sidebarPinOverlays = [
  'apps/web/src/components/sidebar/rubatoPinnedThreads.ts',
  'apps/web/src/components/sidebar/rubatoPinnedThreads.test.ts',
];

export const sidebarPinEdits = {
  'apps/web/src/components/LegacySidebar.tsx': [
    ['import { sortThreads } from "../lib/threadSort";\n',
      'import { pinMenuItems, pinnedThreadsFirst } from "./sidebar/rubatoPinnedThreads";\n'],
    ['  SearchIcon,\n', '  PinIcon,\n'],
    [
      '    const visibleProjectThreads = sortThreads(\n      projectThreads.filter((thread) => thread.archivedAt === null),\n      threadSortOrder,\n    );',
      '    const visibleProjectThreads = pinnedThreadsFirst(\n      sortThreads(\n        projectThreads.filter((thread) => thread.archivedAt === null),\n        threadSortOrder,\n      ),\n    );',
      'replace',
    ],
    [
      '        const projectThreads = sortThreads(\n          (threadsByProjectKey.get(project.projectKey) ?? []).filter(\n            (thread) => thread.archivedAt === null,\n          ),\n          sidebarThreadSortOrder,\n        );',
      '        const projectThreads = pinnedThreadsFirst(\n          sortThreads(\n            (threadsByProjectKey.get(project.projectKey) ?? []).filter(\n              (thread) => thread.archivedAt === null,\n            ),\n            sidebarThreadSortOrder,\n          ),\n        );',
      'replace',
    ],
    ['          {threadStatus && <ThreadStatusLabel status={threadStatus} compact />}\n',
      '          {thread.pinnedAt != null ? (\n            <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />\n          ) : null}\n'],
    ['  const handleThreadContextMenu = useCallback(\n    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {\n',
      '  const { pinThread, confirmAndUnpinThread } = useThreadActions();\n'],
    ['          { id: "rename", label: "Rename thread" },\n',
      '          ...pinMenuItems(thread),\n'],
    ['      if (clicked === "rename") {\n',
      [
        '      if (clicked === "pin" || clicked === "unpin") {',
        '        const result =',
        '          clicked === "pin" ? await pinThread(threadRef) : await confirmAndUnpinThread(threadRef);',
        '        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {',
        '          const error = squashAtomCommandFailure(result);',
        '          toastManager.add(',
        '            stackedThreadToast({',
        '              type: "error",',
        '              title: clicked === "pin" ? "Failed to pin thread" : "Failed to unpin thread",',
        '              description: error instanceof Error ? error.message : "An error occurred.",',
        '            }),',
        '          );',
        '        }',
        '        return;',
        '      }',
        '',
        '',
      ].join('\n')],
    ['      markThreadUnread,\n      memberProjectByScopedKey,\n',
      '      markThreadUnread,\n      memberProjectByScopedKey,\n      pinThread,\n      confirmAndUnpinThread,\n',
      'replace'],
  ],
};
