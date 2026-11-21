// The sidebar as it looks on T3 v0.1.0 (intent t3-v0-1-11-bump: the sidebar stays as it is).
// T3 v0.1.11 restyled the new sidebar; every change that shows with Rubato's settings goes
// back here, and upstream additions that stay hidden until turned on are left alone.
//
// - Card titles: a read or background thread's title is the foreground at 80% (T3 v0.1.11:
//   75%, full on hover), a read active one 90%, an unread one full.
// - Cards keep three lines and one height: the branch line stays, empty, so the model logo
//   sits under the title (T3 v0.1.11 drops an empty third line and moves the logo up). The
//   branch and scratch machine there are the faint 40% gray.
// - The pin sits right of the project name, beside the time (T3 v0.1.11: left of the name).
// - The project name is medium weight on rows that do not recede.
// - Settled rows fade their text to 70% gray at rest; the open and selected rows have no
//   light-theme rim.
// - Shelf headers read "Settled (4)" while folded and "Settled" open, with the rule running to
//   a chevron that points up while folded; Snoozed is blue (T3 v0.1.11: a trailing count, no
//   rule, a sideways chevron, all muted). The header component's tones are v0.1.0's.
// - The undo notice is a card above the footer (RubatoThreadUndoNotice.tsx), and the footer
//   pads 4px below as above.
// - The narrow-window project picker lists projects in Rubato's order (T3 v0.1.11 lifts pinned
//   projects first); archived projects stay out, as upstream.
export const sidebarLookOverlays = [
  'apps/web/src/components/sidebar/RubatoThreadUndoNotice.tsx',
];

export const sidebarLookEdits = {
  'apps/web/src/components/sidebar/SidebarThreadRow.tsx': [
    [
      [
        '                  ? "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"',
        '                  : status === "failed" && !isUnread && !isWoke',
        '                    ? "text-foreground/95"',
        '                    : "text-foreground",',
        '',
      ].join('\n'),
      [
        '                  ? "text-foreground/80"',
        '                  : isUnread || isWoke || status === "input" || status === "request"',
        '                    ? "text-foreground"',
        '                    : status === "failed"',
        '                      ? "text-foreground/95"',
        '                      : "text-foreground/90",',
        '',
      ].join('\n'),
      'replace',
    ],
    ['                shouldRecede\n                  ? "text-secondary-label"\n                  : props.isActive || isWoke',
      '                shouldRecede\n                  ? "text-secondary-label/70"\n                  : props.isActive || isWoke',
      'replace'],
    [
      [
        '              {/* Left of the status slot, the pin would slide when hover swaps the',
        '                label for the wider row controls. */}',
        '              {pinIndicator}',
        '              {props.projectDisplayName ? (',
        '                <span',
        '                  className={cn("min-w-0 flex-1 truncate font-normal text-secondary-label text-xs")}',
        '                >',
        '                  {props.projectDisplayName}',
        '                </span>',
        '              ) : (',
        '                <span className="flex-1" />',
        '              )}',
        '',
      ].join('\n'),
      [
        '              {props.projectDisplayName ? (',
        '                <span',
        '                  className={cn(',
        '                    "min-w-0 flex-1 truncate text-secondary-label text-xs",',
        '                    shouldRecede ? "font-normal" : "font-medium",',
        '                  )}',
        '                >',
        '                  {props.projectDisplayName}',
        '                </span>',
        '              ) : (',
        '                <span className="flex-1" />',
        '              )}',
        '              {/* Rubato: the pin beside the time, as on v0.1.0 (sidebar-look-edits.mjs). */}',
        '              {pinIndicator}',
        '',
      ].join('\n'),
      'replace',
    ],
    ['        metaLineEmpty && "[contain-intrinsic-size:auto_60px]",\n',
      '        // Rubato: a card keeps its 78px height (sidebar-look-edits.mjs).\n', 'replace'],
    ['              metaLineEmpty && "h-auto",\n',
      '              // Rubato: the card keeps its height; its third line stays (sidebar-look-edits.mjs).\n', 'replace'],
    ['              {titleLineIcons}\n            </div>\n            {metaLine}\n          </div>\n',
      '            </div>\n            {rubatoCardMetaLine}\n          </div>\n',
      'replace'],
    ['  if (variant !== "card") {\n',
      [
        '  // Rubato: a card keeps its third line, so the model logo stays under the title',
        '  // (sidebar-look-edits.mjs).',
        '  const rubatoCardMetaLine = metaLine ?? (',
        '    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">',
        '      <span className="flex-1" />',
        '      <span',
        '        aria-hidden',
        '        className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"',
        '      >',
        '        {remoteMachineIcon}',
        '        <SidebarProviderStack',
        '          thread={thread}',
        '          providerEntryByInstanceId={props.providerEntryByInstanceId}',
        '        />',
        '      </span>',
        '    </div>',
        '  );',
        '',
      ].join('\n')],
    ['          <span className="flex min-w-0 flex-1">\n            <MiddleTruncate value={checkoutThread.branch} showTitle={false} />\n',
      '          <span className="flex min-w-0 flex-1 text-muted-foreground/40">\n            <MiddleTruncate value={checkoutThread.branch} showTitle={false} />\n',
      'replace'],
    ['            className="size-3 shrink-0"\n          />\n          <span className="min-w-0 flex-1 truncate">{props.scratchMachineLabel}</span>\n',
      '            className="size-3 shrink-0 text-muted-foreground/40"\n          />\n          <span className="min-w-0 flex-1 truncate text-muted-foreground/40">{props.scratchMachineLabel}</span>\n',
      'replace'],
    ['      "[&:not(:hover):not(:focus-within)_*:not(.live-activity-focus_*)]:text-secondary-label",\n',
      '      "[&:not(:hover):not(:focus-within)_*:not(.live-activity-focus_*)]:text-secondary-label/70",\n',
      'replace'],
    ['      ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"\n',
      '      ? // Rubato: no light-theme rim on the open row (sidebar-look-edits.mjs).\n        "bg-sidebar-row-active text-sidebar-foreground"\n',
      'replace'],
    ['        ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"\n',
      '        ? "bg-sidebar-row-selected text-sidebar-foreground"\n',
      'replace'],
    ['"flex items-center self-center justify-self-end tabular-nums text-secondary-label",\n',
      '"flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",\n',
      'replace'],
  ],
  'apps/web/src/components/sidebar/SidebarListMarkers.tsx': [
    ['        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}\n',
      [
        '        tone={',
        '          props.isDropTarget',
        '            ? "accent"',
        '            : props.dragging',
        '              ? "emphasized"',
        '              : shelf === "snoozed"',
        '                ? "info"',
        '                : "muted"',
        '        }',
        '',
      ].join('\n'),
      'replace'],
    ['        accessory={<span className="font-normal tabular-nums">{props.count}</span>}\n      >\n        {props.label}\n',
      '      >\n        {props.toggle.expanded ? props.label : `${props.label} (${props.count})`}\n',
      'replace'],
  ],
  'apps/web/src/components/ui/collapsible-section-header.tsx': [
    ['  muted: { label: "text-sidebar-muted-foreground", line: "bg-sidebar-border/50" },\n',
      '  muted: { label: "text-sidebar-muted-foreground/60", line: "bg-sidebar-border/60" },\n  info: { label: "text-blue-600 dark:text-blue-400", line: "bg-blue-500/20 dark:bg-blue-400/15" },\n',
      'replace'],
    ['!expanded && "-rotate-90")}', '!expanded && "rotate-180")}', 'replace'],
  ],
  'apps/web/src/components/sidebar/SidebarChrome.tsx': [
    ['      <SidebarThreadUndoNotice />\n',
      '      {/* Rubato: the undo notice is a card above the footer (sidebar-look-edits.mjs). */}\n', 'replace'],
    ['    <SidebarFooter>\n', '    <SidebarFooter>\n      <RubatoThreadUndoNotice />\n', 'replace'],
    ['import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";\n',
      'import { RubatoThreadUndoNotice } from "./RubatoThreadUndoNotice";\n',
      'replace'],
  ],
  'apps/web/src/components/ui/sidebar.tsx': [
    ['        "flex flex-col gap-2 px-[var(--sidebar-content-inset)] pt-1 pb-[var(--sidebar-content-inset)]",\n',
      '        "flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1", // Rubato: v0.1.0 footer (sidebar-look-edits.mjs)\n',
      'replace'],
  ],
  'apps/web/src/components/Sidebar.tsx': [
    ['    ...pickableProjectGroups(projectGroups).map((project) => ({\n',
      '    // Rubato: the projects in Rubato\'s order, pinned ones not lifted (sidebar-look-edits.mjs).\n    ...projectGroups.filter((group) => !group.archived).map((project) => ({\n',
      'replace'],
  ],
};
